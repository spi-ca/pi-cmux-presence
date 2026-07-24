import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PresenceClient } from "./client.js";
import type { PresenceConfig } from "./config.js";
import {
  PI_PRESENCE_READY_EVENT,
  PI_PRESENCE_UPDATE_EVENT,
  parsePresenceReady,
  parsePresenceSessionId,
  parsePresenceUpdate,
  PresenceEventRegistry,
  type PresenceUpdate,
} from "./events.js";
import { readCmuxIdentity, resolveCmuxSocketPath } from "./identity.js";
import { officialHookDetected } from "./official-hook.js";
import {
  aggregateMetadata,
  attentionLevel,
  deriveTerminalState,
  formatAttentionTitle,
  formatAutoTitle,
  formatProgressText,
  formatStateText,
  PRESENCE_STATE_STYLES,
  presenceStatusKey,
  selectProgress,
} from "./presentation.js";
import { TodoProgressAdapter } from "./todo.js";
import { UnixSocketTransport } from "./transport.js";
import { UsageTracker } from "./usage.js";

const LOCAL_SOURCE = { id: "pi", label: "Pi", kind: "agent" };
const TODO_SOURCE = "pi-todo";

type ContextProvider = { getContextUsage?: () => unknown };
type TerminalState = "success" | "error" | "cancelled";
type ToolFeedEvent = { toolCallId?: unknown; toolName?: unknown };
type DetachedSession = {
  client: PresenceClient | null;
  sessionId: string | null;
  officialHook: boolean;
  statusScope: string | undefined;
  retainedEvents: PresenceUpdate[];
};

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
    return parsePresenceSessionId(getSessionId.call(sessionManager));
  } catch {
    return null;
  }
}

/** Owns presence session state and best-effort side effects; hook wiring lives in hooks.ts. */
export class PresenceRuntime {
  private readonly registry = new PresenceEventRegistry();
  private readonly todo = new TodoProgressAdapter();
  private client: PresenceClient | null = null;
  private clientCloseBarrier: Promise<void> = Promise.resolve();
  private contextProvider: ContextProvider | null = null;
  private sessionId: string | null = null;
  private sessionEpoch = 0;
  private generation = 0;
  private localSequence = 0;
  private active = false;
  private completed = 0;
  private failed = 0;
  private usage = new UsageTracker();
  private terminal: TerminalState = "success";
  private hadToolError = false;
  private shownProgress: string | null = null;
  private clearTimer: ReturnType<typeof setTimeout> | undefined;
  private officialHook = false;
  private statusScope: string | undefined;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly config: PresenceConfig,
  ) {}

  handlePresenceUpdate(payload: unknown): void {
    try {
      const event = parsePresenceUpdate(payload);
      if (!event
        || event.source.id === LOCAL_SOURCE.id
        || event.source.id === TODO_SOURCE
        || !this.registry.acceptParsed(event)) {
        return;
      }
      this.apply(event);
    } catch {
      // Untrusted event-bus input is always best-effort.
    }
  }

  handleReady(payload: unknown): void {
    try {
      const ready = parsePresenceReady(payload);
      if (!ready || ready.sessionId !== this.sessionId) return;

      const retainedLocalEvents = this.registry.snapshot().filter(
        (event) => event.source.id === LOCAL_SOURCE.id || event.source.id === TODO_SOURCE,
      );
      for (const retained of retainedLocalEvents) {
        const replay: PresenceUpdate = {
          ...retained,
          generation: this.generation,
          sequence: ++this.localSequence,
          attention: "none",
        };
        if (!this.registry.acceptParsed(replay)) continue;
        this.apply(replay);
        this.emitUpdate(replay);
      }
    } catch {
      // Ready replay must never affect Pi work.
    }
  }

  async startSession(context: unknown): Promise<void> {
    const epoch = ++this.sessionEpoch;
    this.cancelFinalClear();

    const previousSession = this.detachCurrentSession();
    this.generation += 1;

    const nextSessionId = sessionIdFromContext(context);
    await this.cleanupDetachedSession(previousSession);
    if (epoch !== this.sessionEpoch || nextSessionId === null) return;

    this.beginSession(nextSessionId, context);
    this.officialHook = await officialHookDetected();
    if (!this.isCurrent(epoch, nextSessionId)) return;

    const identity = readCmuxIdentity();
    this.statusScope = identity?.surfaceId;
    const socketPath = identity ? await resolveCmuxSocketPath() : null;
    if (!this.isCurrent(epoch, nextSessionId)) return;

    if (identity && socketPath) {
      const created = new PresenceClient(
        identity,
        new UnixSocketTransport(socketPath, this.config.timeoutMs, this.config.maxQueue),
        this.config,
      );
      await created.initialize();
      if (!this.isCurrent(epoch, nextSessionId)) {
        await created.close();
        return;
      }
      this.client = created;
      await created.initializeOwnedProgress();
      if (!this.isCurrent(epoch, nextSessionId)) return;
    }

    await this.initializeOptionalIntegrations(nextSessionId);
    if (!this.isCurrent(epoch, nextSessionId)) return;

    this.emitReady(nextSessionId);
    this.publish("idle");
    if (!this.officialHook) {
      void this.client?.feed("SessionStart", nextSessionId);
      if (this.config.metaBlock) void this.client?.meta(this.metadata());
    }
  }

  handleAgentStart(): void {
    if (!this.sessionId) return;
    this.cancelFinalClear();
    if (!this.active) {
      this.active = true;
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
    if (this.sessionId && this.active) this.updateContextUsage();
  }

  handleMessageEnd(event: unknown): void {
    if (!this.sessionId || typeof event !== "object" || event === null) return;
    const message = (event as { message?: unknown }).message;
    if (typeof message !== "object" || message === null) return;
    const assistant = message as { role?: unknown; usage?: unknown };
    if (assistant.role !== "assistant") return;
    this.usage.add(assistant.usage);
    this.updateContextUsage();
  }

  handleAgentEnd(event: unknown): void {
    if (!this.sessionId || typeof event !== "object" || event === null) return;
    const messages = (event as { messages?: unknown }).messages;
    this.terminal = deriveTerminalState(Array.isArray(messages) ? messages : [], this.hadToolError);
  }

  handleBeforeAgentStart(): void {
    if (!this.officialHook && this.sessionId) {
      void this.client?.feed("UserPromptSubmit", this.sessionId);
    }
  }

  handleToolExecutionStart(event: ToolFeedEvent): void {
    this.feedToolEvent("PreToolUse", event);
  }

  handleToolExecutionEnd(event: ToolFeedEvent): void {
    this.feedToolEvent("PostToolUse", event);
  }

  handleToolResult(event: unknown): void {
    if (!this.sessionId) return;
    if (typeof event === "object" && event !== null && (event as { isError?: unknown }).isError === true && this.active) {
      this.hadToolError = true;
    }

    let todoEvent: PresenceUpdate | null = null;
    try {
      todoEvent = this.todo.accept(
        event,
        this.pi.getAllTools(),
        this.sessionId,
        this.generation,
        ++this.localSequence,
      );
    } catch {
      // Tool provenance and result parsing are best-effort.
    }
    if (!todoEvent || !this.registry.acceptParsed(todoEvent)) return;

    this.apply(todoEvent);
    this.emitUpdate(todoEvent);
  }

  handleAgentSettled(context: unknown): void {
    if (!this.sessionId || !this.active) return;
    try {
      if (typeof context === "object" && context !== null) {
        const isIdle = (context as { isIdle?: unknown }).isIdle;
        if (typeof isIdle === "function" && !isIdle.call(context)) return;
      }
    } catch {
      return;
    }

    this.active = false;
    this.updateContextUsage();
    if (this.terminal === "error") this.failed += 1;
    else if (this.terminal === "success") this.completed += 1;

    const attention = this.terminal === "error"
      ? "error"
      : this.terminal === "success"
        ? "success"
        : "info";
    this.publish(this.terminal, attention);
    this.scheduleFinalClear(this.sessionEpoch);

    if (!this.officialHook) {
      if (this.config.nativeLifecycle) void this.client?.lifecycle("idle");
      void this.client?.feed("Stop", this.sessionId);
      if (this.config.metaBlock) void this.client?.meta(this.metadata());
    }
  }

  handleSessionInfoChanged(event: unknown): void {
    if (!this.sessionId || this.officialHook || !this.config.autoTitle) return;
    if (typeof event !== "object" || event === null) return;
    const name = (event as { name?: unknown }).name;
    if (typeof name !== "string" || !name.trim()) return;
    void this.client?.autoTitle(formatAutoTitle(name, Math.min(80, this.config.maxLabelChars)));
  }

  async shutdownSession(): Promise<void> {
    ++this.sessionEpoch;
    this.cancelFinalClear();

    const closingSession = this.detachCurrentSession();
    await this.cleanupDetachedSession(closingSession);
  }

  private beginSession(sessionId: string, context: unknown): void {
    this.sessionId = sessionId;
    this.registry.start(sessionId);
    this.contextProvider = typeof context === "object" && context !== null
      ? context as ContextProvider
      : null;
    this.localSequence = 0;
    this.active = false;
    this.completed = 0;
    this.failed = 0;
    this.usage = new UsageTracker();
    this.terminal = "success";
    this.hadToolError = false;
    this.shownProgress = null;
    this.officialHook = false;
    this.statusScope = undefined;
  }

  private detachCurrentSession(): DetachedSession {
    const detached = {
      client: this.client,
      sessionId: this.sessionId,
      officialHook: this.officialHook,
      statusScope: this.statusScope,
      retainedEvents: this.registry.snapshot(),
    };
    this.client = null;
    this.disableCurrentSession();
    return detached;
  }

  private disableCurrentSession(): void {
    this.registry.stop();
    this.contextProvider = null;
    this.sessionId = null;
    this.localSequence = 0;
    this.active = false;
    this.completed = 0;
    this.failed = 0;
    this.usage = new UsageTracker();
    this.terminal = "success";
    this.hadToolError = false;
    this.shownProgress = null;
    this.officialHook = false;
    this.statusScope = undefined;
  }

  private isCurrent(epoch: number, sessionId: string): boolean {
    return epoch === this.sessionEpoch && sessionId === this.sessionId;
  }

  private async initializeOptionalIntegrations(sessionId: string): Promise<void> {
    if (!this.officialHook && this.config.nativeLifecycle) {
      void this.client?.setPiPid();
      void this.client?.lifecycle("idle");
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

  private apply(event: PresenceUpdate): void {
    const label = formatStateText(event, this.config.maxLabelChars);
    void this.client?.status(
      this.statusKey(event.source.id),
      label,
      PRESENCE_STATE_STYLES[event.state],
    );
    this.renderProgress();

    const level = attentionLevel(event.attention);
    // Official hooks already own local completion attention. Other producers remain useful.
    if (level && !(this.officialHook && event.source.id === LOCAL_SOURCE.id)) {
      void this.client?.log(level, label);
      void this.client?.notify(
        formatAttentionTitle(event, this.config.maxLabelChars),
        label,
      );
      void this.client?.flash();
    }
    if (!this.officialHook && this.config.metaBlock) {
      void this.client?.meta(this.metadata());
    }
  }

  private renderProgress(): void {
    const next = selectProgress(this.registry.snapshot());
    if (!next) {
      if (this.shownProgress !== null) void this.client?.clearProgress();
      this.shownProgress = null;
      return;
    }

    void this.client?.progress(
      next.progress!.value,
      formatProgressText(next, this.config.maxLabelChars),
    );
    this.shownProgress = next.source.id;
  }

  private publish(
    state: PresenceUpdate["state"],
    attention: PresenceUpdate["attention"] = "none",
  ): void {
    if (!this.sessionId) return;
    const snapshot = this.usage.snapshot();
    const event: PresenceUpdate = {
      version: 1,
      sessionId: this.sessionId,
      generation: this.generation,
      sequence: ++this.localSequence,
      source: { ...LOCAL_SOURCE },
      state,
      counts: { active: this.active ? 1 : 0, completed: this.completed, failed: this.failed },
      ...(snapshot ? { usage: snapshot } : {}),
      attention,
    };
    if (!this.registry.acceptParsed(event)) return;
    this.apply(event);
    this.emitUpdate(event);
  }

  private emitUpdate(event: PresenceUpdate): void {
    try {
      this.pi.events.emit(PI_PRESENCE_UPDATE_EVENT, event);
    } catch {
      // Process-local observers are optional.
    }
  }

  private emitReady(sessionId: string): void {
    try {
      this.pi.events.emit(PI_PRESENCE_READY_EVENT, {
        version: 1,
        sessionId,
        consumer: {
          id: "pi-cmux-presence",
          capabilities: ["cmux-status", "cmux-progress", "cmux-attention"],
        },
      });
    } catch {
      // Process-local producers are optional.
    }
  }

  private feedToolEvent(
    hookEvent: "PreToolUse" | "PostToolUse",
    event: ToolFeedEvent,
  ): void {
    if (this.officialHook || !this.sessionId) return;
    void this.client?.feed(hookEvent, this.sessionId, {
      callId: typeof event?.toolCallId === "string" ? event.toolCallId : undefined,
      name: typeof event?.toolName === "string" ? event.toolName : undefined,
    });
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
    this.clearTimer = setTimeout(() => {
      if (epoch === this.sessionEpoch && !this.active) {
        void this.client?.clearStatus(this.statusKey(LOCAL_SOURCE.id));
      }
    }, this.config.finalClearMs);
    this.clearTimer.unref?.();
  }

  private cancelFinalClear(): void {
    if (this.clearTimer) clearTimeout(this.clearTimer);
    this.clearTimer = undefined;
  }

  private cleanupDetachedSession(detached: DetachedSession): Promise<void> {
    const client = detached.client;
    if (!client) return this.clientCloseBarrier;

    const cleanup = this.clientCloseBarrier.then(async () => {
      await client.clearProgress();
      for (const event of detached.retainedEvents) {
        const key = presenceStatusKey(event.source.id, detached.statusScope);
        void client.clearStatus(key);
      }

      if (!detached.officialHook) {
        if (this.config.nativeLifecycle) {
          void client.lifecycle("idle");
          void client.clearPiPid();
        }
        if (this.config.metaBlock) void client.clearMeta();
        if (this.config.resumeFallback && detached.sessionId) {
          await client.clearOwnedResumeFallback(detached.sessionId);
        }
      }
      await client.close();
    }).catch(() => {
      // Session teardown is best-effort and still releases the transition barrier.
    });

    this.clientCloseBarrier = cleanup;
    return cleanup;
  }
}
