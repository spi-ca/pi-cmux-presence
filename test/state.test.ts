import { describe, expect, test } from "bun:test";
import {
  createPresenceConsumer,
  createPresenceProducer,
  EVENT_NAMES,
  type PresenceEventV2,
} from "@pi/presence";
import { adaptPresenceState, adaptPresenceTerminal, PresenceStateRegistry } from "../src/events.js";
import { readCmuxIdentity } from "../src/identity.js";
import { presenceStatusKey } from "../src/presence.js";
import { TodoProgressAdapter } from "../src/todo.js";
import { UsageTracker } from "../src/usage.js";
import { isSafeSessionId } from "../src/validation.js";

function v2() {
  const events: PresenceEventV2[] = [];
  const consumer = createPresenceConsumer({ id: "pi-cmux-presence" })!;
  const producer = createPresenceProducer({ source: "subagent", emit(name: string, payload: unknown) {
    const accepted = consumer.accept(name, payload);
    if (accepted) events.push(accepted);
  } })!;
  expect(consumer.activate()).toBe(true);
  expect(producer.activate()).toBe(true);
  return { consumer, producer, events };
}

describe("V2 presence state", () => {
  test("uses shared consumer fences, source labels, and retained replay", () => {
    const { consumer, producer, events } = v2();
    expect(producer.publishState({ version: 2, generation: 1, sequence: 1, source: "subagent", state: "running", subagents: { running: 1, cancelling: 0, queued: 2, completed: 3, failed: 0, cancelled: 0, omitted: 0 } })).toBe(true);
    const event = events[0]!;
    expect("state" in event && adaptPresenceState(event)).toMatchObject({ source: { id: "subagent", label: "Subagents", kind: "agent-group" }, counts: { active: 1, queued: 2, completed: 3 } });
    expect(consumer.accept(EVENT_NAMES.state, event)).toBeUndefined();
    producer.deactivate();
    consumer.deactivate();
  });

  test("does not replay terminals and keeps terminal adapters quiet and non-authoritative", () => {
    const { consumer, producer, events } = v2();
    const late = createPresenceConsumer({ id: "pi-herdr-presence" })!;
    try {
      expect(producer.publishTerminal({ version: 2, generation: 1, sequence: 1, source: "subagent", eventId: 1, outcome: "failed" })).toBe(true);
      const terminal = events[0]!;
      expect("eventId" in terminal && adaptPresenceTerminal(terminal)).toMatchObject({ source: { id: "subagent" }, state: "error", attention: "none", counts: { failed: 0 } });
      expect(late.activate()).toBe(true);
      expect(events).toHaveLength(1);
    } finally {
      producer.deactivate(); consumer.deactivate(); late.deactivate();
    }
  });

  test("maps V2 blocked attention to error-style needs-attention presentation", () => {
    const blocked = {
      version: 2 as const, generation: 1, sequence: 1, source: "pi" as const, state: "waiting" as const,
      attention: { reason: "blocked" as const, occurrence: "new" as const }, sessionEpoch: "test",
    };
    expect(adaptPresenceState(blocked).state).toBe("error");
    expect(adaptPresenceState(blocked).attention).toBe("error");
  });

  test("terminal adapters preserve authoritative cumulative state without inventing counts", () => {
    const terminal = { version: 2 as const, generation: 2, sequence: 9, source: "subagent" as const, eventId: 4, outcome: "failed" as const, sessionEpoch: "test" };
    const prior = { generation: 2, sequence: 8, source: { id: "subagent", label: "Subagents", kind: "agent-group" }, state: "error" as const, counts: { active: 0, completed: 7, failed: 3 }, attention: "none" as const };
    expect(adaptPresenceTerminal(terminal, prior).counts).toMatchObject({ completed: 7, failed: 3 });
    expect(adaptPresenceTerminal(terminal).counts).toMatchObject({ completed: 0, failed: 0 });
  });

  test("withdrawal removes state and higher generation reopens it", () => {
    const { consumer, producer, events } = v2();
    const registry = new PresenceStateRegistry();
    producer.publishState({ version: 2, generation: 1, sequence: 1, source: "subagent", state: "waiting", subagents: { running: 0, cancelling: 0, queued: 1, completed: 0, failed: 0, cancelled: 0, omitted: 0 } });
    registry.set(adaptPresenceState(events.at(-1)! as Extract<PresenceEventV2, { state: string }>));
    producer.withdraw({ version: 2, generation: 1, sequence: 2, source: "subagent" });
    expect(registry.remove("subagent")).toBeDefined();
    expect(producer.publishState({ version: 2, generation: 1, sequence: 3, source: "subagent", state: "waiting", subagents: { running: 0, cancelling: 0, queued: 1, completed: 0, failed: 0, cancelled: 0, omitted: 0 } })).toBe(false);
    expect(producer.publishState({ version: 2, generation: 2, sequence: 0, source: "subagent", state: "waiting", subagents: { running: 0, cancelling: 0, queued: 1, completed: 0, failed: 0, cancelled: 0, omitted: 0 } })).toBe(true);
    producer.deactivate(); consumer.deactivate();
  });

  test("accepts only bounded control- and bidi-free host session IDs", () => {
    expect(isSafeSessionId("safe-session.1")).toBe(true);
    expect(isSafeSessionId("")).toBe(false);
    expect(isSafeSessionId("bad\u202e")).toBe(false);
    expect(isSafeSessionId("😀".repeat(97))).toBe(false);
  });

  test("uses fixed-length status keys and canonical cmux identities", () => {
    expect(presenceStatusKey("subagent")).toMatch(/^pi-presence:[a-f0-9]{64}$/);
    const target = "00000000-0000-4000-8000-000000000000";
    expect(readCmuxIdentity({ CMUX_WORKSPACE_ID: "not-a-uuid", CMUX_SURFACE_ID: target })).toBeNull();
    expect(readCmuxIdentity({ CMUX_WORKSPACE_ID: target, CMUX_SURFACE_ID: target })).not.toBeNull();
  });

  test("keeps todo task text private and local usage separate", () => {
    const adapter = new TodoProgressAdapter();
    const tools = [{ name: "todo", sourceInfo: { path: "/safe/todo.ts", source: "project", scope: "project", origin: "top-level" } }];
    const result = adapter.accept({ toolName: "todo", isError: false, details: { action: "list", params: {}, nextId: 3, tasks: [{ id: 1, status: "completed", subject: "secret" }, { id: 2, status: "pending" }] } }, tools, 1, 1);
    expect(result).toMatchObject({ source: { id: "todo" }, counts: { completed: 1, queued: 1 } });
    expect(JSON.stringify(result)).not.toContain("secret");
    const usage = new UsageTracker(); usage.add({ input: 10, output: 5 }); usage.setContext({ percent: 42 });
    expect(usage.snapshot()).toEqual({ tokens: 15, contextPercent: 42 });
  });
});
