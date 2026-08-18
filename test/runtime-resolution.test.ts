import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import type { PresenceConfig } from "../src/config.js";
import { registerPresenceHooks } from "../src/hooks.js";
import { PresenceRuntime } from "../src/runtime.js";
import { UnresolvedSocketFingerprintGate } from "../src/transport.js";
import { fakeSocket } from "./helpers/fake-socket.js";

const config: PresenceConfig = {
  enabled: true,
  timeoutMs: 100,
  maxQueue: 2,
  progress: false,
  notifications: false,
  flash: false,
  notificationPolicy: "disabled",
  flashPolicy: "disabled",
  subagentChildProfile: false,
  suppressNativeNotifications: false,
  suppressNativeFlash: false,
  log: false,
  sidebar: false,
  nativeLifecycle: false,
  feed: false,
  metaBlock: false,
  autoTitle: false,
  resumeFallback: false,
  finalClearMs: 0,
  maxLabelChars: 96,
};

function fakePi(emitted: unknown[]) {
  return {
    getAllTools: () => [],
    events: {
      emit: (_name: string, payload: unknown) => { emitted.push(payload); },
      on: () => {},
    },
  };
}

/** A local V2 bus so runtime-produced terminals reach its registered consumer. */
function eventedPi(emitted: Array<{ name: string; payload: unknown }>) {
  const listeners = new Map<string, Array<(payload: unknown) => unknown>>();
  return {
    getAllTools: () => [],
    on: () => {},
    events: {
      emit(name: string, payload: unknown) {
        emitted.push({ name, payload });
        for (const listener of listeners.get(name) ?? []) void listener(payload);
      },
      on(name: string, listener: (payload: unknown) => unknown) {
        listeners.set(name, [...(listeners.get(name) ?? []), listener]);
      },
    },
  };
}

function session(id: string) {
  return { sessionManager: { getSessionId: () => id } };
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  for (let elapsed = 0; elapsed < timeoutMs; elapsed += 2) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Timed out waiting for runtime output.");
}

class ManualRuntimeClock {
  private nowMs = 0;
  private readonly timers: Array<{ due: number; callback: () => void; cleared: boolean }> = [];

  now = () => this.nowMs;
  setTimeout = (callback: () => void, delayMs: number) => {
    const timer = { due: this.nowMs + delayMs, callback, cleared: false, unref() {} };
    this.timers.push(timer);
    return timer as unknown as ReturnType<typeof setTimeout>;
  };
  clearTimeout = (timer: ReturnType<typeof setTimeout>) => {
    (timer as unknown as { cleared: boolean }).cleared = true;
  };
  advance(ms: number): void {
    const target = this.nowMs + ms;
    while (true) {
      const timer = this.timers.filter((candidate) => !candidate.cleared && candidate.due <= target)
        .sort((left, right) => left.due - right.due)[0];
      if (!timer) break;
      this.nowMs = timer.due;
      timer.cleared = true;
      timer.callback();
    }
    this.nowMs = target;
  }
}

test("lifecycle callbacks return immediately while a socket resolver is stalled", async () => {
  const previousWorkspace = process.env.CMUX_WORKSPACE_ID;
  const previousSurface = process.env.CMUX_SURFACE_ID;
  process.env.CMUX_WORKSPACE_ID = "00000000-0000-4000-8000-000000000011";
  process.env.CMUX_SURFACE_ID = "00000000-0000-4000-8000-000000000012";
  const emitted: unknown[] = [];
  const hooks = new Map<string, Array<(event: unknown, context?: unknown) => unknown>>();
  let resolverCalls = 0;
  let releaseResolver: ((path: string | null) => void) | undefined;
  const runtime = new PresenceRuntime(
    {
      ...fakePi(emitted),
      on(name: string, handler: (event: unknown, context?: unknown) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
    } as never,
    config,
    undefined,
    async () => false,
    () => new Promise<string | null>((resolve) => {
      resolverCalls += 1;
      releaseResolver = resolve;
    }),
  );
  registerPresenceHooks(
    {
      ...fakePi(emitted),
      on(name: string, handler: (event: unknown, context?: unknown) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
    } as never,
    runtime,
  );

  try {
    const start = hooks.get("session_start")?.[0];
    const shutdown = hooks.get("session_shutdown")?.[0];
    expect(start).toBeDefined();
    expect(shutdown).toBeDefined();
    expect(start!({}, session("hook-pending"))).toBeUndefined();
    await nextTurn();
    expect(resolverCalls).toBe(1);

    // The start epoch exists before resolver completion, so these callbacks
    // retain and publish the terminal rather than being dropped as pre-session.
    hooks.get("agent_start")?.[0]({});
    hooks.get("agent_end")?.[0]({ messages: [{ stopReason: "stop" }] });
    hooks.get("agent_settled")?.[0]({}, { isIdle: () => true });
    expect(emitted.length).toBeGreaterThanOrEqual(2);
    expect((runtime as unknown as {
      localPresentation: Map<string, { state: string }>;
    }).localPresentation.get("pi")?.state).toBe("success");

    expect(shutdown!({})).toBeUndefined();
    releaseResolver?.(null);
    await nextTurn();
  } finally {
    await runtime.shutdownSession();
    releaseResolver?.(null);
    if (previousWorkspace === undefined) delete process.env.CMUX_WORKSPACE_ID;
    else process.env.CMUX_WORKSPACE_ID = previousWorkspace;
    if (previousSurface === undefined) delete process.env.CMUX_SURFACE_ID;
    else process.env.CMUX_SURFACE_ID = previousSurface;
  }
});

test("a second agent start invalidates a detached startup terminal from the first run", async () => {
  const previousWorkspace = process.env.CMUX_WORKSPACE_ID;
  const previousSurface = process.env.CMUX_SURFACE_ID;
  const previousSocket = process.env.CMUX_SOCKET_PATH;
  const directory = await fs.mkdtemp(join(os.tmpdir(), "presence-runtime-startup-order-"));
  const socketPath = join(directory, "cmux.sock");
  const lines: string[] = [];
  const server = await fakeSocket(socketPath, (line) => {
    lines.push(line);
    if (!line.startsWith("{")) return "OK";
    const request = JSON.parse(line) as { id: number; method: string };
    return JSON.stringify({
      id: request.id,
      ok: true,
      result: request.method === "system.capabilities"
        ? { protocol: "cmux-socket", version: 2, methods: ["notification.create_for_surface"] }
        : {},
    });
  });
  process.env.CMUX_WORKSPACE_ID = "00000000-0000-4000-8000-000000000013";
  process.env.CMUX_SURFACE_ID = "00000000-0000-4000-8000-000000000014";
  process.env.CMUX_SOCKET_PATH = socketPath;
  const emitted: Array<{ name: string; payload: unknown }> = [];
  const api = eventedPi(emitted);
  let releaseSocket: ((path: string | null) => void) | undefined;
  let socketStarted: (() => void) | undefined;
  const startedSocket = new Promise<void>((resolve) => { socketStarted = resolve; });
  const runtime = new PresenceRuntime(
    api as never,
    { ...config, notifications: true, notificationPolicy: "all" },
    undefined,
    async () => false,
    () => new Promise<string | null>((resolve) => {
      releaseSocket = resolve;
      socketStarted?.();
    }),
  );
  registerPresenceHooks(api as never, runtime);

  try {
    const startup = runtime.startSession(session("startup-order"));
    await startedSocket;
    runtime.handleAgentStart();
    runtime.handleAgentEnd({ messages: [{ stopReason: "stop" }] });
    runtime.handleAgentSettled({ isIdle: () => true });
    expect(runtime as unknown as {
      pendingLocalTerminalAttention: { sessionEpoch: number; parentRunRevision: number } | null;
    }).toMatchObject({
      pendingLocalTerminalAttention: { sessionEpoch: 1, parentRunRevision: 1 },
    });

    // This is a distinct parent run, even though setup still has no client.
    runtime.handleAgentStart();
    expect(runtime as unknown as { parentRunRevision: number; pendingLocalTerminalAttention: unknown }).toMatchObject({
      parentRunRevision: 2,
      pendingLocalTerminalAttention: null,
    });
    releaseSocket?.(socketPath);
    await startup;
    await waitFor(() => lines.some((line) => line.includes('"method":"system.capabilities"')));
    await nextTurn();
    expect(lines.filter((line) => line.includes('"method":"notification.create_for_surface"'))).toHaveLength(0);
  } finally {
    releaseSocket?.(socketPath);
    await runtime.shutdownSession();
    if (previousWorkspace === undefined) delete process.env.CMUX_WORKSPACE_ID;
    else process.env.CMUX_WORKSPACE_ID = previousWorkspace;
    if (previousSurface === undefined) delete process.env.CMUX_SURFACE_ID;
    else process.env.CMUX_SURFACE_ID = previousSurface;
    if (previousSocket === undefined) delete process.env.CMUX_SOCKET_PATH;
    else process.env.CMUX_SOCKET_PATH = previousSocket;
    await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a late official hook suppresses a terminal retained through slow hook and socket startup", async () => {
  const previousWorkspace = process.env.CMUX_WORKSPACE_ID;
  const previousSurface = process.env.CMUX_SURFACE_ID;
  const previousSocket = process.env.CMUX_SOCKET_PATH;
  const directory = await fs.mkdtemp(join(os.tmpdir(), "presence-runtime-hook-precedence-"));
  const socketPath = join(directory, "cmux.sock");
  const lines: string[] = [];
  const server = await fakeSocket(socketPath, (line) => {
    lines.push(line);
    if (!line.startsWith("{")) return "OK";
    const request = JSON.parse(line) as { id: number; method: string };
    return JSON.stringify({
      id: request.id,
      ok: true,
      result: request.method === "system.capabilities"
        ? { protocol: "cmux-socket", version: 2, methods: ["notification.create_for_surface"] }
        : {},
    });
  });
  process.env.CMUX_WORKSPACE_ID = "00000000-0000-4000-8000-000000000015";
  process.env.CMUX_SURFACE_ID = "00000000-0000-4000-8000-000000000016";
  process.env.CMUX_SOCKET_PATH = socketPath;
  const emitted: Array<{ name: string; payload: unknown }> = [];
  const api = eventedPi(emitted);
  let releaseProbe: ((detected: boolean) => void) | undefined;
  let probeStarted: (() => void) | undefined;
  const startedProbe = new Promise<void>((resolve) => { probeStarted = resolve; });
  let releaseSocket: ((path: string | null) => void) | undefined;
  let socketStarted: (() => void) | undefined;
  const startedSocket = new Promise<void>((resolve) => { socketStarted = resolve; });
  const runtime = new PresenceRuntime(
    api as never,
    { ...config, notifications: true, notificationPolicy: "all" },
    undefined,
    () => new Promise<boolean>((resolve) => {
      releaseProbe = resolve;
      probeStarted?.();
    }),
    () => new Promise<string | null>((resolve) => {
      releaseSocket = resolve;
      socketStarted?.();
    }),
  );
  registerPresenceHooks(api as never, runtime);

  try {
    const startup = runtime.startSession(session("hook-precedence"));
    await startedProbe;
    runtime.handleAgentStart();
    runtime.handleAgentEnd({ messages: [{ stopReason: "stop" }] });
    runtime.handleAgentSettled({ isIdle: () => true });
    expect(runtime as unknown as {
      pendingLocalTerminalAttention: { sessionEpoch: number; parentRunRevision: number } | null;
    }).toMatchObject({
      pendingLocalTerminalAttention: { sessionEpoch: 1, parentRunRevision: 1 },
    });

    releaseProbe?.(true);
    await startedSocket;
    releaseSocket?.(socketPath);
    await startup;
    await waitFor(() => lines.some((line) => line.includes('"method":"system.capabilities"')));
    await nextTurn();
    expect(runtime as unknown as {
      officialHook: boolean;
      pendingLocalTerminalAttention: unknown;
    }).toMatchObject({ officialHook: true, pendingLocalTerminalAttention: null });
    expect(lines.filter((line) => line.includes('"method":"notification.create_for_surface"'))).toHaveLength(0);
  } finally {
    releaseProbe?.(true);
    releaseSocket?.(socketPath);
    await runtime.shutdownSession();
    if (previousWorkspace === undefined) delete process.env.CMUX_WORKSPACE_ID;
    else process.env.CMUX_WORKSPACE_ID = previousWorkspace;
    if (previousSurface === undefined) delete process.env.CMUX_SURFACE_ID;
    else process.env.CMUX_SURFACE_ID = previousSurface;
    if (previousSocket === undefined) delete process.env.CMUX_SOCKET_PATH;
    else process.env.CMUX_SOCKET_PATH = previousSocket;
    await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("stalled socket resolution stays exclusive across deadlines and repeated session epochs", async () => {
  const previousWorkspace = process.env.CMUX_WORKSPACE_ID;
  const previousSurface = process.env.CMUX_SURFACE_ID;
  process.env.CMUX_WORKSPACE_ID = "00000000-0000-4000-8000-000000000021";
  process.env.CMUX_SURFACE_ID = "00000000-0000-4000-8000-000000000022";
  const emitted: unknown[] = [];
  const releases: Array<(path: string | null) => void> = [];
  let invocations = 0;
  const resolveSocketPath = () => new Promise<string | null>((resolve) => {
    invocations += 1;
    releases.push(resolve);
  });
  const runtime = new PresenceRuntime(
    fakePi(emitted) as never,
    config,
    undefined,
    async () => false,
    resolveSocketPath,
  );

  try {
    const started = performance.now();
    await runtime.startSession(session("resolution-first"));
    expect(performance.now() - started).toBeLessThan(250);
    expect(invocations).toBe(1);

    const repeats = [
      runtime.startSession(session("resolution-second")),
      runtime.startSession(session("resolution-third")),
      runtime.startSession(session("resolution-fourth")),
      runtime.startSession(session("resolution-fifth")),
    ];
    await Promise.all(repeats);
    expect(invocations).toBe(1);

    const afterDeadlineAndEpochs = emitted.length;
    releases[0]?.("/late-and-ignored.sock");
    await nextTurn();
    expect(emitted).toHaveLength(afterDeadlineAndEpochs);

    const fresh = runtime.startSession(session("resolution-fresh"));
    await nextTurn();
    expect(invocations).toBe(2);
    const shutdownStarted = performance.now();
    await runtime.shutdownSession();
    await fresh;
    expect(performance.now() - shutdownStarted).toBeLessThan(100);

    const afterShutdown = emitted.length;
    releases[1]?.("/late-and-ignored.sock");
    await nextTurn();
    expect(emitted).toHaveLength(afterShutdown);
  } finally {
    if (previousWorkspace === undefined) delete process.env.CMUX_WORKSPACE_ID;
    else process.env.CMUX_WORKSPACE_ID = previousWorkspace;
    if (previousSurface === undefined) delete process.env.CMUX_SURFACE_ID;
    else process.env.CMUX_SURFACE_ID = previousSurface;
  }
});

test("stalled official-hook probes remain exclusive across epochs and late absence cannot restore native lifecycle", async () => {
  const previousWorkspace = process.env.CMUX_WORKSPACE_ID;
  const previousSurface = process.env.CMUX_SURFACE_ID;
  const previousSocket = process.env.CMUX_SOCKET_PATH;
  const dir = await fs.mkdtemp(join(os.tmpdir(), "presence-runtime-hook-probe-"));
  const socketPath = join(dir, "socket");
  const lines: string[] = [];
  const server = await fakeSocket(socketPath, (line) => {
    lines.push(line);
    if (!line.startsWith("{")) return "OK";
    const request = JSON.parse(line) as { id: number; method: string };
    return JSON.stringify({
      id: request.id,
      ok: true,
      result: request.method === "system.capabilities"
        ? { protocol: "cmux-socket", version: 2, methods: [] }
        : {},
    });
  });
  process.env.CMUX_WORKSPACE_ID = "00000000-0000-4000-8000-000000000041";
  process.env.CMUX_SURFACE_ID = "00000000-0000-4000-8000-000000000042";
  process.env.CMUX_SOCKET_PATH = socketPath;
  const clock = new ManualRuntimeClock();
  let resolveProbe: ((value: boolean) => void) | undefined;
  let probeStarted: (() => void) | undefined;
  const firstProbeStarted = new Promise<void>((resolve) => { probeStarted = resolve; });
  let probes = 0;
  const runtime = new PresenceRuntime(
    fakePi([]) as never,
    { ...config, nativeLifecycle: true },
    clock,
    () => {
      probes += 1;
      probeStarted?.();
      return new Promise<boolean>((resolve) => { resolveProbe = resolve; });
    },
  );

  try {
    const staleStart = runtime.startSession(session("hook-probe-first"));
    await firstProbeStarted;
    await Promise.all([
      runtime.startSession(session("hook-probe-second")),
      runtime.startSession(session("hook-probe-third")),
      runtime.startSession(session("hook-probe-current")),
    ]);
    expect(probes).toBe(1);
    expect(lines.some((line) => line.startsWith("set_agent_pid ") || line.startsWith("set_agent_lifecycle "))).toBe(false);

    resolveProbe?.(false);
    await staleStart;
    await nextTurn();
    expect(lines.some((line) => line.startsWith("set_agent_pid ") || line.startsWith("set_agent_lifecycle "))).toBe(false);
    await runtime.shutdownSession();
  } finally {
    if (previousWorkspace === undefined) delete process.env.CMUX_WORKSPACE_ID;
    else process.env.CMUX_WORKSPACE_ID = previousWorkspace;
    if (previousSurface === undefined) delete process.env.CMUX_SURFACE_ID;
    else process.env.CMUX_SURFACE_ID = previousSurface;
    if (previousSocket === undefined) delete process.env.CMUX_SOCKET_PATH;
    else process.env.CMUX_SOCKET_PATH = previousSocket;
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("official-hook deadline fails closed before socket resolution", async () => {
  const previousWorkspace = process.env.CMUX_WORKSPACE_ID;
  const previousSurface = process.env.CMUX_SURFACE_ID;
  process.env.CMUX_WORKSPACE_ID = "00000000-0000-4000-8000-000000000051";
  process.env.CMUX_SURFACE_ID = "00000000-0000-4000-8000-000000000052";
  const clock = new ManualRuntimeClock();
  let resolveProbe: ((value: boolean) => void) | undefined;
  let probeStarted: (() => void) | undefined;
  const startedProbe = new Promise<void>((resolve) => { probeStarted = resolve; });
  let socketResolutions = 0;
  const runtime = new PresenceRuntime(
    fakePi([]) as never,
    config,
    clock,
    () => {
      probeStarted?.();
      return new Promise<boolean>((resolve) => { resolveProbe = resolve; });
    },
    async () => {
      socketResolutions += 1;
      return null;
    },
  );

  try {
    const start = runtime.startSession(session("hook-timeout"));
    await startedProbe;
    expect(socketResolutions).toBe(0);
    clock.advance(config.timeoutMs);
    await start;
    expect(socketResolutions).toBe(1);
    expect((runtime as unknown as { officialHook: boolean }).officialHook).toBe(true);
    resolveProbe?.(false);
    await nextTurn();
    expect((runtime as unknown as { officialHook: boolean }).officialHook).toBe(true);
    await runtime.shutdownSession();
  } finally {
    if (previousWorkspace === undefined) delete process.env.CMUX_WORKSPACE_ID;
    else process.env.CMUX_WORKSPACE_ID = previousWorkspace;
    if (previousSurface === undefined) delete process.env.CMUX_SURFACE_ID;
    else process.env.CMUX_SURFACE_ID = previousSurface;
  }
});

test("session churn shares one runtime fingerprint gate until a stale validation settles", async () => {
  const previousWorkspace = process.env.CMUX_WORKSPACE_ID;
  const previousSurface = process.env.CMUX_SURFACE_ID;
  const previousSocket = process.env.CMUX_SOCKET_PATH;
  const dir = await fs.mkdtemp(join(os.tmpdir(), "presence-runtime-gate-"));
  let writes = 0;
  const socketPath = join(dir, "socket");
  const server = await fakeSocket(socketPath, () => {
    writes += 1;
    return '{"id":1,"ok":true,"result":{"protocol":"cmux-socket","version":2,"methods":[]}}';
  });
  process.env.CMUX_WORKSPACE_ID = "00000000-0000-4000-8000-000000000031";
  process.env.CMUX_SURFACE_ID = "00000000-0000-4000-8000-000000000032";
  process.env.CMUX_SOCKET_PATH = socketPath;
  const emitted: unknown[] = [];
  const runtime = new PresenceRuntime(
    fakePi(emitted) as never,
    config,
    undefined,
    async () => false,
  );
  const gate = (runtime as unknown as {
    fingerprintGate: UnresolvedSocketFingerprintGate;
  }).fingerprintGate;
  const stale = gate.acquire();

  try {
    expect(stale).not.toBeNull();
    await runtime.startSession(session("gate-first"));
    await runtime.startSession(session("gate-second"));
    await runtime.startSession(session("gate-third"));
    expect(writes).toBe(0);

    expect(gate.release(stale!)).toBe(true);
    await runtime.startSession(session("gate-fresh"));
    expect(writes).toBe(1);
    await runtime.shutdownSession();
  } finally {
    if (previousWorkspace === undefined) delete process.env.CMUX_WORKSPACE_ID;
    else process.env.CMUX_WORKSPACE_ID = previousWorkspace;
    if (previousSurface === undefined) delete process.env.CMUX_SURFACE_ID;
    else process.env.CMUX_SURFACE_ID = previousSurface;
    if (previousSocket === undefined) delete process.env.CMUX_SOCKET_PATH;
    else process.env.CMUX_SOCKET_PATH = previousSocket;
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("detached parent fallback and aggregate are fenced by readiness, run, and official-hook authority", async () => {
  const notifications: string[] = [];
  const runtime = new PresenceRuntime(
    fakePi([]) as never,
    { ...config, notifications: true, notificationPolicy: "all" },
  );
  type Internals = {
    sessionId: string | null;
    sessionEpoch: number;
    parentRunRevision: number;
    active: boolean;
    attentionOutputReady: boolean;
    officialHook: boolean;
    client: { log: () => Promise<void>; notify: (title: string) => Promise<void>; flash: () => Promise<void> } | null;
    suppressedParentAttention: { sessionEpoch: number; parentRun: number; attention: "success"; completed: number; failed: number } | null;
    subagentPending: {
      sessionEpoch: number; generation: number; completedDelta: number; failedDelta: number; cancelledDelta: number;
      terminal: "success"; parentRun: number; coalesceDeadline: number | null; errorDeadline: number | null;
      parentSettled: "success"; deferredDispatch?: boolean; deferredTimeout?: boolean;
    } | null;
    invalidateSubagentNotifications(): void;
    dispatchSuppressedParentAttention(parentRun: number): void;
  };
  const internal = runtime as unknown as Internals;
  internal.sessionId = "parent-fence";
  internal.sessionEpoch = 1;
  internal.parentRunRevision = 1;
  internal.client = {
    log: async () => {},
    notify: async (title) => { notifications.push(title); },
    flash: async () => {},
  };
  internal.suppressedParentAttention = {
    sessionEpoch: 1, parentRun: 1, attention: "success", completed: 1, failed: 0,
  };
  internal.subagentPending = {
    sessionEpoch: 1, generation: 1, completedDelta: 1, failedDelta: 0, cancelledDelta: 0,
    terminal: "success", parentRun: 1, coalesceDeadline: null, errorDeadline: null, parentSettled: "success",
  };

  // A subagent withdrawal/generation invalidation must retain the parent's
  // fallback through detached startup, rather than consuming it with no client.
  internal.invalidateSubagentNotifications();
  internal.dispatchSuppressedParentAttention(1);
  expect(internal.suppressedParentAttention).not.toBeNull();
  internal.attentionOutputReady = true;
  internal.dispatchSuppressedParentAttention(1);
  expect(notifications).toEqual(["Pi"]);

  // A replacement run discards both a settled aggregate and its parent fallback.
  internal.attentionOutputReady = false;
  internal.suppressedParentAttention = {
    sessionEpoch: 1, parentRun: 1, attention: "success", completed: 1, failed: 0,
  };
  internal.subagentPending = {
    sessionEpoch: 1, generation: 2, completedDelta: 1, failedDelta: 0, cancelledDelta: 0,
    terminal: "success", parentRun: 1, coalesceDeadline: null, errorDeadline: null,
    parentSettled: "success", deferredDispatch: true,
  };
  runtime.handleAgentStart();
  expect(internal.parentRunRevision).toBe(2);
  expect(internal.subagentPending).toBeNull();
  expect(internal.suppressedParentAttention).toBeNull();

  // Even a retained fallback cannot beat official-hook authority at final dispatch.
  internal.parentRunRevision = 2;
  internal.attentionOutputReady = true;
  internal.officialHook = true;
  internal.suppressedParentAttention = {
    sessionEpoch: 1, parentRun: 2, attention: "success", completed: 1, failed: 0,
  };
  internal.dispatchSuppressedParentAttention(2);
  expect(notifications).toEqual(["Pi"]);
  await runtime.shutdownSession();
});

test("detached opt-in feed queues ordered safe edges and fails closed on replacement or startup overflow", () => {
  const sent: Array<{ event: string; sessionId: string; tool?: { callId?: string; name?: string } }> = [];
  const runtime = new PresenceRuntime(fakePi([]) as never, { ...config, feed: true });
  type Internals = {
    sessionId: string | null;
    sessionEpoch: number;
    attentionOutputReady: boolean;
    officialHook: boolean;
    feedQueueOverflowed: boolean;
    pendingFeedEdges: unknown[];
    client: { feed: (event: string, sessionId: string, tool?: { callId?: string; name?: string }) => Promise<void> } | null;
    queueFeedEdge(event: "SessionStart" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "Stop", sessionId: string, tool?: { toolCallId?: unknown; toolName?: unknown }): void;
    dispatchPendingFeedEdges(): void;
    resetPendingFeedEdges(): void;
  };
  const internal = runtime as unknown as Internals;
  internal.sessionId = "queued-session";
  internal.sessionEpoch = 1;
  internal.client = { feed: async (event, sessionId, tool) => { sent.push({ event, sessionId, tool }); } };

  internal.queueFeedEdge("SessionStart", "queued-session");
  internal.queueFeedEdge("UserPromptSubmit", "queued-session");
  internal.queueFeedEdge("PreToolUse", "queued-session", { toolCallId: "call-1", toolName: "todo" });
  // Invalid queued tool identifiers drop the whole edge, never an anonymous PostToolUse.
  internal.queueFeedEdge("PostToolUse", "queued-session", { toolCallId: "bad call", toolName: "private\nname" });
  internal.queueFeedEdge("Stop", "queued-session");
  expect(sent).toEqual([]);
  internal.attentionOutputReady = true;
  internal.dispatchPendingFeedEdges();
  expect(sent).toEqual([
    { event: "SessionStart", sessionId: "queued-session", tool: undefined },
    { event: "UserPromptSubmit", sessionId: "queued-session", tool: undefined },
    { event: "PreToolUse", sessionId: "queued-session", tool: { callId: "call-1", name: "todo" } },
    { event: "Stop", sessionId: "queued-session", tool: undefined },
  ]);

  // The ready path applies the same all-or-nothing validation without a local queue.
  internal.queueFeedEdge("PostToolUse", "queued-session", { toolCallId: "call-2", toolName: "private\nname" });
  internal.queueFeedEdge("PostToolUse", "queued-session", { toolCallId: "bad call", toolName: "todo" });
  expect(sent).toHaveLength(4);

  // Replacement epoch fences detached edges before they reach the client queue.
  internal.attentionOutputReady = false;
  internal.queueFeedEdge("SessionStart", "queued-session");
  internal.sessionEpoch = 2;
  internal.sessionId = "replacement";
  internal.attentionOutputReady = true;
  internal.dispatchPendingFeedEdges();
  expect(sent).toHaveLength(4);
  expect(internal.pendingFeedEdges).toEqual([]);

  // A startup overflow emits neither a partial prefix nor a later suffix for this epoch.
  internal.resetPendingFeedEdges();
  internal.sessionEpoch = 3;
  internal.sessionId = "overflow";
  internal.attentionOutputReady = false;
  internal.queueFeedEdge("SessionStart", "overflow");
  for (let index = 0; index < 32; index += 1) internal.queueFeedEdge("UserPromptSubmit", "overflow");
  expect(internal.feedQueueOverflowed).toBe(true);
  internal.attentionOutputReady = true;
  internal.dispatchPendingFeedEdges();
  internal.queueFeedEdge("Stop", "overflow");
  expect(sent).toHaveLength(4);
});

test("ready feed edges bypass the detached queue while earlier client writes are in flight", () => {
  const sent: string[] = [];
  let release: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const runtime = new PresenceRuntime(fakePi([]) as never, { ...config, feed: true });
  type Internals = {
    sessionId: string | null;
    sessionEpoch: number;
    attentionOutputReady: boolean;
    feedQueueOverflowed: boolean;
    pendingFeedEdges: unknown[];
    client: { feed: (event: string) => Promise<void> } | null;
    queueFeedEdge(event: "SessionStart" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "Stop", sessionId: string): void;
    dispatchPendingFeedEdges(): void;
  };
  const internal = runtime as unknown as Internals;
  internal.sessionId = "ready-in-flight";
  internal.sessionEpoch = 4;
  internal.client = { feed: async (event) => { sent.push(event); await blocked; } };

  // Exactly 32 detached edges are valid. Readiness must submit all of them
  // before the next ready-state edge sees a local queue.
  internal.queueFeedEdge("SessionStart", "ready-in-flight");
  for (let index = 0; index < 31; index += 1) {
    internal.queueFeedEdge("UserPromptSubmit", "ready-in-flight");
  }
  internal.attentionOutputReady = true;
  internal.dispatchPendingFeedEdges();
  internal.queueFeedEdge("Stop", "ready-in-flight");

  // All 33 calls were submitted in their local order. No ready-state event can
  // overflow, clear, or partially replay the detached startup queue.
  expect(sent).toEqual(["SessionStart", ...Array(31).fill("UserPromptSubmit"), "Stop"]);
  expect(internal.pendingFeedEdges).toEqual([]);
  expect(internal.feedQueueOverflowed).toBe(false);
  release?.();
});
