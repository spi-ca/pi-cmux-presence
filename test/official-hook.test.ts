import { expect, mock, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import {
  hasSameRegularFileIdentity,
  OFFICIAL_HOOK_MAX_BYTES,
  officialHookDetected,
  readBoundedOfficialHookSource,
} from "../src/official-hook.js";

async function hookDirectory(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(join(os.tmpdir(), prefix));
  await fs.mkdir(join(directory, "extensions"));
  return directory;
}

function functionBody(source: string, name: string): string {
  const match = new RegExp(`export\\s+async\\s+function\\s+${name}\\s*\\(`).exec(source);
  expect(match).not.toBeNull();
  const openingBrace = source.indexOf("{", match!.index);
  expect(openingBrace).toBeGreaterThanOrEqual(0);

  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(openingBrace + 1, index);
  }
  throw new Error(`Could not find the end of ${name}.`);
}

function procfsUnavailable(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "EACCES" || error.code === "EPERM");
}

async function procSelfFdTargets(): Promise<string[] | undefined> {
  try {
    const descriptors = await fs.readdir("/proc/self/fd");
    const targets = await Promise.all(descriptors.map(async (descriptor) => {
      try {
        return await fs.readlink(join("/proc/self/fd", descriptor));
      } catch (error) {
        // A descriptor may close after readdir and before readlink.
        if (procfsUnavailable(error)) return undefined;
        throw error;
      }
    }));
    return targets.filter((target): target is string => target !== undefined);
  } catch (error) {
    if (procfsUnavailable(error)) return undefined;
    throw error;
  }
}

test("official hook probe preserves marker, absence, and explicit disable behavior", async () => {
  const directory = await hookDirectory("presence-official-hook-ordinary-");
  const hookPath = join(directory, "extensions", "cmux-session.ts");
  try {
    expect(await officialHookDetected({ PI_CODING_AGENT_DIR: directory })).toBe(false);
    await fs.writeFile(hookPath, "cmux-pi-session-extension-marker v2");
    expect(await officialHookDetected({ PI_CODING_AGENT_DIR: directory })).toBe(true);
    expect(await officialHookDetected({ PI_CODING_AGENT_DIR: directory, CMUX_PI_HOOKS_DISABLED: "1" })).toBe(false);
    await fs.writeFile(hookPath, "export default {};\n");
    expect(await officialHookDetected({ PI_CODING_AGENT_DIR: directory })).toBe(false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("official hook probe rejects non-regular, leaf-symlink, and oversized sources", async () => {
  const directory = await hookDirectory("presence-official-hook-bounds-");
  const hookPath = join(directory, "extensions", "cmux-session.ts");
  const targetPath = join(directory, "hook-target.ts");
  try {
    await fs.mkdir(hookPath);
    await expect(officialHookDetected({ PI_CODING_AGENT_DIR: directory })).rejects.toThrow("not a regular file");
    await fs.rmdir(hookPath);

    await fs.writeFile(targetPath, "cmux-pi-session-extension-marker v2");
    await fs.symlink(targetPath, hookPath);
    await expect(officialHookDetected({ PI_CODING_AGENT_DIR: directory })).rejects.toThrow("not a regular file");
    await fs.unlink(hookPath);

    // A maximum-size source is read successfully, while MAX + 1 is rejected.
    const marker = "cmux-pi-session-extension-marker v2";
    await fs.writeFile(hookPath, `${marker}${" ".repeat(OFFICIAL_HOOK_MAX_BYTES - Buffer.byteLength(marker))}`);
    expect(await officialHookDetected({ PI_CODING_AGENT_DIR: directory })).toBe(true);
    await fs.writeFile(hookPath, Buffer.alloc(OFFICIAL_HOOK_MAX_BYTES + 1));
    await expect(officialHookDetected({ PI_CODING_AGENT_DIR: directory })).rejects.toThrow("conservative read limit");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("official hook file identity validator requires matching regular dev and inode", () => {
  const regular = () => true;
  const nonRegular = () => false;
  expect(hasSameRegularFileIdentity({ dev: 1, ino: 2, isFile: regular }, { dev: 1, ino: 2, isFile: regular })).toBe(true);
  expect(hasSameRegularFileIdentity({ dev: 1, ino: 2, isFile: regular }, { dev: 1, ino: 3, isFile: regular })).toBe(false);
  expect(hasSameRegularFileIdentity({ dev: 1, ino: 2, isFile: regular }, { dev: 2, ino: 2, isFile: regular })).toBe(false);
  expect(hasSameRegularFileIdentity({ dev: 1, ino: 2, isFile: regular }, { dev: 1, ino: 2, isFile: nonRegular })).toBe(false);
});

test("bounded hook reads use one MAX + 1 buffer and reject a file that grows by one byte", async () => {
  const reads: Array<{ bufferLength: number; offset: number; length: number; position: number | null }> = [];
  const handle = {
    read: async (buffer: Buffer, offset: number, length: number, position: number | null) => {
      reads.push({ bufferLength: buffer.length, offset, length, position });
      buffer.fill(0x20, offset, offset + length);
      return { bytesRead: reads.length === 1 ? OFFICIAL_HOOK_MAX_BYTES : 1, buffer };
    },
  };

  await expect(readBoundedOfficialHookSource(handle as never)).rejects.toThrow("conservative read limit");
  expect(reads).toEqual([
    { bufferLength: OFFICIAL_HOOK_MAX_BYTES + 1, offset: 0, length: OFFICIAL_HOOK_MAX_BYTES + 1, position: 0 },
    { bufferLength: OFFICIAL_HOOK_MAX_BYTES + 1, offset: OFFICIAL_HOOK_MAX_BYTES, length: 1, position: OFFICIAL_HOOK_MAX_BYTES },
  ]);

  const controller = new AbortController();
  let abortedReadCalls = 0;
  const abortingHandle = {
    read: async (buffer: Buffer) => {
      abortedReadCalls += 1;
      controller.abort(new Error("cancelled read"));
      return { bytesRead: 1, buffer };
    },
  };
  await expect(readBoundedOfficialHookSource(abortingHandle as never, controller.signal)).rejects.toThrow("cancelled read");
  expect(abortedReadCalls).toBe(1);
});

test("official hook aborts after in-flight filesystem work and a later settled probe recovers", async () => {
  const directory = await hookDirectory("presence-official-hook-abort-");
  const hookPath = join(directory, "extensions", "cmux-session.ts");
  const controller = new AbortController();
  try {
    // The microtask runs while lstat is in flight, so the post-lstat recheck
    // must reject rather than authoritatively report this absent hook.
    queueMicrotask(() => controller.abort(new Error("cancelled probe")));
    await expect(officialHookDetected({ PI_CODING_AGENT_DIR: directory }, controller.signal)).rejects.toThrow("cancelled probe");

    await fs.writeFile(hookPath, "cmux-pi-session-extension-marker v2");
    expect(await officialHookDetected({ PI_CODING_AGENT_DIR: directory })).toBe(true);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("official hook production path retains its safe open, identity, reader, and close wiring", async () => {
  const source = await fs.readFile(new URL("../src/official-hook.ts", import.meta.url), "utf8");
  const body = functionBody(source, "officialHookDetected");

  expect(body).toMatch(
    /const\s+noFollow\s*=\s*typeof\s+fsConstants\.O_NOFOLLOW\s*===\s*["']number["']\s*\?\s*fsConstants\.O_NOFOLLOW\s*:\s*0/,
  );
  expect(body).toMatch(
    /await\s+fs\.open\s*\(\s*hookPath\s*,\s*fsConstants\.O_RDONLY\s*\|\s*fsConstants\.O_NONBLOCK\s*\|\s*noFollow\s*\)/s,
  );
  expect(body).toMatch(/hasSameRegularFileIdentity\s*\(\s*initialEntry\s*,\s*openedEntry\s*\)/);
  expect(body).toMatch(/await\s+readBoundedOfficialHookSource\s*\(\s*handle\s*,\s*signal\s*\)/);

  const openIndex = body.search(/await\s+fs\.open\s*\(/);
  const tryIndex = body.indexOf("try", openIndex);
  const finallyIndex = body.indexOf("finally", tryIndex);
  const finallyOpeningBrace = body.indexOf("{", finallyIndex);
  const finallyBody = functionBody(`export async function finallyBody() ${body.slice(finallyOpeningBrace)}`, "finallyBody");
  expect(openIndex).toBeGreaterThanOrEqual(0);
  expect(tryIndex).toBeGreaterThan(openIndex);
  expect(finallyIndex).toBeGreaterThan(tryIndex);
  expect(finallyBody).toMatch(/await\s+handle\.close\s*\(\s*\)/);
});

test("post-open abort errors repeatedly close official-hook descriptors when procfs is available", async () => {
  if (await procSelfFdTargets() === undefined) return;

  const originalFilesystem = { ...fs };
  const originalOpen = fs.open;
  let abortAfterOpen: AbortController | undefined;

  // This test-only wrapper aborts after a real descriptor has been opened but
  // before officialHookDetected resumes from its await. No production seam is
  // added, and procfs verifies the real descriptor is not left behind.
  mock.module("node:fs/promises", () => ({
    ...originalFilesystem,
    open: async (...args: Parameters<typeof originalOpen>) => {
      const handle = await originalOpen(...args);
      const controller = abortAfterOpen;
      abortAfterOpen = undefined;
      controller?.abort(new Error("post-open cancellation"));
      return handle;
    },
  }));

  const directory = await hookDirectory("presence-official-hook-post-open-abort-");
  const hookPath = join(directory, "extensions", "cmux-session.ts");
  try {
    await fs.writeFile(hookPath, "cmux-pi-session-extension-marker v2");

    for (let attempt = 0; attempt < 32; attempt += 1) {
      const controller = new AbortController();
      abortAfterOpen = controller;
      await expect(officialHookDetected({ PI_CODING_AGENT_DIR: directory }, controller.signal)).rejects.toThrow("post-open cancellation");
      expect(await procSelfFdTargets()).not.toContain(hookPath);
    }
  } finally {
    abortAfterOpen = undefined;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
