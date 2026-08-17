import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const OFFICIAL_HOOK_MARKER = "cmux-pi-session-extension-marker v2";
/** Conservative bound: the official hook is a small source file, never a general input. */
export const OFFICIAL_HOOK_MAX_BYTES = 64 * 1024;

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && "code" in error
    && ((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new Error("Official hook probe aborted.");
}

type FileIdentity = { dev: number; ino: number; isFile(): boolean };

function requireRegularBoundedFile(entry: { isFile(): boolean; size: number }): void {
  if (!entry.isFile()) throw new Error("Official hook is not a regular file.");
  if (entry.size > OFFICIAL_HOOK_MAX_BYTES) throw new Error("Official hook exceeds the conservative read limit.");
}

/** True only when both observations identify the same regular file. */
export function hasSameRegularFileIdentity(initial: FileIdentity, opened: FileIdentity): boolean {
  return initial.isFile()
    && opened.isFile()
    && initial.dev === opened.dev
    && initial.ino === opened.ino;
}

/** Reads a previously validated hook descriptor without data-driven allocation. */
export async function readBoundedOfficialHookSource(
  handle: Awaited<ReturnType<typeof fs.open>>,
  signal?: AbortSignal,
): Promise<string> {
  // One fixed buffer prevents an untrusted file from driving allocation growth.
  const buffer = Buffer.alloc(OFFICIAL_HOOK_MAX_BYTES + 1);
  let bytesRead = 0;

  while (bytesRead < buffer.length) {
    throwIfAborted(signal);
    const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
    throwIfAborted(signal);
    if (result.bytesRead === 0) break;
    bytesRead += result.bytesRead;
  }

  if (bytesRead > OFFICIAL_HOOK_MAX_BYTES) {
    throw new Error("Official hook exceeds the conservative read limit.");
  }
  return buffer.subarray(0, bytesRead).toString("utf8");
}

export function expandHomeDirectory(value: string, homeDirectory = os.homedir()): string {
  if (value === "~") return homeDirectory;
  if (value.startsWith("~/")) return path.join(homeDirectory, value.slice(2));
  return value;
}

/**
 * Returns false only for a confirmed absent or marker-free hook. Any rejected
 * probe is uncertain and callers must retain official-hook authority.
 */
export async function officialHookDetected(
  env: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
): Promise<boolean> {
  if (env.CMUX_PI_HOOKS_DISABLED === "1") return false;

  const homeDirectory = env.HOME?.trim() || os.homedir();
  const configuredAgentDirectory = env.PI_CODING_AGENT_DIR?.trim();
  const agentDirectory = configuredAgentDirectory
    ? expandHomeDirectory(configuredAgentDirectory, homeDirectory)
    : path.join(homeDirectory, ".pi", "agent");
  const hookPath = path.join(agentDirectory, "extensions", "cmux-session.ts");

  throwIfAborted(signal);
  let initialEntry: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    initialEntry = await fs.lstat(hookPath);
    throwIfAborted(signal);
  } catch (error) {
    // A missing result is authoritative only while this probe remains current.
    throwIfAborted(signal);
    if (isMissing(error)) return false;
    throw error;
  }
  requireRegularBoundedFile(initialEntry);

  // O_NONBLOCK prevents a replacement FIFO from blocking before fstat rejects it.
  // O_NOFOLLOW rejects a leaf symlink on platforms that support the flag.
  throwIfAborted(signal);
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await fs.open(hookPath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | noFollow);
  try {
    throwIfAborted(signal);
    const openedEntry = await handle.stat();
    throwIfAborted(signal);
    requireRegularBoundedFile(openedEntry);
    if (!hasSameRegularFileIdentity(initialEntry, openedEntry)) {
      throw new Error("Official hook changed while it was being opened.");
    }
    const source = await readBoundedOfficialHookSource(handle, signal);
    throwIfAborted(signal);
    return source.includes(OFFICIAL_HOOK_MARKER);
  } finally {
    // Always close the descriptor, including after cancellation.
    const abortedBeforeClose = signal?.aborted;
    const abortReason = signal?.reason;
    await handle.close();
    if (abortedBeforeClose || signal?.aborted) {
      throw abortReason ?? signal?.reason ?? new Error("Official hook probe aborted.");
    }
  }
}
