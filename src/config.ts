export interface PresenceConfig {
  enabled: boolean;
  timeoutMs: number;
  maxQueue: number;
  progress: boolean;
  notifications: boolean;
  flash: boolean;
  log: boolean;
  sidebar: boolean;
  nativeLifecycle: boolean;
  feed: boolean;
  metaBlock: boolean;
  autoTitle: boolean;
  resumeFallback: boolean;
  finalClearMs: number;
  maxLabelChars: number;
}

type BooleanSetting = {
  readonly type: "boolean";
  readonly env: string;
  readonly defaultValue: boolean;
};
type IntegerSetting = {
  readonly type: "integer";
  readonly env: string;
  readonly defaultValue: number;
  readonly min: number;
  readonly max: number;
};
type Setting = BooleanSetting | IntegerSetting;

/** The sole source for public configuration keys, defaults, and integer bounds. */
const SETTINGS = {
  enabled: { type: "boolean", env: "PI_CMUX_PRESENCE_ENABLED", defaultValue: true },
  timeoutMs: { type: "integer", env: "PI_CMUX_PRESENCE_TIMEOUT_MS", defaultValue: 1_000, min: 100, max: 30_000 },
  maxQueue: { type: "integer", env: "PI_CMUX_PRESENCE_MAX_QUEUE", defaultValue: 16, min: 1, max: 128 },
  progress: { type: "boolean", env: "PI_CMUX_PRESENCE_PROGRESS", defaultValue: true },
  notifications: { type: "boolean", env: "PI_CMUX_PRESENCE_NOTIFICATIONS", defaultValue: true },
  flash: { type: "boolean", env: "PI_CMUX_PRESENCE_FLASH", defaultValue: true },
  log: { type: "boolean", env: "PI_CMUX_PRESENCE_LOG", defaultValue: false },
  sidebar: { type: "boolean", env: "PI_CMUX_PRESENCE_SIDEBAR", defaultValue: true },
  nativeLifecycle: { type: "boolean", env: "PI_CMUX_PRESENCE_NATIVE_LIFECYCLE", defaultValue: true },
  feed: { type: "boolean", env: "PI_CMUX_PRESENCE_FEED", defaultValue: false },
  metaBlock: { type: "boolean", env: "PI_CMUX_PRESENCE_META_BLOCK", defaultValue: false },
  autoTitle: { type: "boolean", env: "PI_CMUX_PRESENCE_AUTO_TITLE", defaultValue: false },
  resumeFallback: { type: "boolean", env: "PI_CMUX_PRESENCE_RESUME_FALLBACK", defaultValue: false },
  finalClearMs: { type: "integer", env: "PI_CMUX_PRESENCE_FINAL_CLEAR_MS", defaultValue: 1_500, min: 0, max: 60_000 },
  maxLabelChars: { type: "integer", env: "PI_CMUX_PRESENCE_MAX_LABEL_CHARS", defaultValue: 96, min: 16, max: 256 },
} as const satisfies Record<keyof PresenceConfig, Setting>;

function booleanEnv(env: NodeJS.ProcessEnv, setting: BooleanSetting): boolean {
  const value = env[setting.env]?.trim().toLowerCase();
  if (value === undefined || value === "") return setting.defaultValue;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return setting.defaultValue;
}

function integerEnv(env: NodeJS.ProcessEnv, setting: IntegerSetting): number {
  const value = env[setting.env]?.trim();
  if (!value || !/^\d+$/.test(value)) return setting.defaultValue;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= setting.min && parsed <= setting.max ? parsed : setting.defaultValue;
}

export function resolvePresenceConfig(env: NodeJS.ProcessEnv = process.env): PresenceConfig {
  return {
    enabled: booleanEnv(env, SETTINGS.enabled),
    timeoutMs: integerEnv(env, SETTINGS.timeoutMs),
    maxQueue: integerEnv(env, SETTINGS.maxQueue),
    progress: booleanEnv(env, SETTINGS.progress),
    notifications: booleanEnv(env, SETTINGS.notifications),
    flash: booleanEnv(env, SETTINGS.flash),
    log: booleanEnv(env, SETTINGS.log),
    sidebar: booleanEnv(env, SETTINGS.sidebar),
    nativeLifecycle: booleanEnv(env, SETTINGS.nativeLifecycle),
    feed: booleanEnv(env, SETTINGS.feed),
    metaBlock: booleanEnv(env, SETTINGS.metaBlock),
    autoTitle: booleanEnv(env, SETTINGS.autoTitle),
    resumeFallback: booleanEnv(env, SETTINGS.resumeFallback),
    finalClearMs: integerEnv(env, SETTINGS.finalClearMs),
    maxLabelChars: integerEnv(env, SETTINGS.maxLabelChars),
  };
}
