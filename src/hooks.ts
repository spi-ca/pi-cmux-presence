import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PI_PRESENCE_READY_EVENT, PI_PRESENCE_UPDATE_EVENT } from "./events.js";
import type { PresenceRuntime } from "./runtime.js";

type LifecycleName =
  | "session_start"
  | "agent_start"
  | "turn_start"
  | "message_end"
  | "agent_end"
  | "before_agent_start"
  | "tool_execution_start"
  | "tool_execution_end"
  | "tool_result"
  | "agent_settled"
  | "session_info_changed"
  | "session_shutdown";

type LifecycleRegistrar = (
  name: LifecycleName,
  handler: (event: any, context?: any) => unknown,
) => void;

/** Register Pi and process-local observers without owning mutable presence state. */
export function registerPresenceHooks(pi: ExtensionAPI, runtime: PresenceRuntime): void {
  pi.events.on(PI_PRESENCE_UPDATE_EVENT, (payload) => runtime.handlePresenceUpdate(payload));
  pi.events.on(PI_PRESENCE_READY_EVENT, (payload) => runtime.handleReady(payload));

  const on = pi.on as unknown as LifecycleRegistrar;
  on("session_start", async (_event, context) => runtime.startSession(context));
  on("agent_start", () => runtime.handleAgentStart());
  on("turn_start", () => runtime.handleTurnStart());
  on("message_end", (event) => runtime.handleMessageEnd(event));
  on("agent_end", (event) => runtime.handleAgentEnd(event));
  on("before_agent_start", () => runtime.handleBeforeAgentStart());
  on("tool_execution_start", (event) => runtime.handleToolExecutionStart(event));
  on("tool_execution_end", (event) => runtime.handleToolExecutionEnd(event));
  on("tool_result", (event) => runtime.handleToolResult(event));
  on("agent_settled", (_event, context) => runtime.handleAgentSettled(context));
  on("session_info_changed", (event) => runtime.handleSessionInfoChanged(event));
  on("session_shutdown", async () => runtime.shutdownSession());
}
