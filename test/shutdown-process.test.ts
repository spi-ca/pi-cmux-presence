import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import { fakeSocket } from "./helpers/fake-socket.js";

async function bounded<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test("a Bun process exits normally only after shutdown clear_status reaches cmux", async () => {
  const directory = await fs.mkdtemp(join(os.tmpdir(), "presence-shutdown-process-"));
  const socketPath = join(directory, "cmux.sock");
  const lines: string[] = [];
  let sawStatus!: () => void;
  const statusReceived = new Promise<void>((resolve) => { sawStatus = resolve; });
  let sawClear!: () => void;
  const clearReceived = new Promise<void>((resolve) => { sawClear = resolve; });
  const server = await fakeSocket(socketPath, (line) => {
    lines.push(line);
    if (line.startsWith("set_status ")) sawStatus();
    if (line.startsWith("clear_status ")) sawClear();
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
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "helpers", "shutdown-child.ts")], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      CMUX_PI_HOOKS_DISABLED: "1",
      CMUX_SOCKET_PATH: socketPath,
      CMUX_SURFACE_ID: "00000000-0000-4000-8000-000000000102",
      CMUX_WORKSPACE_ID: "00000000-0000-4000-8000-000000000101",
      PI_CMUX_PRESENCE_ENABLED: "true",
      PI_CMUX_PRESENCE_FEED: "false",
      PI_CMUX_PRESENCE_FLASH: "false",
      PI_CMUX_PRESENCE_META_BLOCK: "false",
      PI_CMUX_PRESENCE_NATIVE_LIFECYCLE: "false",
      PI_CMUX_PRESENCE_NOTIFICATIONS: "false",
      PI_CMUX_PRESENCE_PROGRESS: "false",
      PI_CMUX_PRESENCE_RESUME_FALLBACK: "false",
      PI_CMUX_PRESENCE_SIDEBAR: "true",
      PI_CMUX_PRESENCE_TIMEOUT_MS: "250",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  try {
    await bounded(statusReceived, 2_000, "child did not publish its initial status");
    child.stdin.write("shutdown\n");
    child.stdin.end();

    const first = await bounded(
      Promise.race([
        clearReceived.then(() => "clear" as const),
        child.exited.then(() => "exit" as const),
      ]),
      2_000,
      "child neither cleared status nor exited",
    );
    expect(first).toBe("clear");

    const exitCode = await bounded(child.exited, 2_000, "child did not exit after cleanup");
    const stderr = await new Response(child.stderr).text();
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(lines.some((line) => line.startsWith("clear_status "))).toBe(true);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await bounded(child.exited, 2_000, "child did not exit after kill");
    }
    await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
