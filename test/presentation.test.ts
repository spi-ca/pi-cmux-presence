import { describe, expect, test } from "bun:test";
import type { PresenceStateV2 } from "@pi/presence";
import { adaptPresenceState, type PresenceUpdate } from "../src/events.js";
import {
  aggregateMetadata,
  formatLocalTurnPresentation,
  formatParentAttentionFallback,
  formatProgressText,
  formatStateText,
  formatSubagentAttention,
  PRESENCE_STATE_STYLES,
} from "../src/presentation.js";
import { CMUX_TEXT_BYTES } from "../src/protocol.js";

function update(overrides: Partial<PresenceUpdate> = {}): PresenceUpdate {
  return {
    generation: 1,
    sequence: 1,
    source: { id: "subagent", label: "Subagents", kind: "agent-group" },
    state: "running",
    counts: { active: 0, completed: 0, failed: 0 },
    ...overrides,
  };
}

describe("human presence presentation", () => {
  test("uses identity then explicit state, reserving outcome marks for terminal outcomes", () => {
    const summaries = {
      idle: "Idle",
      waiting: "Waiting",
      running: "Running",
      success: "✓ Completed",
      error: "✗ Failed",
      cancelled: "Cancelled",
    } as const;
    for (const [state, summary] of Object.entries(summaries) as Array<[PresenceUpdate["state"], string]>) {
      const event = update({ state });
      expect(formatStateText(event, 96)).toBe(`Subagents · ${summary}`);
      expect(formatProgressText(event, 96)).toBe(`Subagents · ${summary}`);
      expect(formatLocalTurnPresentation(state, 96)).toEqual({
        sidebar: `Pi · ${summary}`, title: "Pi", body: summary,
      });
    }
    // Preserve existing cmux style tokens and priorities while changing wording.
    expect(PRESENCE_STATE_STYLES.running).toEqual({ icon: "play", color: "#2563eb", priority: 30 });
    expect(PRESENCE_STATE_STYLES.success.icon).toBe("check");
    expect(PRESENCE_STATE_STYLES.error.icon).toBe("x");
  });

  test("shows queued only with pending counts and no active work, never over a terminal", () => {
    const queued = update({ state: "waiting", counts: { active: 0, completed: 1, failed: 0, queued: 2 } });
    expect(formatStateText(queued, 96)).toBe("Subagents · Queued · 2 queued · 1 completed");
    expect(formatStateText({ ...queued, state: "running" }, 96)).toContain("Subagents · Queued");
    expect(formatStateText({ ...queued, counts: { ...queued.counts, active: 1 } }, 96)).toContain("Subagents · Waiting");
    expect(formatStateText({ ...queued, state: "error" }, 96)).toContain("Subagents · ✗ Failed");
    expect(formatStateText({ ...queued, state: "cancelled" }, 96)).toContain("Subagents · Cancelled");
    expect(queued.state).toBe("waiting");
  });

  test("keeps blocked distinct on new and retained snapshots without changing attention routing", () => {
    for (const source of ["pi", "subagent"] as const) {
      for (const occurrence of ["new", "retained"] as const) {
        const wire: PresenceStateV2 = {
          version: 2, sessionEpoch: "A".repeat(32), generation: 1, sequence: 1,
          source, state: "waiting", attention: { reason: "blocked", occurrence },
        };
        const event = adaptPresenceState(wire);
        expect(event.state).toBe("error");
        expect(event.attention).toBe(occurrence === "new" ? "error" : "none");
        expect(event.attentionReason).toBe(occurrence === "new" ? "blocked" : undefined);
        expect(event.blocked).toBe(true);
        expect(formatStateText(event, 96)).toStartWith(`${event.source.label} · Blocked`);
        expect(formatLocalTurnPresentation(event.state, 96, event.blocked).sidebar).toBe("Pi · Blocked");
        expect(formatProgressText(event, 96)).toBe(`${event.source.label} · Blocked`);
        expect(wire.state).toBe("waiting");
      }
    }
  });

  test("orders essential counts before usage and leaves numeric metadata byte-identical", () => {
    const event = update({
      counts: { active: 1, queued: 2, completed: 3, failed: 4, cancelled: 5, total: 15 },
      usage: { tokens: 1234, contextPercent: 50, cost: 0.25 },
      progress: { value: 3 / 15, completed: 3, total: 15, label: "PRIVATE_TASK_PROMPT_PATH_CANARY" },
    });
    expect(formatStateText(event, 256)).toBe("Subagents · Running · 1 active · 2 queued · 3 completed · 4 failed · 5 cancelled · 1234 tokens · 50% ctx · $0.25");
    expect(formatProgressText(event, 96)).toBe("Subagents · Running · 3/15 completed");
    expect(aggregateMetadata([event])).toBe("1\n3\n4\n2\n5\n15\n1234\n0.25\n50");
    expect(aggregateMetadata([{ ...event, blocked: true }])).toBe(aggregateMetadata([event]));
  });

  test("keeps aggregate and fallback summaries fixed and concise with unchanged attention enums", () => {
    expect(formatSubagentAttention("success", 2, 0, {}, 96)).toEqual({
      title: "Subagents · ✓ Completed", body: "Subagents · ✓ Completed · 2 completed", attention: "success",
    });
    expect(formatSubagentAttention("error", 2, 1, { timeout: true }, 96)).toEqual({
      title: "Subagents · ✗ Failed", body: "Subagents · ✗ Failed · 2 completed · 1 failed · Deferred summary", attention: "error",
    });
    expect(formatSubagentAttention("success", 2, 0, { parentSucceeded: true }, 96).title).toBe("Pi · ✓ Completed");
    expect(formatParentAttentionFallback("error", 2, 1, 96)).toEqual({
      title: "Pi", body: "Pi · ✗ Failed · 2 completed · 1 failed",
    });
    expect(formatParentAttentionFallback("success", 1, 0, 96).body).toBe("Pi · ✓ Completed · 1 completed");
    expect(formatParentAttentionFallback("info", 0, 0, 96).body).toBe("Pi · Needs attention");
  });

  test("bounds new outcome marks and summaries at minimum, default and maximum label caps", () => {
    for (const cap of [16, 96, 256]) {
      for (const attention of ["success", "error"] as const) {
        const local = formatLocalTurnPresentation(attention, cap);
        const aggregate = formatSubagentAttention(attention, 1_000_000, 1_000_000, { timeout: true }, cap);
        for (const text of [local.sidebar, local.body, aggregate.body]) {
          expect([...text].length).toBeLessThanOrEqual(cap);
          expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(CMUX_TEXT_BYTES.notificationBody);
          expect(text).not.toContain("�");
        }
        expect([...aggregate.title].length).toBeLessThanOrEqual(cap);
        expect(Buffer.byteLength(aggregate.title, "utf8")).toBeLessThanOrEqual(CMUX_TEXT_BYTES.notificationTitle);
      }
    }
  });
});
