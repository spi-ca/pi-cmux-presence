import { describe, expect, test } from "bun:test";
import type { PresenceUpdate } from "../src/events.js";
import {
  formatAttentionTitle,
  formatAutoTitle,
  formatProgressText,
  formatStateText,
  aggregateMetadata,
  deriveTerminalState,
  selectProgress,
} from "../src/presentation.js";
import { CMUX_TEXT_BYTES } from "../src/protocol.js";
import { boundedPresenceText, normalizePresenceText } from "../src/text.js";

const event = (label: string, progressLabel = label): PresenceUpdate => ({
  version: 1,
  sessionId: "session-1",
  generation: 1,
  sequence: 1,
  source: { id: "worker", label, kind: "task" },
  state: "running",
  counts: { active: 1, completed: 123_456, failed: 0, queued: 654_321, total: 777_778 },
  progress: { value: 0.5, label: progressLabel },
  usage: { tokens: 999_999_999_999, cost: 999_999_999.99, contextPercent: 100 },
});

describe("UTF-8 bounded presence text", () => {
  test("preserves exact ASCII, Korean, and emoji byte boundaries", () => {
    const cases = ["a".repeat(128), "한".repeat(42), "😀".repeat(32)];
    for (const value of cases) {
      const result = boundedPresenceText(value, { maxBytes: 128, maxCodePoints: 128 });
      expect(result).toBe(value);
      expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(128);
    }
  });

  test("truncates by complete code points and reserves the ellipsis byte budget", () => {
    for (const value of ["가".repeat(100), "😀".repeat(100), `a${"😀".repeat(100)}`]) {
      const result = boundedPresenceText(value, { maxBytes: 128, maxCodePoints: 256 });
      expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(128);
      expect(result.endsWith("…")).toBe(true);
      expect(result).not.toContain("�");
      expect(() => Buffer.from(result, "utf8").toString("utf8")).not.toThrow();
    }
  });

  test("repairs malformed UTF-16 and normalizes unsafe display controls", () => {
    expect(normalizePresenceText("  safe\u202e\ud800  text  ")).toBe("safe � text");
  });

  test("enforces destination byte budgets for every rendered label", () => {
    const long = "😀한".repeat(120);
    const rendered = [
      [formatStateText(event(long), 256), CMUX_TEXT_BYTES.v1Text],
      [formatProgressText(event("worker", long), 256), CMUX_TEXT_BYTES.v1Text],
      [formatAttentionTitle(event(long), 96), CMUX_TEXT_BYTES.notificationTitle],
      [formatAutoTitle(long, 80), CMUX_TEXT_BYTES.autoTitle],
    ] as const;

    for (const [value, maxBytes] of rendered) {
      expect(Buffer.byteLength(value, "utf8")).toBeLessThanOrEqual(maxBytes);
      expect(value).not.toContain("�");
      expect(value.endsWith("…")).toBe(true);
    }
    expect(rendered[3][0].startsWith("Pi · ")).toBe(true);
    expect([...formatAttentionTitle(event("a".repeat(200)), 96)]).toHaveLength(96);
    expect([...formatAutoTitle("a".repeat(200), 80)]).toHaveLength(80);
  });

  test("keeps the configured code-point cap including an ellipsis", () => {
    const value = boundedPresenceText("😀".repeat(30), { maxBytes: 512, maxCodePoints: 16 });
    expect([...value]).toHaveLength(16);
    expect(value.endsWith("…")).toBe(true);
  });

  test("selects todo progress before other eligible progress", () => {
    const worker = event("Worker");
    const todo: PresenceUpdate = {
      ...event("Pi todo"),
      source: { id: "pi-todo", label: "Pi todo", kind: "todo" },
      state: "success",
      progress: { value: 1 },
    };
    expect(selectProgress([worker, todo])).toBe(todo);
  });

  test("uses the maximum context percent and recognizes error stop reasons", () => {
    const lower = { ...event("Lower"), usage: { contextPercent: 40 } };
    const higher = { ...event("Higher"), usage: { contextPercent: 75 } };
    expect(aggregateMetadata([lower, higher]).split("\n").at(-1)).toBe("75");
    expect(deriveTerminalState([{ stopReason: "error" }], false)).toBe("error");
  });
});
