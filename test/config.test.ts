import { describe, expect, test } from "bun:test";
import { resolvePresenceConfig } from "../src/config.js";

describe("resolvePresenceConfig", () => {
  test("uses every documented default", () => {
    expect(resolvePresenceConfig({})).toEqual({
      enabled: true,
      timeoutMs: 1_000,
      maxQueue: 16,
      progress: true,
      notifications: true,
      flash: true,
      log: false,
      sidebar: true,
      nativeLifecycle: true,
      feed: false,
      metaBlock: false,
      autoTitle: false,
      resumeFallback: false,
      finalClearMs: 1_500,
      maxLabelChars: 96,
    });
  });

  test.each(["1", "true", "yes", "on"])("accepts the true token %s", (value) => {
    expect(resolvePresenceConfig({ PI_CMUX_PRESENCE_LOG: ` ${value.toUpperCase()} ` }).log).toBe(true);
  });

  test.each(["0", "false", "no", "off"])("accepts the false token %s", (value) => {
    expect(resolvePresenceConfig({ PI_CMUX_PRESENCE_ENABLED: ` ${value.toUpperCase()} ` }).enabled).toBe(false);
  });

  test("falls back to declared boolean defaults for empty or invalid values", () => {
    expect(resolvePresenceConfig({
      PI_CMUX_PRESENCE_ENABLED: "invalid",
      PI_CMUX_PRESENCE_PROGRESS: "maybe",
      PI_CMUX_PRESENCE_NOTIFICATIONS: "",
      PI_CMUX_PRESENCE_FLASH: "2",
      PI_CMUX_PRESENCE_LOG: "not false",
      PI_CMUX_PRESENCE_SIDEBAR: "-1",
    })).toMatchObject({ enabled: true, progress: true, notifications: true, flash: true, log: false, sidebar: true });
  });

  test.each([
    ["PI_CMUX_PRESENCE_TIMEOUT_MS", "timeoutMs", 100, 30_000, 1_000],
    ["PI_CMUX_PRESENCE_MAX_QUEUE", "maxQueue", 1, 128, 16],
    ["PI_CMUX_PRESENCE_FINAL_CLEAR_MS", "finalClearMs", 0, 60_000, 1_500],
    ["PI_CMUX_PRESENCE_MAX_LABEL_CHARS", "maxLabelChars", 16, 256, 96],
  ] as const)("accepts inclusive boundaries and rejects invalid %s", (envKey, configKey, min, max, fallback) => {
    expect(resolvePresenceConfig({ [envKey]: String(min) })[configKey]).toBe(min);
    expect(resolvePresenceConfig({ [envKey]: String(max) })[configKey]).toBe(max);
    expect(resolvePresenceConfig({ [envKey]: String(min - 1) })[configKey]).toBe(fallback);
    expect(resolvePresenceConfig({ [envKey]: String(max + 1) })[configKey]).toBe(fallback);
    expect(resolvePresenceConfig({ [envKey]: ` ${min} ` })[configKey]).toBe(min);
    for (const invalid of ["1.5", `+${min}`, "1e2", " ", String(Number.MAX_SAFE_INTEGER + 1)]) {
      expect(resolvePresenceConfig({ [envKey]: invalid })[configKey]).toBe(fallback);
    }
  });
});
