import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import net from "node:net";
import * as os from "node:os";
import { join } from "node:path";
import { fakeSocket, type FakeSocketResponse } from "./helpers/fake-socket.js";
import { PresenceClient } from "../src/client.js";
import { resolvePresenceConfig } from "../src/config.js";
import {
  BoundedSocketQueue,
  PresenceTransportError,
  raceAbort,
  UnresolvedSocketFingerprintGate,
  UnixSocketTransport,
} from "../src/transport.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()?.(); });

async function fixture(
  handler: (line: string) => FakeSocketResponse | Promise<FakeSocketResponse>,
  options?: { onConnection?: (socket: import("node:net").Socket) => void },
) {
  const dir = await fs.mkdtemp(join(os.tmpdir(), "presence-test-"));
  const server = await fakeSocket(join(dir, "socket"), handler, options);
  cleanup.push(async () => { await server.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return join(dir, "socket");
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("Unix socket transport", () => {
  test("exchanges one bounded LF response", async () => {
    const path = await fixture((line) => line === "request" ? "ok" : "no");
    const transport = new UnixSocketTransport(path, 300, 4);
    await expect(transport.request("request\n")).resolves.toBe("ok");
    await transport.close();
  });
  test("times out when a fake server gives no response", async () => {
    const path = await fixture(() => undefined);
    const transport = new UnixSocketTransport(path, 100, 4);
    await expect(transport.request("request\n")).rejects.toThrow("timed out");
    await transport.close();
  });
  test("keeps a transport usable after a pre-connect error or timeout", async () => {
    const path = await fixture(() => "ok");
    const transport = new UnixSocketTransport(path, 40, 2);
    const mutableNet = net as typeof net & { createConnection: (...args: unknown[]) => net.Socket };
    const createConnection = mutableNet.createConnection;
    let attempts = 0;
    mutableNet.createConnection = (...args) => {
      attempts += 1;
      if (attempts === 1) {
        const socket = new net.Socket();
        queueMicrotask(() => socket.emit("error", new Error("synthetic connection failure")));
        return socket;
      }
      if (attempts === 2) return new net.Socket();
      return createConnection(...args);
    };
    try {
      await expect(transport.request("error\n")).rejects.toThrow("synthetic connection failure");
      await expect(transport.request("timeout\n")).rejects.toThrow("timed out");
    } finally {
      mutableNet.createConnection = createConnection;
    }
    await expect(transport.request("fast\n")).resolves.toBe("ok");
    await transport.close();
  });
  test("keeps a transport usable after a response timeout", async () => {
    const path = await fixture((line) => line === "slow" ? undefined : "ok");
    const transport = new UnixSocketTransport(path, 40, 2);
    await expect(transport.request("slow\n")).rejects.toThrow("timed out");
    await expect(transport.request("fast\n")).resolves.toBe("ok");
    await transport.close();
  });
  test("ignores a late close after a timed-out request while the next request is queued", async () => {
    const path = await fixture((line) => line === "slow" ? undefined : "ok");
    const transport = new UnixSocketTransport(path, 40, 2);
    const timedOut = transport.request("slow\n");
    const next = transport.request("fast\n");
    await expect(timedOut).rejects.toThrow("timed out");
    await expect(next).resolves.toBe("ok");
    await transport.close();
  });
  test("hard-gates unsolicited post-connect data while fingerprint validation is pending", async () => {
    let writes = 0;
    const path = await fixture(
      () => { writes += 1; return "ok"; },
      { onConnection: (socket) => { socket.write("unsolicited\\n"); } },
    );
    const transport = new UnixSocketTransport(path, 300, 2);
    await expect(transport.request("request\n")).rejects.toThrow(
      "before post-connect validation and request write",
    );
    expect(writes).toBe(0);
    await expect(transport.request("later\n")).rejects.toThrow("queue is closed");
    await transport.close();
  });
  test("hard-gates an unsolicited post-connect close while fingerprint validation is pending", async () => {
    let writes = 0;
    const path = await fixture(
      () => { writes += 1; return "ok"; },
      { onConnection: (socket) => { socket.end(); } },
    );
    const transport = new UnixSocketTransport(path, 300, 2);
    await expect(transport.request("request\n")).rejects.toThrow("closed before a complete response");
    expect(writes).toBe(0);
    await expect(transport.request("later\n")).rejects.toThrow("queue is closed");
    await transport.close();
  });
  test("fingerprint gate retains stale ownership and fences late release", () => {
    const gate = new UnresolvedSocketFingerprintGate();
    const stale = gate.acquire();
    expect(stale).not.toBeNull();
    expect(gate.unresolved).toBe(true);
    expect(gate.acquire()).toBeNull();
    expect(gate.release({})).toBe(false);
    expect(gate.release(stale!)).toBe(true);

    const current = gate.acquire();
    expect(current).not.toBeNull();
    expect(gate.release(stale!)).toBe(false);
    expect(gate.unresolved).toBe(true);
    expect(gate.release(current!)).toBe(true);
    expect(gate.unresolved).toBe(false);
  });
  test("does not let an overridden fingerprint gate fabricate a safe fingerprint", async () => {
    class ForgedGate extends UnresolvedSocketFingerprintGate {
      override acquire() { return { dev: 1, ino: 1, uid: 1 }; }
      override release() { return true; }
      fingerprint() { return { dev: 1, ino: 1, uid: 1 }; }
    }
    const path = await fixture(() => "ok");
    await fs.chmod(path, 0o666);
    const transport = new UnixSocketTransport(path, 100, 2, new ForgedGate());
    await expect(transport.request("request\n")).rejects.toThrow("owner-only");
    await transport.close();
  });
  test("rejects a malformed fingerprint gate without accepting a fabricated fingerprint", async () => {
    const path = await fixture(() => "ok");
    const malformedGate = { acquire: () => ({ dev: 1, ino: 1, uid: 1 }) };
    const transport = new UnixSocketTransport(path, 100, 2, malformedGate as never);
    await expect(transport.request("request\n")).rejects.toThrow("already unresolved");
    await transport.close();
  });
  test("cancellation primitive stops a late pre-connect validation before connection or write", async () => {
    let release!: () => void;
    const stalled = new Promise<{ dev: number }>((resolve) => { release = () => resolve({ dev: 1 }); });
    const controller = new AbortController();
    let abandoned = 0;
    let connections = 0;
    let writes = 0;
    const request = (async () => {
      await raceAbort(
        stalled,
        controller.signal,
        () => new PresenceTransportError("Socket request timed out."),
        () => { abandoned += 1; },
      );
      connections += 1;
      writes += 1;
    })();

    const deadline = setTimeout(() => controller.abort(), 5);
    await expect(request).rejects.toThrow("timed out");
    clearTimeout(deadline);
    release();
    await nextTurn();
    expect(abandoned).toBe(1);
    expect(connections).toBe(0);
    expect(writes).toBe(0);
  });
  test("fail-closes validation-stalled work so repeated deadlines start one filesystem operation", async () => {
    const queue = new BoundedSocketQueue(8);
    let release!: () => void;
    const stalled = new Promise<string>((resolve) => { release = () => resolve("fingerprint"); });
    let validations = 0;
    let connections = 0;
    const request = () => queue.enqueue(async (signal) => {
      validations += 1;
      await raceAbort(
        stalled,
        signal,
        () => new PresenceTransportError("Socket request timed out."),
        () => queue.failClose(),
      );
      connections += 1;
      return "connected";
    });

    const first = request();
    await nextTurn();
    const repeated = [request(), request(), request(), request()];
    await queue.close(5);
    await expect(first).rejects.toThrow("timed out");
    for (const pending of repeated) await expect(pending).rejects.toThrow("closed before dispatch");
    expect(validations).toBe(1);
    release();
    await nextTurn();
    expect(connections).toBe(0);
  });
  test("rejects promptly when a socket ends without a complete response", async () => {
    const path = await fixture(() => ({ end: true }));
    const timeoutMs = 300;
    const transport = new UnixSocketTransport(path, timeoutMs, 4);
    const started = performance.now();
    await expect(transport.request("request\n")).rejects.toThrow("closed before a complete response");
    expect(performance.now() - started).toBeLessThan(timeoutMs / 2);
    await transport.close();
  });
  test("rejects a socket that is no longer owner-only before connecting", async () => {
    const path = await fixture(() => "ok");
    await fs.chmod(path, 0o666);
    const transport = new UnixSocketTransport(path, 100, 4);
    await expect(transport.request("request\n")).rejects.toThrow("owner-only");
    await transport.close();
  });
  test("rejects a socket beneath a replaceable ancestor even when its direct parent is private", async () => {
    const outer = await fs.mkdtemp(join(os.tmpdir(), "presence-unsafe-"));
    const inner = join(outer, "private");
    await fs.mkdir(inner, { mode: 0o700 });
    const socketPath = join(inner, "socket");
    const server = await fakeSocket(socketPath, () => "ok");
    cleanup.push(async () => { await server.close(); await fs.rm(outer, { recursive: true, force: true }); });
    await fs.chmod(outer, 0o777);
    const transport = new UnixSocketTransport(socketPath, 100, 4);
    await expect(transport.request("request\n")).rejects.toThrow("replaceable");
    await transport.close();
  });
  test("rejects a user-owned lexical symlink ancestor even when its resolved target is private", async () => {
    const outer = await fs.mkdtemp(join(os.tmpdir(), "presence-symlink-"));
    const target = join(outer, "target");
    const link = join(outer, "link");
    await fs.mkdir(target, { mode: 0o700 });
    await fs.symlink(target, link);
    const targetSocket = join(target, "socket");
    const server = await fakeSocket(targetSocket, () => "ok");
    cleanup.push(async () => { await server.close(); await fs.rm(outer, { recursive: true, force: true }); });
    const transport = new UnixSocketTransport(join(link, "socket"), 100, 4);
    await expect(transport.request("request\n")).rejects.toThrow("symlink");
    await transport.close();
  });
  test("coalesces keyed pending work into one shared promise and keeps the newest work", async () => {
    const queue = new BoundedSocketQueue(1);
    let release!: () => void;
    const started: string[] = [];
    const blocker = queue.enqueue(async () => { started.push("blocker"); await new Promise<void>((resolve) => { release = resolve; }); return "blocker"; });
    await nextTurn();
    const first = queue.enqueue(async () => { started.push("first"); return "first"; }, "status");
    const replacement = queue.enqueue(async () => { started.push("replacement"); return "replacement"; }, "status");
    expect(replacement).toBe(first);
    await expect(queue.enqueue(async () => "overflow")).rejects.toThrow("full");
    release();
    await expect(blocker).resolves.toBe("blocker");
    await expect(first).resolves.toBe("replacement");
    expect(started).toEqual(["blocker", "replacement"]);
    await queue.close(50);
  });
  test("dispatches primary work ahead of an ordered optional feed queue", async () => {
    const queue = new BoundedSocketQueue(3);
    let release!: () => void;
    const started: string[] = [];
    const blocker = queue.enqueue(async () => {
      started.push("blocker");
      await new Promise<void>((resolve) => { release = resolve; });
      return "blocker";
    });
    await nextTurn();
    const firstFeed = queue.enqueue(async () => { started.push("first-feed"); return "first-feed"; }, undefined, { displaceable: true });
    const secondFeed = queue.enqueue(async () => { started.push("second-feed"); return "second-feed"; }, undefined, { displaceable: true });
    const primary = queue.enqueue(async () => { started.push("primary"); return "primary"; });

    release();
    await Promise.all([blocker, firstFeed, secondFeed, primary]);
    expect(started).toEqual(["blocker", "primary", "first-feed", "second-feed"]);
    await queue.close(50);
  });
  test("evicts the newest saturated feed while retaining earlier feeds in FIFO order", async () => {
    const queue = new BoundedSocketQueue(3);
    let release!: () => void;
    const started: string[] = [];
    const blocker = queue.enqueue(async () => {
      started.push("blocker");
      await new Promise<void>((resolve) => { release = resolve; });
      return "blocker";
    });
    await nextTurn();
    const firstFeed = queue.enqueue(async () => { started.push("first-feed"); return "first-feed"; }, undefined, { displaceable: true });
    const secondFeed = queue.enqueue(async () => { started.push("second-feed"); return "second-feed"; }, undefined, { displaceable: true });
    const newestFeed = queue.enqueue(async () => { started.push("newest-feed"); return "newest-feed"; }, undefined, { displaceable: true });
    const primary = queue.enqueue(async () => { started.push("primary"); return "primary"; });

    release();
    await expect(newestFeed).rejects.toThrow("displaced by primary output");
    await Promise.all([blocker, firstFeed, secondFeed, primary]);
    expect(started).toEqual(["blocker", "primary", "first-feed", "second-feed"]);
    await queue.close(50);
  });
  test("keeps the earliest ordered feed prefix from a startup-sized burst at maxQueue=1", async () => {
    let releaseSessionStart!: () => void;
    const sessionStartReleased = new Promise<void>((resolve) => { releaseSessionStart = resolve; });
    const writes: string[] = [];
    const path = await fixture(async (line) => {
      writes.push(line);
      if (!line.startsWith("{")) return "OK";

      const request = JSON.parse(line) as { id: number; method: string; params: { event?: { hook_event_name?: string } } };
      if (request.method === "feed.push" && request.params.event?.hook_event_name === "SessionStart") {
        await sessionStartReleased;
      }
      const result = request.method === "system.capabilities"
        ? { protocol: "cmux-socket", version: 2, methods: ["feed.push"] }
        : {};
      return JSON.stringify({ id: request.id, ok: true, result });
    });
    const transport = new UnixSocketTransport(path, 300, 1);
    const client = new PresenceClient(
      { workspaceId: "00000000-0000-4000-8000-000000000001", surfaceId: "00000000-0000-4000-8000-000000000002" },
      transport,
      { ...resolvePresenceConfig({}), maxQueue: 1, feed: true },
    );
    await client.initialize();

    const sessionStart = client.feed("SessionStart", "session-1");
    while (!writes.some((line) => line.includes('"hook_event_name":"SessionStart"'))) await nextTurn();
    const feeds = [
      client.feed("UserPromptSubmit", "session-1"),
      client.feed("PreToolUse", "session-1", { callId: "call-1", name: "todo" }),
      client.feed("PostToolUse", "session-1", { callId: "call-1", name: "todo" }),
      ...Array.from({ length: 27 }, () => client.feed("UserPromptSubmit", "session-1")),
      client.feed("Stop", "session-1"),
    ];

    releaseSessionStart();
    await Promise.all([sessionStart, ...feeds]);
    await client.close();

    const feedRequests = writes
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as { method: string; params: { event?: unknown } })
      .filter((request) => request.method === "feed.push");
    expect(feedRequests.map((request) => request.params.event)).toEqual([
      {
        session_id: "session-1",
        hook_event_name: "SessionStart",
        _source: "pi",
        workspace_id: "00000000-0000-4000-8000-000000000001",
        surface_id: "00000000-0000-4000-8000-000000000002",
      },
      {
        session_id: "session-1",
        hook_event_name: "UserPromptSubmit",
        _source: "pi",
        workspace_id: "00000000-0000-4000-8000-000000000001",
        surface_id: "00000000-0000-4000-8000-000000000002",
      },
    ]);
    expect(writes.map((line) => line.startsWith("{") ? (JSON.parse(line) as { method: string }).method : line))
      .toEqual(["system.capabilities", "feed.push", "feed.push"]);
  });
  test("dispatches each primary output ahead of a pending feed at maxQueue=1", async () => {
    const primary = [
      { command: "set_status", send: (client: PresenceClient) => client.status("state", "Ready", { icon: "circle", color: "#00aa00", priority: 1 }) },
      { command: "set_progress", send: (client: PresenceClient) => client.progress(0.5, "Working") },
      { command: "set_agent_lifecycle", send: (client: PresenceClient) => client.lifecycle("running") },
    ];

    for (const { command, send } of primary) {
      let releaseBlocker!: () => void;
      const blockerReleased = new Promise<void>((resolve) => { releaseBlocker = resolve; });
      const writes: string[] = [];
      const path = await fixture(async (line) => {
        writes.push(line);
        if (line === "blocker") {
          await blockerReleased;
          return "OK";
        }
        if (!line.startsWith("{")) return "OK";

        const request = JSON.parse(line) as { id: number; method: string };
        const result = request.method === "system.capabilities"
          ? { protocol: "cmux-socket", version: 2, methods: ["feed.push"] }
          : {};
        return JSON.stringify({ id: request.id, ok: true, result });
      });
      const transport = new UnixSocketTransport(path, 300, 1);
      const client = new PresenceClient(
        { workspaceId: "00000000-0000-4000-8000-000000000001", surfaceId: "00000000-0000-4000-8000-000000000002" },
        transport,
        { ...resolvePresenceConfig({}), maxQueue: 1, feed: true },
      );
      await client.initialize();

      const blocker = transport.request("blocker\n");
      while (!writes.includes("blocker")) await nextTurn();
      const feed = client.feed("SessionStart", "session-1");
      const output = send(client);
      releaseBlocker();
      await Promise.all([blocker, feed, output]);
      await client.close();

      expect(writes.map((line) => line.startsWith("{")
        ? (JSON.parse(line) as { method: string }).method
        : line.split(" ", 1)[0]))
        .toEqual(["system.capabilities", "blocker", command]);
    }
  });
  test("drains a request enqueued immediately after awaiting the previous request", async () => {
    const queue = new BoundedSocketQueue(1);
    await expect(queue.enqueue(async () => "first")).resolves.toBe("first");
    await expect(queue.enqueue(async () => "second")).resolves.toBe("second");
    await queue.close(50);
  });
  test("aborts an active exchange at close deadline and leaves no old request alive", async () => {
    const queue = new BoundedSocketQueue(2);
    let observedAbort = false;
    const active = queue.enqueue((signal) => new Promise<string>((_resolve, reject) => signal.addEventListener("abort", () => { observedAbort = true; reject(new Error("aborted")); }, { once: true })));
    await nextTurn();
    const queued = queue.enqueue(async () => "never");
    await queue.close(5);
    expect(observedAbort).toBe(true);
    await expect(active).rejects.toThrow("aborted");
    await expect(queued).rejects.toThrow("closed before dispatch");
  });
  test("drains queued work in FIFO order before close and rejects new work", async () => {
    const queue = new BoundedSocketQueue(3);
    let release!: () => void;
    const order: string[] = [];
    const first = queue.enqueue(async () => { order.push("first"); await new Promise<void>((resolve) => { release = resolve; }); return "first"; });
    await nextTurn();
    const second = queue.enqueue(async () => { order.push("second"); return "second"; });
    const closing = queue.close(100);
    release();
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    await closing;
    expect(order).toEqual(["first", "second"]);
    await expect(queue.enqueue(async () => "late")).rejects.toThrow("closed");
  });
});
