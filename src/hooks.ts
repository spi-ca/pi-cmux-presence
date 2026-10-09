import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { EVENT_NAMES } from "@pi/presence";
import type { PresenceRuntime } from "./runtime.js";

/** Register lifecycle observers and V2 bus listeners before a session activates its consumer. */
export function registerPresenceHooks(pi: ExtensionAPI, runtime: PresenceRuntime): void {
  for (const eventName of [EVENT_NAMES.state, EVENT_NAMES.terminal, EVENT_NAMES.withdraw, EVENT_NAMES.consumerReady]) {
    pi.events.on(eventName, (payload) => runtime.handlePresenceEvent(eventName, payload));
  }

  // agent_end closes only a low-level run. Retry, compaction, queued work,
  // and agent_before_settle continuations must finish before terminal output.
  pi.on("agent_settled", (event, context) => runtime.handleAgentSettled(context, event));

  // Startup remains detached: the runtime establishes its epoch synchronously,
  // then fences optional output internally.
  pi.on("session_start", (_event, context) => { void runtime.startSession(context).catch(() => {}); });
  pi.on("agent_start", () => runtime.handleAgentStart());
  pi.on("turn_start", () => runtime.handleTurnStart());
  // Pi emits these only around blocking native UI prompts. The runtime
  // validates the TUI context and session fence synchronously.
  pi.on("ui_prompt_start", (event, context) => runtime.handleUiPromptStart(event, context));
  pi.on("ui_prompt_end", (event, context) => runtime.handleUiPromptEnd(event, context));
  pi.on("message_end", (event) => runtime.handleMessageEnd(event));
  pi.on("agent_end", (event) => runtime.handleAgentEnd(event));
  pi.on("before_agent_start", () => runtime.handleBeforeAgentStart());
  pi.on("tool_execution_start", (event) => runtime.handleToolExecutionStart(event));
  pi.on("tool_execution_end", (event) => runtime.handleToolExecutionEnd(event));
  pi.on("tool_result", (event) => runtime.handleToolResult(event));
  pi.on("session_info_changed", (event) => runtime.handleSessionInfoChanged(event));
  // Let normal process shutdown await the runtime's bounded cleanup, but keep
  // observer failures best-effort so presence can never fail Pi work.
  pi.on("session_shutdown", () => runtime.shutdownSession().catch(() => {}));
}
