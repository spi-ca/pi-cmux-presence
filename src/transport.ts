import net from "node:net";
import { safeSocketFingerprint, type SocketFingerprint } from "./identity.js";

export class PresenceTransportError extends Error {}

function sameFingerprint(left: SocketFingerprint, right: SocketFingerprint): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid;
}

/** A lease identifies exactly one unresolved filesystem fingerprint. */
export type SocketFingerprintLease = object;

const activeFingerprintLeases = new WeakMap<UnresolvedSocketFingerprintGate, SocketFingerprintLease>();

/**
 * Shares ownership of one unabortable socket fingerprint. Transport code reads
 * the module-private lease store directly, so an override cannot replace the
 * intrinsic fingerprint operation or forge its result.
 */
export class UnresolvedSocketFingerprintGate {
  get unresolved(): boolean {
    return activeFingerprintLeases.has(this);
  }

  acquire(): SocketFingerprintLease | null {
    return acquireFingerprintLease(this);
  }

  release(lease: SocketFingerprintLease): boolean {
    return releaseFingerprintLease(this, lease);
  }
}

function acquireFingerprintLease(gate: UnresolvedSocketFingerprintGate): SocketFingerprintLease | null {
  if (!(gate instanceof UnresolvedSocketFingerprintGate)) return null;
  if (activeFingerprintLeases.has(gate)) return null;
  const lease = {};
  activeFingerprintLeases.set(gate, lease);
  return lease;
}

function releaseFingerprintLease(
  gate: UnresolvedSocketFingerprintGate,
  lease: SocketFingerprintLease,
): boolean {
  if (activeFingerprintLeases.get(gate) !== lease) return false;
  activeFingerprintLeases.delete(gate);
  return true;
}

type StartedSocketFingerprint = {
  pending: boolean;
  promise: Promise<SocketFingerprint>;
};

/** Always invokes this module's safeSocketFingerprint; a gate only owns a lease. */
function startSafeSocketFingerprint(
  socketPath: string,
  gate: UnresolvedSocketFingerprintGate,
): StartedSocketFingerprint {
  const lease = acquireFingerprintLease(gate);
  if (!lease) {
    return {
      pending: false,
      promise: Promise.reject(new PresenceTransportError("Socket validation is already unresolved.")),
    };
  }
  return {
    pending: true,
    promise: (async () => {
      try {
        return await safeSocketFingerprint(socketPath);
      } catch (error) {
        const detail = error instanceof Error ? `: ${error.message}` : ".";
        throw new PresenceTransportError(`Socket validation failed${detail}`);
      } finally {
        // A stale result can release only the lease that began it.
        releaseFingerprintLease(gate, lease);
      }
    })(),
  };
}

/**
 * Event-driven cancellation for work that cannot itself accept an AbortSignal.
 * `onAbandoned` owns the still-running operation; callers must not use its
 * eventual result after it is called.
 */
export async function raceAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  abortError: () => PresenceTransportError,
  onAbandoned?: () => void,
): Promise<T> {
  let settled = false;
  void operation.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  if (signal.aborted) {
    if (!settled) onAbandoned?.();
    throw abortError();
  }

  let removeAbort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    const abort = () => {
      if (!settled) onAbandoned?.();
      reject(abortError());
    };
    signal.addEventListener("abort", abort, { once: true });
    removeAbort = () => signal.removeEventListener("abort", abort);
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    removeAbort();
  }
}

async function connectedExchange(
  socketPath: string,
  line: string,
  before: SocketFingerprint,
  signal: AbortSignal,
  abortError: () => PresenceTransportError,
  failCloseQueue: () => void,
  fingerprintGate: UnresolvedSocketFingerprintGate,
): Promise<string> {
  if (signal.aborted) throw abortError();

  return await new Promise<string>((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let buffer = "";
    let settled = false;
    let requestWritten = false;
    // This remains true after a deadline wins the race, until the intrinsic
    // filesystem operation itself settles and releases its lease.
    let postConnectValidationPending = false;
    const finish = (error?: Error, value?: string) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      socket.destroy();
      if (error) reject(error);
      else resolve(value ?? "");
    };
    const abort = () => {
      if (settled) return;
      const failClose = postConnectValidationPending;
      finish(abortError());
      if (failClose) failCloseQueue();
    };

    signal.addEventListener("abort", abort, { once: true });
    const failSocketEvent = (error: PresenceTransportError) => {
      if (settled) return;
      if (requestWritten) {
        finish(error);
        return;
      }
      // Only hostile events during a live post-connect fingerprint can leave
      // an authenticated connection ambiguous enough to fail-close the queue.
      const failClose = postConnectValidationPending;
      finish(error);
      if (failClose) failCloseQueue();
    };

    socket.setEncoding("utf8");
    socket.once("error", (error) => {
      if (settled) return;
      failSocketEvent(new PresenceTransportError(`Socket failure: ${error.message}`));
    });
    const incompleteResponse = () => {
      if (settled) return;
      failSocketEvent(new PresenceTransportError("Socket closed before a complete response."));
    };
    socket.once("end", incompleteResponse);
    socket.once("close", incompleteResponse);
    socket.on("data", (chunk: string) => {
      if (settled) return;
      if (!requestWritten) {
        failSocketEvent(new PresenceTransportError(
          "Socket sent data before post-connect validation and request write.",
        ));
        return;
      }
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > 16 * 1024 + 1) {
        finish(new PresenceTransportError("Socket response exceeds its bound."));
        return;
      }

      const end = buffer.indexOf("\n");
      if (end < 0) return;
      const response = buffer.slice(0, end);
      if (buffer.length !== end + 1) {
        finish(new PresenceTransportError("Socket sent more than one response line."));
        return;
      }
      finish(undefined, response);
    });
    socket.once("connect", () => {
      if (settled || signal.aborted) return;
      const postConnectFingerprint = startSafeSocketFingerprint(socketPath, fingerprintGate);
      postConnectValidationPending = postConnectFingerprint.pending;
      void postConnectFingerprint.promise.then(
        () => { postConnectValidationPending = false; },
        () => { postConnectValidationPending = false; },
      );
      void (async () => {
        try {
          const after = await raceAbort(
            postConnectFingerprint.promise,
            signal,
            abortError,
            () => {
              if (postConnectValidationPending) failCloseQueue();
            },
          );
          // A late post-connect validation must never gain a write opportunity.
          if (settled || signal.aborted) return;
          if (!sameFingerprint(before, after)) {
            finish(new PresenceTransportError("Socket changed during connection."));
            return;
          }
          requestWritten = true;
          socket.write(line, (error) => {
            if (settled || !error) return;
            finish(new PresenceTransportError(`Socket write failed: ${error.message}`));
          });
        } catch (error) {
          if (settled) return;
          const failure = error instanceof PresenceTransportError
            ? error
            : new PresenceTransportError("Socket validation failed.");
          finish(failure);
        }
      })();
    });
  });
}

async function exchange(
  socketPath: string,
  line: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  failCloseQueue: () => void,
  fingerprintGate: UnresolvedSocketFingerprintGate,
): Promise<string> {
  if (signal?.aborted) throw new PresenceTransportError("Socket request aborted.");

  const deadline = new AbortController();
  let timedOut = false;
  const abortFromParent = () => deadline.abort();
  signal?.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    deadline.abort();
  }, timeoutMs);
  const abortError = () => new PresenceTransportError(
    timedOut ? "Socket request timed out." : "Socket request aborted.",
  );

  try {
    const before = await raceAbort(
      startSafeSocketFingerprint(socketPath, fingerprintGate).promise,
      deadline.signal,
      abortError,
    );
    return await connectedExchange(
      socketPath,
      line,
      before,
      deadline.signal,
      abortError,
      failCloseQueue,
      fingerprintGate,
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortFromParent);
  }
}

interface Pending<T> {
  key?: string;
  displaceable: boolean;
  work: (signal: AbortSignal) => Promise<T>;
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export interface SocketQueueOptions {
  /** Optional work may be dropped to make room for primary output. */
  displaceable?: boolean;
}

/**
 * Serial bounded queue. Pending work with the same key uses latest-write-wins
 * coalescing and shares one promise. Displaceable work is kept in FIFO order,
 * but primary work is inserted ahead of it and may evict its newest entry.
 * Active work is never replaced.
 */
export class BoundedSocketQueue {
  private readonly queue: Array<Pending<unknown>> = [];
  private readonly coalesced = new Map<string, Pending<unknown>>();
  private closed = false;
  private abandon = false;
  private drainPromise: Promise<void> | null = null;
  private active: AbortController | null = null;

  constructor(private readonly maxQueue: number) {}

  enqueue<T>(
    work: ((signal: AbortSignal) => Promise<T>) | (() => Promise<T>),
    key?: string,
    options?: SocketQueueOptions,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new PresenceTransportError("Socket queue is closed."));

    if (key) {
      const existing = this.coalesced.get(key) as Pending<T> | undefined;
      if (existing) {
        existing.work = work as (signal: AbortSignal) => Promise<T>;
        return existing.promise;
      }
    }

    const displaceable = options?.displaceable === true;
    if (this.queue.length >= this.maxQueue) {
      if (displaceable) return Promise.reject(new PresenceTransportError("Socket queue is full."));

      let displacedAt = -1;
      for (let index = this.queue.length - 1; index >= 0; index -= 1) {
        if (this.queue[index].displaceable) {
          displacedAt = index;
          break;
        }
      }
      if (displacedAt < 0) return Promise.reject(new PresenceTransportError("Socket queue is full."));
      const [displaced] = this.queue.splice(displacedAt, 1);
      if (displaced.key) this.coalesced.delete(displaced.key);
      displaced.reject(new PresenceTransportError("Socket queue work displaced by primary output."));
    }

    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const pending: Pending<T> = {
      key,
      displaceable,
      work: work as (signal: AbortSignal) => Promise<T>,
      promise,
      resolve,
      reject,
    };

    const firstDisplaceable = displaceable
      ? -1
      : this.queue.findIndex((queued) => queued.displaceable);
    if (firstDisplaceable < 0) this.queue.push(pending as Pending<unknown>);
    else this.queue.splice(firstDisplaceable, 0, pending as Pending<unknown>);
    if (key) this.coalesced.set(key, pending as Pending<unknown>);
    this.startDrain();
    return promise;
  }

  async close(timeoutMs: number): Promise<void> {
    this.closed = true;
    const draining = this.drainPromise ?? Promise.resolve();
    if (timeoutMs <= 0) {
      this.failClose();
      await draining;
      return;
    }

    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    await Promise.race([
      draining,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          expired = true;
          this.failClose();
          resolve();
        }, timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);

    if (expired) {
      this.rejectUndispatched();
      await (this.drainPromise ?? Promise.resolve());
    } else if (this.queue.length > 0) {
      this.rejectUndispatched();
    }
  }

  /** Stop dispatch immediately; used when an unabortable validation is still live. */
  failClose(): void {
    this.closed = true;
    this.abandon = true;
    this.active?.abort();
    this.rejectUndispatched();
  }

  private rejectUndispatched(): void {
    const error = new PresenceTransportError("Socket queue closed before dispatch.");
    for (const pending of this.queue.splice(0)) pending.reject(error);
    this.coalesced.clear();
  }

  private startDrain(): void {
    if (this.drainPromise) return;
    this.drainPromise = this.drain().finally(() => {
      this.drainPromise = null;
      if (this.queue.length > 0 && !this.closed) this.startDrain();
    });
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      if (this.abandon) return;
      const pending = this.queue.shift()!;
      if (pending.key) this.coalesced.delete(pending.key);

      const controller = new AbortController();
      this.active = controller;
      try {
        pending.resolve(await pending.work(controller.signal));
      } catch (error) {
        pending.reject(error);
      } finally {
        if (this.active === controller) this.active = null;
      }
    }
  }
}

export class UnixSocketTransport {
  private readonly queue: BoundedSocketQueue;

  constructor(
    private readonly socketPath: string,
    private readonly timeoutMs: number,
    maxQueue: number,
    private readonly fingerprintGate = new UnresolvedSocketFingerprintGate(),
  ) {
    this.queue = new BoundedSocketQueue(maxQueue);
  }

  request(line: string, key?: string, options?: SocketQueueOptions): Promise<string> {
    return this.queue.enqueue(
      (signal) => exchange(
        this.socketPath,
        line,
        this.timeoutMs,
        signal,
        () => this.queue.failClose(),
        this.fingerprintGate,
      ),
      key,
      options,
    );
  }

  async close(timeoutMs = this.timeoutMs): Promise<void> {
    await this.queue.close(timeoutMs);
  }
}
