import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { basename, join } from "node:path";
import extension from "../index.js";
import { PI_PRESENCE_UPDATE_EVENT, type PresenceUpdate } from "../src/events.js";
import { fakeSocket } from "./helpers/fake-socket.js";
import { presenceStatusKey } from "../src/presence.js";

test("entrypoint registers lifecycle and generic event observers without tools", () => {
  const previousEnabled = process.env.PI_CMUX_PRESENCE_ENABLED;
  process.env.PI_CMUX_PRESENCE_ENABLED = "true";
  try {
    const hooks: string[] = [];
    const events: string[] = [];
    extension({
      on(name: string) { hooks.push(name); },
      events: { on(name: string) { events.push(name); }, emit() {} },
    } as never);
    expect(events).toEqual(["pi-presence:update:v1", "pi-presence:ready:v1"]);
    expect(hooks).toContain("session_start");
    expect(hooks).toContain("tool_result");
    expect(hooks).toContain("agent_settled");
    expect(hooks).toContain("session_shutdown");
  } finally {
    if (previousEnabled === undefined) delete process.env.PI_CMUX_PRESENCE_ENABLED;
    else process.env.PI_CMUX_PRESENCE_ENABLED = previousEnabled;
  }
});

type Hook = (event: any, context?: any) => unknown;
type EventHandler = (payload: unknown) => unknown;

function fakePi() {
  const hooks = new Map<string, Hook[]>();
  const listeners = new Map<string, EventHandler[]>();
  const emitted: Array<{ name: string; payload: unknown }> = [];
  const tools: unknown[] = [];
  return {
    tools,
    api: {
      getAllTools() { return tools; },
      on(name: string, handler: Hook) {
        const handlers = hooks.get(name) ?? [];
        handlers.push(handler);
        hooks.set(name, handlers);
      },
      events: {
        on(name: string, handler: EventHandler) {
          const handlers = listeners.get(name) ?? [];
          handlers.push(handler);
          listeners.set(name, handlers);
        },
        emit(name: string, payload: unknown) {
          emitted.push({ name, payload });
          for (const handler of listeners.get(name) ?? []) void handler(payload);
        },
      },
    },
    emitted,
    emit(name: string, payload: unknown) {
      for (const handler of listeners.get(name) ?? []) void handler(payload);
    },
    async lifecycle(name: string, event: unknown = {}, context?: unknown) {
      for (const handler of hooks.get(name) ?? []) await handler(event, context);
    },
  };
}

const ENV_KEYS = [
  "CMUX_WORKSPACE_ID", "CMUX_SURFACE_ID", "CMUX_SOCKET_PATH", "PI_CODING_AGENT_DIR",
  "PI_CMUX_PRESENCE_ENABLED", "PI_CMUX_PRESENCE_TIMEOUT_MS", "PI_CMUX_PRESENCE_MAX_QUEUE",
  "PI_CMUX_PRESENCE_PROGRESS", "PI_CMUX_PRESENCE_NOTIFICATIONS", "PI_CMUX_PRESENCE_FLASH",
  "PI_CMUX_PRESENCE_LOG", "PI_CMUX_PRESENCE_SIDEBAR", "PI_CMUX_PRESENCE_NATIVE_LIFECYCLE",
  "PI_CMUX_PRESENCE_FEED", "PI_CMUX_PRESENCE_META_BLOCK", "PI_CMUX_PRESENCE_AUTO_TITLE",
  "PI_CMUX_PRESENCE_RESUME_FALLBACK", "PI_CMUX_PRESENCE_FINAL_CLEAR_MS", "PI_CMUX_PRESENCE_MAX_LABEL_CHARS",
];

function replaceEnv(values: Record<string, string>): () => void {
  const previous = new Map(ENV_KEYS.map((name) => [name, process.env[name]]));
  for (const name of ENV_KEYS) {
    if (values[name] === undefined) delete process.env[name];
    else process.env[name] = values[name];
  }
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempts = 0; attempts < 100; attempts += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for fake socket requests.");
}

async function presenceFixture(firstCapabilityGate?: () => Promise<void>) {
  const workspaceId = "00000000-0000-4000-8000-000000000001";
  const surfaceId = "00000000-0000-4000-8000-000000000002";
  const lines: string[] = [];
  const directory = await fs.mkdtemp(join(os.tmpdir(), "presence-lifecycle-"));
  const socketPath = join(directory, "cmux.sock");
  let capabilityRequests = 0;
  const server = await fakeSocket(socketPath, async (line) => {
    lines.push(line);
    if (line.startsWith("{")) {
      const request = JSON.parse(line) as { id: number; method: string };
      if (request.method === "system.capabilities") {
        capabilityRequests += 1;
        if (capabilityRequests === 1) await firstCapabilityGate?.();
      }
      const result = request.method === "system.capabilities"
        ? { protocol: "cmux-socket", version: 2, methods: ["notification.create_for_surface"] }
        : {};
      return JSON.stringify({ id: request.id, ok: true, result });
    }
    return "OK";
  });
  const restoreEnv = replaceEnv({
    CMUX_WORKSPACE_ID: workspaceId,
    CMUX_SURFACE_ID: surfaceId,
    CMUX_SOCKET_PATH: socketPath,
    PI_CMUX_PRESENCE_ENABLED: "true",
    PI_CMUX_PRESENCE_TIMEOUT_MS: "100",
    PI_CMUX_PRESENCE_MAX_QUEUE: "32",
    PI_CMUX_PRESENCE_PROGRESS: "true",
    PI_CMUX_PRESENCE_NOTIFICATIONS: "true",
    PI_CMUX_PRESENCE_FLASH: "true",
    PI_CMUX_PRESENCE_LOG: "false",
    PI_CMUX_PRESENCE_SIDEBAR: "true",
    PI_CMUX_PRESENCE_FINAL_CLEAR_MS: "60000",
  });
  return {
    workspaceId, surfaceId, lines,
    cleanup: async () => { restoreEnv(); await server.close(); await fs.rm(directory, { recursive: true, force: true }); },
  };
}

test("lifecycle observes Pi and generic producers through only the targeted fake socket", async () => {
  const fixture = await presenceFixture();
  try {
    const pi = fakePi();
    extension(pi.api as never);
    const sessionId = "lifecycle-session";
    await pi.lifecycle("session_start", {}, { sessionManager: { getSessionId: () => sessionId } });
    await pi.lifecycle("agent_start");
    await pi.lifecycle("tool_result", { isError: true });
    await pi.lifecycle("agent_end", { messages: [{ stopReason: "stop" }] });
    await pi.lifecycle("agent_settled");

    const producer: PresenceUpdate = {
      version: 1,
      sessionId,
      generation: 9,
      sequence: 1,
      source: { id: "arbitrary-producer", label: "Any producer", kind: "custom" },
      state: "success",
      counts: { active: 0, completed: 1, failed: 0 },
      attention: "success",
    };
    pi.emit(PI_PRESENCE_UPDATE_EVENT, producer);
    await waitFor(() => fixture.lines.some((line) => line.includes("Pi: error · 1 failed")) && fixture.lines.some((line) => line.includes("Any producer: success · 1 done")));
    await pi.lifecycle("session_shutdown");

    const v1 = fixture.lines.filter((line) => !line.startsWith("{"));
    const v2 = fixture.lines.filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
    const localUpdates = pi.emitted
      .filter((event) => event.name === PI_PRESENCE_UPDATE_EVENT)
      .map((event) => event.payload as PresenceUpdate)
      .filter((event) => event.source.id === "pi");
    const localKey = presenceStatusKey("pi", fixture.surfaceId);
    const producerKey = presenceStatusKey("arbitrary-producer", fixture.surfaceId);

    expect(localUpdates).toHaveLength(3);
    expect(localUpdates.every((event) => event.progress === undefined)).toBe(true);
    expect(v1.some((line) => line.startsWith("set_progress "))).toBe(false);
    expect(v1).toContain(`set_status ${localKey} "Pi: error · 1 failed" --icon=x --color=#dc2626 --priority=40 --tab=${fixture.workspaceId} --panel=00000000-0000-4000-8000-000000000002`);
    expect(v1).toContain(`set_status ${producerKey} "Any producer: success · 1 done" --icon=check --color=#16a34a --priority=20 --tab=${fixture.workspaceId} --panel=00000000-0000-4000-8000-000000000002`);
    expect(v1).toContain(`clear_status ${localKey} --tab=${fixture.workspaceId}`);
    expect(v1).toContain(`clear_status ${producerKey} --tab=${fixture.workspaceId}`);
    expect(v1.filter((line) => /^(set_status|clear_status) /.test(line)).every((line) => line.includes(`--tab=${fixture.workspaceId}`))).toBe(true);
    expect(v2).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: "notification.create_for_surface",
        params: expect.objectContaining({ workspace_id: fixture.workspaceId, surface_id: "00000000-0000-4000-8000-000000000002", title: "Any producer" }),
      }),
    ]));
    expect(v2.some((request) => request.method === "surface.trigger_flash")).toBe(false);
  } finally {
    await fixture.cleanup();
  }
});

test("matching ready replays retained local state with fresh sequence and no attention", async () => {
  const fixture = await presenceFixture();
  try {
    const pi = fakePi(); extension(pi.api as never);
    const sessionId = "ready-session";
    pi.tools.push({ name: "todo", sourceInfo: { path: "/safe/todo.ts", source: "project", scope: "project", origin: "top-level" } });
    await pi.lifecycle("session_start", {}, { sessionManager: { getSessionId: () => sessionId } });
    await pi.lifecycle("tool_result", { toolName: "todo", isError: false, details: { action: "list", params: {}, nextId: 2, tasks: [{ id: 1, status: "completed" }] } });
    const before = pi.emitted.filter((event) => event.name === PI_PRESENCE_UPDATE_EVENT).map((event) => event.payload as PresenceUpdate).filter((event) => event.source.id === "pi").at(-1)!;
    pi.emit("pi-presence:ready:v1", { version: 1, sessionId });
    const replay = pi.emitted.filter((event) => event.name === PI_PRESENCE_UPDATE_EVENT).map((event) => event.payload as PresenceUpdate).filter((event) => event.source.id === "pi").at(-1)!;
    const todoReplay = pi.emitted.filter((event) => event.name === PI_PRESENCE_UPDATE_EVENT).map((event) => event.payload as PresenceUpdate).filter((event) => event.source.id === "pi-todo").at(-1)!;
    expect(replay.sequence).toBeGreaterThan(before.sequence);
    expect(replay.attention).toBe("none");
    expect(todoReplay).toMatchObject({ state: "success", attention: "none", progress: { value: 1 } });
    await pi.lifecycle("session_shutdown");
  } finally { await fixture.cleanup(); }
});

test("official hook suppresses only local completion attention", async () => {
  const fixture = await presenceFixture();
  const agentDir = await fs.mkdtemp(join(os.tmpdir(), "presence-official-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    await fs.mkdir(join(agentDir, "extensions"));
    await fs.writeFile(join(agentDir, "extensions", "cmux-session.ts"), "cmux-pi-session-extension-marker v2");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const pi = fakePi(); extension(pi.api as never);
    const sessionId = "official-session";
    await pi.lifecycle("session_start", {}, { sessionManager: { getSessionId: () => sessionId } });
    await pi.lifecycle("agent_start"); await pi.lifecycle("agent_end", { messages: [{ stopReason: "stop" }] }); await pi.lifecycle("agent_settled");
    pi.emit(PI_PRESENCE_UPDATE_EVENT, { version: 1, sessionId, generation: 2, sequence: 1, source: { id: "external", label: "External", kind: "task" }, state: "success", counts: { active: 0, completed: 1, failed: 0 }, attention: "success" });
    await waitFor(() => fixture.lines.some((line) => line.includes("External: success")) && fixture.lines.some((line) => line.includes('"title":"External"')));
    const notifications = fixture.lines.filter((line) => line.startsWith("{")).map((line) => JSON.parse(line)).filter((request) => request.method === "notification.create_for_surface");
    expect(notifications.some((request) => request.params.title === "Pi")).toBe(false);
    expect(notifications.some((request) => request.params.title === "External")).toBe(true);
    await pi.lifecycle("session_shutdown");
  } finally { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; await fs.rm(agentDir, { recursive: true, force: true }); await fixture.cleanup(); }
});

test("metadata block is raw numeric aggregate data without task or source text", async () => {
  const fixture = await presenceFixture();
  try {
    process.env.PI_CMUX_PRESENCE_META_BLOCK = "true";
    const pi = fakePi(); extension(pi.api as never);
    await pi.lifecycle("session_start", {}, { sessionManager: { getSessionId: () => "metadata-session" } });
    await waitFor(() => fixture.lines.some((line) => line.startsWith("report_meta_block ")));
    const line = fixture.lines.find((candidate) => candidate.startsWith("report_meta_block "))!;
    const body = line.slice(line.indexOf(" -- ") + 4);
    expect(body).toMatch(/^\d+(?:\\n\d+){6}\\n\d+\.\d{2}\\n\d+$/);
    expect(body).not.toContain('"');
    await pi.lifecycle("session_shutdown");
  } finally { await fixture.cleanup(); }
});

test("preserves aggregate usage across agent continuations and ignores forged local source events", async () => {
  const fixture = await presenceFixture();
  try {
    const pi = fakePi();
    extension(pi.api as never);
    const sessionId = "aggregate-session";
    await pi.lifecycle("session_start", {}, { sessionManager: { getSessionId: () => sessionId } });
    await pi.lifecycle("agent_start");
    await pi.lifecycle("message_end", { message: { role: "assistant", usage: { totalTokens: 10, cost: 0.01 } } });
    await pi.lifecycle("agent_end", { messages: [{ stopReason: "stop" }] });
    await pi.lifecycle("agent_start");
    await pi.lifecycle("tool_result", { isError: true });
    await pi.lifecycle("message_end", { message: { role: "assistant", usage: { totalTokens: 20, cost: 0.02 } } });
    await pi.lifecycle("agent_end", { messages: [{ stopReason: "stop" }] });
    pi.emit(PI_PRESENCE_UPDATE_EVENT, {
      version: 1, sessionId, generation: 99, sequence: 1,
      source: { id: "pi", label: "Forged", kind: "untrusted" }, state: "success",
      counts: { active: 0, completed: 999, failed: 0 },
    });
    await pi.lifecycle("agent_settled");
    await waitFor(() => fixture.lines.some((line) => line.includes("Pi: error · 1 failed · 30 tokens · $0.03")));
    const localUpdates = pi.emitted.filter((event) => event.name === PI_PRESENCE_UPDATE_EVENT).map((event) => event.payload as PresenceUpdate).filter((event) => event.source.id === "pi");
    expect(localUpdates.at(-1)).toMatchObject({ state: "error", counts: { active: 0, completed: 0, failed: 1 }, usage: { tokens: 30, cost: 0.03 } });
    expect(fixture.lines.some((line) => line.includes("Forged"))).toBe(false);
    await pi.lifecycle("session_shutdown");
  } finally {
    await fixture.cleanup();
  }
});

test("settled does not finalize a run started by an earlier settled handler", async () => {
  const fixture = await presenceFixture();
  try {
    const pi = fakePi();
    let restarted = false;
    pi.api.on("agent_settled", async () => {
      if (restarted) return;
      restarted = true;
      await pi.lifecycle("agent_start");
    });
    extension(pi.api as never);
    await pi.lifecycle("session_start", {}, { sessionManager: { getSessionId: () => "reentrant-session" } });
    await pi.lifecycle("agent_start");
    await pi.lifecycle("agent_end", { messages: [{ stopReason: "stop" }] });
    await pi.lifecycle("agent_settled", {}, { isIdle: () => false });
    const localUpdates = pi.emitted.filter((event) => event.name === PI_PRESENCE_UPDATE_EVENT).map((event) => event.payload as PresenceUpdate).filter((event) => event.source.id === "pi");
    expect(localUpdates.at(-1)).toMatchObject({ state: "running", counts: { active: 1, completed: 0, failed: 0 } });
    await pi.lifecycle("session_shutdown");
  } finally {
    await fixture.cleanup();
  }
});

test("cancelled runs do not increment completed or failed counts", async () => {
  const fixture = await presenceFixture();
  try {
    const pi = fakePi();
    extension(pi.api as never);
    await pi.lifecycle("session_start", {}, { sessionManager: { getSessionId: () => "cancel-session" } });
    await pi.lifecycle("agent_start");
    await pi.lifecycle("agent_end", { messages: [{ stopReason: "aborted" }] });
    await pi.lifecycle("agent_settled");
    const localUpdates = pi.emitted.filter((event) => event.name === PI_PRESENCE_UPDATE_EVENT).map((event) => event.payload as PresenceUpdate).filter((event) => event.source.id === "pi");
    expect(localUpdates.at(-1)).toMatchObject({ state: "cancelled", counts: { active: 0, completed: 0, failed: 0 } });
    await pi.lifecycle("session_shutdown");
  } finally {
    await fixture.cleanup();
  }
});

test("progress-disabled sessions never mutate workspace progress during startup or shutdown", async () => {
  const fixture = await presenceFixture();
  try {
    process.env.PI_CMUX_PRESENCE_PROGRESS = "false";
    const pi = fakePi();
    extension(pi.api as never);
    await pi.lifecycle("session_start", {}, { sessionManager: { getSessionId: () => "no-progress-session" } });
    await pi.lifecycle("session_shutdown");

    expect(fixture.lines.some((line) => /^(set_progress|clear_progress)\b/.test(line))).toBe(false);
  } finally {
    await fixture.cleanup();
  }
});

test("tilde agent directories preserve official hook precedence", async () => {
  const fixture = await presenceFixture();
  const agentDir = await fs.mkdtemp(join(os.homedir(), ".presence-official-"));
  try {
    await fs.mkdir(join(agentDir, "extensions"));
    await fs.writeFile(
      join(agentDir, "extensions", "cmux-session.ts"),
      "cmux-pi-session-extension-marker v2",
    );
    process.env.PI_CODING_AGENT_DIR = `~/${basename(agentDir)}`;

    const pi = fakePi();
    extension(pi.api as never);
    await pi.lifecycle("session_start", {}, { sessionManager: { getSessionId: () => "tilde-session" } });
    await waitFor(() => fixture.lines.some((line) => line.startsWith("set_status ")));
    await pi.lifecycle("session_shutdown");

    expect(fixture.lines.some((line) => line.startsWith("set_agent_pid "))).toBe(false);
    expect(fixture.lines.some((line) => line.startsWith("set_agent_lifecycle "))).toBe(false);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
    await fixture.cleanup();
  }
});

test("invalid session IDs fail closed without rejecting lifecycle hooks and later recover", async () => {
  const fixture = await presenceFixture();
  try {
    const pi = fakePi();
    extension(pi.api as never);
    const invalidIds: unknown[] = ["", "x".repeat(97), "bad\u202e", "😀".repeat(97), undefined];

    for (const invalidId of invalidIds) {
      await expect(pi.lifecycle("session_start", {}, {
        sessionManager: { getSessionId: () => invalidId },
      })).resolves.toBeUndefined();
      await pi.lifecycle("agent_start");
      await pi.lifecycle("session_shutdown");
    }
    await expect(pi.lifecycle("session_start", {}, {
      sessionManager: { getSessionId: () => { throw new Error("unavailable"); } },
    })).resolves.toBeUndefined();

    expect(fixture.lines).toEqual([]);
    expect(pi.emitted.some((event) => event.name === PI_PRESENCE_UPDATE_EVENT)).toBe(false);
    expect(pi.emitted.some((event) => event.name === "pi-presence:ready:v1")).toBe(false);

    await pi.lifecycle("session_start", {}, {
      sessionManager: { getSessionId: () => "recovered-session" },
    });
    await waitFor(() => fixture.lines.some((line) => line.startsWith("set_status ")));
    const recovered = pi.emitted
      .filter((event) => event.name === PI_PRESENCE_UPDATE_EVENT)
      .map((event) => event.payload as PresenceUpdate);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.sessionId).toBe("recovered-session");
    await pi.lifecycle("session_shutdown");
  } finally {
    await fixture.cleanup();
  }
});

test("an invalid replacement session clears the previous session outputs", async () => {
  const fixture = await presenceFixture();
  try {
    const pi = fakePi();
    extension(pi.api as never);
    await pi.lifecycle("session_start", {}, {
      sessionManager: { getSessionId: () => "valid-before-invalid" },
    });
    await waitFor(() => fixture.lines.some((line) => line.startsWith("set_status ")));
    const oldKey = presenceStatusKey("pi", fixture.surfaceId);

    await pi.lifecycle("session_start", {}, {
      sessionManager: { getSessionId: () => "x".repeat(97) },
    });

    expect(fixture.lines).toContain(`clear_status ${oldKey} --tab=${fixture.workspaceId}`);
    expect(fixture.lines.filter((line) => line.startsWith("set_status "))).toHaveLength(1);
  } finally {
    await fixture.cleanup();
  }
});

test("shutdown teardown finishes before a concurrently started session publishes", async () => {
  const fixture = await presenceFixture();
  try {
    const pi = fakePi();
    extension(pi.api as never);
    await pi.lifecycle("session_start", {}, {
      sessionManager: { getSessionId: () => "old-before-shutdown" },
    });
    await waitFor(() => fixture.lines.some((line) => line.startsWith("set_status ")));
    const oldKey = presenceStatusKey("pi", fixture.surfaceId);

    const shutdown = pi.lifecycle("session_shutdown");
    const restart = pi.lifecycle("session_start", {}, {
      sessionManager: { getSessionId: () => "new-after-shutdown" },
    });
    await Promise.all([shutdown, restart]);
    await waitFor(() => fixture.lines.filter((line) => line.startsWith("set_status ")).length === 2);

    const clearIndex = fixture.lines.indexOf(`clear_status ${oldKey} --tab=${fixture.workspaceId}`);
    const statusIndices = fixture.lines
      .map((line, index) => line.startsWith("set_status ") ? index : -1)
      .filter((index) => index >= 0);
    const newStatusIndex = statusIndices.at(-1) ?? -1;
    expect(clearIndex).toBeGreaterThan(-1);
    expect(newStatusIndex).toBeGreaterThan(clearIndex);
    await pi.lifecycle("session_shutdown");
  } finally {
    await fixture.cleanup();
  }
});

test("a delayed stale capability probe cannot clear newer session progress", async () => {
  let releaseCapability!: () => void;
  const capabilityGate = new Promise<void>((resolve) => { releaseCapability = resolve; });
  const fixture = await presenceFixture(() => capabilityGate);
  try {
    const pi = fakePi();
    extension(pi.api as never);
    const first = pi.lifecycle("session_start", {}, {
      sessionManager: { getSessionId: () => "delayed-old-session" },
    });
    await waitFor(() => fixture.lines.some((line) => line.includes('"method":"system.capabilities"')));

    await pi.lifecycle("session_start", {}, {
      sessionManager: { getSessionId: () => "current-session" },
    });
    pi.emit(PI_PRESENCE_UPDATE_EVENT, {
      version: 1,
      sessionId: "current-session",
      generation: 1,
      sequence: 1,
      source: { id: "progress-owner", label: "Progress owner", kind: "task" },
      state: "running",
      counts: { active: 1, completed: 0, failed: 0 },
      progress: { value: 0.5, label: "Current progress" },
    });
    await waitFor(() => fixture.lines.some((line) => line.startsWith("set_progress ")));
    const progressIndex = fixture.lines.findIndex((line) => line.startsWith("set_progress "));

    releaseCapability();
    await first;
    expect(fixture.lines.slice(progressIndex + 1).some((line) => line.startsWith("clear_progress"))).toBe(false);
    await pi.lifecycle("session_shutdown");
  } finally {
    releaseCapability();
    await fixture.cleanup();
  }
});

test("a stale session start cannot publish or install after a newer start", async () => {
  const fixture = await presenceFixture();
  try {
    const pi = fakePi();
    extension(pi.api as never);
    const first = pi.lifecycle("session_start", {}, { sessionManager: { getSessionId: () => "old-session" } });
    const second = pi.lifecycle("session_start", {}, { sessionManager: { getSessionId: () => "new-session" } });
    await Promise.all([first, second]);
    const localUpdates = pi.emitted.filter((event) => event.name === PI_PRESENCE_UPDATE_EVENT).map((event) => event.payload as PresenceUpdate).filter((event) => event.source.id === "pi");
    expect(localUpdates).toHaveLength(1);
    expect(localUpdates[0]?.sessionId).toBe("new-session");
    await pi.lifecycle("session_shutdown");
  } finally {
    await fixture.cleanup();
  }
});
