import { createHash } from "node:crypto";
import type { PresenceUpdate } from "./events.js";
import { CMUX_TEXT_BYTES } from "./protocol.js";
import { boundedPresenceText } from "./text.js";
import type { AttentionKind } from "./notification-policy.js";

const STATUS_PREFIX = "pi-presence";
const TODO_SOURCE = "todo";

export interface PresenceStyle {
  icon: string;
  color: string;
  priority: number;
}

export const PRESENCE_STATE_STYLES: Record<PresenceUpdate["state"], PresenceStyle> = {
  idle: { icon: "circle", color: "#808080", priority: 10 },
  waiting: { icon: "clock", color: "#d97706", priority: 20 },
  running: { icon: "play", color: "#2563eb", priority: 30 },
  success: { icon: "check", color: "#16a34a", priority: 20 },
  error: { icon: "x", color: "#dc2626", priority: 40 },
  cancelled: { icon: "minus", color: "#6b7280", priority: 20 },
};

const LOCAL_TURN_SUMMARIES: Record<PresenceUpdate["state"], string> = {
  idle: "Idle",
  waiting: "Waiting",
  running: "Running",
  success: "✓ Completed",
  error: "✗ Failed",
  cancelled: "Cancelled",
};

export interface LocalTurnPresentation {
  readonly sidebar: string;
  readonly title: string;
  readonly body: string;
}

export interface InteractionWaitingPresentation extends LocalTurnPresentation {
  readonly progress: string;
}

/** Only an explicit interaction wait can use the fixed user-input presentation. */
export function isInteractionWaiting(event: PresenceUpdate): boolean {
  return event.source.kind === "interaction"
    && event.state === "waiting"
    && (event.attention === "info" || event.attention === "none" || event.attention === undefined);
}

/** Fixed local wording deliberately excludes every assistant and user payload. */
export function formatLocalTurnPresentation(
  state: PresenceUpdate["state"],
  maxCodePoints: number,
  blocked = false,
): LocalTurnPresentation {
  const body = boundedPresenceText(blocked ? "Blocked" : LOCAL_TURN_SUMMARIES[state], {
    maxBytes: CMUX_TEXT_BYTES.notificationBody,
    maxCodePoints,
  });
  return {
    sidebar: boundedPresenceText(`Pi · ${body}`, {
      maxBytes: CMUX_TEXT_BYTES.v1Text,
      maxCodePoints,
    }),
    title: boundedPresenceText("Pi", {
      maxBytes: CMUX_TEXT_BYTES.notificationTitle,
      maxCodePoints,
    }),
    body,
  };
}

/** Fixed interaction wording deliberately excludes every producer payload. */
export function formatInteractionWaitingPresentation(
  maxCodePoints: number,
): InteractionWaitingPresentation {
  const text = "Pi needs your input";
  return {
    sidebar: boundedPresenceText(text, {
      maxBytes: CMUX_TEXT_BYTES.v1Text,
      maxCodePoints,
    }),
    title: boundedPresenceText(text, {
      maxBytes: CMUX_TEXT_BYTES.notificationTitle,
      maxCodePoints,
    }),
    body: boundedPresenceText(text, {
      maxBytes: CMUX_TEXT_BYTES.notificationBody,
      maxCodePoints,
    }),
    progress: boundedPresenceText(text, {
      maxBytes: CMUX_TEXT_BYTES.v1Text,
      maxCodePoints,
    }),
  };
}

export function presenceStatusKey(sourceId: string, surfaceId?: string): string {
  const hashInput = surfaceId ? `${surfaceId}:${sourceId}` : sourceId;
  const hash = createHash("sha256").update(hashInput, "utf8").digest("hex");
  return `${STATUS_PREFIX}:${hash}`;
}

/** Display-only refinements never replace the accepted state or attention enums. */
function stateSummary(event: PresenceUpdate): string {
  if (event.blocked) return "Blocked";
  const canBeQueued = event.state === "waiting" || event.state === "running";
  if (canBeQueued && event.counts.active === 0 && (event.counts.queued ?? 0) > 0) return "Queued";
  return LOCAL_TURN_SUMMARIES[event.state];
}

export function formatStateText(event: PresenceUpdate, maxCodePoints: number): string {
  const parts = [`${event.source.label} · ${stateSummary(event)}`];
  if (event.counts.active) parts.push(`${event.counts.active} active`);
  if (event.counts.queued) parts.push(`${event.counts.queued} queued`);
  if (event.counts.completed) parts.push(`${event.counts.completed} completed`);
  if (event.counts.failed) parts.push(`${event.counts.failed} failed`);
  if (event.counts.cancelled) parts.push(`${event.counts.cancelled} cancelled`);
  if (event.usage?.tokens) parts.push(`${Math.round(event.usage.tokens)} tokens`);
  if (event.usage?.contextPercent !== undefined) {
    parts.push(`${Math.round(event.usage.contextPercent)}% ctx`);
  }
  if (event.usage?.cost) parts.push(`$${event.usage.cost.toFixed(2)}`);

  return boundedPresenceText(parts.join(" · "), {
    maxBytes: CMUX_TEXT_BYTES.v1Text,
    maxCodePoints,
  });
}

export function formatProgressText(event: PresenceUpdate, maxCodePoints: number): string {
  const progress = event.progress;
  // V2 supplies only bounded numeric progress. Never borrow producer text.
  let label = `${event.source.label} · ${stateSummary(event)}`;
  if (progress?.completed !== undefined && progress.total !== undefined) {
    label += ` · ${progress.completed}/${progress.total} completed`;
  }
  return boundedPresenceText(label, {
    maxBytes: CMUX_TEXT_BYTES.v1Text,
    maxCodePoints,
  });
}

export function formatAttentionTitle(
  event: PresenceUpdate,
  maxCodePoints: number,
): string {
  return boundedPresenceText(event.source.label, {
    maxBytes: CMUX_TEXT_BYTES.notificationTitle,
    maxCodePoints,
  });
}

/** Static parent fallback for an invalidated deferred subagent error burst. */
export function formatParentAttentionFallback(
  attention: "info" | AttentionKind,
  completed: number,
  failed: number,
  maxCodePoints: number,
): { title: string; body: string } {
  const summary = attention === "info" ? "Needs attention" : LOCAL_TURN_SUMMARIES[attention];
  const parts = [`Pi · ${summary}`];
  if (completed > 0) parts.push(`${completed} completed`);
  if (failed > 0) parts.push(`${failed} failed`);
  return {
    title: "Pi",
    body: boundedPresenceText(parts.join(" · "), {
      maxBytes: CMUX_TEXT_BYTES.notificationBody,
      maxCodePoints,
    }),
  };
}

/** Static aggregate text never copies producer labels or task data. */
export function formatSubagentAttention(
  attention: AttentionKind,
  completedDelta: number,
  failedDelta: number,
  options: { readonly parentSucceeded?: boolean; readonly timeout?: boolean },
  maxCodePoints: number,
): { title: string; body: string; attention: AttentionKind } {
  const parts: string[] = [];
  if (completedDelta > 0) parts.push(`${completedDelta} completed`);
  if (failedDelta > 0) parts.push(`${failedDelta} failed`);
  const identity = options.parentSucceeded && attention === "success" ? "Pi" : "Subagents";
  const title = `${identity} · ${LOCAL_TURN_SUMMARIES[attention]}`;
  let body = `Subagents · ${LOCAL_TURN_SUMMARIES[attention]}`;
  if (parts.length > 0) body += ` · ${parts.join(" · ")}`;
  // A deferred timeout snapshot is not evidence that Pi is still running.
  if (options.timeout) body += " · Deferred summary";
  return {
    title: boundedPresenceText(title, {
      maxBytes: CMUX_TEXT_BYTES.notificationTitle,
      maxCodePoints,
    }),
    body: boundedPresenceText(body, {
      maxBytes: CMUX_TEXT_BYTES.notificationBody,
      maxCodePoints,
    }),
    attention,
  };
}

export function formatAutoTitle(name: string, maxCodePoints: number): string {
  return boundedPresenceText(`Pi · ${name}`, {
    maxBytes: CMUX_TEXT_BYTES.autoTitle,
    maxCodePoints,
  });
}

export function attentionLevel(
  attention: PresenceUpdate["attention"],
): "info" | "success" | "error" | null {
  return attention === "info" || attention === "success" || attention === "error"
    ? attention
    : null;
}

export function selectProgress(events: readonly PresenceUpdate[]): PresenceUpdate | null {
  // Todo is an explicit user-visible plan and wins even at 100% until cleared.
  const todo = events.find((event) => event.source.id === TODO_SOURCE && event.progress !== undefined);
  if (todo) return todo;

  const eligible = events.filter((event) => event.progress !== undefined
    && (event.state === "running" || event.state === "waiting"));
  return eligible.sort((left, right) => left.source.id.localeCompare(right.source.id))[0] ?? null;
}

export function aggregateMetadata(events: readonly PresenceUpdate[]): string {
  const count = (key: "active" | "completed" | "failed" | "queued" | "cancelled" | "total") => (
    events.reduce((sum, event) => sum + (event.counts[key] ?? 0), 0)
  );
  const tokens = events.reduce((sum, event) => sum + (event.usage?.tokens ?? 0), 0);
  const cost = events.reduce((sum, event) => sum + (event.usage?.cost ?? 0), 0);
  const context = events.reduce((maximum, event) => Math.max(maximum, event.usage?.contextPercent ?? 0), 0);

  // The raw cmux block intentionally has no labels or producer-provided text.
  return [
    count("active"),
    count("completed"),
    count("failed"),
    count("queued"),
    count("cancelled"),
    count("total"),
    Math.round(tokens),
    cost.toFixed(2),
    Math.round(context),
  ].join("\n");
}

export function deriveTerminalState(
  messages: readonly unknown[],
  hadToolError: boolean,
): "success" | "error" | "cancelled" {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (typeof message !== "object" || message === null) continue;
    const stopReason = (message as { stopReason?: unknown }).stopReason;
    if (stopReason === "aborted" || stopReason === "cancelled") return "cancelled";
    if (stopReason === "error") return "error";
    // A later completed assistant response recovers an earlier retry error and
    // is authoritative over the per-turn tool fallback.
    if (stopReason === "stop" || stopReason === "length") return "success";
    // A tool-only ending is not an assistant recovery response. Its parent
    // tool result remains authoritative; handled nested errors never reach it.
    if (stopReason === "toolUse") return hadToolError ? "error" : "success";
  }
  return hadToolError ? "error" : "success";
}
