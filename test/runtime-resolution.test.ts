import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import type { PresenceConfig } from "../src/config.js";
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

function session(id: string) {
  return { sessionManager: { getSessionId: () => id } };
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

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
