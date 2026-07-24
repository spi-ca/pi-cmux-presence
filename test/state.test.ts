import { describe, expect, test } from "bun:test";
import { MAX_COUNT, PresenceEventRegistry, parsePresenceReady, parsePresenceUpdate } from "../src/events.js";
import { TodoProgressAdapter } from "../src/todo.js";
import { readCmuxIdentity } from "../src/identity.js";
import { presenceStatusKey } from "../src/presence.js";
import { UsageTracker } from "../src/usage.js";

const sessionId = "session-1";
const base = {
  version: 1 as const, sessionId, generation: 1, sequence: 1,
  source: { id: "worker", label: "Worker", kind: "task" }, state: "running" as const,
  counts: { active: 1, completed: 0, failed: 0 }, progress: { value: 0.5, label: "Working" },
};

describe("generic presence event state", () => {
  test("validates bounds and fences session, generation, and sequence", () => {
    const registry = new PresenceEventRegistry();
    registry.start(sessionId);
    expect(parsePresenceUpdate({ ...base, source: { ...base.source, label: "x".repeat(97) } })).toBeNull();
    expect(parsePresenceUpdate({ ...base, source: { ...base.source, label: "😀".repeat(96) } })).not.toBeNull();
    expect(parsePresenceUpdate({ ...base, source: { ...base.source, label: "😀".repeat(97) } })).toBeNull();
    expect(registry.accept(base)).toBe(true);
    expect(registry.accept(base)).toBe(false);
    expect(registry.accept({ ...base, sequence: 2, generation: 0 })).toBe(false);
    expect(registry.accept({ ...base, sequence: 1, generation: 2, state: "success", counts: { active: 0, completed: 1, failed: 0 } })).toBe(true);
    expect(registry.accept({ ...base, sequence: 1, generation: 2 })).toBe(false);
    expect(registry.snapshot()[0]?.state).toBe("success");
  });
  test("accepts the full safe generation/sequence domain and canonicalizes untrusted input", () => {
    const maximum = Number.MAX_SAFE_INTEGER;
    const input = { ...base, source: { ...base.source }, counts: { ...base.counts }, generation: maximum, sequence: maximum };
    const parsed = parsePresenceUpdate(input);
    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
    input.source.label = "Changed after parsing";
    expect(parsed?.source.label).toBe("Worker");
    expect(parsePresenceUpdate({ ...base, generation: maximum + 1 })).toBeNull();
    expect(parsePresenceUpdate({ ...base, sequence: 0 })).toBeNull();
    expect(parsePresenceUpdate({ ...base, counts: { ...base.counts, active: MAX_COUNT + 1 } })).toBeNull();
    expect(parsePresenceUpdate({ ...base, source: { ...base.source, extra: "no" } })).toBeNull();
    expect(parsePresenceUpdate({ ...base, counts: { ...base.counts, extra: 1 } })).toBeNull();
    expect(parsePresenceUpdate({ ...base, progress: { ...base.progress, extra: true } })).toBeNull();
    expect(parsePresenceUpdate({ ...base, usage: { tokens: 1, extra: true } })).toBeNull();
    expect(parsePresenceUpdate(new Proxy({}, { getPrototypeOf() { throw new Error("nope"); } }))).toBeNull();
    expect(parsePresenceUpdate({ ...base, source: new Proxy(base.source, { get() { throw new Error("nope"); } }) })).toBeNull();
  });
  test("uses fixed-length SHA-256 status keys for maximum-length source IDs", () => {
    const key = presenceStatusKey("x".repeat(96));
    expect(key).toMatch(/^pi-presence:[a-f0-9]{64}$/);
    expect(key).toHaveLength("pi-presence:".length + 64);
  });
  test("requires both canonical target identities", () => {
    const target = "00000000-0000-4000-8000-000000000000";
    expect(readCmuxIdentity({ CMUX_WORKSPACE_ID: "not-a-uuid", CMUX_SURFACE_ID: target })).toBeNull();
    expect(readCmuxIdentity({ CMUX_WORKSPACE_ID: target })).toBeNull();
    expect(readCmuxIdentity({ CMUX_SURFACE_ID: target })).toBeNull();
    expect(readCmuxIdentity({ CMUX_WORKSPACE_ID: target, CMUX_SURFACE_ID: target })).not.toBeNull();
  });
  test("strictly parses authority-free ready requests and additive count fields", () => {
    expect(parsePresenceReady({ version: 1, sessionId })).toEqual({ version: 1, sessionId });
    expect(parsePresenceReady({ version: 1, sessionId, consumer: { id: "pi-cmux-presence", capabilities: ["cmux-status", "cmux-progress"] } })).toEqual({ version: 1, sessionId, consumer: { id: "pi-cmux-presence", capabilities: ["cmux-status", "cmux-progress"] } });
    expect(parsePresenceReady({ version: 1, sessionId, consumer: { id: "x", capabilities: Array(17).fill("x") } })).toBeNull();
    expect(parsePresenceReady({ version: 1, sessionId, source: "no" })).toBeNull();
    expect(parsePresenceReady({ version: 1, sessionId: "bad\u202e" })).toBeNull();
    expect(parsePresenceUpdate({ ...base, state: "waiting", counts: { active: 0, completed: 1, failed: 0, queued: 2, cancelled: 1, total: 4 } })?.counts).toMatchObject({ queued: 2, cancelled: 1, total: 4 });
    expect(parsePresenceUpdate({ ...base, source: { ...base.source, label: "bad\u0085" } })).toBeNull();
    for (const directional of ["\u061c", "\u200e", "\u200f", "\u2028", "\u2029", "\u202a", "\u2066"]) expect(parsePresenceUpdate({ ...base, source: { ...base.source, label: `bad${directional}` } })).toBeNull();
  });
  test("accepts the RPIV TaskDetails envelope and never copies descriptive task text", () => {
    const adapter = new TodoProgressAdapter();
    const tools = [{ name: "todo", sourceInfo: { path: "/safe/todo.ts", source: "project", scope: "project", origin: "top-level" } }];
    const details = { action: "list", params: {}, nextId: 5, tasks: [{ id: 1, status: "completed", subject: "secret" }, { id: 2, status: "in_progress", description: "private" }, { id: 3, status: "pending" }, { id: 4, status: "deleted" }] };
    const valid = adapter.accept({ toolName: "todo", isError: false, content: [{ text: "secret" }], details }, tools, sessionId, 1, 2);
    expect(valid).toMatchObject({ source: { id: "pi-todo" }, counts: { active: 1, completed: 1, queued: 1, total: 3 }, progress: { value: 1 / 3 } });
    expect(JSON.stringify(valid)).not.toContain("secret");
    expect(adapter.accept({ toolName: "todo", isError: false, details: { ...details, tasks: [{ id: 9, status: "completed" }] } }, tools, sessionId, 1, 3)).toMatchObject({ state: "success", progress: { value: 1 }, counts: { total: 1 } });
    expect(adapter.accept({ toolName: "todo", isError: false, details: { ...details, tasks: [{ id: 1, status: "pending" }, { id: 1, status: "completed" }] } }, tools, sessionId, 1, 3)).toBeNull();
    for (const tasks of [
      [{ id: 7, status: "deleted" }, { id: 7, status: "deleted" }],
      [{ id: 7, status: "deleted" }, { id: 7, status: "pending" }],
      [{ id: 7, status: "completed" }, { id: 7, status: "deleted" }],
    ]) {
      expect(adapter.accept({ toolName: "todo", isError: false, details: { ...details, tasks } }, tools, sessionId, 1, 3)).toBeNull();
    }
    expect(adapter.accept({ toolName: "todo", isError: false, details: { ...details, extra: true } }, tools, sessionId, 1, 4)).toBeNull();
    expect(adapter.accept({ toolName: "todo", isError: false, details: { ...details, tasks: [{ id: 0, status: "pending" }] } }, tools, sessionId, 1, 5)).toBeNull();
    expect(adapter.accept({ toolName: "todo", isError: false, details: { ...details, tasks: [] } }, [{ name: "todo", sourceInfo: { path: "/changed", source: "project", scope: "project", origin: "top-level" } }], sessionId, 1, 6)).toBeNull();
  });
  test("tracks reported tokens, cost, and optional context usage", () => {
    const usage = new UsageTracker();
    usage.add({ input: 10, output: 5, cacheRead: 2, cost: { total: 0.03 } });
    usage.setContext({ percent: 42 });
    expect(usage.snapshot()).toEqual({ tokens: 17, cost: 0.03, contextPercent: 42 });
  });
});
