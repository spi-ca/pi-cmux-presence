import extension from "../../index.js";

type Hook = (event: unknown, context?: unknown) => unknown;

const hooks = new Map<string, Hook[]>();
const listeners = new Map<string, Array<(payload: unknown) => unknown>>();
const pi = {
  getAllTools: () => [],
  on(name: string, handler: Hook) {
    hooks.set(name, [...(hooks.get(name) ?? []), handler]);
  },
  events: {
    on(name: string, handler: (payload: unknown) => unknown) {
      listeners.set(name, [...(listeners.get(name) ?? []), handler]);
    },
    emit(name: string, payload: unknown) {
      for (const handler of listeners.get(name) ?? []) void handler(payload);
    },
  },
};

extension(pi as never);
const start = hooks.get("session_start")?.[0];
const shutdown = hooks.get("session_shutdown")?.[0];
if (!start || !shutdown) throw new Error("presence lifecycle hooks were not registered");

start({}, { sessionManager: { getSessionId: () => "shutdown-child" } });
await new Promise<void>((resolve, reject) => {
  process.stdin.once("data", () => resolve());
  process.stdin.once("error", reject);
  process.stdin.resume();
});

const cleanup = shutdown({});
if (!(cleanup instanceof Promise)) {
  throw new Error("session_shutdown did not return its cleanup promise");
}
await cleanup;
