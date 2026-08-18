import type { PresenceUpdate } from "./events.js";

/** Exact producer identity; labels and kinds are descriptive, never routing authority. */
export const PI_SUBAGENT_SOURCE_ID = "subagent";

export type NotificationPolicy = "errors" | "background" | "settled" | "all" | "disabled";
export type FlashPolicy = "errors" | "attention" | "disabled";
export type AttentionKind = "success" | "error";
export type AttentionOrigin = "local" | "external";

export interface SubagentTerminalBaseline {
  readonly generation: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
}

export interface SubagentObservation {
  readonly baseline: SubagentTerminalBaseline;
  readonly terminal: AttentionKind | null;
  readonly completedDelta: number;
  readonly failedDelta: number;
  /** Counts went backwards: discard any aggregate burst. */
  readonly reset: boolean;
  /** The generation changed; a non-none first update is only an unknown live alert. */
  readonly generationChanged: boolean;
  /** A first non-none update has no trustworthy historical delta. */
  readonly unknownCount: boolean;
}

function baselineFor(event: PresenceUpdate): SubagentTerminalBaseline {
  return {
    generation: event.generation,
    completed: event.counts.completed,
    failed: event.counts.failed,
    cancelled: event.counts.cancelled ?? 0,
  };
}

/**
 * V2 state snapshots establish only the subagent cumulative baseline. Terminal
 * attention is represented exclusively by V2 terminal events: state counter
 * changes and state attention must never be converted into completion edges.
 */
export function observeSubagentTerminal(
  previous: SubagentTerminalBaseline | null,
  event: PresenceUpdate,
): SubagentObservation {
  const baseline = baselineFor(event);
  if (event.source.id !== PI_SUBAGENT_SOURCE_ID) {
    return { baseline, terminal: null, completedDelta: 0, failedDelta: 0, reset: false, generationChanged: false, unknownCount: false };
  }

  if (previous === null || previous.generation !== event.generation) {
    return {
      baseline,
      terminal: null,
      completedDelta: 0,
      failedDelta: 0,
      reset: false,
      generationChanged: previous !== null,
      unknownCount: false,
    };
  }

  const reset = event.counts.completed < previous.completed
    || event.counts.failed < previous.failed
    || (event.counts.cancelled ?? 0) < previous.cancelled;
  return {
    baseline,
    terminal: null,
    completedDelta: 0,
    failedDelta: 0,
    reset,
    generationChanged: false,
    unknownCount: false,
  };
}

/** Preserve the first event's fixed semantic window instead of sliding it. */
export function fixedCoalescingDeadline(
  existingDeadline: number | null,
  now: number,
  windowMs: number,
): number {
  return existingDeadline ?? now + windowMs;
}

/** Pure monotonic timeout arithmetic keeps timer tests free of long sleeps. */
export function remainingErrorDeadlineMs(deadline: number, now: number): number {
  return Math.max(0, deadline - now);
}

/** Whether an attention signal is eligible under the selected modern policy. */
export function isAttentionEligible(
  policy: NotificationPolicy,
  attention: PresenceUpdate["attention"],
  origin: AttentionOrigin,
  mergedWithSubagent = false,
): boolean {
  if (policy === "disabled" || attention === "none" || attention === undefined) return false;
  if (policy === "errors") return attention === "error";
  if (policy === "settled") {
    // Generic external completion is intentionally quiet. An exact merged
    // parent/subagent success represents a finalized local completion.
    return attention === "error"
      || (attention === "success" && (origin === "local" || mergedWithSubagent));
  }
  if (policy === "all") return true;
  // background: external producers retain their non-none attention; local
  // success is only useful as the merged parent/subagent completion.
  return origin === "external" || attention === "error" || mergedWithSubagent;
}

export function shouldNotifyAttention(
  policy: NotificationPolicy,
  legacyNotificationsEnabled: boolean,
  attention: PresenceUpdate["attention"],
  origin: AttentionOrigin,
  mergedWithSubagent = false,
): boolean {
  return legacyNotificationsEnabled
    && isAttentionEligible(policy, attention, origin, mergedWithSubagent);
}

export function shouldFlashAttention(
  policy: FlashPolicy,
  legacyFlashEnabled: boolean,
  notificationPolicy: NotificationPolicy,
  attention: PresenceUpdate["attention"],
  origin: AttentionOrigin,
  mergedWithSubagent = false,
): boolean {
  if (!legacyFlashEnabled || policy === "disabled") return false;
  // Error flash is independently configured; it must not be coupled to the
  // legacy notification capability/kill switch.
  if (policy === "errors") return attention === "error";
  return isAttentionEligible(notificationPolicy, attention, origin, mergedWithSubagent);
}
