import type { PresenceEventV2, PresenceStateV2, PresenceTerminalV2 } from "@pi/presence";

export const LOCAL_SOURCE = { id: "pi", label: "Pi", kind: "agent" } as const;
export const TODO_SOURCE = { id: "todo", label: "Pi todo", kind: "todo" } as const;
export const SUBAGENT_SOURCE = { id: "subagent", label: "Subagents", kind: "agent-group" } as const;
export const INTERACTION_SOURCE = { id: "interaction", label: "Input", kind: "interaction" } as const;

export interface PresenceUsage { tokens?: number; cost?: number; contextPercent?: number; }
export interface PresenceUpdate {
  generation: number;
  sequence: number;
  source: { id: string; label: string; kind: string };
  state: "idle" | "waiting" | "running" | "success" | "error" | "cancelled";
  counts: { active: number; completed: number; failed: number; queued?: number; cancelled?: number; total?: number };
  progress?: { value: number; completed?: number; total?: number; label?: string };
  usage?: PresenceUsage;
  attention?: "none" | "info" | "success" | "error";
  /** Structured V2 cause retained only for local attention routing. */
  attentionReason?: "failure" | "blocked" | "input_required";
}

/** Local presentation state only. V2 validation, epoch routing, and fences stay in @pi/presence. */
export class PresenceStateRegistry {
  private readonly values = new Map<string, PresenceUpdate>();
  clear(): void { this.values.clear(); }
  set(event: PresenceUpdate): void { this.values.set(event.source.id, event); }
  remove(sourceId: string): PresenceUpdate | undefined {
    const removed = this.values.get(sourceId);
    this.values.delete(sourceId);
    return removed;
  }
  snapshot(): PresenceUpdate[] { return [...this.values.values()].sort((left, right) => left.source.label.localeCompare(right.source.label)); }
}

function attention(event: PresenceStateV2): PresenceUpdate["attention"] {
  if (event.attention?.occurrence !== "new") return "none";
  return event.attention.reason === "failure" || event.attention.reason === "blocked" ? "error" : "info";
}

function attentionReason(event: PresenceStateV2): PresenceUpdate["attentionReason"] {
  if (event.attention?.occurrence !== "new") return undefined;
  if (event.attention.reason === "failure"
    || event.attention.reason === "blocked"
    || event.attention.reason === "input_required") return event.attention.reason;
  return undefined;
}

/** Maps V2's closed sources to this consumer's fixed local presentation vocabulary. */
export function adaptPresenceState(event: PresenceStateV2, local?: Partial<PresenceUpdate>): PresenceUpdate {
  const state = event.attention?.reason === "blocked" ? "error" : event.state;
  const progress = event.progress
    ? { value: event.progress.completed / event.progress.total, completed: event.progress.completed, total: event.progress.total }
    : undefined;
  const reason = attentionReason(event);
  if (event.source === "subagent") {
    const counts = event.subagents ?? { running: 0, cancelling: 0, queued: 0, completed: 0, failed: 0, cancelled: 0, omitted: 0 };
    return {
      generation: event.generation, sequence: event.sequence, source: { ...SUBAGENT_SOURCE }, state,
      counts: { active: counts.running + counts.cancelling, queued: counts.queued, completed: counts.completed, failed: counts.failed, cancelled: counts.cancelled, total: counts.running + counts.cancelling + counts.queued + counts.completed + counts.failed + counts.cancelled + counts.omitted },
      ...(progress ? { progress } : {}), attention: attention(event),
      ...(reason ? { attentionReason: reason } : {}),
    };
  }
  if (event.source === "interaction") {
    return {
      generation: event.generation, sequence: event.sequence, source: { ...INTERACTION_SOURCE }, state: "waiting",
      counts: { active: event.interaction?.pending ?? 0, completed: 0, failed: 0 }, attention: attention(event),
      ...(reason ? { attentionReason: reason } : {}),
    };
  }
  const source = event.source === "todo" ? TODO_SOURCE : LOCAL_SOURCE;
  // Private local overlays are presentation-only and cannot cross a V2 generation.
  const overlay = local?.generation === event.generation ? local : {};
  return {
    generation: event.generation, sequence: event.sequence, source: { ...source }, state,
    counts: overlay.counts ?? { active: state === "running" || state === "waiting" ? 1 : 0, completed: state === "success" ? 1 : 0, failed: state === "error" ? 1 : 0 },
    ...(progress ? { progress } : overlay.progress ? { progress: overlay.progress } : {}),
    ...(overlay.usage ? { usage: overlay.usage } : {}), attention: attention(event),
    ...(reason ? { attentionReason: reason } : {}),
  };
}

/**
 * Compatibility-only terminal view. Runtime terminal delivery must use the
 * explicit edge and never retain this value or derive count increments.
 */
export function adaptPresenceTerminal(event: PresenceTerminalV2, prior?: PresenceUpdate): PresenceUpdate {
  const presentation = prior?.generation === event.generation ? prior : undefined;
  return {
    generation: event.generation,
    sequence: event.sequence,
    source: { ...(event.source === "subagent" ? SUBAGENT_SOURCE : LOCAL_SOURCE) },
    state: event.outcome === "completed" ? "success" : event.outcome === "failed" ? "error" : "cancelled",
    counts: presentation?.counts ?? { active: 0, completed: 0, failed: 0 },
    ...(presentation?.usage ? { usage: presentation.usage } : {}),
    attention: "none",
  };
}

export function isState(event: PresenceEventV2): event is PresenceStateV2 { return "state" in event; }
export function isTerminal(event: PresenceEventV2): event is PresenceTerminalV2 { return "eventId" in event; }
