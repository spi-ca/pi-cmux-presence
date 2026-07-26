import { createHash } from "node:crypto";
import type { PresenceUpdate } from "./events.js";
import { CMUX_TEXT_BYTES } from "./protocol.js";
import { boundedPresenceText } from "./text.js";

const STATUS_PREFIX = "pi-presence";
const TODO_SOURCE = "pi-todo";

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

export function presenceStatusKey(sourceId: string, surfaceId?: string): string {
  const hashInput = surfaceId ? `${surfaceId}:${sourceId}` : sourceId;
  const hash = createHash("sha256").update(hashInput, "utf8").digest("hex");
  return `${STATUS_PREFIX}:${hash}`;
}

export function formatStateText(event: PresenceUpdate, maxCodePoints: number): string {
  const parts = [`${event.source.label}: ${event.state}`];
  if (event.counts.active) parts.push(`${event.counts.active} active`);
  if (event.counts.queued) parts.push(`${event.counts.queued} queued`);
  if (event.counts.completed) parts.push(`${event.counts.completed} done`);
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
  return boundedPresenceText(event.progress?.label ?? event.source.label, {
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
    if (stopReason === "aborted") return "cancelled";
    if (stopReason === "error") return "error";
  }
  return hadToolError ? "error" : "success";
}
