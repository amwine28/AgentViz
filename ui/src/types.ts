export type AgentStatus = "running" | "waiting" | "complete" | "error" | "paused";
export type ViewMode = "3d" | "2d" | "flow" | "credit";
export type EventKind =
  | "session_start" | "agent_spawn" | "agent_status" | "tool_call_pending"
  | "tool_result" | "tool_denied" | "agent_message" | "log" | "agent_complete"
  | "command_ack" | "usage" | "outcome";
export type CommandKind =
  | "tool_approve" | "tool_deny" | "agent_pause" | "agent_resume"
  | "agent_stop" | "inject_message" | "spawn_agent";

export interface SessionStartEvent {
  kind: "session_start";
  name: string;
  timestamp: number;
}
export interface CommandAckEvent {
  kind: "command_ack";
  cmd_id: string;
  status: "applied" | "failed";
  timestamp: number;
}
export interface AgentSpawnEvent {
  kind: "agent_spawn";
  agent_id: string;
  parent_id: string | null;
  name: string;
  timestamp: number;
}
export interface AgentStatusEvent {
  kind: "agent_status";
  agent_id: string;
  status: AgentStatus;
  timestamp: number;
}
export interface ToolCallPendingEvent {
  kind: "tool_call_pending";
  agent_id: string;
  call_id: string;
  name: string;
  args: Record<string, unknown>;
  timeout_s?: number;
  timestamp: number;
}
export interface ToolResultEvent {
  kind: "tool_result";
  agent_id: string;
  call_id: string;
  result: unknown;
  duration_ms: number;
  timestamp: number;
}
export interface ToolDeniedEvent {
  kind: "tool_denied";
  agent_id: string;
  call_id: string;
  name: string;
  reason: "denied" | "timeout";
  timestamp: number;
}
export interface AgentMessageEvent {
  kind: "agent_message";
  from_agent_id: string;
  to_agent_id: string;
  content: string;
  timestamp: number;
}
export interface LogEvent {
  kind: "log";
  agent_id: string;
  content: string;
  level: "info" | "warn" | "error";
  timestamp: number;
}
export interface UsageEvent {
  kind: "usage";
  agent_id: string;
  input_tokens: number;
  output_tokens: number;
  model: string | null;
  cost_usd: number | null;
  timestamp: number;
}
export interface OutcomeEvent {
  kind: "outcome";
  agent_id: string | null;          // null => run-level terminal outcome
  channel: string;
  value: number;
  scale: "binary" | "unit" | "score" | "delta";
  value_min: number | null;
  value_max: number | null;
  stage: "terminal" | "intermediate";
  source: string;
  measured: boolean;
  detail: Record<string, unknown>;  // may carry result_agent_ids: string[]
  run_id: string | null;
  ablated_agent_id: string | null;
  baseline_run_id: string | null;
  baseline_value: number | null;
  timestamp: number;
}
export interface AgentCompleteEvent {
  kind: "agent_complete";
  agent_id: string;
  exit_status: "ok" | "error" | "stopped";
  summary: string;
  timestamp: number;
}

export type AgentVizEvent = (
  | SessionStartEvent | AgentSpawnEvent | AgentStatusEvent | ToolCallPendingEvent
  | ToolResultEvent | ToolDeniedEvent | AgentMessageEvent | LogEvent | AgentCompleteEvent
  | CommandAckEvent | UsageEvent | OutcomeEvent
) & { seq?: number; run_id?: string };

// UI state shapes
export interface AgentNode {
  id: string;
  name: string;
  parent_id: string | null;
  status: AgentStatus;
  completed_at: number | null;   // event.timestamp from agent_complete (for sink inference)
  exit_status: string | null;    // raw "ok" | "error" | "stopped"
  tool_calls: Array<{ call_id: string; name: string; args: Record<string, unknown>; result?: unknown; duration_ms?: number; pending: boolean; denied?: "denied" | "timeout"; requested_at?: number; timeout_s?: number }>;
  logs: Array<{ content: string; level: "info" | "warn" | "error"; timestamp: number }>;
  usage?: { input_tokens: number; output_tokens: number; cost_usd: number };
}

export interface MessageEdge {
  from_agent_id: string;
  to_agent_id: string;
  messages: Array<{ content: string; timestamp: number; from: string; to: string }>;
}
