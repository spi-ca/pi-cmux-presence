import { expect, test } from "bun:test";

import * as fs from "node:fs/promises";

import * as os from "node:os";

import { join } from "node:path";

import {
	createPresenceConsumer,
	createPresenceProducer,
	EVENT_NAMES,
	MAX_INTEGER,
	type PresenceSource,
} from "@pi/presence";

import { resolvePresenceConfig } from "../src/config.js";

import { registerPresenceHooks } from "../src/hooks.js";

import { presenceStatusKey } from "../src/presentation.js";

import { PresenceRuntime } from "../src/runtime.js";

import { fakeSocket } from "./helpers/fake-socket.js";

const ENV_KEYS = [
	"CMUX_WORKSPACE_ID",
	"CMUX_SURFACE_ID",
	"CMUX_SOCKET_PATH",
	"CMUX_PI_HOOKS_DISABLED",
	"PI_CMUX_PRESENCE_ENABLED",
	"PI_CMUX_PRESENCE_TIMEOUT_MS",
	"PI_CMUX_PRESENCE_MAX_QUEUE",
	"PI_CMUX_PRESENCE_NOTIFICATIONS",
	"PI_CMUX_PRESENCE_FLASH",
	"PI_CMUX_PRESENCE_NOTIFY_POLICY",
	"PI_CMUX_PRESENCE_FLASH_POLICY",
	"PI_CMUX_PRESENCE_FINAL_CLEAR_MS",
	"PI_CMUX_PRESENCE_LOG",
	"PI_CMUX_PROFILE",
	"PI_CMUX_NOTIFY_LEVEL",
	"PI_CMUX_SIDEBAR_FLASH",
	"PI_CMUX_SIDEBAR_SOURCE",
] as const;

type Hook = (event: unknown, context?: unknown) => unknown;

type Listener = (payload: unknown) => unknown;

function replaceEnv(values: Record<string, string | undefined>): () => void {
	const previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

	for (const key of ENV_KEYS) {
		if (values[key] === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = values[key];
		}
	}

	return () => {
		for (const [key, value] of previous) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	};
}

function bus() {
	const hooks = new Map<string, Hook[]>();

	const listeners = new Map<string, Listener[]>();

	const emitted: Array<{ name: string; payload: unknown }> = [];

	const api = {
		getAllTools: () => [],
		on(name: string, handler: Hook) {
			hooks.set(name, [...(hooks.get(name) ?? []), handler]);
		},
		events: {
			on(name: string, handler: Listener) {
				listeners.set(name, [...(listeners.get(name) ?? []), handler]);
			},
			emit(name: string, payload: unknown) {
				emitted.push({ name, payload });
				for (const handler of listeners.get(name) ?? []) void handler(payload);
			},
		},
	};

	return {
		api,
		emitted,
		async lifecycle(name: string, event: unknown = {}, context?: unknown) {
			for (const hook of hooks.get(name) ?? []) await hook(event, context);
		},
	};
}

async function waitFor(
	predicate: () => boolean,
	timeoutMs = 500,
): Promise<void> {
	for (let i = 0; i < timeoutMs; i += 1) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
	}
	throw new Error("Timed out waiting for fake socket requests.");
}

/** Let all already-enqueued fake-socket writes settle before exact-count checks. */
async function drainSocketQueue(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 20));
}

async function fixture(
	methods = ["notification.create_for_surface", "surface.trigger_flash"],
	failNotification = false,
	waitForCapabilities?: () => Promise<void>,
) {
	const workspaceId = "00000000-0000-4000-8000-000000000011";

	const surfaceId = "00000000-0000-4000-8000-000000000012";

	const directory = await fs.mkdtemp(
		join(os.tmpdir(), "presence-notification-v2-"),
	);

	const socketPath = join(directory, "cmux.sock");

	const lines: string[] = [];

	const server = await fakeSocket(socketPath, async (line) => {
		lines.push(line);

		if (!line.startsWith("{")) return "OK";

		const request = JSON.parse(line) as { id: number; method: string };

		const failed =
			failNotification && request.method === "notification.create_for_surface";

		if (request.method === "system.capabilities") {
			await waitForCapabilities?.();
			return JSON.stringify({
				id: request.id,
				ok: true,
				result: { protocol: "cmux-socket", version: 2, methods },
			});
		}
		return JSON.stringify({
			id: request.id,
			ok: !failed,
			...(failed
				? { error: { code: "denied", message: "RPC_FAIL" } }
				: { result: {} }),
		});
	});

	const restore = replaceEnv({
		CMUX_WORKSPACE_ID: workspaceId,
		CMUX_SURFACE_ID: surfaceId,
		CMUX_SOCKET_PATH: socketPath,
		CMUX_PI_HOOKS_DISABLED: "1",
		PI_CMUX_PRESENCE_ENABLED: "true",
		PI_CMUX_PRESENCE_TIMEOUT_MS: "100",
		PI_CMUX_PRESENCE_MAX_QUEUE: "32",
		PI_CMUX_PRESENCE_NOTIFICATIONS: "true",
		PI_CMUX_PRESENCE_FLASH: "true",
		PI_CMUX_PRESENCE_NOTIFY_POLICY: "all",
		PI_CMUX_PRESENCE_FLASH_POLICY: "attention",
		PI_CMUX_PRESENCE_FINAL_CLEAR_MS: "60000",
		PI_CMUX_PRESENCE_LOG: "false",
		PI_CMUX_PROFILE: undefined,
		PI_CMUX_NOTIFY_LEVEL: undefined,
		PI_CMUX_SIDEBAR_FLASH: undefined,
		PI_CMUX_SIDEBAR_SOURCE: undefined,
	});

	return {
		lines,
		workspaceId,
		surfaceId,
		cleanup: async () => {
			restore();
			await server.close();
			await fs.rm(directory, { recursive: true, force: true });
		},
	};
}

function notifications(lines: string[]) {
	return lines
		.filter((line) => line.startsWith("{"))
		.map(
			(line) =>
				JSON.parse(line) as {
					method: string;
					params: { title?: string; body?: string };
				},
		)
		.filter((request) => request.method === "notification.create_for_surface");
}

class ManualRuntimeClock {
	nowMs = 0;

	readonly timers: Array<{
		due: number;
		callback: () => void;
		cleared: boolean;
		unrefCalled: boolean;
		unref(): void;
	}> = [];

	now = () => this.nowMs;

	setTimeout = (callback: () => void, delayMs: number) => {
		const timer = {
			due: this.nowMs + delayMs,
			callback,
			cleared: false,
			unrefCalled: false,
			unref() {
				this.unrefCalled = true;
			},
		};

		this.timers.push(timer);
		return timer as unknown as ReturnType<typeof setTimeout>;
	};

	clearTimeout = (timer: ReturnType<typeof setTimeout>) => {
		(timer as unknown as { cleared: boolean }).cleared = true;
	};

	advance(ms: number): void {
		const target = this.nowMs + ms;
		while (true) {
			const timer = this.timers
				.filter((x) => !x.cleared && x.due <= target)
				.sort((a, b) => a.due - b.due)[0];
			if (!timer) break;
			this.nowMs = Math.max(this.nowMs, timer.due);
			timer.cleared = true;
			timer.callback();
		}
		this.nowMs = target;
	}

	/** Advance monotonic time while deliberately leaving queued callbacks dormant. */
	elapseWithoutRunningTimers(ms: number): void {
		this.nowMs += ms;
	}
}

async function start(
	_socket: Awaited<ReturnType<typeof fixture>>,
	config = resolvePresenceConfig(),
	clock?: ManualRuntimeClock,
	hook?: (signal: AbortSignal) => Promise<boolean>,
) {
	const pi = bus();
	const runtime = new PresenceRuntime(pi.api as never, config, clock, hook);
	registerPresenceHooks(pi.api as never, runtime);

	await runtime.startSession({
		sessionManager: { getSessionId: () => "acceptance-session" },
	});

	return { pi, runtime };
}
function producer(pi: ReturnType<typeof bus>, source: PresenceSource) {
	const handle = createPresenceProducer({
		source,
		emit: (name: string, payload: unknown) => pi.api.events.emit(name, payload),
	});

	expect(handle).toBeDefined();
	expect(handle!.activate()).toBe(true);
	return handle!;
}
function subagentState(
	generation: number,
	sequence: number,
	overrides: Record<string, unknown> = {},
) {
	return {
		version: 2,
		generation,
		sequence,
		source: "subagent",
		state: "running",
		subagents: {
			running: 1,
			cancelling: 0,
			queued: 0,
			completed: 0,
			failed: 0,
			cancelled: 0,
			omitted: 0,
		},
		...overrides,
	};
}
function inputState(
	generation: number,
	sequence: number,
	occurrence: "new" | "retained" = "new",
) {
	return {
		version: 2,
		generation,
		sequence,
		source: "interaction",
		state: "waiting",
		interaction: { kind: "ask_user", pending: 1 },
		attention: { reason: "input_required", occurrence },
	};
}
async function close(
	runtime: PresenceRuntime,
	handles: Array<{ deactivate(): boolean }>,
	socket: Awaited<ReturnType<typeof fixture>>,
) {
	for (const handle of handles) handle.deactivate();
	await runtime.shutdownSession();
	await socket.cleanup();
}

test("subagent ordinary, cancelling, replay, and cancellation stay quiet", async () => {
	const socket = await fixture();
	const { pi, runtime } = await start(socket);
	const subagent = producer(pi, "subagent");

	try {
		subagent.publishState(subagentState(1, 0));

		subagent.publishState(
			subagentState(1, 1, {
				subagents: {
					running: 0,
					cancelling: 1,
					queued: 0,
					completed: 0,
					failed: 0,
					cancelled: 0,
					omitted: 0,
				},
			}),
		);

		subagent.publishTerminal({
			version: 2,
			generation: 1,
			sequence: 2,
			source: "subagent",
			eventId: 0,
			outcome: "cancelled",
		});

		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(notifications(socket.lines)).toEqual([]);
		expect(
			socket.lines.filter((line) => line.includes("surface.trigger_flash")),
		).toEqual([]);
	} finally {
		await close(runtime, [subagent], socket);
	}
});

test("producer-first retained interaction renders status but never replays attention", async () => {
	const socket = await fixture();
	const pi = bus();
	const input = producer(pi, "interaction");

	try {
		input.publishState(inputState(1, 0));

		const runtime = new PresenceRuntime(
			pi.api as never,
			resolvePresenceConfig(),
		);
		registerPresenceHooks(pi.api as never, runtime);

		await runtime.startSession({
			sessionManager: { getSessionId: () => "producer-first" },
		});

		await waitFor(() =>
			socket.lines.some((line) => line.includes('"Pi needs your input"')),
		);

		expect(notifications(socket.lines)).toEqual([]);
		await runtime.shutdownSession();
	} finally {
		input.deactivate();
		await socket.cleanup();
	}
});

test("interaction uses private fixed wording and emits one input notification", async () => {
	const socket = await fixture();
	const { pi, runtime } = await start(socket, {
		...resolvePresenceConfig(),
		log: true,
	});
	const input = producer(pi, "interaction");

	try {
		expect(input.publishState(inputState(1, 0))).toBe(true);
		await waitFor(() => notifications(socket.lines).length === 1);

		expect(notifications(socket.lines)[0]?.params).toMatchObject({
			title: "Pi needs your input",
			body: "Pi needs your input",
		});

		expect(socket.lines.join("\n")).not.toContain("ask_user");

		expect(
			socket.lines.some((line) =>
				line.startsWith(
					`set_status ${presenceStatusKey("interaction", socket.surfaceId)} "Pi needs your input"`,
				),
			),
		).toBe(true);
	} finally {
		await close(runtime, [input], socket);
	}
});

test("interaction withdrawal clears status and fences same-generation state", async () => {
	const socket = await fixture();
	const { pi, runtime } = await start(socket);
	const input = producer(pi, "interaction");

	try {
		input.publishState(inputState(3, 0));
		await waitFor(() =>
			socket.lines.some((line) => line.startsWith("set_status ")),
		);

		expect(
			input.withdraw({
				version: 2,
				generation: 3,
				sequence: 1,
				source: "interaction",
			}),
		).toBe(true);

		expect(input.publishState(inputState(3, 2))).toBe(false);

		await waitFor(() =>
			socket.lines.some((line) =>
				line.startsWith(
					`clear_status ${presenceStatusKey("interaction", socket.surfaceId)}`,
				),
			),
		);

		expect(input.publishState(inputState(4, 0))).toBe(true);
	} finally {
		await close(runtime, [input], socket);
	}
});

test("shared V2 parser rejects malformed near-misses before runtime presentation", async () => {
	const socket = await fixture();
	const { pi, runtime } = await start(socket);
	const input = producer(pi, "interaction");

	try {
		expect(input.publishState({ ...inputState(1, 0), source: "unknown" })).toBe(
			false,
		);

		expect(
			input.publishState({
				...inputState(1, 0),
				attention: { reason: "input_required", occurrence: "old" },
			}),
		).toBe(false);

		expect(
			input.publishTerminal({
				version: 2,
				generation: 1,
				sequence: 1,
				source: "interaction",
				eventId: 0,
				outcome: "completed",
			}),
		).toBe(false);

		pi.api.events.emit(EVENT_NAMES.state, {
			...inputState(1, 0),
			sessionEpoch: "forged",
		});

		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(
			socket.lines.some((line) =>
				line.includes(presenceStatusKey("interaction", socket.surfaceId)),
			),
		).toBe(false);
	} finally {
		await close(runtime, [input], socket);
	}
});

test("generic input attention dedupes repeats and reopens after a retained-none state", async () => {
	const socket = await fixture();
	const { pi, runtime } = await start(socket);
	const input = producer(pi, "interaction");

	try {
		input.publishState(inputState(1, 0));
		input.publishState(inputState(1, 1));
		await waitFor(() => notifications(socket.lines).length === 1);

		input.publishState(inputState(1, 2, "retained"));
		input.publishState(inputState(1, 3));

		await waitFor(() => notifications(socket.lines).length === 2);
	} finally {
		await close(runtime, [input], socket);
	}
});

test("generation churn is bounded to four immediate outputs and one coalesced refill", async () => {
	const socket = await fixture();
	const clock = new ManualRuntimeClock();
	const { pi, runtime } = await start(socket, resolvePresenceConfig(), clock);
	const input = producer(pi, "interaction");

	try {
		for (let generation = 1; generation <= 6; generation += 1)
			input.publishState(inputState(generation, 0));

		await waitFor(() => notifications(socket.lines).length === 4);
		clock.advance(999);
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(notifications(socket.lines)).toHaveLength(4);
		clock.advance(1);
		await waitFor(() => notifications(socket.lines).length === 5);
	} finally {
		await close(runtime, [input], socket);
	}
});

test("notification and flash policies remain independently capability-gated", async () => {
	const observe = async (
		methods: string[],
		notificationPolicy: "all" | "errors",
		flashPolicy: "attention" | "disabled",
		expected: [number, number],
	) => {
		const socket = await fixture(methods);
		const { pi, runtime } = await start(socket, {
			...resolvePresenceConfig(),
			notificationPolicy,
			flashPolicy,
		});
		const input = producer(pi, "interaction");

		try {
			input.publishState(inputState(1, 0));
			await waitFor(() =>
				socket.lines.some((line) => line.startsWith("set_status ")),
			);
			await runtime.shutdownSession();
			expect(notifications(socket.lines)).toHaveLength(expected[0]);
			expect(
				socket.lines.filter((line) => line.includes("surface.trigger_flash")),
			).toHaveLength(expected[1]);
		} finally {
			input.deactivate();
			await socket.cleanup();
		}
	};

	await observe(
		["notification.create_for_surface"],
		"all",
		"attention",
		[1, 0],
	);

	await observe(["surface.trigger_flash"], "all", "attention", [0, 1]);

	await observe(
		["notification.create_for_surface", "surface.trigger_flash"],
		"errors",
		"attention",
		[0, 0],
	);

	await observe(
		["notification.create_for_surface", "surface.trigger_flash"],
		"all",
		"disabled",
		[1, 0],
	);
});

test("successful terminal ordinals form one fixed 450ms count-aware burst", async () => {
	const socket = await fixture();
	const clock = new ManualRuntimeClock();
	const { pi, runtime } = await start(socket, resolvePresenceConfig(), clock);
	const subagent = producer(pi, "subagent");

	try {
		subagent.publishTerminal({
			version: 2,
			generation: 1,
			sequence: 0,
			source: "subagent",
			eventId: 0,
			outcome: "completed",
		});
		clock.advance(300);

		subagent.publishTerminal({
			version: 2,
			generation: 1,
			sequence: 1,
			source: "subagent",
			eventId: 1,
			outcome: "completed",
		});
		clock.advance(149);

		expect(notifications(socket.lines)).toEqual([]);
		clock.advance(1);
		await waitFor(() => notifications(socket.lines).length === 1);

		expect(notifications(socket.lines)[0]?.params).toMatchObject({
			title: "Subagents completed",
			body: "2 completed",
		});
	} finally {
		await close(runtime, [subagent], socket);
	}
});

test("failed terminal ordinals form one fixed 100ms burst", async () => {
	const socket = await fixture();
	const clock = new ManualRuntimeClock();
	const { pi, runtime } = await start(socket, resolvePresenceConfig(), clock);
	const subagent = producer(pi, "subagent");

	try {
		subagent.publishTerminal({
			version: 2,
			generation: 1,
			sequence: 0,
			source: "subagent",
			eventId: 0,
			outcome: "failed",
		});
		clock.advance(50);

		subagent.publishTerminal({
			version: 2,
			generation: 1,
			sequence: 1,
			source: "subagent",
			eventId: 1,
			outcome: "failed",
		});
		clock.advance(50);

		await waitFor(() => notifications(socket.lines).length === 1);
		expect(notifications(socket.lines)[0]?.params).toMatchObject({
			title: "Subagents need attention",
			body: "2 failed",
		});
	} finally {
		await close(runtime, [subagent], socket);
	}
});

test("a terminal accepted during delayed socket startup dispatches after owned output is ready", async () => {
	let releaseCapabilities: (() => void) | undefined;
	let signalCapabilities: (() => void) | undefined;
	const capabilitiesRequested = new Promise<void>((resolve) => {
		signalCapabilities = resolve;
	});
	const capabilitiesGate = new Promise<void>((resolve) => {
		releaseCapabilities = resolve;
	});
	const socket = await fixture(
		["notification.create_for_surface", "surface.trigger_flash"],
		false,
		async () => {
			signalCapabilities?.();
			await capabilitiesGate;
		},
	);
	const clock = new ManualRuntimeClock();
	const pi = bus();
	const runtime = new PresenceRuntime(pi.api as never, resolvePresenceConfig(), clock);
	registerPresenceHooks(pi.api as never, runtime);
	const subagent = producer(pi, "subagent");

	try {
		const sessionStart = runtime.startSession({
			sessionManager: { getSessionId: () => "delayed-socket-startup" },
		});
		await capabilitiesRequested;

		expect(subagent.publishTerminal({
			version: 2,
			generation: 1,
			sequence: 0,
			source: "subagent",
			eventId: 0,
			outcome: "failed",
		})).toBe(true);
		clock.advance(100);
		await drainSocketQueue();
		expect(notifications(socket.lines)).toEqual([]);

		releaseCapabilities?.();
		await sessionStart;
		await waitFor(() => notifications(socket.lines).length === 1);
		expect(notifications(socket.lines)[0]?.params).toMatchObject({
			title: "Subagents need attention",
			body: "1 failed",
		});
	} finally {
		await close(runtime, [subagent], socket);
	}
});

test("slow startup dispatches the settled parent fallback when a deferred child is withdrawn", async () => {
	let releaseCapabilities: (() => void) | undefined;
	let signalCapabilities: (() => void) | undefined;
	const capabilitiesRequested = new Promise<void>((resolve) => {
		signalCapabilities = resolve;
	});
	const capabilitiesGate = new Promise<void>((resolve) => {
		releaseCapabilities = resolve;
	});
	const socket = await fixture(
		["notification.create_for_surface", "surface.trigger_flash"],
		false,
		async () => {
			signalCapabilities?.();
			await capabilitiesGate;
		},
	);
	const clock = new ManualRuntimeClock();
	const pi = bus();
	const runtime = new PresenceRuntime(pi.api as never, resolvePresenceConfig(), clock);
	registerPresenceHooks(pi.api as never, runtime);
	const subagent = producer(pi, "subagent");

	try {
		const sessionStart = runtime.startSession({
			sessionManager: { getSessionId: () => "delayed-parent-fallback" },
		});
		await capabilitiesRequested;
		await pi.lifecycle("agent_start");
		expect(subagent.publishTerminal({
			version: 2,
			generation: 1,
			sequence: 0,
			source: "subagent",
			eventId: 0,
			outcome: "completed",
		})).toBe(true);
		clock.advance(450);
		await pi.lifecycle("agent_end", { messages: [{ stopReason: "stop" }] });
		await pi.lifecycle("agent_settled", {}, { isIdle: () => true });

		// The closed child aggregate suppresses the parent before cmux is ready.
		// Its withdrawal must release the original parent terminal, not discard it.
		expect(subagent.withdraw({
			version: 2,
			generation: 1,
			sequence: 1,
			source: "subagent",
		})).toBe(true);
		expect(notifications(socket.lines)).toEqual([]);

		releaseCapabilities?.();
		await sessionStart;
		await waitFor(() => notifications(socket.lines).length === 1);
		expect(notifications(socket.lines)[0]?.params).toMatchObject({
			title: "Pi",
			body: "Response ready",
		});
	} finally {
		releaseCapabilities?.();
		await close(runtime, [subagent], socket);
	}
});

test("slow startup keeps hard-cap wording when parent settlement re-evaluates deferred output", async () => {
	let releaseCapabilities: (() => void) | undefined;
	let signalCapabilities: (() => void) | undefined;
	const capabilitiesRequested = new Promise<void>((resolve) => {
		signalCapabilities = resolve;
	});
	const capabilitiesGate = new Promise<void>((resolve) => {
		releaseCapabilities = resolve;
	});
	const socket = await fixture(
		["notification.create_for_surface", "surface.trigger_flash"],
		false,
		async () => {
			signalCapabilities?.();
			await capabilitiesGate;
		},
	);
	const clock = new ManualRuntimeClock();
	const pi = bus();
	const runtime = new PresenceRuntime(pi.api as never, resolvePresenceConfig(), clock);
	registerPresenceHooks(pi.api as never, runtime);
	const subagent = producer(pi, "subagent");

	try {
		const sessionStart = runtime.startSession({
			sessionManager: { getSessionId: () => "delayed-hard-cap" },
		});
		await capabilitiesRequested;
		await pi.lifecycle("agent_start");
		expect(subagent.publishTerminal({
			version: 2,
			generation: 1,
			sequence: 0,
			source: "subagent",
			eventId: 0,
			outcome: "failed",
		})).toBe(true);
		clock.advance(10_000);
		await pi.lifecycle("agent_end", { messages: [{ stopReason: "stop" }] });
		await pi.lifecycle("agent_settled", {}, { isIdle: () => true });

		releaseCapabilities?.();
		await sessionStart;
		await waitFor(() => notifications(socket.lines).length === 1);
		expect(notifications(socket.lines)[0]?.params).toMatchObject({
			title: "Subagent failed",
			body: "1 failed · Parent is processing results",
		});
	} finally {
		releaseCapabilities?.();
		await close(runtime, [subagent], socket);
	}
});

test("state-before-terminal uses only the explicit terminal ordinal", async () => {
	const socket = await fixture();
	const clock = new ManualRuntimeClock();
	const { pi, runtime } = await start(socket, resolvePresenceConfig(), clock);
	const subagent = producer(pi, "subagent");

	try {
		subagent.publishState(
			subagentState(8, 0, {
				subagents: {
					running: 0,
					cancelling: 0,
					queued: 0,
					completed: 99,
					failed: 0,
					cancelled: 0,
					omitted: 0,
				},
			}),
		);

		subagent.publishTerminal({
			version: 2,
			generation: 8,
			sequence: 1,
			source: "subagent",
			eventId: 0,
			outcome: "completed",
		});
		clock.advance(450);

		await waitFor(() => notifications(socket.lines).length === 1);
		expect(notifications(socket.lines)[0]?.params.body).toBe("1 completed");
	} finally {
		await close(runtime, [subagent], socket);
	}
});

test("same-generation count resets refresh the baseline without cancelling an accepted terminal aggregate", async () => {
	const socket = await fixture();
	const clock = new ManualRuntimeClock();
	const { pi, runtime } = await start(socket, resolvePresenceConfig(), clock);
	const subagent = producer(pi, "subagent");

	try {
		expect(subagent.publishState(subagentState(12, 0, {
			subagents: {
				running: 0,
				cancelling: 0,
				queued: 0,
				completed: 8,
				failed: 3,
				cancelled: 0,
				omitted: 0,
			},
		}))).toBe(true);
		expect(subagent.publishTerminal({
			version: 2,
			generation: 12,
			sequence: 1,
			source: "subagent",
			eventId: 0,
			outcome: "failed",
		})).toBe(true);
		// The state counters reset in the same generation after the accepted
		// terminal. They only establish the next presentation baseline.
		expect(subagent.publishState(subagentState(12, 2))).toBe(true);

		clock.advance(100);
		await waitFor(() => notifications(socket.lines).length === 1);
		expect(notifications(socket.lines)[0]?.params).toMatchObject({
			title: "Subagents need attention",
			body: "1 failed",
		});
	} finally {
		await close(runtime, [subagent], socket);
	}
});

test("a higher-generation state invalidates a terminal-first pending aggregate", async () => {
	const socket = await fixture();
	const clock = new ManualRuntimeClock();
	const { pi, runtime } = await start(socket, resolvePresenceConfig(), clock);
	const subagent = producer(pi, "subagent");

	try {
		expect(
			subagent.publishTerminal({
				version: 2,
				generation: 1,
				sequence: 0,
				source: "subagent",
				eventId: 0,
				outcome: "failed",
			}),
		).toBe(true);
		// There is no baseline yet. The higher generation must still fence the
		// terminal-first pending timer rather than letting it fire at 100ms.
		expect(subagent.publishState(subagentState(2, 0))).toBe(true);
		clock.advance(10_000);
		await drainSocketQueue();

		expect(notifications(socket.lines)).toEqual([]);
		expect(
			socket.lines.filter((line) => line.includes("surface.trigger_flash")),
		).toEqual([]);
	} finally {
		await close(runtime, [subagent], socket);
	}
});

test("terminal-before-state remains one failure edge despite later counter state", async () => {
	const socket = await fixture();
	const clock = new ManualRuntimeClock();
	const { pi, runtime } = await start(socket, resolvePresenceConfig(), clock);
	const subagent = producer(pi, "subagent");

	try {
		// An earlier generation baseline must not erase the terminal-first
		// tombstone for the new generation.
		expect(subagent.publishState(subagentState(8, 0))).toBe(true);
		subagent.publishTerminal({
			version: 2,
			generation: 9,
			sequence: 0,
			source: "subagent",
			eventId: 0,
			outcome: "failed",
		});

		subagent.publishState(
			subagentState(9, 1, {
				state: "error",
				attention: { reason: "failure", occurrence: "new" },
				subagents: {
					running: 0,
					cancelling: 0,
					queued: 0,
					completed: 0,
					failed: 50,
					cancelled: 0,
					omitted: 0,
				},
			}),
		);
		clock.advance(100);

		await waitFor(() => notifications(socket.lines).length === 1);
		expect(notifications(socket.lines)[0]?.params.body).toBe("1 failed");
	} finally {
		await close(runtime, [subagent], socket);
	}
});

test("a state-first failure consumed by its terminal leaves a same-generation new failure independent", async () => {
	const socket = await fixture();
	const clock = new ManualRuntimeClock();
	const { pi, runtime } = await start(socket, resolvePresenceConfig(), clock);
	const subagent = producer(pi, "subagent");

	try {
		expect(subagent.publishState(subagentState(14, 0, {
			state: "error",
			attention: { reason: "failure", occurrence: "new" },
			subagents: {
				running: 0,
				cancelling: 0,
				queued: 0,
				completed: 0,
				failed: 1,
				cancelled: 0,
				omitted: 0,
			},
		}))).toBe(true);
		expect(subagent.publishTerminal({
			version: 2,
			generation: 14,
			sequence: 1,
			source: "subagent",
			eventId: 0,
			outcome: "failed",
		})).toBe(true);
		clock.advance(100);
		await waitFor(() => notifications(socket.lines).length === 1);
		expect(notifications(socket.lines)[0]?.params.body).toBe("1 failed");

		// The preceding terminal consumed the first state-first failure, so it
		// must not leave a terminal-first tombstone that swallows this new edge.
		expect(subagent.publishState(subagentState(14, 2, {
			state: "error",
			attention: { reason: "failure", occurrence: "new" },
			subagents: {
				running: 0,
				cancelling: 0,
				queued: 0,
				completed: 0,
				failed: 2,
				cancelled: 0,
				omitted: 0,
			},
		}))).toBe(true);
		clock.advance(100);
		await waitFor(() => notifications(socket.lines).length === 2);
		expect(notifications(socket.lines)[1]?.params).toMatchObject({
			title: "Subagents",
			body: "Subagents: error · 2 failed",
		});
	} finally {
		await close(runtime, [subagent], socket);
	}
});

test("expired terminal-first tombstones allow a later same-generation standalone failure", async () => {
	const socket = await fixture();
	const clock = new ManualRuntimeClock();
	const { pi, runtime } = await start(socket, resolvePresenceConfig(), clock);
	const subagent = producer(pi, "subagent");

	try {
		expect(subagent.publishTerminal({
			version: 2,
			generation: 9,
			sequence: 0,
			source: "subagent",
			eventId: 0,
			outcome: "failed",
		})).toBe(true);
		// Pairing fences end with the documented 100ms failure window.
		clock.advance(101);
		await waitFor(() => notifications(socket.lines).length === 1);

		expect(subagent.publishState(subagentState(9, 1, {
			state: "error",
			attention: { reason: "failure", occurrence: "new" },
			subagents: {
				running: 0,
				cancelling: 0,
				queued: 0,
				completed: 0,
				failed: 1,
				cancelled: 0,
				omitted: 0,
			},
		}))).toBe(true);
		clock.advance(100);

		await waitFor(() => notifications(socket.lines).length === 2);
		expect(notifications(socket.lines)[1]?.params).toMatchObject({
			title: "Subagents",
			body: "Subagents: error · 1 failed",
		});
	} finally {
		await close(runtime, [subagent], socket);
	}
});

test("a quiet same-generation state does not cancel a standalone failure alert", async () => {
	const socket = await fixture();
	const clock = new ManualRuntimeClock();
	const { pi, runtime } = await start(socket, resolvePresenceConfig(), clock);
	const subagent = producer(pi, "subagent");

	try {
		expect(subagent.publishState(subagentState(13, 0, {
			state: "error",
			attention: { reason: "failure", occurrence: "new" },
			subagents: {
				running: 0,
				cancelling: 0,
				queued: 0,
				completed: 0,
				failed: 1,
				cancelled: 0,
				omitted: 0,
			},
		}))).toBe(true);
		// Ordinary state churn cannot retract a new failure; only its matching
		// failed terminal or an explicit lifecycle boundary may do so.
		expect(subagent.publishState(subagentState(13, 1))).toBe(true);

		clock.advance(100);
		await waitFor(() => notifications(socket.lines).length === 1);
		expect(notifications(socket.lines)[0]?.params).toMatchObject({
			title: "Subagents",
			body: "Subagents: error · 1 failed",
		});
	} finally {
		await close(runtime, [subagent], socket);
	}
});

test("expired state-first pairing uses its clock deadline before a late terminal can cancel it", async () => {
	const socket = await fixture();
	const clock = new ManualRuntimeClock();
	const { pi, runtime } = await start(socket, resolvePresenceConfig(), clock);
	const subagent = producer(pi, "subagent");

	try {
		expect(subagent.publishState(subagentState(10, 0, {
			state: "error",
			attention: { reason: "failure", occurrence: "new" },
			subagents: {
				running: 0,
				cancelling: 0,
				queued: 0,
				completed: 0,
				failed: 1,
				cancelled: 0,
				omitted: 0,
			},
		}))).toBe(true);
		clock.elapseWithoutRunningTimers(101);

		// The matching terminal arrives after the state pairing deadline, while
		// its timer callback is still dormant. It must not cancel this alert.
		expect(subagent.publishTerminal({
			version: 2,
			generation: 10,
			sequence: 1,
			source: "subagent",
			eventId: 0,
			outcome: "failed",
		})).toBe(true);
		await waitFor(() => notifications(socket.lines).length === 1);
		expect(notifications(socket.lines)[0]?.params).toMatchObject({
			title: "Subagents",
			body: "Subagents: error · 1 failed",
		});

		clock.advance(100);
		await waitFor(() => notifications(socket.lines).length === 2);
	} finally {
		await close(runtime, [subagent], socket);
	}
});

test("expired terminal-first pairing uses its clock deadline before suppressing a late state", async () => {
	const socket = await fixture();
	const clock = new ManualRuntimeClock();
	const { pi, runtime } = await start(socket, resolvePresenceConfig(), clock);
	const subagent = producer(pi, "subagent");

	try {
		expect(subagent.publishTerminal({
			version: 2,
			generation: 11,
			sequence: 0,
			source: "subagent",
			eventId: 0,
			outcome: "failed",
		})).toBe(true);
		clock.elapseWithoutRunningTimers(101);

		// The tombstone is expired even though its callback has not run, so this
		// state is standalone rather than the terminal's paired state.
		expect(subagent.publishState(subagentState(11, 1, {
			state: "error",
			attention: { reason: "failure", occurrence: "new" },
			subagents: {
				running: 0,
				cancelling: 0,
				queued: 0,
				completed: 0,
				failed: 1,
				cancelled: 0,
				omitted: 0,
			},
		}))).toBe(true);

		clock.advance(100);
		await waitFor(() => notifications(socket.lines).length === 2);
		expect(notifications(socket.lines).map((notification) => notification.params)).toContainEqual(
			expect.objectContaining({
				title: "Subagents",
				body: "Subagents: error · 1 failed",
			}),
		);
	} finally {
		await close(runtime, [subagent], socket);
	}
});

test("quiet local state preserves deferred suppression until a cancelled terminal clears it", async () => {
	const socket = await fixture();
	const { runtime } = await start(socket, {
		...resolvePresenceConfig(),
		notificationPolicy: "all",
		flashPolicy: "attention",
	});
	type RuntimeInternals = {
		generation: number;
		localSequence: number;
		suppressParentAttentionOnce: boolean;
		piProducer?: {
			publishState(snapshot: unknown): boolean;
			publishTerminal(snapshot: unknown): boolean;
		};
	};

	try {
		const internal = runtime as unknown as RuntimeInternals;
		const producer = internal.piProducer;
		expect(producer).toBeDefined();
		internal.suppressParentAttentionOnce = true;
		expect(
			producer!.publishState({
				version: 2,
				generation: internal.generation,
				sequence: ++internal.localSequence,
				source: "pi",
				state: "cancelled",
			}),
		).toBe(true);
		expect(internal.suppressParentAttentionOnce).toBe(true);
		expect(
			producer!.publishTerminal({
				version: 2,
				generation: internal.generation,
				sequence: ++internal.localSequence,
				source: "pi",
				eventId: 0,
				outcome: "cancelled",
			}),
		).toBe(true);
		expect(internal.suppressParentAttentionOnce).toBe(false);
		await drainSocketQueue();
		expect(notifications(socket.lines)).toEqual([]);
		expect(
			socket.lines.filter((line) => line.includes("surface.trigger_flash")),
		).toEqual([]);
	} finally {
		await close(runtime, [], socket);
	}
});

test("parent success merges a closed child burst into one response-ready notification", async () => {
	const socket = await fixture();
	const clock = new ManualRuntimeClock();
	const { pi, runtime } = await start(socket, resolvePresenceConfig(), clock);
	const subagent = producer(pi, "subagent");

	try {
		await pi.lifecycle("agent_start");

		subagent.publishState(subagentState(1, 0));

		subagent.publishTerminal({
			version: 2,
			generation: 1,
			sequence: 1,
			source: "subagent",
			eventId: 0,
			outcome: "completed",
		});

		clock.advance(450);

		await pi.lifecycle("agent_end", { messages: [{ stopReason: "stop" }] });

		await pi.lifecycle("agent_settled", {}, { isIdle: () => true });

		await waitFor(() => notifications(socket.lines).length === 1);
		await drainSocketQueue();
		expect(notifications(socket.lines)).toHaveLength(1);
		expect(
			socket.lines.filter((line) => line.includes("surface.trigger_flash")),
		).toHaveLength(1);
		expect(notifications(socket.lines)[0]?.params).toMatchObject({
			title: "Pi response ready",
			body: "Subagents: 1 completed",
		});
	} finally {
		await close(runtime, [subagent], socket);
	}
});

test("active-parent failed terminal has a fixed ten-second deadline and one alert", async () => {
	const socket = await fixture();
	const clock = new ManualRuntimeClock();
	const { pi, runtime } = await start(socket, resolvePresenceConfig(), clock);
	const subagent = producer(pi, "subagent");

	try {
		await pi.lifecycle("agent_start");
		subagent.publishTerminal({
			version: 2,
			generation: 1,
			sequence: 0,
			source: "subagent",
			eventId: 0,
			outcome: "failed",
		});
		clock.advance(9_999);

		expect(notifications(socket.lines)).toEqual([]);
		clock.advance(1);
		await waitFor(() => notifications(socket.lines).length === 1);

		expect(notifications(socket.lines)[0]?.params).toMatchObject({
			title: "Subagent failed",
			body: "1 failed · Parent is processing results",
		});

		await pi.lifecycle("agent_end", { messages: [{ stopReason: "error" }] });
		await pi.lifecycle("agent_settled", {}, { isIdle: () => true });
		expect(notifications(socket.lines)).toHaveLength(1);
	} finally {
		await close(runtime, [subagent], socket);
	}
});

test("cancelled parent resolves child completion independently without leaking next run", async () => {
	const socket = await fixture();
	const clock = new ManualRuntimeClock();
	const { pi, runtime } = await start(socket, resolvePresenceConfig(), clock);
	const subagent = producer(pi, "subagent");

	try {
		await pi.lifecycle("agent_start");
		subagent.publishTerminal({
			version: 2,
			generation: 1,
			sequence: 0,
			source: "subagent",
			eventId: 0,
			outcome: "completed",
		});
		clock.advance(450);

		await pi.lifecycle("agent_end", { messages: [{ stopReason: "aborted" }] });
		await pi.lifecycle("agent_settled", {}, { isIdle: () => true });
		await waitFor(() => notifications(socket.lines).length === 1);

		await pi.lifecycle("agent_start");
		await pi.lifecycle("agent_end", { messages: [{ stopReason: "stop" }] });
		await pi.lifecycle("agent_settled", {}, { isIdle: () => true });
		expect(notifications(socket.lines)).toHaveLength(1);
	} finally {
		await close(runtime, [subagent], socket);
	}
});

test("a stale official-hook probe cannot overwrite the current session", async () => {
	const socket = await fixture();
	let resolveProbe: ((value: boolean) => void) | undefined;
	let signal: (() => void) | undefined;
	const waiting = new Promise<void>((resolve) => {
		signal = resolve;
	});
	let probes = 0;
	const pi = bus();

	const runtime = new PresenceRuntime(
		pi.api as never,
		resolvePresenceConfig(),
		undefined,
		() => {
			probes += 1;
			if (probes === 1) {
				signal?.();
				return new Promise<boolean>((resolve) => {
					resolveProbe = resolve;
				});
			}
			return Promise.resolve(true);
		},
	);
	registerPresenceHooks(pi.api as never, runtime);

	try {
		const stale = pi.lifecycle(
			"session_start",
			{},
			{ sessionManager: { getSessionId: () => "stale" } },
		);
		await waiting;
		await pi.lifecycle(
			"session_start",
			{},
			{ sessionManager: { getSessionId: () => "current" } },
		);
		resolveProbe?.(false);
		await stale;
		await pi.lifecycle("agent_start");

		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(
			socket.lines.some(
				(line) =>
					line.startsWith("set_agent_lifecycle ") ||
					line.startsWith("set_agent_pid "),
			),
		).toBe(false);
	} finally {
		await runtime.shutdownSession();
		await socket.cleanup();
	}
});

test("replacement and shutdown fence pending child timers", async () => {
	const socket = await fixture();
	const clock = new ManualRuntimeClock();
	const { pi, runtime } = await start(socket, resolvePresenceConfig(), clock);
	const subagent = producer(pi, "subagent");

	try {
		subagent.publishTerminal({
			version: 2,
			generation: 1,
			sequence: 0,
			source: "subagent",
			eventId: 0,
			outcome: "completed",
		});
		await runtime.startSession({
			sessionManager: { getSessionId: () => "replacement" },
		});
		clock.advance(500);
		expect(notifications(socket.lines)).toEqual([]);

		await pi.lifecycle("agent_start");
		subagent.publishTerminal({
			version: 2,
			generation: 2,
			sequence: 0,
			source: "subagent",
			eventId: 0,
			outcome: "failed",
		});
		await runtime.shutdownSession();
		clock.advance(10_000);
		expect(notifications(socket.lines)).toEqual([]);
	} finally {
		subagent.deactivate();
		await socket.cleanup();
	}
});

test("aggregate output excludes payload and session canaries", async () => {
	const socket = await fixture();
	const clock = new ManualRuntimeClock();
	const { pi, runtime } = await start(socket, resolvePresenceConfig(), clock);
	const subagent = producer(pi, "subagent");

	try {
		subagent.publishState(subagentState(1, 0));
		subagent.publishTerminal({
			version: 2,
			generation: 1,
			sequence: 1,
			source: "subagent",
			eventId: 0,
			outcome: "completed",
		});
		clock.advance(450);
		await waitFor(() => notifications(socket.lines).length === 1);
		for (const canary of [
			"acceptance-session",
			"RAW_OUTPUT_CANARY",
			"/private/PATH_CANARY",
		])
			expect(socket.lines.join("\n")).not.toContain(canary);
	} finally {
		await close(runtime, [subagent], socket);
	}
});

test("notification RPC failure remains best effort and teardown clears interaction status", async () => {
	const socket = await fixture(["notification.create_for_surface"], true);
	const { pi, runtime } = await start(socket);
	const input = producer(pi, "interaction");
	const unhandled: unknown[] = [];
	const listener = (reason: unknown) => unhandled.push(reason);
	process.on("unhandledRejection", listener);

	try {
		input.publishState(inputState(1, 0));
		await waitFor(
			() =>
				socket.lines.some((line) => line.startsWith("set_status ")) &&
				notifications(socket.lines).length === 1,
		);
		await runtime.shutdownSession();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(unhandled).toEqual([]);
		expect(socket.lines).toContain(
			`clear_status ${presenceStatusKey("interaction", socket.surfaceId)} --tab=${socket.workspaceId}`,
		);
	} finally {
		process.off("unhandledRejection", listener);
		input.deactivate();
		await socket.cleanup();
	}
});

test("local terminal wording is static, settles once, and clears on its final deadline", async () => {
	const socket = await fixture(["notification.create_for_surface"]);
	const clock = new ManualRuntimeClock();
	const { pi, runtime } = await start(
		socket,
		{ ...resolvePresenceConfig(), finalClearMs: 25 },
		clock,
	);

	try {
		await pi.lifecycle("agent_start");
		await pi.lifecycle("message_end", {
			message: { role: "assistant", content: "RAW_OUTPUT_CANARY" },
		});
		await pi.lifecycle("agent_end", {
			messages: [{ stopReason: "error", error: "RAW_ERROR_CANARY" }],
		});
		await pi.lifecycle("agent_settled", {}, { isIdle: () => true });
		await waitFor(() => notifications(socket.lines).length === 1);
		expect(notifications(socket.lines)[0]?.params).toMatchObject({
			title: "Pi",
			body: "Needs attention",
		});
		await pi.lifecycle("agent_settled", {}, { isIdle: () => true });
		expect(notifications(socket.lines)).toHaveLength(1);
		expect(socket.lines.join("\n")).not.toContain("RAW_OUTPUT_CANARY");
		clock.advance(25);
		await waitFor(() =>
			socket.lines.includes(
				`clear_status ${presenceStatusKey("pi", socket.surfaceId)} --tab=${socket.workspaceId}`,
			),
		);
	} finally {
		await close(runtime, [], socket);
	}
});

test("shutdown withdraws bounded local pi and todo sources before deactivation", async () => {
	const socket = await fixture();
	const { pi, runtime } = await start(socket);
	const remote = createPresenceConsumer({ id: "pi-herdr-presence" });
	const retained = new Set<string>();
	const withdrawals: Array<{ source: string; sequence: number }> = [];

	expect(remote).toBeDefined();
	pi.api.events.on(EVENT_NAMES.state, (payload) => {
		const accepted = remote!.accept(EVENT_NAMES.state, payload);
		if (accepted && "state" in accepted) retained.add(accepted.source);
	});
	pi.api.events.on(EVENT_NAMES.withdraw, (payload) => {
		const accepted = remote!.accept(EVENT_NAMES.withdraw, payload);
		if (accepted && !("state" in accepted) && !("eventId" in accepted)) {
			retained.delete(accepted.source);
			withdrawals.push({ source: accepted.source, sequence: accepted.sequence });
		}
	});
	expect(remote!.activate()).toBe(true);

	try {
		(pi.api as { getAllTools(): unknown }).getAllTools = () => [{
			name: "todo",
			sourceInfo: {
				path: "/project/todo.ts",
				source: "project",
				scope: "project",
				origin: "top-level",
			},
		}];
		await pi.lifecycle("tool_result", {
			toolName: "todo",
			isError: false,
			details: {
				action: "list",
				params: {},
				nextId: 2,
				tasks: [{ id: 1, status: "pending" }],
			},
		});
		expect(retained).toEqual(new Set(["pi", "todo"]));

		await runtime.shutdownSession();

		expect(withdrawals).toEqual(expect.arrayContaining([
			{ source: "pi", sequence: MAX_INTEGER },
			{ source: "todo", sequence: MAX_INTEGER },
		]));
		expect(retained).toEqual(new Set());
	} finally {
		remote!.deactivate();
		await socket.cleanup();
	}
});

test("terminal-only withdrawal leaves no stale retained subagent status", async () => {
	const socket = await fixture();
	const { pi, runtime } = await start(socket);
	const subagent = producer(pi, "subagent");

	try {
		subagent.publishTerminal({
			version: 2,
			generation: 1,
			sequence: 0,
			source: "subagent",
			eventId: 0,
			outcome: "completed",
		});
		expect(
			subagent.withdraw({
				version: 2,
				generation: 1,
				sequence: 1,
				source: "subagent",
			}),
		).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(
			socket.lines.some((line) =>
				line.includes(presenceStatusKey("subagent", socket.surfaceId)),
			),
		).toBe(false);
	} finally {
		await close(runtime, [subagent], socket);
	}
});

test("all accepted channels are the shared V2 event names", () => {
	expect([
		EVENT_NAMES.state,
		EVENT_NAMES.terminal,
		EVENT_NAMES.withdraw,
		EVENT_NAMES.consumerReady,
	]).toEqual([
		"pi-presence:state:v2",
		"pi-presence:terminal:v2",
		"pi-presence:withdraw:v2",
		"pi-presence:consumer-ready:v2",
	]);
});

test("duplicate terminal event IDs and stale sequences cannot split a single terminal burst", async () => {
	const socket = await fixture();

	const clock = new ManualRuntimeClock();

	const { pi, runtime } = await start(socket, resolvePresenceConfig(), clock);

	const subagent = producer(pi, "subagent");

	try {
		expect(
			subagent.publishTerminal({
				version: 2,
				generation: 7,
				sequence: 0,
				source: "subagent",
				eventId: 0,
				outcome: "completed",
			}),
		).toBe(true);

		// Both ingress and the consumer retain the terminal ordinal fence. A
		// repeated ordinal must not be accepted merely because its sequence grows.
		expect(
			subagent.publishTerminal({
				version: 2,
				generation: 7,
				sequence: 1,
				source: "subagent",
				eventId: 0,
				outcome: "completed",
			}),
		).toBe(false);

		expect(
			subagent.publishTerminal({
				version: 2,
				generation: 7,
				sequence: 0,
				source: "subagent",
				eventId: 1,
				outcome: "completed",
			}),
		).toBe(false);

		expect(
			subagent.publishTerminal({
				version: 2,
				generation: 7,
				sequence: 1,
				source: "subagent",
				eventId: 1,
				outcome: "completed",
			}),
		).toBe(true);

		clock.advance(450);

		await waitFor(() => notifications(socket.lines).length === 1);

		expect(notifications(socket.lines)[0]?.params).toMatchObject({
			title: "Subagents completed",
			body: "2 completed",
		});
	} finally {
		await close(runtime, [subagent], socket);
	}
});

test("matching state-before-terminal subagent failures produce one terminal-counted alert", async () => {
	const socket = await fixture();
	const clock = new ManualRuntimeClock();
	const { pi, runtime } = await start(socket, resolvePresenceConfig(), clock);
	const subagent = producer(pi, "subagent");

	try {
		expect(subagent.publishState(subagentState(3, 0, {
			state: "error",
			attention: { reason: "failure", occurrence: "new" },
			subagents: {
				running: 0,
				cancelling: 0,
				queued: 0,
				completed: 4,
				failed: 2,
				cancelled: 0,
				omitted: 0,
			},
		}))).toBe(true);
		expect(subagent.publishTerminal({
			version: 2,
			generation: 3,
			sequence: 1,
			source: "subagent",
			eventId: 0,
			outcome: "failed",
		})).toBe(true);

		clock.advance(100);
		await waitFor(() => notifications(socket.lines).length === 1);
		expect(notifications(socket.lines)[0]?.params).toMatchObject({
			title: "Subagents need attention",
			// The explicit terminal, never the state counters, owns this count.
			body: "1 failed",
		});
		clock.advance(1_000);
		await drainSocketQueue();
		expect(notifications(socket.lines)).toHaveLength(1);
	} finally {
		await close(runtime, [subagent], socket);
	}
});

test("standalone subagent failure and blocked states each alert once", async () => {
	const socket = await fixture();
	const clock = new ManualRuntimeClock();
	const { pi, runtime } = await start(socket, resolvePresenceConfig(), clock);
	const subagent = producer(pi, "subagent");

	try {
		expect(subagent.publishState(subagentState(3, 0, {
			state: "error",
			attention: { reason: "failure", occurrence: "new" },
			subagents: {
				running: 0,
				cancelling: 0,
				queued: 0,
				completed: 4,
				failed: 2,
				cancelled: 0,
				omitted: 0,
			},
		}))).toBe(true);
		clock.advance(100);
		await waitFor(() => notifications(socket.lines).length === 1);
		expect(notifications(socket.lines)[0]?.params).toMatchObject({
			title: "Subagents",
			body: "Subagents: error · 4 done · 2 failed",
		});

		expect(subagent.publishState(subagentState(4, 0, {
			state: "waiting",
			attention: { reason: "blocked", occurrence: "new" },
			subagents: {
				running: 0,
				cancelling: 0,
				queued: 0,
				completed: 0,
				failed: 0,
				cancelled: 0,
				omitted: 0,
			},
		}))).toBe(true);
		await waitFor(() => notifications(socket.lines).length === 2);
		expect(notifications(socket.lines)[1]?.params).toMatchObject({
			title: "Subagents",
			body: "Subagents: error",
		});
	} finally {
		await close(runtime, [subagent], socket);
	}
});

test("withdrawal, generation change, and teardown clear pending failure-state alerts", async () => {
	const socket = await fixture();
	const clock = new ManualRuntimeClock();
	const { pi, runtime } = await start(socket, resolvePresenceConfig(), clock);
	const subagent = producer(pi, "subagent");
	const failure = (generation: number, sequence: number) => subagentState(generation, sequence, {
		state: "error",
		attention: { reason: "failure", occurrence: "new" },
	});

	try {
		expect(subagent.publishState(failure(1, 0))).toBe(true);
		expect(subagent.withdraw({ version: 2, generation: 1, sequence: 1, source: "subagent" })).toBe(true);
		clock.advance(100);

		expect(subagent.publishState(failure(2, 0))).toBe(true);
		expect(subagent.publishState(subagentState(3, 0))).toBe(true);
		clock.advance(100);

		expect(subagent.publishState(failure(4, 0))).toBe(true);
		await runtime.shutdownSession();
		clock.advance(100);
		await drainSocketQueue();
		expect(notifications(socket.lines)).toEqual([]);
	} finally {
		subagent.deactivate();
		await socket.cleanup();
	}
});

test("a failure superseding a success terminal uses the error window and preserves both explicit counts", async () => {
	const socket = await fixture();

	const clock = new ManualRuntimeClock();

	const { pi, runtime } = await start(socket, resolvePresenceConfig(), clock);

	const subagent = producer(pi, "subagent");

	try {
		subagent.publishTerminal({
			version: 2,
			generation: 5,
			sequence: 0,
			source: "subagent",
			eventId: 0,
			outcome: "completed",
		});

		clock.advance(25);

		subagent.publishTerminal({
			version: 2,
			generation: 5,
			sequence: 1,
			source: "subagent",
			eventId: 1,
			outcome: "failed",
		});

		clock.advance(99);

		expect(notifications(socket.lines)).toEqual([]);

		clock.advance(1);

		await waitFor(() => notifications(socket.lines).length === 1);

		expect(notifications(socket.lines)[0]?.params).toMatchObject({
			title: "Subagents need attention",
			body: "1 completed · 1 failed",
		});
	} finally {
		await close(runtime, [subagent], socket);
	}
});

test("withdrawal cancels a rate-limited pending input notification without poisoning the next wait", async () => {
	const socket = await fixture();

	const clock = new ManualRuntimeClock();

	const { pi, runtime } = await start(socket, resolvePresenceConfig(), clock);

	const input = producer(pi, "interaction");

	try {
		// Consume the four-token external-attention bucket with real, accepted
		// V2 events. The next event is queued rather than emitted immediately.
		for (let generation = 1; generation <= 4; generation += 1) {
			expect(input.publishState(inputState(generation, 0))).toBe(true);
		}
		await waitFor(() => notifications(socket.lines).length === 4);

		expect(input.publishState(inputState(5, 0))).toBe(true);

		expect(
			input.withdraw({
				version: 2,
				generation: 5,
				sequence: 1,
				source: "interaction",
			}),
		).toBe(true);

		clock.advance(1_000);

		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(notifications(socket.lines)).toHaveLength(4);

		// The fresh generation is a new lifecycle and can use the replenished
		// token, proving the withdrawn pending work did not poison the source.
		expect(input.publishState(inputState(6, 0))).toBe(true);

		await waitFor(() => notifications(socket.lines).length === 5);

		expect(notifications(socket.lines)[4]?.params).toMatchObject({
			title: "Pi needs your input",
		});
	} finally {
		await close(runtime, [input], socket);
	}
});

test("local ordinal rotation withdraws the old source and resets terminal ordinals", async () => {
	const socket = await fixture();
	const { pi, runtime } = await start(socket, {
		...resolvePresenceConfig(),
		notificationPolicy: "all",
		flashPolicy: "attention",
	});

	type RuntimeInternals = {
		generation: number;
		localSequence: number;
		localEventId: number;
		piProducer?: {
			publishTerminal(snapshot: unknown): boolean;
		};
		publish(state: "success"): void;
	};

	try {
		// This is intentionally test-only reflection: production keeps ordinal
		// rotation private and exposes no boundary-injection seam.
		const internal = runtime as unknown as RuntimeInternals;
		const staleProducer = internal.piProducer;
		expect(staleProducer).toBeDefined();
		internal.generation = 12;
		internal.localSequence = MAX_INTEGER - 1;
		internal.localEventId = MAX_INTEGER;
		internal.publish("success");

		const withdrawal = pi.emitted.find(
			(event) => event.name === EVENT_NAMES.withdraw
				&& (event.payload as { source?: unknown }).source === "pi"
				&& (event.payload as { generation?: unknown }).generation === 12,
		);
		expect(withdrawal).toBeDefined();
		expect((withdrawal!.payload as { sequence: number }).sequence).toBe(MAX_INTEGER);
		expect(
			staleProducer!.publishTerminal({
				version: 2,
				generation: 12,
				sequence: MAX_INTEGER,
				source: "pi",
				eventId: MAX_INTEGER,
				outcome: "completed",
			}),
		).toBe(false);

		const terminal = [...pi.emitted].reverse().find(
			(event) => event.name === EVENT_NAMES.terminal
				&& (event.payload as { source?: unknown }).source === "pi",
		);
		expect(terminal).toBeDefined();
		expect(terminal!.payload).toMatchObject({
			generation: 13,
			sequence: 3,
			eventId: 1,
			outcome: "completed",
		});
		await waitFor(() => notifications(socket.lines).length === 1);
		await drainSocketQueue();
		expect(notifications(socket.lines)).toHaveLength(1);
		expect(
			socket.lines.filter((line) => line.includes("surface.trigger_flash")),
		).toHaveLength(1);
	} finally {
		await close(runtime, [], socket);
	}
});

test("consumer receipt delivery is one-shot: a raw replay after accepted bus delivery is inert", async () => {
	const socket = await fixture();

	const { pi, runtime } = await start(socket);

	const captured: Array<{ name: string; payload: unknown }> = [];

	const subagent = createPresenceProducer({
		source: "subagent",
		emit: (name: string, payload: unknown) => {
			captured.push({ name, payload });

			pi.api.events.emit(name, payload);
		},
	});

	expect(subagent?.activate()).toBe(true);

	try {
		expect(subagent?.publishState(subagentState(1, 0))).toBe(true);

		await waitFor(() =>
			socket.lines.some((line) =>
				line.includes(presenceStatusKey("subagent", socket.surfaceId)),
			),
		);

		const statusWrites = socket.lines.filter((line) =>
			line.startsWith("set_status "),
		).length;

		const delivered = captured.find(
			(event) => event.name === EVENT_NAMES.state,
		);

		expect(delivered).toBeDefined();

		// The runtime's shared consumer has already consumed this opaque receipt;
		// calling the bus again with the same payload cannot re-accept it.
		pi.api.events.emit(delivered!.name, delivered!.payload);

		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(
			socket.lines.filter((line) => line.startsWith("set_status ")),
		).toHaveLength(statusWrites);
	} finally {
		await close(runtime, subagent ? [subagent] : [], socket);
	}
});
