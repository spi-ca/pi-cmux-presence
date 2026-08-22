import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import {
	createPresenceConsumer,
	createPresenceProducer,
	EVENT_NAMES,
} from "@pi/presence";
import extension from "../index.js";
import { presenceStatusKey } from "../src/presence.js";
import { fakeSocket } from "./helpers/fake-socket.js";

type Hook = (event: unknown, context?: unknown) => unknown;
type Source = "pi" | "todo" | "subagent" | "interaction";
const keys = [
	"CMUX_WORKSPACE_ID",
	"CMUX_SURFACE_ID",
	"CMUX_SOCKET_PATH",
	"CMUX_PI_HOOKS_DISABLED",
	"PI_CODING_AGENT_DIR",
	"PI_CMUX_PRESENCE_ENABLED",
	"PI_CMUX_PRESENCE_TIMEOUT_MS",
	"PI_CMUX_PRESENCE_MAX_QUEUE",
	"PI_CMUX_PRESENCE_PROGRESS",
	"PI_CMUX_PRESENCE_NOTIFICATIONS",
	"PI_CMUX_PRESENCE_FLASH",
	"PI_CMUX_PRESENCE_NOTIFY_POLICY",
	"PI_CMUX_PRESENCE_FLASH_POLICY",
	"PI_CMUX_PRESENCE_LOG",
	"PI_CMUX_PRESENCE_SIDEBAR",
	"PI_CMUX_PRESENCE_NATIVE_LIFECYCLE",
	"PI_CMUX_PRESENCE_FEED",
	"PI_CMUX_PRESENCE_META_BLOCK",
	"PI_CMUX_PRESENCE_AUTO_TITLE",
	"PI_CMUX_PRESENCE_RESUME_FALLBACK",
	"PI_CMUX_PRESENCE_FINAL_CLEAR_MS",
	"PI_CMUX_PRESENCE_MAX_LABEL_CHARS",
	"PI_CMUX_PROFILE",
	"PI_CMUX_NOTIFY_LEVEL",
	"PI_CMUX_SIDEBAR_FLASH",
];
function env(values: Record<string, string | undefined>) {
	const before = new Map(keys.map((k) => [k, process.env[k]]));
	for (const k of keys) {
		if (values[k] === undefined) {
			delete process.env[k];
		} else {
			process.env[k] = values[k]!;
		}
	}
	return () => {
		for (const [k, v] of before) {
			if (v === undefined) {
				delete process.env[k];
			} else {
				process.env[k] = v;
			}
		}
	};
}
const hosts = new Set<ReturnType<typeof pi>>();
const externalProducers = new Set<
	NonNullable<ReturnType<typeof createPresenceProducer>>
>();
const externalConsumers = new Set<
	NonNullable<ReturnType<typeof createPresenceConsumer>>
>();
function pi(rejectSettled = false) {
	const hooks = new Map<string, Hook[]>(),
		listeners = new Map<string, ((p: unknown) => unknown)[]>(),
		emitted: { name: string; payload: unknown }[] = [];
	const api = {
		getAllTools: () => [],
		on(name: string, fn: Hook) {
			if (rejectSettled && name === "agent_settled") throw Error("unsupported");
			hooks.set(name, [...(hooks.get(name) ?? []), fn]);
		},
		events: {
			on(name: string, fn: (p: unknown) => unknown) {
				listeners.set(name, [...(listeners.get(name) ?? []), fn]);
			},
			emit(name: string, payload: unknown) {
				emitted.push({ name, payload });
				for (const fn of listeners.get(name) ?? []) void fn(payload);
			},
		},
	};
	const host = {
		api,
		emitted,
		hooks,
		listeners,
		emit(name: string, payload: unknown) {
			for (const fn of listeners.get(name) ?? []) void fn(payload);
		},
		async life(name: string, event: unknown = {}, context?: unknown) {
			for (const fn of hooks.get(name) ?? []) await fn(event, context);
		},
	};
	hosts.add(host);
	return host;
}
afterEach(async () => {
	for (const producer of externalProducers) producer.deactivate();
	externalProducers.clear();
	for (const consumer of externalConsumers) consumer.deactivate();
	externalConsumers.clear();
	await Promise.all(
		[...hosts].map((host) => host.life("session_shutdown").catch(() => {})),
	);
	hosts.clear();
});
async function waitFor(p: () => boolean, timeout = 800) {
	const end = performance.now() + timeout;
	while (performance.now() < end) {
		if (p()) return;
		await new Promise((r) => setTimeout(r, 2));
	}
	throw Error("cmux request timed out");
}
async function cmux(
	methods = ["notification.create_for_surface", "surface.trigger_flash"],
	handler?: (line: string) => string | undefined | Promise<string | undefined>,
) {
	const dir = await fs.mkdtemp(join(os.tmpdir(), "entrypoint-v2-")),
		path = join(dir, "cmux.sock"),
		lines: string[] = [];
	const workspaceId = "00000000-0000-4000-8000-000000000001",
		surfaceId = "00000000-0000-4000-8000-000000000002";
	const server = await fakeSocket(path, async (line) => {
		lines.push(line);
		const custom = await handler?.(line);
		if (custom !== undefined) return custom;
		if (!line.startsWith("{")) return "OK";
		const r = JSON.parse(line) as { id: number; method: string };
		return JSON.stringify({
			id: r.id,
			ok: true,
			result:
				r.method === "system.capabilities"
					? { protocol: "cmux-socket", version: 2, methods }
					: {},
		});
	});
	const restore = env({
		CMUX_WORKSPACE_ID: workspaceId,
		CMUX_SURFACE_ID: surfaceId,
		CMUX_SOCKET_PATH: path,
		PI_CMUX_PRESENCE_ENABLED: "true",
		PI_CMUX_PRESENCE_TIMEOUT_MS: "100",
		PI_CMUX_PRESENCE_PROGRESS: "true",
		PI_CMUX_PRESENCE_NOTIFICATIONS: "true",
		PI_CMUX_PRESENCE_FLASH: "true",
		PI_CMUX_PRESENCE_SIDEBAR: "true",
		PI_CMUX_PRESENCE_NATIVE_LIFECYCLE: "true",
	});
	return {
		lines,
		workspaceId,
		surfaceId,
		requests: () =>
			lines
				.filter((l) => l.startsWith("{"))
				.map(
					(l) =>
						JSON.parse(l) as {
							method: string;
							params: Record<string, unknown>;
						},
				),
		async close() {
			restore();
			await server.close();
			await fs.rm(dir, { recursive: true, force: true });
		},
	};
}
const ctx = (id: string) => ({ sessionManager: { getSessionId: () => id } });
const interaction = (g = 0, s = 0, occurrence: "new" | "retained" = "new") => ({
	version: 2 as const,
	generation: g,
	sequence: s,
	source: "interaction" as const,
	state: "waiting" as const,
	interaction: { kind: "ask_user" as const, pending: 1 },
	attention: { reason: "input_required" as const, occurrence },
});
const subagent = (g = 0, s = 0) => ({
	version: 2 as const,
	generation: g,
	sequence: s,
	source: "subagent" as const,
	state: "running" as const,
	subagents: {
		running: 1,
		cancelling: 0,
		queued: 0,
		completed: 0,
		failed: 0,
		cancelled: 0,
		omitted: 0,
	},
});
function externalProducer(
	source: Source,
	emit: (name: string, payload: unknown) => void,
) {
	const p = createPresenceProducer({ source, emit })!;
	externalProducers.add(p);
	return p;
}
function externalConsumer(id: "pi-cmux-presence" | "pi-herdr-presence") {
	const c = createPresenceConsumer({ id })!;
	externalConsumers.add(c);
	return c;
}
function producer(host: ReturnType<typeof pi>, source: Source) {
	const p = externalProducer(source, (name, payload) =>
		host.api.events.emit(name, payload),
	);
	expect(p.activate()).toBe(true);
	return p;
}

// Registration, lifecycle, and strict V2 message wiring.
test("registers the four literal V2 event names", () => {
	const r = env({ PI_CMUX_PRESENCE_ENABLED: "true" });
	try {
		const host = pi();
		extension(host.api as never);
		expect([...host.listeners.keys()]).toEqual([
			"pi-presence:state:v2",
			"pi-presence:terminal:v2",
			"pi-presence:withdraw:v2",
			"pi-presence:consumer-ready:v2",
		]);
	} finally {
		r();
	}
});
test("registers lifecycle observers", () => {
	const host = pi();
	extension(host.api as never);
	expect([...host.hooks.keys()]).toEqual(
		expect.arrayContaining([
			"session_start",
			"agent_start",
			"agent_end",
			"agent_settled",
			"session_shutdown",
		]),
	);
});
test("stalled socket setup does not block lifecycle callbacks or lose an early terminal", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const c = await cmux([], async (line) => {
		if (line.includes('"method":"system.capabilities"')) await gate;
		return undefined;
	});
	try {
		const host = pi();
		extension(host.api as never);
		const start = host.hooks.get("session_start")?.[0];
		expect(start).toBeDefined();
		expect(start!({}, ctx("socket-pending"))).toBeUndefined();
		await waitFor(() =>
			c.lines.some((line) => line.includes('"method":"system.capabilities"')),
		);

		await host.life("agent_start");
		await host.life("agent_end", { messages: [{ stopReason: "stop" }] });
		await host.life("agent_settled");
		expect(host.emitted.some((event) => event.name === EVENT_NAMES.terminal)).toBe(true);

		release();
		await waitFor(() => c.lines.some((line) =>
			line.startsWith("set_status ") && line.includes("Pi · Response ready"),
		));
	} finally {
		release?.();
		await c.close();
	}
});
test("disabled mode registers nothing", () => {
	const r = env({ PI_CMUX_PRESENCE_ENABLED: "false" });
	try {
		const host = pi();
		extension(host.api as never);
		expect(host.hooks.size).toBe(0);
		expect(host.listeners.size).toBe(0);
	} finally {
		r();
	}
});
test("agent_settled fallback is used when registration throws", async () => {
	const host = pi(true);
	extension(host.api as never);
	await host.life("session_start", {}, ctx("fallback"));
	await host.life("agent_start");
	await host.life("agent_end", { messages: [{ stopReason: "stop" }] });
	expect(host.emitted.some((e) => e.name === EVENT_NAMES.terminal)).toBe(true);
	await host.life("session_shutdown");
});
test("non-idle settlement does not emit a terminal", async () => {
	const host = pi();
	extension(host.api as never);
	await host.life("session_start", {}, ctx("busy"));
	await host.life("agent_start");
	await host.life("agent_end", { messages: [{ stopReason: "stop" }] });
	const n = host.emitted.length;
	await host.life("agent_settled", {}, { isIdle: () => false });
	expect(host.emitted).toHaveLength(n);
	await host.life("session_shutdown");
});
test("idle settlement uses an explicit V2 terminal", async () => {
	const host = pi();
	extension(host.api as never);
	await host.life("session_start", {}, ctx("idle"));
	await host.life("agent_start");
	await host.life("agent_end", { messages: [{ stopReason: "stop" }] });
	await host.life("agent_settled");
	expect(host.emitted.some((e) => e.name === EVENT_NAMES.terminal)).toBe(true);
	await host.life("session_shutdown");
});

// V2 consumer-first and producer-first handshake coverage.
test("consumer-first producer receives a target receipt", async () => {
	const host = pi();
	extension(host.api as never);
	await host.life("session_start", {}, ctx("receipt"));
	const p = producer(host, "interaction");
	expect(p.publishState(interaction())).toBe(true);
	expect(host.emitted.some((e) => e.name === EVENT_NAMES.state)).toBe(true);
	p.deactivate();
	await host.life("session_shutdown");
});
test("producer-first retained state is delivered when consumer activates", async () => {
	const host = pi();
	const p = producer(host, "interaction");
	p.publishState(interaction(1, 0, "retained"));
	extension(host.api as never);
	await host.life("session_start", {}, ctx("producer-first"));
	expect(host.emitted.some((e) => e.name === EVENT_NAMES.consumerReady)).toBe(
		true,
	);
	p.deactivate();
	await host.life("session_shutdown");
});
test("replayed receipt is not accepted twice", async () => {
	const host = pi();
	extension(host.api as never);
	await host.life("session_start", {}, ctx("replay"));
	const p = producer(host, "interaction");
	p.publishState(interaction());
	const wire = host.emitted.find((e) => e.name === EVENT_NAMES.state)!;
	const count = host.emitted.length;
	host.emit(wire.name, wire.payload);
	expect(host.emitted).toHaveLength(count);
	p.deactivate();
	await host.life("session_shutdown");
});
test("consumer-ready is not an accepted presence event", async () => {
	const host = pi();
	extension(host.api as never);
	await host.life("session_start", {}, ctx("ready"));
	const n = host.emitted.length;
	host.emit(EVENT_NAMES.consumerReady, { bogus: true });
	expect(host.emitted).toHaveLength(n);
	await host.life("session_shutdown");
});
test("two shared consumers receive consumer-specific deliveries", () => {
	const one = externalConsumer("pi-cmux-presence"),
		two = externalConsumer("pi-herdr-presence");
	const received: unknown[] = [];
	one.activate();
	two.activate();
	const p = externalProducer("subagent", (name, payload) => {
		received.push(one.accept(name, payload), two.accept(name, payload));
	});
	p.activate();
	p.publishState(subagent());
	expect(received.filter(Boolean)).toHaveLength(2);
	p.deactivate();
	one.deactivate();
	two.deactivate();
});
test("local source ownership fences a late producer", async () => {
	const host = pi();
	extension(host.api as never);
	await host.life("session_start", {}, ctx("owner"));
	const late = externalProducer("pi", () => {});
	expect(late.activate()).toBe(false);
	await host.life("session_shutdown");
	expect(late.activate()).toBe(true);
	late.deactivate();
});
test("source ownership fails over after deactivation", () => {
	const a = externalProducer("todo", () => {}),
		b = externalProducer("todo", () => {});
	expect(a.activate()).toBe(true);
	expect(b.activate()).toBe(false);
	a.deactivate();
	expect(b.activate()).toBe(true);
	b.deactivate();
});

// Actual cmux request payloads, privacy, progress, feed, and metadata.
test("interaction renders fixed private status", async () => {
	const c = await cmux();
	try {
		const host = pi();
		extension(host.api as never);
		await host.life("session_start", {}, ctx("private-session"));
		const p = producer(host, "interaction");
		p.publishState(interaction());
		const key = presenceStatusKey("interaction", c.surfaceId);
		await waitFor(() =>
			c.lines.some((l) =>
				l.startsWith(`set_status ${key} "Pi needs your input"`),
			),
		);
		expect(c.lines.join("\n")).not.toContain("private-session");
		p.deactivate();
		await host.life("session_shutdown");
	} finally {
		await c.close();
	}
});
test("interaction has no producer-controlled progress payload", async () => {
	const c = await cmux();
	try {
		const host = pi();
		extension(host.api as never);
		await host.life("session_start", {}, ctx("interaction"));
		const p = producer(host, "interaction");
		p.publishState(interaction());
		await waitFor(() => c.lines.some((l) => l.includes("Pi needs your input")));
		expect(c.lines.some((l) => l.startsWith("set_progress "))).toBe(false);
		p.deactivate();
		await host.life("session_shutdown");
	} finally {
		await c.close();
	}
});
test("subagent numeric progress writes an actual cmux command", async () => {
	const c = await cmux();
	try {
		const host = pi();
		extension(host.api as never);
		await host.life("session_start", {}, ctx("progress"));
		const p = producer(host, "subagent");
		p.publishState({ ...subagent(), progress: { completed: 1, total: 4 } });
		await waitFor(() =>
			c.lines.some(
				(l) =>
					l === `set_progress 0.25 --label="Source 1/4" --tab=${c.workspaceId}`,
			),
		);
		p.deactivate();
		await host.life("session_shutdown");
	} finally {
		await c.close();
	}
});
test("progress disabled sends no set or clear progress", async () => {
	const c = await cmux();
	try {
		process.env.PI_CMUX_PRESENCE_PROGRESS = "false";
		const host = pi();
		extension(host.api as never);
		await host.life("session_start", {}, ctx("no-progress"));
		const p = producer(host, "subagent");
		p.publishState({ ...subagent(), progress: { completed: 1, total: 2 } });
		await host.life("session_shutdown");
		expect(
			c.lines.some((l) => /^(set_progress|clear_progress)\b/.test(l)),
		).toBe(false);
		p.deactivate();
	} finally {
		await c.close();
	}
});
test("metadata is a raw numeric cmux block", async () => {
	const c = await cmux();
	try {
		process.env.PI_CMUX_PRESENCE_META_BLOCK = "true";
		const host = pi();
		extension(host.api as never);
		await host.life("session_start", {}, ctx("meta"));
		await waitFor(() =>
			c.lines.some((l) => l.startsWith("report_meta_block ")),
		);
		const line = c.lines.find((l) => l.startsWith("report_meta_block "))!;
		expect(line.slice(line.indexOf(" -- ") + 4)).toMatch(
			/^\d+(?:\\n\d+){6}\\n\d+\.\d{2}\\n\d+$/,
		);
		await host.life("session_shutdown");
	} finally {
		await c.close();
	}
});
test("feed uses a privacy-minimal V2 request", async () => {
	const c = await cmux(["feed.push"]);
	try {
		process.env.PI_CMUX_PRESENCE_FEED = "true";
		const host = pi();
		extension(host.api as never);
		await host.life("session_start", {}, ctx("feed"));
		await host.life("tool_execution_start", {
			toolCallId: "call",
			toolName: "todo",
		});
		await waitFor(() => c.requests().some((r) => r.method === "feed.push"));
		expect(
			c.requests().find((r) => r.method === "feed.push")!.params.event,
		).toMatchObject({
			hook_event_name: "SessionStart",
			session_id: "feed",
			workspace_id: c.workspaceId,
			surface_id: c.surfaceId,
		});
		await host.life("session_shutdown");
	} finally {
		await c.close();
	}
});

// Withdraw/remove behavior and retry ownership.
test("withdraw clears retained status", async () => {
	const c = await cmux();
	try {
		const host = pi();
		extension(host.api as never);
		await host.life("session_start", {}, ctx("withdraw"));
		const p = producer(host, "interaction");
		p.publishState(interaction());
		const key = presenceStatusKey("interaction", c.surfaceId);
		await waitFor(() => c.lines.some((l) => l.startsWith(`set_status ${key}`)));
		p.withdraw({
			version: 2,
			generation: 0,
			sequence: 1,
			source: "interaction",
		});
		await waitFor(() =>
			c.lines.includes(`clear_status ${key} --tab=${c.workspaceId}`),
		);
		p.deactivate();
		await host.life("session_shutdown");
	} finally {
		await c.close();
	}
});
test("withdraw fences same generation state", async () => {
	const host = pi();
	extension(host.api as never);
	await host.life("session_start", {}, ctx("fence"));
	const p = producer(host, "subagent");
	expect(p.publishState(subagent(3, 0))).toBe(true);
	expect(
		p.withdraw({ version: 2, generation: 3, sequence: 1, source: "subagent" }),
	).toBe(true);
	expect(p.publishState(subagent(3, 2))).toBe(false);
	expect(p.publishState(subagent(4, 0))).toBe(true);
	p.deactivate();
	await host.life("session_shutdown");
});
test("failed remove clear retries during teardown", async () => {
	let attempts = 0,
		key = "";
	const c = await cmux([], (line) =>
		line.startsWith(`clear_status ${key}`) && ++attempts === 1
			? "NOT OK"
			: "OK",
	);
	try {
		const host = pi();
		extension(host.api as never);
		await host.life("session_start", {}, ctx("retry"));
		key = presenceStatusKey("interaction", c.surfaceId);
		const p = producer(host, "interaction");
		p.publishState(interaction());
		await waitFor(() => c.lines.some((l) => l.startsWith(`set_status ${key}`)));
		p.withdraw({
			version: 2,
			generation: 0,
			sequence: 1,
			source: "interaction",
		});
		await waitFor(() => attempts === 1);
		await host.life("session_shutdown");
		await waitFor(() => attempts === 2);
		expect(attempts).toBe(2);
		p.deactivate();
	} finally {
		await c.close();
	}
});
test("withdraw is silent after an interaction alert", async () => {
	const c = await cmux(["notification.create_for_surface"]);
	try {
		process.env.PI_CMUX_PRESENCE_NOTIFY_POLICY = "all";
		const host = pi();
		extension(host.api as never);
		await host.life("session_start", {}, ctx("silent"));
		await waitFor(() => c.lines.some((line) => line.startsWith("set_status ")));
		const p = producer(host, "interaction");
		p.publishState(interaction());
		await waitFor(() =>
			c.requests().some((r) => r.method === "notification.create_for_surface"),
		);
		const n = c.requests().length;
		p.withdraw({
			version: 2,
			generation: 0,
			sequence: 1,
			source: "interaction",
		});
		await waitFor(() => c.lines.some((l) => l.startsWith("clear_status ")));
		expect(c.requests()).toHaveLength(n);
		p.deactivate();
		await host.life("session_shutdown");
	} finally {
		await c.close();
	}
});

// Explicit terminal windows, subagent aggregation, and parent merge.
test("terminal is live-only and does not synthesize state", async () => {
	const host = pi();
	extension(host.api as never);
	await host.life("session_start", {}, ctx("live"));
	const p = producer(host, "subagent");
	p.publishState(subagent());
	p.publishTerminal({
		version: 2,
		generation: 0,
		sequence: 1,
		source: "subagent",
		eventId: 0,
		outcome: "completed",
	});
	expect(
		host.emitted.filter(
			(e) =>
				e.name === EVENT_NAMES.state &&
				(e.payload as { source?: unknown }).source === "subagent",
		),
	).toHaveLength(1);
	p.deactivate();
	await host.life("session_shutdown");
});
test("subagent error terminal alerts", async () => {
	const c = await cmux([
		"notification.create_for_surface",
		"surface.trigger_flash",
	]);
	try {
		const host = pi();
		extension(host.api as never);
		await host.life("session_start", {}, ctx("error"));
		const p = producer(host, "subagent");
		p.publishTerminal({
			version: 2,
			generation: 0,
			sequence: 0,
			source: "subagent",
			eventId: 0,
			outcome: "failed",
		});
		await waitFor(() =>
			c.requests().some((r) => r.params.title === "Subagents need attention"),
		);
		p.deactivate();
		await host.life("session_shutdown");
	} finally {
		await c.close();
	}
});
test("subagent success coalesces at the first deadline", async () => {
	const c = await cmux(["notification.create_for_surface"]);
	try {
		const host = pi();
		extension(host.api as never);
		await host.life("session_start", {}, ctx("success"));
		const p = producer(host, "subagent");
		p.publishTerminal({
			version: 2,
			generation: 0,
			sequence: 0,
			source: "subagent",
			eventId: 0,
			outcome: "completed",
		});
		p.publishTerminal({
			version: 2,
			generation: 0,
			sequence: 1,
			source: "subagent",
			eventId: 1,
			outcome: "completed",
		});
		await waitFor(
			() => c.requests().some((r) => r.params.body === "2 completed"),
			700,
		);
		p.deactivate();
		await host.life("session_shutdown");
	} finally {
		await c.close();
	}
});
test("error coalesces over success", async () => {
	const c = await cmux(["notification.create_for_surface"]);
	try {
		const host = pi();
		extension(host.api as never);
		await host.life("session_start", {}, ctx("error-wins"));
		const p = producer(host, "subagent");
		p.publishTerminal({
			version: 2,
			generation: 0,
			sequence: 0,
			source: "subagent",
			eventId: 0,
			outcome: "completed",
		});
		p.publishTerminal({
			version: 2,
			generation: 0,
			sequence: 1,
			source: "subagent",
			eventId: 1,
			outcome: "failed",
		});
		await waitFor(() =>
			c.requests().some((r) => r.params.title === "Subagents need attention"),
		);
		p.deactivate();
		await host.life("session_shutdown");
	} finally {
		await c.close();
	}
});
test("subagent cancel does not notify", async () => {
	const c = await cmux(["notification.create_for_surface"]);
	try {
		const host = pi();
		extension(host.api as never);
		await host.life("session_start", {}, ctx("cancel"));
		const p = producer(host, "subagent");
		p.publishTerminal({
			version: 2,
			generation: 0,
			sequence: 0,
			source: "subagent",
			eventId: 0,
			outcome: "cancelled",
		});
		await new Promise((r) => setTimeout(r, 150));
		expect(c.requests()).toHaveLength(1);
		p.deactivate();
		await host.life("session_shutdown");
	} finally {
		await c.close();
	}
});
test("withdraw cancels pending subagent terminal", async () => {
	const c = await cmux(["notification.create_for_surface"]);
	try {
		const host = pi();
		extension(host.api as never);
		await host.life("session_start", {}, ctx("terminal-withdraw"));
		const p = producer(host, "subagent");
		p.publishTerminal({
			version: 2,
			generation: 0,
			sequence: 0,
			source: "subagent",
			eventId: 0,
			outcome: "completed",
		});
		p.withdraw({ version: 2, generation: 0, sequence: 1, source: "subagent" });
		await new Promise((r) => setTimeout(r, 500));
		expect(
			c.requests().some((r) => r.params.title === "Subagents completed"),
		).toBe(false);
		p.deactivate();
		await host.life("session_shutdown");
	} finally {
		await c.close();
	}
});
test("parent settlement merges child success", async () => {
	const c = await cmux(["notification.create_for_surface"]);
	try {
		const host = pi();
		extension(host.api as never);
		await host.life("session_start", {}, ctx("parent"));
		await host.life("agent_start");
		const p = producer(host, "subagent");
		p.publishTerminal({
			version: 2,
			generation: 0,
			sequence: 0,
			source: "subagent",
			eventId: 0,
			outcome: "completed",
		});
		await host.life("agent_end", { messages: [{ stopReason: "stop" }] });
		await host.life("agent_settled");
		await waitFor(
			() => c.requests().some((r) => r.params.title === "Pi response ready"),
			700,
		);
		p.deactivate();
		await host.life("session_shutdown");
	} finally {
		await c.close();
	}
});
test("new subagent generation resets a deferred terminal", async () => {
	const c = await cmux(["notification.create_for_surface"]);
	try {
		const host = pi();
		extension(host.api as never);
		await host.life("session_start", {}, ctx("reset"));
		const p = producer(host, "subagent");
		p.publishState(subagent());
		p.publishTerminal({
			version: 2,
			generation: 0,
			sequence: 1,
			source: "subagent",
			eventId: 0,
			outcome: "completed",
		});
		p.publishState(subagent(1, 0));
		await new Promise((r) => setTimeout(r, 500));
		expect(
			c.requests().some((r) => r.params.title === "Subagents completed"),
		).toBe(false);
		p.deactivate();
		await host.life("session_shutdown");
	} finally {
		await c.close();
	}
});

// Local attention, official policy, invalid input, and ordered teardown.
test("local error notifies after idle", async () => {
	const c = await cmux(["notification.create_for_surface"]);
	try {
		process.env.CMUX_PI_HOOKS_DISABLED = "1";
		const host = pi();
		extension(host.api as never);
		await host.life("session_start", {}, ctx("local-error"));
		await host.life("agent_start");
		await host.life("agent_end", { messages: [{ stopReason: "error" }] });
		await host.life("agent_settled");
		await waitFor(() =>
			c.requests().some((r) => r.params.body === "Needs attention"),
		);
		await host.life("session_shutdown");
	} finally {
		await c.close();
	}
});
test("cancelled local run is attention-free", async () => {
	const c = await cmux(["notification.create_for_surface"]);
	try {
		process.env.PI_CMUX_PRESENCE_NOTIFY_POLICY = "all";
		const host = pi();
		extension(host.api as never);
		await host.life("session_start", {}, ctx("local-cancel"));
		await host.life("agent_start");
		await host.life("agent_end", { messages: [{ stopReason: "aborted" }] });
		await host.life("agent_settled");
		await waitFor(() => c.requests().length === 1);
		expect(c.requests()).toHaveLength(1);
		await host.life("session_shutdown");
	} finally {
		await c.close();
	}
});
test("usage continuations never put session identifiers on V2 wire", async () => {
	const host = pi();
	extension(host.api as never);
	await host.life("session_start", {}, ctx("usage-private"));
	await host.life("agent_start");
	await host.life("message_end", {
		message: { role: "assistant", usage: { totalTokens: 10 } },
	});
	await host.life("agent_end", { messages: [{ stopReason: "stop" }] });
	await host.life("agent_start");
	await host.life("message_end", {
		message: { role: "assistant", usage: { totalTokens: 20 } },
	});
	await host.life("agent_end", { messages: [{ stopReason: "error" }] });
	await host.life("agent_settled");
	expect(JSON.stringify(host.emitted)).not.toContain("usage-private");
	await host.life("session_shutdown");
});
test("official hook suppresses local completion", async () => {
	const c = await cmux(["notification.create_for_surface"]),
		dir = await fs.mkdtemp(join(os.tmpdir(), "official-"));
	try {
		await fs.mkdir(join(dir, "extensions"));
		await fs.writeFile(
			join(dir, "extensions", "cmux-session.ts"),
			"cmux-pi-session-extension-marker v2",
		);
		process.env.PI_CODING_AGENT_DIR = dir;
		const host = pi();
		extension(host.api as never);
		await host.life("session_start", {}, ctx("official"));
		await host.life("agent_start");
		await host.life("agent_end", { messages: [{ stopReason: "stop" }] });
		await host.life("agent_settled");
		await waitFor(() => c.requests().length === 1);
		expect(c.requests()).toHaveLength(1);
		await host.life("session_shutdown");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
		await c.close();
	}
});
test("invalid session safely recovers", async () => {
	const c = await cmux();
	try {
		const host = pi();
		extension(host.api as never);
		await host.life("session_start", {}, ctx("x".repeat(97)));
		expect(c.lines).toEqual([]);
		await host.life("session_start", {}, ctx("recovered"));
		await waitFor(() => c.lines.some((l) => l.startsWith("set_status ")));
		await host.life("session_shutdown");
	} finally {
		await c.close();
	}
});
test("invalid replacement clears prior status", async () => {
	const c = await cmux();
	try {
		const host = pi();
		extension(host.api as never);
		await host.life("session_start", {}, ctx("valid"));
		await waitFor(() => c.lines.some((l) => l.startsWith("set_status ")));
		const key = presenceStatusKey("pi", c.surfaceId);
		await host.life("session_start", {}, ctx("x".repeat(97)));
		await waitFor(() => c.lines.includes(`clear_status ${key} --tab=${c.workspaceId}`));
		expect(c.lines).toContain(`clear_status ${key} --tab=${c.workspaceId}`);
	} finally {
		await c.close();
	}
});
test("shutdown clears retained external sources", async () => {
	const c = await cmux();
	try {
		const host = pi();
		extension(host.api as never);
		await host.life("session_start", {}, ctx("cleanup"));
		const a = producer(host, "interaction"),
			b = producer(host, "subagent");
		a.publishState(interaction());
		b.publishState(subagent());
		await waitFor(
			() => c.lines.filter((l) => l.startsWith("set_status ")).length >= 3,
		);
		await host.life("session_shutdown");
		await waitFor(() => c.lines.includes(
			`clear_status ${presenceStatusKey("interaction", c.surfaceId)} --tab=${c.workspaceId}`,
		));
		await waitFor(() => c.lines.includes(
			`clear_status ${presenceStatusKey("subagent", c.surfaceId)} --tab=${c.workspaceId}`,
		));
		expect(c.lines).toContain(
			`clear_status ${presenceStatusKey("interaction", c.surfaceId)} --tab=${c.workspaceId}`,
		);
		expect(c.lines).toContain(
			`clear_status ${presenceStatusKey("subagent", c.surfaceId)} --tab=${c.workspaceId}`,
		);
		a.deactivate();
		b.deactivate();
	} finally {
		await c.close();
	}
});
test("concurrent shutdown clears before replacement status", async () => {
	const c = await cmux();
	try {
		const host = pi();
		extension(host.api as never);
		await host.life("session_start", {}, ctx("old"));
		await waitFor(() => c.lines.some((l) => l.startsWith("set_status ")));
		const key = presenceStatusKey("pi", c.surfaceId);
		await Promise.all([
			host.life("session_shutdown"),
			host.life("session_start", {}, ctx("new")),
		]);
		await waitFor(
			() => c.lines.filter((l) => l.startsWith("set_status ")).length >= 2,
		);
		expect(
			c.lines.indexOf(`clear_status ${key} --tab=${c.workspaceId}`),
		).toBeLessThan(
			c.lines.map((l, i) => (l.startsWith("set_status ") ? i : -1)).at(-1)!,
		);
		await host.life("session_shutdown");
	} finally {
		await c.close();
	}
});
test("stale concurrent start cannot leak an old session", async () => {
	const c = await cmux();
	const host = pi();
	try {
		extension(host.api as never);
		await Promise.all([
			host.life("session_start", {}, ctx("old")),
			host.life("session_start", {}, ctx("new")),
		]);
		expect(c.lines.some((l) => l.includes("old"))).toBe(false);
	} finally {
		await host.life("session_shutdown");
		await c.close();
	}
});
test("replacement callback returns before its fenced capability initialization", async () => {
	let first = true,
		release!: () => void;
	const gate = new Promise<void>((r) => {
		release = r;
	});
	const c = await cmux([], async (l) => {
		if (first && l.includes('"method":"system.capabilities"')) {
			first = false;
			await gate;
		}
		return undefined;
	});
	try {
		const host = pi();
		extension(host.api as never);
		const one = host.life("session_start", {}, ctx("old"));
		await waitFor(() =>
			c.lines.some((l) => l.includes('"method":"system.capabilities"')),
		);
		let done = false;
		const two = host.life("session_start", {}, ctx("new")).then(() => {
			done = true;
		});
		await new Promise((r) => setTimeout(r, 0));
		expect(done).toBe(true);
		release();
		await Promise.all([one, two]);
		await waitFor(() =>
			c.lines.filter((l) => l.includes('"method":"system.capabilities"')).length === 2,
		);
		expect(
			c.lines.filter((l) => l.includes('"method":"system.capabilities"')),
		).toHaveLength(2);
		await host.life("session_shutdown");
	} finally {
		release?.();
		await c.close();
	}
});
test("shutdown callback awaits the aggregate cleanup deadline", async () => {
	let blockClear = false;
	const c = await cmux([], async (l) => {
		if (blockClear && l.startsWith("clear_status ")) {
			await new Promise<never>(() => {});
		}
		return undefined;
	});
	try {
		process.env.PI_CMUX_PRESENCE_TIMEOUT_MS = "150";
		const host = pi();
		const piProducer = producer(host, "pi");
		extension(host.api as never);
		await host.life("session_start", {}, ctx("deadline"));
		const interactionProducer = producer(host, "interaction");
		const subagentProducer = producer(host, "subagent");
		piProducer.publishState({
			version: 2,
			generation: 0,
			sequence: 0,
			source: "pi",
			state: "running",
		});
		interactionProducer.publishState(interaction());
		subagentProducer.publishState(subagent());
		await waitFor(
			() => c.lines.filter((l) => l.startsWith("set_status ")).length >= 3,
		);
		blockClear = true;
		piProducer.withdraw({
			version: 2,
			generation: 0,
			sequence: 1,
			source: "pi",
		});
		interactionProducer.withdraw({
			version: 2,
			generation: 0,
			sequence: 1,
			source: "interaction",
		});
		subagentProducer.withdraw({
			version: 2,
			generation: 0,
			sequence: 1,
			source: "subagent",
		});
		const shutdown = host.hooks.get("session_shutdown")?.[0];
		expect(shutdown).toBeDefined();
		const start = performance.now();
		const result = shutdown!({});
		expect(result).toBeInstanceOf(Promise);
		let settled = false;
		const completion = Promise.resolve(result).then(() => {
			settled = true;
		});
		await waitFor(() => c.lines.some((line) => line.startsWith("clear_status ")));
		expect(settled).toBe(false);
		await completion;
		const elapsed = performance.now() - start;
		expect(elapsed).toBeGreaterThanOrEqual(650);
		expect(elapsed).toBeLessThan(1_500);
		piProducer.deactivate();
		interactionProducer.deactivate();
		subagentProducer.deactivate();
	} finally {
		await c.close();
	}
});
