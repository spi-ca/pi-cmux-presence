import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createPresenceConsumer,
  createPresenceProducer,
  type PresenceConsumerHandle,
  type PresenceProducerHandle,
  type PresenceTerminalV2,
  MAX_INTEGER,
} from "@pi/presence";
import { PresenceClient } from "./client.js";
import type { PresenceConfig } from "./config.js";
import {
  adaptPresenceState,
  isState,
  isTerminal,
  LOCAL_SOURCE,
  PresenceStateRegistry,
  type PresenceUpdate,
} from "./events.js";
import { readCmuxIdentity, resolveCmuxSocketPath } from "./identity.js";
import { officialHookDetected } from "./official-hook.js";
import {
  PI_SUBAGENT_SOURCE_ID,
  fixedCoalescingDeadline,
  observeSubagentTerminal,
  remainingErrorDeadlineMs,
  shouldFlashAttention,
  shouldNotifyAttention,
  type AttentionKind,
  type SubagentTerminalBaseline,
} from "./notification-policy.js";
import {
  aggregateMetadata,
  attentionLevel,
  deriveTerminalState,
  formatAttentionTitle,
  formatAutoTitle,
  formatInteractionWaitingPresentation,
  formatLocalTurnPresentation,
  formatSubagentAttention,
  formatProgressText,
  formatStateText,
  isInteractionWaiting,
  PRESENCE_STATE_STYLES,
  presenceStatusKey,
  selectProgress,
} from "./presentation.js";
import { TodoProgressAdapter } from "./todo.js";
import { UnresolvedSocketFingerprintGate, UnixSocketTransport } from "./transport.js";
import { UsageTracker } from "./usage.js";
import { hasControlOrBidi, isProtocolToken, isSafeSessionId } from "./validation.js";

const LAST_STATE_SEQUENCE = MAX_INTEGER - 1;

type ContextProvider = { getContextUsage?: () => unknown };
type TerminalState = "success" | "error" | "cancelled";
type ToolFeedEvent = { toolCallId?: unknown; toolName?: unknown };
type FeedHookEvent = "SessionStart" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "Stop";
type QueuedFeedEdge = {
  readonly sessionEpoch: number;
  readonly sessionId: string;
  readonly event: FeedHookEvent;
  readonly tool?: { readonly callId?: string; readonly name?: string };
};
type OfficialHookDetector = (signal: AbortSignal) => Promise<boolean>;
type SocketPathResolver = () => Promise<string | null>;

type RuntimeClock = {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
};

/** Production uses a monotonic clock; tests can inject a deterministic scheduler. */
const SYSTEM_RUNTIME_CLOCK: RuntimeClock = {
  now: () => performance.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
};

type StatusClearAttempt = {
  /** Identifies the current attempt for a status key despite overlapping removes. */
  readonly token: object;
  readonly client: PresenceClient;
  /** Resolves to whether cmux acknowledged this exact attempted clear. */
  readonly outcome: Promise<boolean>;
};

type DetachedSession = {
  client: PresenceClient | null;
  sessionId: string | null;
  officialHook: boolean;
  statusScope: string | undefined;
  retainedEvents: PresenceUpdate[];
  /** Latest unacknowledged clear attempt by status key; bounded by source fences. */
  pendingStatusClears: Map<string, StatusClearAttempt>;
};

type PendingSubagentAttention = {
  /** Session ownership fence for delayed startup output. */
  readonly sessionEpoch: number;
  generation: number;
  completedDelta: number;
  failedDelta: number;
  cancelledDelta: number;
  terminal: AttentionKind | "cancelled";
  /** Parent run that can settle this burst; zero means independent. */
  parentRun: number;
  /** Fixed semantic burst deadline: first success + 450ms or first error + 100ms. */
  coalesceDeadline: number | null;
  /** First-error + 10s active-parent maximum wait deadline. */
  errorDeadline: number | null;
  /** Terminal outcome recorded when the parent settles during this burst. */
  parentSettled: TerminalState | null;
  /** A closed terminal waits for asynchronous owned output initialization. */
  deferredDispatch?: boolean;
  /** Preserve hard-cap wording when that closed terminal waits for output. */
  deferredTimeout?: boolean;
};

type SuppressedParentAttention = {
  /** Original session ownership fence for a delayed fallback. */
  readonly sessionEpoch: number;
  readonly parentRun: number;
  readonly attention: "info" | AttentionKind;
  readonly completed: number;
  readonly failed: number;
};

type GenericAttentionSemantic = {
  readonly generation: number;
  readonly state: PresenceUpdate["state"];
  readonly attention: "info" | AttentionKind;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly interactionWaiting: boolean;
};

type PendingSubagentFailureState = {
  /** Absolute monotonic expiry; callbacks only trigger reconciliation. */
  readonly deadline: number;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly sourceId: string;
  readonly level: AttentionKind;
  readonly title: string;
  readonly body: string;
  readonly notify: boolean;
  readonly flash: boolean;
};

type SubagentFailureTerminalTombstone = {
  /** Absolute monotonic expiry; callbacks only trigger reconciliation. */
  readonly deadline: number;
  readonly timer: ReturnType<typeof setTimeout>;
};

type ExternalAttention = {
  readonly key: string;
  readonly priority: number;
  readonly level: "info" | AttentionKind;
  readonly title: string;
  readonly body: string;
  readonly notify: boolean;
  readonly flash: boolean;
};

type PendingLocalTerminalAttention = {
  /** Startup output may only dispatch within the terminal's original session epoch. */
  readonly sessionEpoch: number;
  /** A later agent_start makes a prior settled run's terminal stale. */
  readonly parentRunRevision: number;
  readonly attention: AttentionKind;
  readonly title: string;
  readonly body: string;
  readonly notify: boolean;
  readonly flash: boolean;
};

// A bounded session-wide bucket prevents untrusted event-bus producers from
// converting generation/none churn into an unbounded cmux attention stream.
const EXTERNAL_ATTENTION_BURST = 4;
const EXTERNAL_ATTENTION_INTERVAL_MS = 1_000;
const MAX_PENDING_EXTERNAL_ATTENTION = 64;
/** Pair a structured subagent failure with its explicit terminal edge only briefly. */
const SUBAGENT_FAILURE_TERMINAL_MATCH_MS = 100;
const MAX_SUBAGENT_FAILURE_TOMBSTONES = 8;
/** Preserve lifecycle ordering without retaining an unbounded startup transcript. */
const MAX_PENDING_FEED_EDGES = 32;
const MAX_FEED_TOOL_NAME_BYTES = 128;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function sessionIdFromContext(context: unknown): string | null {
  try {
    if (typeof context !== "object" || context === null) return null;
    const sessionManager = (context as { sessionManager?: unknown }).sessionManager;
    if (typeof sessionManager !== "object" || sessionManager === null) return null;
    const getSessionId = (sessionManager as { getSessionId?: unknown }).getSessionId;
    if (typeof getSessionId !== "function") return null;
    const sessionId = getSessionId.call(sessionManager);
    return isSafeSessionId(sessionId) ? sessionId : null;
  } catch {
    return null;
  }
}

/** Owns presence session state and best-effort side effects; hook wiring lives in hooks.ts. */
export class PresenceRuntime {
  private readonly registry = new PresenceStateRegistry();
  private readonly todo = new TodoProgressAdapter();
  private consumer: PresenceConsumerHandle | undefined;
  private piProducer: PresenceProducerHandle | undefined;
  private todoProducer: PresenceProducerHandle | undefined;
  /** Private cmux-only local metrics and todo counts; never placed on the V2 wire. */
  private readonly localPresentation = new Map<"pi" | "todo", PresenceUpdate>();
  private client: PresenceClient | null = null;
  private clientCloseBarrier: Promise<void> = Promise.resolve();
  /** One intrinsic fingerprint lease may remain unresolved across client replacement. */
  private readonly fingerprintGate = new UnresolvedSocketFingerprintGate();
  /** Cancels only the current epoch's wait for official-hook authority. */
  private officialHookProbeAbort: AbortController | null = null;
  /** An unabortable hook probe remains exclusive until it actually settles. */
  private unresolvedOfficialHookProbe: Promise<void> | null = null;
  /** Cancels only the current epoch's wait for pre-ownership path resolution. */
  private socketResolutionAbort: AbortController | null = null;
  /** An unabortable filesystem resolver remains exclusive until it actually settles. */
  private unresolvedSocketResolution: Promise<void> | null = null;
  /** Latest attempts only, bounded by the registry's retained-source cap. */
  private pendingStatusClears = new Map<string, StatusClearAttempt>();
  private contextProvider: ContextProvider | null = null;
  private sessionId: string | null = null;
  private sessionEpoch = 0;
  private generation = 0;
  private localSequence = 0;
  private localEventId = 0;
  private active = false;
  private completed = 0;
  private failed = 0;
  private usage = new UsageTracker();
  private terminal: TerminalState = "success";
  private hadToolError = false;
  private shownProgress = false;
  /** A settled status may expire before delayed owned output exists. */
  private deferredFinalClear = false;
  private clearTimer: ReturnType<typeof setTimeout> | undefined;
  private subagentBaseline: SubagentTerminalBaseline | null = null;
  private subagentPending: PendingSubagentAttention | null = null;
  /** At most one semantic attention marker per retained external source. */
  private readonly genericAttentionBySource = new Map<string, GenericAttentionSemantic>();
  /** Short state-first window for matching structured failures to live terminal edges. */
  private readonly pendingSubagentFailureStates = new Map<string, PendingSubagentFailureState>();
  /** Terminal-first fences prevent one matching state from replaying the alert. */
  private readonly subagentFailureTerminalTombstones = new Map<string, SubagentFailureTerminalTombstone>();
  /** Becomes true only after the current client completed owned initialization. */
  private attentionOutputReady = false;
  /** One current local terminal is enough to reconcile a delayed session setup. */
  private pendingLocalTerminalAttention: PendingLocalTerminalAttention | null = null;
  /** Opt-in lifecycle edges accepted before owned cmux output is ready. */
  private pendingFeedEdges: QueuedFeedEdge[] = [];
  /** A startup overflow drops this epoch's feed rather than emitting a partial transcript. */
  private feedQueueOverflowed = false;
  private externalAttentionTokens = EXTERNAL_ATTENTION_BURST;
  private externalAttentionRefillAt = 0;
  private readonly pendingExternalAttention = new Map<string, ExternalAttention>();
  private externalAttentionTimer: ReturnType<typeof setTimeout> | undefined;
  private subagentTimer: ReturnType<typeof setTimeout> | undefined;
  private subagentTimerEpoch = 0;
  private parentRunRevision = 0;
  /** Suppresses a terminal after its child error already timed out at 10 seconds. */
  private fencedParentRun: number | null = null;
  private suppressParentAttentionOnce = false;
  /** A trusted local terminal held only while its child error burst is pending. */
  private suppressedParentAttention: SuppressedParentAttention | null = null;
  private officialHook = false;
  private statusScope: string | undefined;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly config: PresenceConfig,
    private readonly clock: RuntimeClock = SYSTEM_RUNTIME_CLOCK,
    private readonly detectOfficialHook: OfficialHookDetector = (signal) => officialHookDetected(process.env, signal),
    private readonly resolveSocketPath: SocketPathResolver = resolveCmuxSocketPath,
  ) {}

  /** Hooks pass every V2 bus message here; shared accept is the sole wire parser and fence. */
  handlePresenceEvent(eventName: string, payload: unknown): void {
    try {
      const accepted = this.consumer?.accept(eventName, payload);
      if (!accepted) return;
      if (isState(accepted)) {
        const overlay = accepted.source === "pi" || accepted.source === "todo"
          ? this.localPresentation.get(accepted.source)
          : undefined;
        const event = adaptPresenceState(accepted, overlay);
        this.registry.set(event);
        this.apply(event);
        return;
      }
      if (isTerminal(accepted)) {
        // Terminal events are explicit live edges. They never synthesize a
        // cumulative state or become a retained status snapshot.
        this.handleTerminalEdge(accepted);
        return;
      }
      const removed = this.registry.remove(accepted.source);
      if (accepted.source === "subagent") this.invalidateSubagentNotifications();
      this.genericAttentionBySource.delete(accepted.source);
      this.discardPendingExternalAttention(accepted.source);
      if (removed) this.clearRemovedStatus(this.statusKey(removed.source.id));
      this.renderProgress();
      if (!this.officialHook && this.config.metaBlock) void this.client?.meta(this.metadata());
    } catch {
      // V2 observer input and presentation are optional.
    }
  }

  /** Terminal edges are live-only: status/counts remain owned by retained state. */
  private handleTerminalEdge(event: PresenceTerminalV2): void {
    if (event.source === PI_SUBAGENT_SOURCE_ID) {
      this.queueSubagentTerminal(event);
      return;
    }

    // The local source's state remains authoritative. Do not write a terminal
    // status or create a synthetic count snapshot for this edge. Only this
    // explicit local terminal consumes a deferred parent suppression; quiet
    // local state snapshots must leave it available for this edge.
    const suppressParentAttention = event.source === LOCAL_SOURCE.id
      && this.suppressParentAttentionOnce;
    if (suppressParentAttention) this.suppressParentAttentionOnce = false;
    if (event.outcome === "cancelled") return;
    const attention: AttentionKind = event.outcome === "failed" ? "error" : "success";
    if (suppressParentAttention || this.officialHook) return;

    const presentation = formatLocalTurnPresentation(
      event.outcome === "failed" ? "error" : "success",
      this.config.maxLabelChars,
    );
    const notify = !this.config.suppressNativeNotifications && shouldNotifyAttention(
      this.config.notificationPolicy,
      this.config.notifications,
      attention,
      "local",
    );
    const flash = !this.config.suppressNativeFlash && shouldFlashAttention(
      this.config.flashPolicy,
      this.config.flash,
      this.config.notificationPolicy,
      attention,
      "local",
    );
    if (!this.attentionOutputReady) {
      // A session may settle while its preceding teardown, hook probe, or socket
      // setup is still pending. Retain the latest terminal semantics so delayed
      // output has the same terminal outcome as the synchronous path.
      this.pendingLocalTerminalAttention = {
        sessionEpoch: this.sessionEpoch,
        parentRunRevision: this.parentRunRevision,
        attention,
        title: presentation.title,
        body: presentation.body,
        notify,
        flash,
      };
      return;
    }
    this.emitAttention(attention, presentation.title, presentation.body, notify, flash);
  }

  async startSession(context: unknown): Promise<void> {
    const epoch = ++this.sessionEpoch;
    this.officialHookProbeAbort?.abort();
    this.socketResolutionAbort?.abort();
    this.cancelFinalClear();

    const previousSession = this.detachCurrentSession();
    this.generation += 1;

    const nextSessionId = sessionIdFromContext(context);
    if (nextSessionId !== null) {
      // Hooks return immediately, so establish the current epoch and V2 handles
      // before the first await. Agent/turn/tool/settled callbacks that arrive
      // during prior teardown are then retained and rendered after setup.
      this.beginSession(nextSessionId, context);
      this.queueFeedEdge("SessionStart", nextSessionId);
      this.activateConsumer();
      this.activateLocalProducers();
    }

    // Prior output must still finish before this epoch receives a client. This
    // preserves replacement/teardown ordering without making Pi await it.
    await this.cleanupDetachedSession(previousSession);
    if (epoch !== this.sessionEpoch || nextSessionId === null) return;

    const detectedOfficialHook = await this.detectOfficialHookWithinDeadline();
    if (!this.isCurrent(epoch, nextSessionId)) return;
    this.officialHook = detectedOfficialHook;
    if (detectedOfficialHook) this.discardPendingFeedEdges();

    const identity = readCmuxIdentity();
    this.statusScope = identity?.surfaceId;
    const socketPath = identity ? await this.resolveSocketPathWithinDeadline() : null;
    if (!this.isCurrent(epoch, nextSessionId)) return;

    if (identity && socketPath) {
      const created = new PresenceClient(
        identity,
        new UnixSocketTransport(
          socketPath,
          this.config.timeoutMs,
          this.config.maxQueue,
          this.fingerprintGate,
        ),
        this.config,
      );
      // Publish ownership before either asynchronous initialization step. A
      // replacement or shutdown can then detach this client and serialize its
      // close through the existing bounded teardown barrier.
      this.client = created;
      await created.initialize();
      if (!this.isCurrent(epoch, nextSessionId)) return;
      // This runs only after the client is the current runtime owner.
      await created.initializeOwnedProgress();
      if (!this.isCurrent(epoch, nextSessionId)) return;
      // Earlier event-bus input may be retained, but it cannot consume
      // semantic attention dedupe until this owned client is usable.
      this.attentionOutputReady = true;
      this.dispatchDeferredSubagentAttention();
      this.dispatchSuppressedParentAttention(this.parentRunRevision);
      this.dispatchPendingFeedEdges();
    }

    // Producer-first snapshots and local lifecycle transitions were accepted
    // before asynchronous cmux setup. Render retained state once without
    // replaying generic attention; a local terminal is reconciled below.
    this.renderRetainedSnapshots();
    this.dispatchDeferredFinalClear();
    this.dispatchPendingLocalTerminalAttention();

    await this.initializeOptionalIntegrations(nextSessionId);
    if (!this.isCurrent(epoch, nextSessionId)) return;

    // Do not overwrite a running or settled state that arrived while setup was
    // fenced behind prior teardown/probe/socket work.
    if (!this.localPresentation.has("pi")) this.publish("idle");
    if (!this.officialHook) {
      if (this.config.metaBlock) void this.client?.meta(this.metadata());
    }
  }

  handleAgentStart(): void {
    if (!this.sessionId) return;
    this.activateLocalProducers();
    this.cancelFinalClear();
    if (!this.active) {
      // Startup may still be waiting on a prior teardown, hook probe, or socket.
      // A new run makes its predecessor's deferred local terminal ineligible.
      this.pendingLocalTerminalAttention = null;
      const nextParentRun = this.parentRunRevision + 1;
      const pending = this.subagentPending;
      if (pending && pending.parentSettled !== null && pending.parentRun !== nextParentRun) {
        // A deferred aggregate belongs to its settled parent, not to the next
        // agent_start. Drop both halves instead of replaying stale completion.
        this.clearSubagentTimer();
        this.subagentPending = null;
        if (this.suppressedParentAttention?.parentRun === pending.parentRun) {
          this.suppressedParentAttention = null;
        }
      }
      if (this.suppressedParentAttention
        && this.suppressedParentAttention.parentRun < nextParentRun) {
        this.suppressedParentAttention = null;
      }
      // Only aggregates not already settled by the prior parent may reconcile
      // before this run claims lifecycle ownership.
      this.reconcileElapsedSubagentAttention();
      this.active = true;
      this.parentRunRevision = nextParentRun;
      // A timeout fence belongs only to its original parent run.
      if (this.fencedParentRun !== this.parentRunRevision) this.fencedParentRun = null;
      this.usage = new UsageTracker();
      this.hadToolError = false;
    }
    this.terminal = "success";
    this.updateContextUsage();
    this.publish("running");
    if (!this.officialHook && this.config.nativeLifecycle) {
      void this.client?.lifecycle("running");
    }
  }

  handleTurnStart(): void {
    this.activateLocalProducers();
    if (this.sessionId && this.active) this.updateContextUsage();
  }

  handleMessageEnd(event: unknown): void {
    this.activateLocalProducers();
    if (!this.sessionId || typeof event !== "object" || event === null) return;
    const message = (event as { message?: unknown }).message;
    if (typeof message !== "object" || message === null) return;
    const assistant = message as { role?: unknown; usage?: unknown };
    if (assistant.role !== "assistant") return;
    this.usage.add(assistant.usage);
    this.updateContextUsage();
  }

  handleAgentEnd(event: unknown): void {
    this.activateLocalProducers();
    if (!this.sessionId || typeof event !== "object" || event === null) return;
    const messages = (event as { messages?: unknown }).messages;
    this.terminal = deriveTerminalState(Array.isArray(messages) ? messages : [], this.hadToolError);
  }

  handleBeforeAgentStart(): void {
    this.activateLocalProducers();
    if (this.sessionId) this.queueFeedEdge("UserPromptSubmit", this.sessionId);
  }

  handleToolExecutionStart(event: ToolFeedEvent): void {
    this.activateLocalProducers();
    this.feedToolEvent("PreToolUse", event);
  }

  handleToolExecutionEnd(event: ToolFeedEvent): void {
    this.activateLocalProducers();
    this.feedToolEvent("PostToolUse", event);
  }

  handleToolResult(event: unknown): void {
    if (!this.sessionId) return;
    if (typeof event === "object" && event !== null && (event as { isError?: unknown }).isError === true && this.active) {
      this.hadToolError = true;
    }

    this.activateLocalProducers();
    this.ensureLocalOrdinals(1);
    let todoEvent: PresenceUpdate | null = null;
    try {
      todoEvent = this.todo.accept(event, this.pi.getAllTools(), this.generation, this.localSequence + 1);
    } catch {
      // Tool provenance and result parsing are best-effort.
    }
    if (todoEvent) this.publishTodo(todoEvent);
  }

  handleAgentSettled(context: unknown): void {
    this.activateLocalProducers();
    try {
      if (typeof context === "object" && context !== null) {
        const isIdle = (context as { isIdle?: unknown }).isIdle;
        if (typeof isIdle === "function" && !isIdle.call(context)) return;
      }
    } catch {
      return;
    }
    this.finalizeAgent();
  }

  /** Used only when a host rejects agent_settled registration. */
  handleAgentEndFallback(): void {
    this.finalizeAgent();
  }

  handleSessionInfoChanged(event: unknown): void {
    this.activateLocalProducers();
    if (!this.sessionId || this.officialHook || !this.config.autoTitle) return;
    if (typeof event !== "object" || event === null) return;
    const name = (event as { name?: unknown }).name;
    if (typeof name !== "string" || !name.trim()) return;
    void this.client?.autoTitle(formatAutoTitle(name, Math.min(80, this.config.maxLabelChars)));
  }

  async shutdownSession(): Promise<void> {
    ++this.sessionEpoch;
    this.officialHookProbeAbort?.abort();
    this.socketResolutionAbort?.abort();
    this.cancelFinalClear();

    const closingSession = this.detachCurrentSession();
    await this.cleanupDetachedSession(closingSession);
  }

  private finalizeAgent(): void {
    if (!this.sessionId || !this.active) return;
    this.active = false;
    this.updateContextUsage();
    if (this.terminal === "error") this.failed += 1;
    else if (this.terminal === "success") this.completed += 1;

    const attention = this.terminal === "error"
      ? "error"
      : this.terminal === "success"
        ? "success"
        : "none";
    // A cancelled local run is status-only: it must not publish an attention
    // event even under permissive notification or flash policies.
    this.suppressParentAttentionOnce = this.flushSubagentForParentSettlement(attention);
    this.publish(this.terminal, attention);
    this.scheduleFinalClear(this.sessionEpoch);

    if (!this.officialHook) {
      if (this.config.nativeLifecycle) void this.client?.lifecycle("idle");
      this.queueFeedEdge("Stop", this.sessionId);
      if (this.config.metaBlock) void this.client?.meta(this.metadata());
    }
  }

  private beginSession(sessionId: string, context: unknown): void {
    this.sessionId = sessionId;
    this.registry.clear();
    this.contextProvider = typeof context === "object" && context !== null
      ? context as ContextProvider
      : null;
    this.localSequence = 0;
    this.localEventId = 0;
    this.active = false;
    this.completed = 0;
    this.failed = 0;
    this.usage = new UsageTracker();
    this.terminal = "success";
    this.hadToolError = false;
    this.shownProgress = false;
    this.deferredFinalClear = false;
    this.resetSubagentNotifications();
    this.resetExternalAttention();
    this.genericAttentionBySource.clear();
    this.parentRunRevision = 0;
    this.fencedParentRun = null;
    this.officialHook = false;
    this.statusScope = undefined;
    this.attentionOutputReady = false;
    this.pendingLocalTerminalAttention = null;
    this.resetPendingFeedEdges();
  }

  private detachCurrentSession(): DetachedSession {
    const detached = {
      client: this.client,
      sessionId: this.sessionId,
      officialHook: this.officialHook,
      statusScope: this.statusScope,
      retainedEvents: this.registry.snapshot(),
      pendingStatusClears: this.pendingStatusClears,
    };
    this.client = null;
    this.disableCurrentSession();
    return detached;
  }

  private disableCurrentSession(): void {
    this.deactivatePresence();
    this.registry.clear();
    // Keep detached attempts alive for their in-flight acknowledgements while
    // giving a replacement session an independent, bounded cleanup scope.
    this.pendingStatusClears = new Map();
    this.contextProvider = null;
    this.sessionId = null;
    this.localSequence = 0;
    this.localEventId = 0;
    this.active = false;
    this.completed = 0;
    this.failed = 0;
    this.usage = new UsageTracker();
    this.terminal = "success";
    this.hadToolError = false;
    this.shownProgress = false;
    this.deferredFinalClear = false;
    this.resetSubagentNotifications();
    this.resetExternalAttention();
    this.genericAttentionBySource.clear();
    this.parentRunRevision = 0;
    this.fencedParentRun = null;
    this.suppressParentAttentionOnce = false;
    this.officialHook = false;
    this.statusScope = undefined;
    this.attentionOutputReady = false;
    this.pendingLocalTerminalAttention = null;
    this.resetPendingFeedEdges();
  }

  private isCurrent(epoch: number, sessionId: string): boolean {
    return epoch === this.sessionEpoch && sessionId === this.sessionId;
  }

  /**
   * Bound pre-socket official-hook authority. An unabortable detector remains
   * exclusive until settlement; timeout, abort, and detector errors fail closed.
   */
  private async detectOfficialHookWithinDeadline(): Promise<boolean> {
    if (this.unresolvedOfficialHookProbe) return true;

    const controller = new AbortController();
    this.officialHookProbeAbort = controller;
    let probe: Promise<boolean>;
    try {
      probe = Promise.resolve(this.detectOfficialHook(controller.signal));
    } catch {
      if (this.officialHookProbeAbort === controller) this.officialHookProbeAbort = null;
      return true;
    }
    let settled!: Promise<void>;
    settled = probe.then(() => {}, () => {}).finally(() => {
      if (this.unresolvedOfficialHookProbe === settled) this.unresolvedOfficialHookProbe = null;
    });
    this.unresolvedOfficialHookProbe = settled;

    let removeAbort = () => {};
    const uncertain = new Promise<boolean>((resolve) => {
      const abort = () => resolve(true);
      controller.signal.addEventListener("abort", abort, { once: true });
      removeAbort = () => controller.signal.removeEventListener("abort", abort);
    });
    const timer = this.clock.setTimeout(() => controller.abort(), this.config.timeoutMs);
    timer.unref?.();

    try {
      return await Promise.race([probe.then((detected) => detected, () => true), uncertain]);
    } finally {
      this.clock.clearTimeout(timer);
      removeAbort();
      if (this.officialHookProbeAbort === controller) this.officialHookProbeAbort = null;
    }
  }

  /**
   * Bound pre-ownership filesystem resolution. A resolver cannot be aborted,
   * so a deadline/epoch only abandons its result; it remains exclusive until
   * settlement rather than allowing another filesystem validation to pile up.
   */
  private async resolveSocketPathWithinDeadline(): Promise<string | null> {
    if (this.unresolvedSocketResolution) return null;

    const controller = new AbortController();
    this.socketResolutionAbort = controller;
    const resolution = this.resolveSocketPath().catch(() => null);
    let settled!: Promise<void>;
    settled = resolution.then(() => {}, () => {}).finally(() => {
      if (this.unresolvedSocketResolution === settled) this.unresolvedSocketResolution = null;
    });
    this.unresolvedSocketResolution = settled;

    let removeAbort = () => {};
    const cancelled = new Promise<null>((resolve) => {
      const abort = () => resolve(null);
      controller.signal.addEventListener("abort", abort, { once: true });
      removeAbort = () => controller.signal.removeEventListener("abort", abort);
    });
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    timer.unref?.();

    try {
      // The resolver itself is read-only validation. Racing it keeps a stalled
      // filesystem operation from owning a lifecycle transition or client.
      return await Promise.race([resolution, cancelled]);
    } finally {
      clearTimeout(timer);
      removeAbort();
      if (this.socketResolutionAbort === controller) this.socketResolutionAbort = null;
    }
  }

  private async initializeOptionalIntegrations(sessionId: string): Promise<void> {
    if (!this.officialHook && this.config.nativeLifecycle) {
      void this.client?.setPiPid();
      void this.client?.lifecycle(this.active ? "running" : "idle");
    }

    if (!this.officialHook && this.config.autoTitle) {
      let currentName: unknown;
      try {
        currentName = typeof this.pi.getSessionName === "function"
          ? this.pi.getSessionName()
          : undefined;
      } catch {
        currentName = undefined;
      }
      if (typeof currentName === "string" && currentName.trim()) {
        void this.client?.autoTitle(
          formatAutoTitle(currentName, Math.min(80, this.config.maxLabelChars)),
        );
      }
    }

    if (!this.officialHook && this.config.resumeFallback) {
      await this.client?.installResumeFallback(
        sessionId,
        `pi --session ${shellQuote(sessionId)}`,
      );
    }
  }

  /** Render state/status only; callers decide whether the snapshot may create attention. */
  private renderState(event: PresenceUpdate): {
    presentation: ReturnType<typeof formatLocalTurnPresentation> | ReturnType<typeof formatInteractionWaitingPresentation> | null;
    interactionPresentation: ReturnType<typeof formatInteractionWaitingPresentation> | null;
    label: string;
  } {
    const localPresentation = event.source.id === LOCAL_SOURCE.id
      ? formatLocalTurnPresentation(event.state, this.config.maxLabelChars)
      : null;
    const interactionPresentation = localPresentation === null && isInteractionWaiting(event)
      ? formatInteractionWaitingPresentation(this.config.maxLabelChars)
      : null;
    const presentation = localPresentation ?? interactionPresentation;
    const label = presentation?.sidebar ?? formatStateText(event, this.config.maxLabelChars);
    void this.client?.status(
      this.statusKey(event.source.id),
      label,
      PRESENCE_STATE_STYLES[event.state],
    );
    return { presentation, interactionPresentation, label };
  }

  /** Retained state is visible after delayed cmux setup but never replays attention. */
  private renderRetainedSnapshots(): void {
    for (const event of this.registry.snapshot()) this.renderState(event);
    this.renderProgress();
  }

  private apply(event: PresenceUpdate): void {
    const { presentation, interactionPresentation, label } = this.renderState(event);
    // A source update that resolves an interaction wait supersedes any
    // rate-limited delayed input attention for that source. Keep other queued
    // categories intact, and let a later wait begin a fresh lifecycle.
    if (event.source.id !== LOCAL_SOURCE.id && interactionPresentation === null) {
      this.discardPendingExternalInputAttention(event.source.id);
    }
    this.renderProgress();

    // Exact pi-subagent interaction waits remain private generic input UI,
    // but still advance/reset the cumulative terminal baseline. They cannot
    // create a terminal aggregate of their own.
    const exactSubagent = event.source.id === PI_SUBAGENT_SOURCE_ID;
    if (exactSubagent) {
      this.observeSubagentAttention(event);
    }
    const level = attentionLevel(event.attention);
    const structuredSubagentFailure = exactSubagent
      && level === "error"
      && event.attentionReason === "failure";
    // Structured subagent state remains generic attention and never derives a
    // terminal count. A failure gets one short chance to join its matching
    // explicit terminal; blocked state stays an independent generic alert.
    if (!exactSubagent || interactionPresentation || level === "error") {
      // Local state snapshots are deliberately quiet. A deferred parent
      // suppression belongs to the following explicit local terminal edge.
      // Official hooks already own local completion attention. Do not consume
      // external semantic dedupe until this session owns a usable cmux client.
      const external = event.source.id !== LOCAL_SOURCE.id;
      if (level && (!external || this.attentionOutputReady)
        && this.shouldDispatchGenericAttention(event, level, interactionPresentation !== null)
        && !(this.officialHook && event.source.id === LOCAL_SOURCE.id)) {
        const notify = !this.config.suppressNativeNotifications && shouldNotifyAttention(
          this.config.notificationPolicy,
          this.config.notifications,
          event.attention,
          external ? "external" : "local",
        );
        const flash = !this.config.suppressNativeFlash && shouldFlashAttention(
          this.config.flashPolicy,
          this.config.flash,
          this.config.notificationPolicy,
          event.attention,
          external ? "external" : "local",
        );
        const title = presentation?.title ?? formatAttentionTitle(event, this.config.maxLabelChars);
        const body = presentation?.body ?? label;
        if (structuredSubagentFailure) {
          this.queueSubagentFailureState(event, level, title, body, notify, flash);
        } else if (external) {
          this.enqueueExternalAttention(
            event.source.id,
            interactionPresentation !== null ? "input" : level === "error" ? "error" : "other",
            level,
            title,
            body,
            notify,
            flash,
          );
        } else {
          this.emitAttention(level, title, body, notify, flash);
        }
      } else if (!level) {
        this.genericAttentionBySource.delete(event.source.id);
        // A quiet same-generation snapshot must not retract a structured
        // failure that is waiting briefly for its matching failed terminal.
        // Withdrawal, a generation replacement, teardown, or that terminal
        // are the only lifecycle boundaries allowed to clear it.
      }
    } else {
      this.genericAttentionBySource.delete(event.source.id);
      // See the quiet-state branch above: retain an exact subagent failure
      // pairing until an explicit lifecycle boundary resolves it.
    }
    if (!this.officialHook && this.config.metaBlock) {
      void this.client?.meta(this.metadata());
    }
  }

  /** State snapshots maintain only the cumulative baseline; they create no terminal edges. */
  private observeSubagentAttention(event: PresenceUpdate): void {
    this.clearSubagentFailurePairsExcept(event.source.id, event.generation);
    const observation = observeSubagentTerminal(this.subagentBaseline, event);
    // A terminal can arrive before any retained state. A later state only
    // invalidates a different pending generation; a matching generation keeps
    // its terminal-first pairing tombstone.
    const pendingGenerationChanged = this.subagentPending !== null
      && this.subagentPending.generation !== event.generation;
    const terminalMatchesState = this.subagentPending?.generation === event.generation
      || this.subagentFailureTerminalTombstones.has(
        this.subagentFailurePairKey(event.source.id, event.generation),
      );
    this.subagentBaseline = observation.baseline;
    if (pendingGenerationChanged
      || (observation.generationChanged && !terminalMatchesState)) {
      this.invalidateSubagentNotifications();
      // The current state remains the valid baseline after stale pending work
      // has been discarded.
      this.subagentBaseline = observation.baseline;
    }
    // A same-generation counter reset is presentation baseline only. Explicit
    // terminal ordinals have already passed their own ingress fence and remain
    // the sole authority for a pending aggregate.
  }

  private subagentFailurePairKey(sourceId: string, generation: number): string {
    return `${sourceId}\u0000${generation}`;
  }

  /** Keep failure/terminal pairing state to the current source generation only. */
  private clearSubagentFailurePairsExcept(sourceId: string, generation: number): void {
    this.reconcileExpiredSubagentFailurePairs();
    const retained = this.subagentFailurePairKey(sourceId, generation);
    const prefix = `${sourceId}\u0000`;
    for (const [key, pending] of this.pendingSubagentFailureStates) {
      if (key === retained) continue;
      this.clock.clearTimeout(pending.timer);
      this.pendingSubagentFailureStates.delete(key);
    }
    for (const [key, tombstone] of this.subagentFailureTerminalTombstones) {
      if (key.startsWith(prefix) && key !== retained) {
        this.clock.clearTimeout(tombstone.timer);
        this.subagentFailureTerminalTombstones.delete(key);
      }
    }
  }

  /** Returns whether this terminal consumed a still-live state-first failure. */
  private cancelPendingSubagentFailureState(sourceId: string, generation: number): boolean {
    this.reconcileExpiredSubagentFailurePairs();
    const key = this.subagentFailurePairKey(sourceId, generation);
    const pending = this.pendingSubagentFailureStates.get(key);
    if (!pending) return false;
    this.clock.clearTimeout(pending.timer);
    this.pendingSubagentFailureStates.delete(key);
    return true;
  }

  private clearSubagentFailurePairs(): void {
    for (const pending of this.pendingSubagentFailureStates.values()) {
      this.clock.clearTimeout(pending.timer);
    }
    this.pendingSubagentFailureStates.clear();
    for (const tombstone of this.subagentFailureTerminalTombstones.values()) {
      this.clock.clearTimeout(tombstone.timer);
    }
    this.subagentFailureTerminalTombstones.clear();
  }

  /** Reconcile pairing by its absolute deadline, regardless of timer callback delay. */
  private reconcileExpiredSubagentFailurePairs(): void {
    const now = this.clock.now();
    for (const [key, pending] of this.pendingSubagentFailureStates) {
      if (now < pending.deadline) continue;
      this.clock.clearTimeout(pending.timer);
      this.pendingSubagentFailureStates.delete(key);
      this.enqueueExternalAttention(
        pending.sourceId,
        "error",
        pending.level,
        pending.title,
        pending.body,
        pending.notify,
        pending.flash,
      );
    }
    for (const [key, tombstone] of this.subagentFailureTerminalTombstones) {
      if (now < tombstone.deadline) continue;
      this.clock.clearTimeout(tombstone.timer);
      this.subagentFailureTerminalTombstones.delete(key);
    }
  }

  /** Delay only structured state failure long enough for its terminal edge to arrive. */
  private queueSubagentFailureState(
    event: PresenceUpdate,
    level: AttentionKind,
    title: string,
    body: string,
    notify: boolean,
    flash: boolean,
  ): void {
    this.reconcileExpiredSubagentFailurePairs();
    const key = this.subagentFailurePairKey(event.source.id, event.generation);
    const tombstone = this.subagentFailureTerminalTombstones.get(key);
    if (tombstone) {
      // This is the single state paired with the preceding terminal edge.
      this.clock.clearTimeout(tombstone.timer);
      this.subagentFailureTerminalTombstones.delete(key);
      return;
    }
    if (this.pendingSubagentFailureStates.has(key)) return;

    const epoch = this.sessionEpoch;
    const deadline = this.clock.now() + SUBAGENT_FAILURE_TERMINAL_MATCH_MS;
    let pending!: PendingSubagentFailureState;
    const timer = this.clock.setTimeout(() => {
      if (epoch !== this.sessionEpoch || this.pendingSubagentFailureStates.get(key) !== pending) return;
      this.reconcileExpiredSubagentFailurePairs();
    }, SUBAGENT_FAILURE_TERMINAL_MATCH_MS);
    pending = { deadline, timer, sourceId: event.source.id, level, title, body, notify, flash };
    this.pendingSubagentFailureStates.set(key, pending);
    timer.unref?.();
  }

  /** Retain one terminal-first pairing fence for exactly the failure window. */
  private rememberSubagentFailureTerminal(sourceId: string, generation: number): void {
    this.reconcileExpiredSubagentFailurePairs();
    const key = this.subagentFailurePairKey(sourceId, generation);
    const previous = this.subagentFailureTerminalTombstones.get(key);
    if (previous) this.clock.clearTimeout(previous.timer);

    const epoch = this.sessionEpoch;
    const deadline = this.clock.now() + SUBAGENT_FAILURE_TERMINAL_MATCH_MS;
    let tombstone!: SubagentFailureTerminalTombstone;
    const timer = this.clock.setTimeout(() => {
      if (epoch !== this.sessionEpoch || this.subagentFailureTerminalTombstones.get(key) !== tombstone) return;
      this.reconcileExpiredSubagentFailurePairs();
    }, SUBAGENT_FAILURE_TERMINAL_MATCH_MS);
    tombstone = { deadline, timer };
    this.subagentFailureTerminalTombstones.set(key, tombstone);
    timer.unref?.();

    while (this.subagentFailureTerminalTombstones.size > MAX_SUBAGENT_FAILURE_TOMBSTONES) {
      const oldest = this.subagentFailureTerminalTombstones.entries().next().value;
      if (!oldest) break;
      const [oldestKey, oldestTombstone] = oldest;
      this.clock.clearTimeout(oldestTombstone.timer);
      this.subagentFailureTerminalTombstones.delete(oldestKey);
    }
  }

  /** Queue one accepted V2 subagent terminal ordinal without deriving it from state counters. */
  private queueSubagentTerminal(event: PresenceTerminalV2): void {
    this.reconcileExpiredSubagentFailurePairs();
    this.clearSubagentFailurePairsExcept(event.source, event.generation);
    if ((this.subagentBaseline && this.subagentBaseline.generation !== event.generation)
      || (this.subagentPending && this.subagentPending.generation !== event.generation)) {
      this.invalidateSubagentNotifications();
    }
    if (event.outcome === "failed") {
      // A state-first failure is already consumed by this terminal. Only a
      // terminal-first failure needs a tombstone to consume one later state.
      const consumedPendingFailure = this.cancelPendingSubagentFailureState(
        event.source,
        event.generation,
      );
      if (!consumedPendingFailure) {
        this.rememberSubagentFailureTerminal(event.source, event.generation);
      }
    }

    const terminal: AttentionKind | "cancelled" = event.outcome === "failed"
      ? "error"
      : event.outcome === "completed" ? "success" : "cancelled";
    this.reconcileElapsedSubagentAttention();
    const existing = this.subagentPending;
    const sameAggregate = existing?.generation === event.generation;
    const priorTerminal = sameAggregate ? existing.terminal : null;
    const pending: PendingSubagentAttention = sameAggregate
      ? {
        ...existing,
        // A new explicit edge reopens the fixed burst even if the preceding
        // closed burst was waiting for startup output.
        deferredDispatch: false,
        deferredTimeout: false,
        completedDelta: existing.completedDelta + (terminal === "success" ? 1 : 0),
        failedDelta: existing.failedDelta + (terminal === "error" ? 1 : 0),
        cancelledDelta: existing.cancelledDelta + (terminal === "cancelled" ? 1 : 0),
        terminal: terminal === "error"
          ? "error"
          : terminal === "success" && existing.terminal === "cancelled" ? "success" : existing.terminal,
      }
      : {
        sessionEpoch: this.sessionEpoch,
        generation: event.generation,
        completedDelta: terminal === "success" ? 1 : 0,
        failedDelta: terminal === "error" ? 1 : 0,
        cancelledDelta: terminal === "cancelled" ? 1 : 0,
        terminal,
        // Success gets a short next-parent grace; errors and cancellation
        // without an active parent remain independent.
        parentRun: this.active && terminal !== "cancelled"
          ? this.parentRunRevision
          : terminal === "success" ? this.parentRunRevision + 1 : 0,
        coalesceDeadline: null,
        errorDeadline: null,
        parentSettled: null,
      };
    this.subagentPending = pending;
    // A standalone cancellation still traverses the same bounded pending path,
    // then resolves immediately and quietly. It must not change the timing of
    // a later completed/failed edge.
    if (terminal === "cancelled" && !sameAggregate) {
      this.dispatchSubagentAttention(event.generation, {});
      return;
    }

    const now = this.clock.now();
    // Closed windows are deliberately not extended. The next terminal starts
    // its own fixed semantic window while its edge remains in this parent
    // aggregate for a single eventual settlement notification.
    const errorSupersedesSuccess = terminal === "error" && priorTerminal === "success";
    // An inactive success temporarily reserves the next parent run. If its
    // burst turns into an error before that parent exists, the error is
    // independent: a later start during its short window cannot add 10s wait.
    if (errorSupersedesSuccess
      && !this.active
      && pending.parentRun === this.parentRunRevision + 1
      && pending.parentSettled === null) {
      pending.parentRun = 0;
      pending.errorDeadline = null;
    }
    if (pending.coalesceDeadline === null || errorSupersedesSuccess) {
      pending.coalesceDeadline = fixedCoalescingDeadline(
        null,
        now,
        terminal === "error" ? 100 : 450,
      );
    }
    if (terminal === "error" && pending.parentRun !== 0 && pending.errorDeadline === null) {
      pending.errorDeadline = now + 10_000;
    }
    this.scheduleSubagentTimer(
      this.pendingSubagentWakeDelay(pending, now),
      pending.generation,
      pending.parentRun,
      () => this.finishSubagentCoalescing(pending.generation, pending.parentRun),
    );
  }

  private finishSubagentCoalescing(generation: number, parentRun: number): void {
    const pending = this.subagentPending;
    if (!pending || pending.generation !== generation || pending.parentRun !== parentRun) return;
    const now = this.clock.now();
    const remainingBurst = remainingErrorDeadlineMs(pending.coalesceDeadline ?? now, now);
    const errorDeadlineReached = pending.terminal === "error"
      && pending.parentRun !== 0
      && pending.errorDeadline !== null
      && remainingErrorDeadlineMs(pending.errorDeadline, now) === 0;
    // The first error's cap outranks a later semantic window. Only an exact,
    // still-active and unsettled parent can be called out as still processing.
    if (errorDeadlineReached) {
      if (this.active && parentRun === this.parentRunRevision && pending.parentSettled === null) {
        this.dispatchSubagentAttention(generation, { timeout: true });
      } else {
        this.dispatchSubagentAttention(generation, {
          parentSucceeded: pending.terminal === "success" && pending.parentSettled === "success",
        });
      }
      return;
    }
    if (remainingBurst > 0) {
      this.scheduleSubagentTimer(this.pendingSubagentWakeDelay(pending, now), generation, parentRun, () => {
        this.finishSubagentCoalescing(generation, parentRun);
      });
      return;
    }
    pending.coalesceDeadline = null;

    // Settlement inside a window is intentionally deferred until the fixed
    // window closes, so same-burst terminals cannot split native attention.
    if (pending.parentSettled !== null) {
      this.dispatchSubagentAttention(generation, {
        parentSucceeded: pending.terminal === "success" && pending.parentSettled === "success",
      });
      return;
    }
    // An unclaimed success grace, an independent error, or a superseded parent
    // cannot wait for a future run.
    if (parentRun === 0 || !this.active || parentRun !== this.parentRunRevision) {
      this.dispatchSubagentAttention(generation, { parentSucceeded: false });
      return;
    }
    if (pending.terminal === "success") {
      // Official hooks retain their prior log-only successful child behavior.
      if (this.officialHook) this.dispatchSubagentAttention(generation, { parentSucceeded: false });
      return;
    }

    const remainingErrorWait = remainingErrorDeadlineMs(pending.errorDeadline ?? now, now);
    if (remainingErrorWait === 0) {
      this.dispatchSubagentAttention(generation, { timeout: true });
      return;
    }
    this.scheduleSubagentTimer(remainingErrorWait, generation, parentRun, () => {
      const current = this.subagentPending;
      if (!current
        || current.terminal !== "error"
        || !this.active
        || current.parentRun !== this.parentRunRevision) return;
      this.dispatchSubagentAttention(generation, { timeout: true });
    });
  }

  /** A real parent settlement resolves only the aggregate bound to that run. */
  private flushSubagentForParentSettlement(attention: "info" | AttentionKind | "none"): boolean {
    const fenced = this.fencedParentRun === this.parentRunRevision;
    const pending = this.subagentPending;
    if (!pending || pending.parentRun !== this.parentRunRevision || pending.terminal === "cancelled") return fenced;
    pending.parentSettled = this.terminal;
    if (pending.terminal === "success" && this.terminal === "error") {
      // A successful child aggregate must never hide the parent's local error.
      this.clearSubagentTimer();
      this.subagentPending = null;
      return fenced;
    }
    const coalescing = pending.coalesceDeadline !== null
      && remainingErrorDeadlineMs(pending.coalesceDeadline, this.clock.now()) > 0;
    // A child aggregate owns this parent terminal while it is coalescing and
    // while closed output waits for startup. Retain the parent fallback in
    // both cases: a withdrawn or superseded child must not consume the parent
    // result merely because cmux was not ready when it settled.
    if (!fenced && attention !== "none" && (coalescing || !this.attentionOutputReady)) {
      this.suppressedParentAttention = {
        sessionEpoch: this.sessionEpoch,
        parentRun: pending.parentRun,
        attention,
        completed: this.completed,
        failed: this.failed,
      };
    }
    if (coalescing) return true;
    this.dispatchSubagentAttention(pending.generation, {
      parentSucceeded: pending.terminal === "success" && pending.parentSettled === "success",
    });
    return true;
  }

  private dispatchSubagentAttention(
    generation: number,
    options: { readonly parentSucceeded?: boolean; readonly timeout?: boolean },
  ): void {
    const pending = this.subagentPending;
    if (!pending || pending.generation !== generation) return;
    // A parent-bound aggregate cannot outlive the specific parent completion
    // that claimed it. Independent child output remains session-scoped only.
    if (pending.sessionEpoch !== this.sessionEpoch
      || (pending.parentSettled !== null
        && pending.parentRun !== 0
        && pending.parentRun !== this.parentRunRevision)) {
      this.clearSubagentTimer();
      this.subagentPending = null;
      return;
    }
    if (options.timeout && pending.parentRun !== 0) this.fencedParentRun = pending.parentRun;
    // A live terminal can beat asynchronous cmux initialization. Once its
    // bounded semantic window closes, retain this one aggregate until owned
    // output is ready; readiness itself is the only wake-up (no polling).
    if (!this.attentionOutputReady && pending.terminal !== "cancelled") {
      pending.deferredDispatch = true;
      // A later parent settlement may re-evaluate this closed aggregate, but
      // must not downgrade an already-reached hard cap. Only a new terminal
      // edge or lifecycle reset reopens this semantic state.
      pending.deferredTimeout = pending.deferredTimeout === true || options.timeout === true;
      return;
    }
    this.clearSubagentTimer();
    this.subagentPending = null;
    if (this.suppressedParentAttention?.parentRun === pending.parentRun) {
      this.suppressedParentAttention = null;
    }

    // A cancellation is an explicit, bounded edge but remains quiet under the
    // established notification policy.
    if (pending.terminal === "cancelled") return;

    const content = formatSubagentAttention(
      pending.terminal,
      pending.completedDelta,
      pending.failedDelta,
      options,
      this.config.maxLabelChars,
    );
    const attention: PresenceUpdate["attention"] = content.attention;
    // An official Pi hook suppresses only successful pi-subagent native alerts.
    const suppressedSuccess = this.officialHook && attention === "success";
    const notify = !this.config.suppressNativeNotifications && !suppressedSuccess && shouldNotifyAttention(
      this.config.notificationPolicy,
      this.config.notifications,
      attention,
      "external",
      options.parentSucceeded === true,
    );
    const flash = !this.config.suppressNativeFlash && !suppressedSuccess && shouldFlashAttention(
      this.config.flashPolicy,
      this.config.flash,
      this.config.notificationPolicy,
      attention,
      "external",
      options.parentSucceeded === true,
    );
    if (this.attentionOutputReady) {
      this.enqueueExternalAttention(
        PI_SUBAGENT_SOURCE_ID,
        attention === "error" ? "error" : "other",
        attention,
        content.title,
        content.body,
        notify,
        flash,
      );
    }
  }

  /** Flush a semantic terminal that closed while cmux initialization was pending. */
  private dispatchDeferredSubagentAttention(): void {
    const pending = this.subagentPending;
    if (!pending?.deferredDispatch) return;
    this.dispatchSubagentAttention(pending.generation, {
      parentSucceeded: pending.terminal === "success" && pending.parentSettled === "success",
      timeout: pending.deferredTimeout,
    });
  }

  private dispatchSuppressedParentAttention(parentRun: number): void {
    const fallback = this.suppressedParentAttention;
    if (!fallback || fallback.parentRun !== parentRun) return;
    // Keep the fallback through detached startup. Only the final owned-output
    // boundary may consume it, after all replacement and hook fences agree.
    if (!this.attentionOutputReady) return;
    this.suppressedParentAttention = null;
    if (fallback.sessionEpoch !== this.sessionEpoch
      || fallback.parentRun !== this.parentRunRevision
      || this.officialHook) return;
    // The fallback is fixed local wording and never copies the invalidating
    // producer event.
    const content = formatLocalTurnPresentation(
      fallback.attention === "error" ? "error" : "success",
      this.config.maxLabelChars,
    );
    const notify = !this.config.suppressNativeNotifications && shouldNotifyAttention(
      this.config.notificationPolicy,
      this.config.notifications,
      fallback.attention,
      "local",
    );
    const flash = !this.config.suppressNativeFlash && shouldFlashAttention(
      this.config.flashPolicy,
      this.config.flash,
      this.config.notificationPolicy,
      fallback.attention,
      "local",
    );
    this.emitAttention(fallback.attention, content.title, content.body, notify, flash);
  }

  /** Resolve elapsed boundaries synchronously before lifecycle ownership changes. */
  private reconcileElapsedSubagentAttention(): void {
    const pending = this.subagentPending;
    if (!pending) return;
    const now = this.clock.now();
    const windowElapsed = pending.coalesceDeadline !== null
      && remainingErrorDeadlineMs(pending.coalesceDeadline, now) === 0;
    const errorCapElapsed = pending.terminal === "error"
      && pending.errorDeadline !== null
      && remainingErrorDeadlineMs(pending.errorDeadline, now) === 0;
    if (!windowElapsed && !errorCapElapsed) return;
    this.finishSubagentCoalescing(pending.generation, pending.parentRun);
  }

  /** A pending active-parent error must wake for either its window or hard cap. */
  private pendingSubagentWakeDelay(pending: PendingSubagentAttention, now: number): number {
    const remainingBurst = remainingErrorDeadlineMs(pending.coalesceDeadline ?? now, now);
    if (pending.terminal !== "error" || pending.parentRun === 0 || pending.errorDeadline === null) {
      return remainingBurst;
    }
    return Math.min(remainingBurst, remainingErrorDeadlineMs(pending.errorDeadline, now));
  }

  private scheduleSubagentTimer(
    delayMs: number,
    generation: number,
    parentRun: number,
    callback: () => void,
  ): void {
    this.clearSubagentTimer();
    const timerEpoch = ++this.subagentTimerEpoch;
    const sessionEpoch = this.sessionEpoch;
    this.subagentTimer = this.clock.setTimeout(() => {
      // Timers are observer-only: every mutable identity is fenced before a
      // callback can route a notification after replacement or teardown.
      if (timerEpoch !== this.subagentTimerEpoch
        || sessionEpoch !== this.sessionEpoch
        || this.subagentPending?.generation !== generation
        || this.subagentPending?.parentRun !== parentRun) return;
      this.subagentTimer = undefined;
      callback();
    }, Math.max(0, delayMs));
    this.subagentTimer.unref?.();
  }

  private clearSubagentTimer(): void {
    if (this.subagentTimer) this.clock.clearTimeout(this.subagentTimer);
    this.subagentTimer = undefined;
    this.subagentTimerEpoch += 1;
  }

  private resetSubagentNotifications(): void {
    this.clearSubagentTimer();
    this.clearSubagentFailurePairs();
    this.subagentPending = null;
    this.subagentBaseline = null;
    this.suppressedParentAttention = null;
  }

  private resetExternalAttention(): void {
    if (this.externalAttentionTimer) this.clock.clearTimeout(this.externalAttentionTimer);
    this.externalAttentionTimer = undefined;
    this.pendingExternalAttention.clear();
    this.externalAttentionTokens = EXTERNAL_ATTENTION_BURST;
    this.externalAttentionRefillAt = this.clock.now();
    this.attentionOutputReady = false;
  }

  private emitAttention(
    level: "info" | AttentionKind,
    title: string,
    body: string,
    notify: boolean,
    flash: boolean,
  ): void {
    void this.client?.log(level, body);
    if (notify) void this.client?.notify(title, body);
    if (flash) void this.client?.flash();
  }

  /** Emit a retained terminal only for its original run after delayed owned output is ready. */
  private dispatchPendingLocalTerminalAttention(): void {
    const pending = this.pendingLocalTerminalAttention;
    if (!pending || !this.attentionOutputReady) return;
    this.pendingLocalTerminalAttention = null;
    // Revalidate at the final dispatch boundary: a detached startup can finish
    // after another run starts, and an official hook detected during setup owns
    // local completion attention even when the terminal arrived before it did.
    if (pending.sessionEpoch !== this.sessionEpoch
      || pending.parentRunRevision !== this.parentRunRevision
      || this.officialHook) return;
    this.emitAttention(
      pending.attention,
      pending.title,
      pending.body,
      pending.notify,
      pending.flash,
    );
  }

  private enqueueExternalAttention(
    sourceId: string,
    category: "input" | "error" | "other",
    level: "info" | AttentionKind,
    title: string,
    body: string,
    notify: boolean,
    flash: boolean,
  ): void {
    if (!this.attentionOutputReady || (!this.config.log && !notify && !flash)) return;
    this.refillExternalAttentionTokens();
    const priority = category === "error" ? 3 : category === "input" ? 2 : 1;
    const key = `${sourceId}\u0000${category}`;
    const next = { key, priority, level, title, body, notify, flash };
    if (this.externalAttentionTokens > 0) {
      this.externalAttentionTokens -= 1;
      this.emitAttention(level, title, body, notify, flash);
      return;
    }

    if (!this.pendingExternalAttention.has(key)
      && this.pendingExternalAttention.size >= MAX_PENDING_EXTERNAL_ATTENTION) {
      let lowest: ExternalAttention | null = null;
      for (const candidate of this.pendingExternalAttention.values()) {
        if (!lowest || candidate.priority < lowest.priority) lowest = candidate;
      }
      if (!lowest || lowest.priority >= priority) return;
      this.pendingExternalAttention.delete(lowest.key);
    }
    this.pendingExternalAttention.set(key, next);
    this.scheduleExternalAttentionFlush();
  }

  private discardPendingExternalAttention(sourceId: string): void {
    const prefix = `${sourceId}\u0000`;
    for (const key of this.pendingExternalAttention.keys()) {
      if (key.startsWith(prefix)) this.pendingExternalAttention.delete(key);
    }
  }

  private discardPendingExternalInputAttention(sourceId: string): void {
    this.pendingExternalAttention.delete(`${sourceId}\u0000input`);
  }

  private refillExternalAttentionTokens(): void {
    const now = this.clock.now();
    const elapsed = now - this.externalAttentionRefillAt;
    if (elapsed < EXTERNAL_ATTENTION_INTERVAL_MS) return;
    const replenished = Math.floor(elapsed / EXTERNAL_ATTENTION_INTERVAL_MS);
    this.externalAttentionTokens = Math.min(EXTERNAL_ATTENTION_BURST, this.externalAttentionTokens + replenished);
    this.externalAttentionRefillAt += replenished * EXTERNAL_ATTENTION_INTERVAL_MS;
  }

  private scheduleExternalAttentionFlush(): void {
    if (this.externalAttentionTimer || this.pendingExternalAttention.size === 0) return;
    const delay = Math.max(0, EXTERNAL_ATTENTION_INTERVAL_MS - (this.clock.now() - this.externalAttentionRefillAt));
    const epoch = this.sessionEpoch;
    this.externalAttentionTimer = this.clock.setTimeout(() => {
      this.externalAttentionTimer = undefined;
      if (epoch !== this.sessionEpoch || !this.attentionOutputReady) return;
      this.flushExternalAttention();
    }, delay);
    this.externalAttentionTimer.unref?.();
  }

  private flushExternalAttention(): void {
    this.refillExternalAttentionTokens();
    while (this.externalAttentionTokens > 0 && this.pendingExternalAttention.size > 0) {
      const next = this.selectPendingExternalAttention(true);
      if (!next) break;
      this.externalAttentionTokens -= 1;
      this.emitAttention(next.level, next.title, next.body, next.notify, next.flash);
    }
    this.scheduleExternalAttentionFlush();
  }

  /** Select highest priority, retaining insertion order for equally urgent entries. */
  private selectPendingExternalAttention(remove: boolean): ExternalAttention | null {
    let selected: ExternalAttention | null = null;
    for (const candidate of this.pendingExternalAttention.values()) {
      if (!selected || candidate.priority > selected.priority) selected = candidate;
    }
    if (selected && remove) this.pendingExternalAttention.delete(selected.key);
    return selected;
  }

  /** Decide whether this event starts a new bounded generic attention lifecycle. */
  private shouldDispatchGenericAttention(
    event: PresenceUpdate,
    attention: "info" | AttentionKind,
    interactionWaiting: boolean,
  ): boolean {
    const current: GenericAttentionSemantic = {
      generation: event.generation,
      state: event.state,
      attention,
      completed: event.counts.completed,
      failed: event.counts.failed,
      cancelled: event.counts.cancelled ?? 0,
      interactionWaiting,
    };
    const previous = this.genericAttentionBySource.get(event.source.id);
    this.genericAttentionBySource.set(event.source.id, current);
    if (!previous
      || previous.generation !== current.generation
      || previous.state !== current.state
      || previous.attention !== current.attention
      || previous.interactionWaiting !== current.interactionWaiting) return true;
    // An input wait repeats only after leaving the waiting lifecycle. Generic
    // terminal counts permit a new completed/failed outcome without letting
    // progress, labels, or active/queued churn create an alert storm.
    if (interactionWaiting) return false;
    return current.completed < previous.completed
      || current.failed < previous.failed
      || current.cancelled < previous.cancelled
      || (attention === "error" && current.failed > previous.failed)
      || (attention !== "error" && current.completed > previous.completed);
  }

  /** A pi-subagent removal invalidates its cumulative baseline and pending burst. */
  private invalidateSubagentNotifications(): void {
    const invalidated = this.subagentPending;
    this.clearSubagentTimer();
    this.clearSubagentFailurePairs();
    this.subagentPending = null;
    this.subagentBaseline = null;
    // A deferred local terminal must not be lost when the child producer
    // retracts the aggregate that had temporarily claimed it.
    if (invalidated && invalidated.parentSettled !== null) {
      this.dispatchSuppressedParentAttention(invalidated.parentRun);
    }
  }

  /**
   * A remove is already accepted in the event registry before this observer
   * write. Track only an actual clear issued through the captured current
   * client. The token prevents an older acknowledgement from erasing a newer
   * failed remove for the same status key.
   */
  private clearRemovedStatus(key: string): void {
    const client = this.client;
    if (!client || !this.config.sidebar) return;

    const intents = this.pendingStatusClears;
    const token = {};
    const outcome = client.clearStatus(key).catch(() => false);
    intents.set(key, { token, client, outcome });
    void outcome.then((acknowledged) => {
      if (acknowledged && intents.get(key)?.token === token) intents.delete(key);
    });
  }

  private renderProgress(): void {
    const next = selectProgress(this.registry.snapshot());
    if (!next) {
      if (this.shownProgress) void this.client?.clearProgress();
      this.shownProgress = false;
      return;
    }

    const interactionPresentation = isInteractionWaiting(next)
      ? formatInteractionWaitingPresentation(this.config.maxLabelChars)
      : null;
    void this.client?.progress(
      next.progress!.value,
      interactionPresentation?.progress ?? formatProgressText(next, this.config.maxLabelChars),
    );
    this.shownProgress = true;
  }

  /** Keep one final ordinal available for a withdrawal before any handle rotation. */
  private ensureLocalOrdinals(requiredSequences: number, requiresEventId = false): void {
    if (this.localSequence + requiredSequences <= LAST_STATE_SEQUENCE
      && (!requiresEventId || this.localEventId < MAX_INTEGER)) return;
    this.rotateLocalProducers();
  }

  /** Withdraw before releasing source ownership, then replay retained local state under fresh bounds. */
  private rotateLocalProducers(): void {
    try {
      if (this.piProducer && this.localSequence < MAX_INTEGER) {
        this.piProducer.withdraw({ version: 2, generation: this.generation, sequence: MAX_INTEGER, source: "pi" });
      }
      if (this.todoProducer && this.localSequence < MAX_INTEGER) {
        this.todoProducer.withdraw({ version: 2, generation: this.generation, sequence: MAX_INTEGER, source: "todo" });
      }
    } catch {
      // An unavailable candidate owner still gets a clean replacement attempt.
    }
    try { this.piProducer?.deactivate(); } catch { /* best effort */ }
    try { this.todoProducer?.deactivate(); } catch { /* best effort */ }
    this.piProducer = undefined;
    this.todoProducer = undefined;
    this.generation = this.generation >= MAX_INTEGER ? 0 : this.generation + 1;
    this.localSequence = 0;
    this.localEventId = 0;
    this.activateLocalProducers();
    this.republishLocalPresentation();
  }

  /** Re-establish only current local snapshots; terminal edges are never replayed. */
  private republishLocalPresentation(): void {
    for (const source of ["pi", "todo"] as const) {
      const prior = this.localPresentation.get(source);
      const producer = source === "pi" ? this.piProducer : this.todoProducer;
      if (!prior || !producer || this.localSequence >= LAST_STATE_SEQUENCE) continue;
      const sequence = ++this.localSequence;
      const next = { ...prior, generation: this.generation, sequence, attention: "none" as const };
      this.localPresentation.set(source, next);
      try {
        producer.publishState({
          version: 2, generation: this.generation, sequence, source, state: next.state,
          ...(source === "todo" && next.progress ? { progress: { completed: next.counts.completed, total: next.counts.total ?? 1 } } : {}),
        });
      } catch { /* optional source re-establishment */ }
    }
  }

  private publish(
    state: PresenceUpdate["state"],
    _attention: PresenceUpdate["attention"] = "none",
  ): void {
    if (!this.sessionId) return;
    const terminal = state === "success" || state === "error" || state === "cancelled";
    this.ensureLocalOrdinals(terminal ? 2 : 1, terminal);
    this.activateLocalProducers();
    const snapshot = this.usage.snapshot();
    const sequence = ++this.localSequence;
    const overlay: PresenceUpdate = {
      generation: this.generation,
      sequence,
      source: { ...LOCAL_SOURCE },
      state,
      counts: { active: this.active ? 1 : 0, completed: this.completed, failed: this.failed },
      ...(snapshot ? { usage: snapshot } : {}),
      // Local state is quiet; the following terminal is the sole semantic edge.
      attention: "none",
    };
    this.localPresentation.set("pi", overlay);
    try {
      this.piProducer?.publishState({ version: 2, generation: this.generation, sequence, source: "pi", state });
      if (terminal) {
        this.piProducer?.publishTerminal({
          version: 2,
          generation: this.generation,
          sequence: ++this.localSequence,
          source: "pi",
          eventId: ++this.localEventId,
          outcome: state === "success" ? "completed" : state === "error" ? "failed" : "cancelled",
        });
      }
    } catch {
      // The local producer is observer-only and fails closed on source ownership loss.
    }
  }

  private publishTodo(event: PresenceUpdate): void {
    this.ensureLocalOrdinals(1);
    this.activateLocalProducers();
    const sequence = ++this.localSequence;
    const overlay = { ...event, generation: this.generation, sequence };
    this.localPresentation.set("todo", overlay);
    try {
      this.todoProducer?.publishState({
        version: 2,
        generation: this.generation,
        sequence,
        source: "todo",
        state: event.state,
        ...(event.progress ? { progress: { completed: event.counts.completed, total: event.counts.total ?? 1 } } : {}),
      });
    } catch {
      // Todo observer output is optional.
    }
  }

  private activateConsumer(): void {
    if (this.consumer) return;
    try {
      const consumer = createPresenceConsumer({ id: "pi-cmux-presence" });
      if (!consumer) return;
      // Retained replay is synchronous during activation, so publish the handle
      // before emitting ready/replay; every bus listener then reaches accept.
      this.consumer = consumer;
      if (!consumer.activate((name, payload) => this.emitPresence(name, payload))) {
        this.consumer = undefined;
      }
    } catch {
      // An occupied consumer ID leaves cmux-only output inactive rather than creating a second authority.
    }
  }

  /** Only lifecycle hooks retry first-owner local sources; there is no polling or fallback wire. */
  private activateLocalProducers(): void {
    if (!this.sessionId) return;
    if (!this.piProducer) this.piProducer = this.createLocalProducer("pi");
    if (!this.todoProducer) this.todoProducer = this.createLocalProducer("todo");
  }

  private createLocalProducer(source: "pi" | "todo"): PresenceProducerHandle | undefined {
    try {
      const producer = createPresenceProducer({ source, emit: (name: string, payload: unknown) => this.emitPresence(name, payload) });
      return producer?.activate() ? producer : undefined;
    } catch { return undefined; }
  }

  private emitPresence(name: string, payload: unknown): void {
    try { this.pi.events.emit(name, payload); } catch { /* optional process-local fanout */ }
  }

  /** Reserve the final bounded sequence to fence local retained state before ownership ends. */
  private withdrawLocalSources(): void {
    if (this.localSequence >= MAX_INTEGER) return;
    try {
      this.piProducer?.withdraw({
        version: 2,
        generation: this.generation,
        sequence: MAX_INTEGER,
        source: "pi",
      });
    } catch { /* best effort */ }
    try {
      this.todoProducer?.withdraw({
        version: 2,
        generation: this.generation,
        sequence: MAX_INTEGER,
        source: "todo",
      });
    } catch { /* best effort */ }
  }

  private deactivatePresence(): void {
    // Deactivation alone clears registry retention, but does not tell already
    // active consumers to clear their source-local presentation. Withdraw both
    // local sources while their handles still own the bounded final sequence.
    this.withdrawLocalSources();
    try { this.piProducer?.deactivate(); } catch { /* best effort */ }
    try { this.todoProducer?.deactivate(); } catch { /* best effort */ }
    try { this.consumer?.deactivate(); } catch { /* best effort */ }
    this.piProducer = undefined;
    this.todoProducer = undefined;
    this.consumer = undefined;
    this.localPresentation.clear();
  }

  private feedToolEvent(
    hookEvent: "PreToolUse" | "PostToolUse",
    event: ToolFeedEvent,
  ): void {
    if (!this.sessionId) return;
    this.queueFeedEdge(hookEvent, this.sessionId, event);
  }

  /** Queue only the allowlisted, bounded feed fields; no hook payload is retained. */
  private queueFeedEdge(event: FeedHookEvent, sessionId: string, tool?: ToolFeedEvent): void {
    if (!this.config.feed || this.officialHook || this.feedQueueOverflowed) return;
    const isToolEvent = event === "PreToolUse" || event === "PostToolUse";
    let safeTool: { callId: string; name: string } | undefined;
    if (isToolEvent) {
      const callId = tool?.toolCallId;
      const name = tool?.toolName;
      const validToolName = typeof name === "string"
        && name.length > 0
        && Buffer.byteLength(name, "utf8") <= MAX_FEED_TOOL_NAME_BYTES
        && !hasControlOrBidi(name);
      // A malformed identifier must not turn a tool lifecycle edge into an
      // anonymous feed event. Tool edges require both bounded identifiers.
      if (!isProtocolToken(callId) || !validToolName) return;
      safeTool = { callId, name };
    }
    const edge: QueuedFeedEdge = {
      sessionEpoch: this.sessionEpoch,
      sessionId,
      event,
      ...(safeTool ? { tool: safeTool } : {}),
    };

    if (this.attentionOutputReady) {
      // Once owned output is ready, do not create a second local queue. The
      // client's bounded socket queue is the sole backpressure policy.
      const client = this.client;
      if (client) this.submitFeedEdge(client, edge);
      return;
    }

    if (this.pendingFeedEdges.length >= MAX_PENDING_FEED_EDGES) {
      // Do not send a suffix whose preceding lifecycle edge was dropped.
      this.pendingFeedEdges = [];
      this.feedQueueOverflowed = true;
      return;
    }
    this.pendingFeedEdges.push(edge);
  }

  /**
   * Submit the detached-startup snapshot in one JavaScript turn. This transfers
   * its ordering to the client's bounded queue before a newly received edge can
   * choose the ready-state direct path.
   */
  private dispatchPendingFeedEdges(): void {
    if (this.pendingFeedEdges.length === 0
      || !this.attentionOutputReady
      || this.officialHook
      || this.feedQueueOverflowed) return;
    const client = this.client;
    if (!client) return;

    const edges = this.pendingFeedEdges;
    this.pendingFeedEdges = [];
    if (edges.some((edge) => edge.sessionEpoch !== this.sessionEpoch || edge.sessionId !== this.sessionId)) {
      return;
    }
    for (const edge of edges) this.submitFeedEdge(client, edge);
  }

  /** Feed is best-effort; the client owns ready-state bounded-queue failures. */
  private submitFeedEdge(client: PresenceClient, edge: QueuedFeedEdge): void {
    void client.feed(edge.event, edge.sessionId, edge.tool).catch(() => {});
  }

  private discardPendingFeedEdges(): void {
    this.pendingFeedEdges = [];
  }

  private resetPendingFeedEdges(): void {
    this.pendingFeedEdges = [];
    this.feedQueueOverflowed = false;
  }

  private updateContextUsage(): void {
    try {
      this.usage.setContext(this.contextProvider?.getContextUsage?.());
    } catch {
      // Context usage is optional observer data.
    }
  }

  private metadata(): string {
    return aggregateMetadata(this.registry.snapshot());
  }

  private statusKey(sourceId: string): string {
    return presenceStatusKey(sourceId, this.statusScope);
  }

  private scheduleFinalClear(epoch: number): void {
    this.cancelFinalClear();
    this.clearTimer = this.clock.setTimeout(() => {
      if (epoch !== this.sessionEpoch || this.active) return;
      if (this.client && this.attentionOutputReady) {
        void this.client.clearStatus(this.statusKey(LOCAL_SOURCE.id));
      } else {
        this.deferredFinalClear = true;
      }
    }, this.config.finalClearMs);
    this.clearTimer.unref?.();
  }

  /** Preserve a terminal's original expiry when cmux setup was delayed. */
  private dispatchDeferredFinalClear(): void {
    if (!this.deferredFinalClear || this.active || !this.client || !this.attentionOutputReady) return;
    this.deferredFinalClear = false;
    void this.client.clearStatus(this.statusKey(LOCAL_SOURCE.id));
  }

  private cancelFinalClear(): void {
    if (this.clearTimer) this.clock.clearTimeout(this.clearTimer);
    this.clearTimer = undefined;
    this.deferredFinalClear = false;
  }

  private cleanupDetachedSession(detached: DetachedSession): Promise<void> {
    const client = detached.client;
    const detachedSessionId = detached.sessionId;
    if (!client) return this.clientCloseBarrier;

    const cleanup = this.clientCloseBarrier.then(async () => {
      const budgetMs = Math.min(5_000, Math.max(750, this.config.timeoutMs * 4));
      const deadline = performance.now() + budgetMs;
      let expired = false;
      const abort = () => {
        expired = true;
        // Closing first makes all later cleanup calls no-ops and aborts active socket work.
        void client.close(0).catch(() => {});
      };
      const timer = setTimeout(abort, budgetMs);
      try {
        const bestEffort = async (operation: () => Promise<unknown>) => {
          if (expired) return;
          await operation().catch(() => {});
        };

        // Resolve pending removal clears first: a hung progress teardown must
        // not consume the aggregate cleanup budget before their one retry.
        // A retained source reactivated after a failed remove shares its exact
        // key with that retry, so consume the key here rather than issuing a
        // duplicate retained-event clear below.
        const retainedStatusKeys = new Set(
          detached.retainedEvents.map((event) => presenceStatusKey(event.source.id, detached.statusScope)),
        );
        for (const [key, attempt] of detached.pendingStatusClears) {
          let acknowledged = false;
          if (!expired) {
            try {
              acknowledged = await attempt.outcome;
            } catch {
              // A failed observer write gets one teardown retry below.
            }
          }
          const clearsRetainedStatus = retainedStatusKeys.delete(key);
          if (!acknowledged || clearsRetainedStatus) {
            await bestEffort(() => attempt.client.clearStatus(key));
          }
        }

        await bestEffort(() => client.clearProgress());
        for (const key of retainedStatusKeys) {
          await bestEffort(() => client.clearStatus(key));
        }

        if (!detached.officialHook) {
          if (this.config.nativeLifecycle) {
            await bestEffort(() => client.lifecycle("idle"));
            await bestEffort(() => client.clearPiPid());
          }
          if (this.config.metaBlock) await bestEffort(() => client.clearMeta());
          if (this.config.resumeFallback && detachedSessionId) {
            await bestEffort(() => client.clearOwnedResumeFallback(detachedSessionId));
          }
        }
      } finally {
        clearTimeout(timer);
        const remainingMs = Math.max(0, deadline - performance.now());
        await client.close(expired ? 0 : remainingMs).catch(() => {});
      }
    }).catch(() => {
      // Session teardown is best-effort and still releases the transition barrier.
    });

    this.clientCloseBarrier = cleanup;
    return cleanup;
  }
}
