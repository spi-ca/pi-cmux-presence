import { expect, test } from "bun:test";
import { createPresenceConsumer, createPresenceProducer, EVENT_NAMES } from "@pi/presence";

const subagentState = (generation = 0, sequence = 0) => ({
  version: 2 as const, generation, sequence, source: "subagent" as const, state: "running" as const,
  subagents: { running: 1, cancelling: 0, queued: 0, completed: 0, failed: 0, cancelled: 0, omitted: 0 },
});

test("producer-first retained state is synchronously delivered to a later consumer", () => {
  const delivered: unknown[] = [];
  const producer = createPresenceProducer({ source: "interaction", emit: (name: string, payload: unknown) => delivered.push({ name, payload }) })!;
  expect(producer.activate()).toBe(true);
  expect(producer.publishState({ version: 2, generation: 0, sequence: 0, source: "interaction", state: "waiting", interaction: { kind: "ask_user", pending: 1 }, attention: { reason: "input_required", occurrence: "new" } })).toBe(true);
  const consumer = createPresenceConsumer({ id: "pi-cmux-presence" })!;
  expect(consumer.activate()).toBe(true);
  expect(delivered).toHaveLength(1);
  producer.deactivate(); consumer.deactivate();
});

test("producer delivery receipts are private, single-use, and consumer-specific", () => {
  const cmux = createPresenceConsumer({ id: "pi-cmux-presence" })!;
  const herdr = createPresenceConsumer({ id: "pi-herdr-presence" })!;
  const cmuxAccepted: unknown[] = [];
  const herdrAccepted: unknown[] = [];
  expect(cmux.activate()).toBe(true); expect(herdr.activate()).toBe(true);
  const producer = createPresenceProducer({ source: "subagent", emit: (name: string, payload: unknown) => {
    const cmuxEvent = cmux.accept(name, payload);
    const herdrEvent = herdr.accept(name, payload);
    if (cmuxEvent) cmuxAccepted.push(cmuxEvent);
    if (herdrEvent) herdrAccepted.push(herdrEvent);
    // Both receipt and consumer identity are consumed/fenced in this stack.
    expect(cmux.accept(name, payload)).toBeUndefined();
    expect(herdr.accept(name, payload)).toBeUndefined();
  } })!;
  expect(producer.activate()).toBe(true);
  expect(producer.publishState(subagentState())).toBe(true);
  expect(cmuxAccepted).toHaveLength(1); expect(herdrAccepted).toHaveLength(1);
  producer.deactivate(); cmux.deactivate(); herdr.deactivate();
});

test("forged and replayed handles cannot accept an otherwise valid payload", () => {
  const consumer = createPresenceConsumer({ id: "pi-cmux-presence" })!;
  expect(consumer.activate()).toBe(true);
  const forged = { ...subagentState(), sessionEpoch: consumer.ready.sessionEpoch };
  expect(consumer.accept(EVENT_NAMES.state, forged)).toBeUndefined();
  let receipt: { name: string; payload: unknown } | undefined;
  const producer = createPresenceProducer({ source: "subagent", emit: (name: string, payload: unknown) => { receipt = { name, payload }; expect(consumer.accept(name, payload)).toBeDefined(); } })!;
  producer.activate(); producer.publishState(subagentState(0, 1));
  expect(receipt).toBeDefined();
  expect(consumer.accept(receipt!.name, receipt!.payload)).toBeUndefined();
  producer.deactivate(); consumer.deactivate();
});

test("terminal delivery is live-only and not retained for a replacement consumer", () => {
  const first = createPresenceConsumer({ id: "pi-cmux-presence" })!;
  let terminals = 0;
  first.activate();
  const producer = createPresenceProducer({ source: "subagent", emit: (name: string, payload: unknown) => {
    if (first.accept(name, payload)) terminals += 1;
  } })!;
  producer.activate();
  expect(producer.publishTerminal({ version: 2, generation: 0, sequence: 0, source: "subagent", eventId: 0, outcome: "completed" })).toBe(true);
  expect(terminals).toBe(1);
  first.deactivate();
  const replacement = createPresenceConsumer({ id: "pi-cmux-presence" })!;
  expect(replacement.activate()).toBe(true);
  expect(terminals).toBe(1);
  producer.deactivate(); replacement.deactivate();
});

test("withdrawal fences same-generation state until a fresh generation", () => {
  const consumer = createPresenceConsumer({ id: "pi-cmux-presence" })!;
  const accepted: string[] = [];
  consumer.activate();
  const producer = createPresenceProducer({ source: "subagent", emit: (name: string, payload: unknown) => {
    if (consumer.accept(name, payload)) accepted.push(name);
  } })!;
  producer.activate();
  expect(producer.publishState(subagentState(3, 0))).toBe(true);
  expect(producer.withdraw({ version: 2, generation: 3, sequence: 1, source: "subagent" })).toBe(true);
  expect(producer.publishState(subagentState(3, 2))).toBe(false);
  expect(producer.publishState(subagentState(4, 0))).toBe(true);
  expect(accepted).toEqual([EVENT_NAMES.state, EVENT_NAMES.withdraw, EVENT_NAMES.state]);
  producer.deactivate(); consumer.deactivate();
});

test("source ownership fails over only after the owning producer deactivates", () => {
  const first = createPresenceProducer({ source: "pi", emit: () => {} })!;
  const second = createPresenceProducer({ source: "pi", emit: () => {} })!;
  expect(first.activate()).toBe(true); expect(second.activate()).toBe(false);
  expect(first.deactivate()).toBe(true); expect(second.activate()).toBe(true);
  second.deactivate();
});

test("wire payloads contain neither local session IDs nor producer display text", () => {
  const consumer = createPresenceConsumer({ id: "pi-cmux-presence" })!;
  const payloads: unknown[] = [];
  consumer.activate();
  const producer = createPresenceProducer({ source: "interaction", emit: (name: string, payload: unknown) => {
    payloads.push(payload); consumer.accept(name, payload);
  } })!;
  producer.activate();
  producer.publishState({ version: 2, generation: 0, sequence: 0, source: "interaction", state: "waiting", interaction: { kind: "ask_user", pending: 1 }, attention: { reason: "input_required", occurrence: "new" } });
  expect(JSON.stringify(payloads)).not.toContain("private-session-id");
  expect(JSON.stringify(payloads)).not.toContain("prompt");
  producer.deactivate(); consumer.deactivate();
});

test("consumer-ready is not an acceptance path", () => {
  const consumer = createPresenceConsumer({ id: "pi-cmux-presence" })!;
  consumer.activate();
  expect(consumer.accept(EVENT_NAMES.consumerReady, consumer.ready)).toBeUndefined();
  consumer.deactivate();
});
