export type AgentStatus = "running" | "waiting" | "complete" | "error" | "paused";
export type ViewMode = "3d" | "2d" | "flow" | "credit" | "ops";
export type EventKind =
  | "session_start" | "agent_spawn" | "agent_status" | "tool_call_pending"
  | "tool_result" | "tool_denied" | "agent_message" | "log" | "agent_complete"
  | "command_ack" | "usage" | "outcome" | "credit_report" | "recommendation_report"
  | "operation_start" | "operation_tick" | "operation_end";
export type CommandKind =
  | "tool_approve" | "tool_deny" | "agent_pause" | "agent_resume"
  | "agent_stop" | "inject_message" | "spawn_agent";

// --- Operation taxonomy (mirrors sdk/agentviz/events.py) ---
export type OperationKind =
  | "loop" | "goal" | "schedule" | "workflow" | "phase" | "spawn" | "message"
  | "skill" | "mcp" | "plan_mode" | "worktree" | "background" | "monitor"
  | "remote" | "todo" | "compact" | "hook";
export type OperationFamily = "recurrence" | "orchestration" | "command" | "mode" | "state";

// Single source of truth mapping op_type -> family (mirrors FAMILY_OF in events.py).
export const FAMILY_OF: Record<OperationKind, OperationFamily> = {
  loop: "recurrence",
  goal: "recurrence",
  schedule: "recurrence",
  workflow: "orchestration",
  phase: "orchestration",
  spawn: "orchestration",
  message: "orchestration",
  skill: "command",
  mcp: "command",
  plan_mode: "mode",
  worktree: "mode",
  background: "mode",
  monitor: "mode",
  remote: "mode",
  todo: "state",
  compact: "state",
  hook: "state",
};

export interface SessionStartEvent {
  kind: "session_start";
  name: string;
  dry_run?: boolean;
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
  simulated?: boolean;   // dry-run mock/replay: fn was NOT executed
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
export interface CreditAgentEntry {
  agent: string;
  credit: number;
  ci: [number, number] | null;
  credit_state: string | null;
  basis: string;
}
export interface CreditReportEvent {
  kind: "credit_report";
  method: "counterfactual" | "shapley" | "densified";
  channel: string;
  agents: CreditAgentEntry[];
  timestamp: number;
}
export interface RecommendationEntry {
  rule: string;            // prune_candidate | single_point_of_failure | increase_samples | regression
  severity: string;        // high | medium | info
  agents: string[];
  action: string;          // the suggested decision (framed as review/verify)
  rationale: string;       // the measured fact it traces to
  savings_usd: number | null;
}
export interface RecommendationReportEvent {
  kind: "recommendation_report";
  channel: string;
  recommendations: RecommendationEntry[];
  timestamp: number;
}
export interface AgentCompleteEvent {
  kind: "agent_complete";
  agent_id: string;
  exit_status: "ok" | "error" | "stopped";
  summary: string;
  timestamp: number;
}
export interface OperationStartEvent {
  kind: "operation_start";
  op_id: string;
  op_type: OperationKind;
  family: OperationFamily;
  parent_op_id: string | null;
  agent_id: string | null;          // null => session-level operation
  label: string;
  status: "running" | "waiting" | "recurring";
  detail: Record<string, unknown>;
  timestamp: number;
}
export interface OperationTickEvent {
  kind: "operation_tick";
  op_id: string;
  n: number;                        // iteration / beat index (0-based)
  label: string;
  status: "running" | "waiting" | "recurring";
  detail: Record<string, unknown>;
  timestamp: number;
}
export interface OperationEndEvent {
  kind: "operation_end";
  op_id: string;
  status: "complete" | "error" | "stopped" | "expired";
  summary: string;
  detail: Record<string, unknown>;
  timestamp: number;
}

export type AgentVizEvent = (
  | SessionStartEvent | AgentSpawnEvent | AgentStatusEvent | ToolCallPendingEvent
  | ToolResultEvent | ToolDeniedEvent | AgentMessageEvent | LogEvent | AgentCompleteEvent
  | CommandAckEvent | UsageEvent | OutcomeEvent | CreditReportEvent | RecommendationReportEvent
  | OperationStartEvent | OperationTickEvent | OperationEndEvent
) & { seq?: number; run_id?: string };

// UI state shapes
export interface AgentNode {
  id: string;
  name: string;
  parent_id: string | null;
  status: AgentStatus;
  completed_at: number | null;   // event.timestamp from agent_complete (for sink inference)
  exit_status: string | null;    // raw "ok" | "error" | "stopped"
  tool_calls: Array<{ call_id: string; name: string; args: Record<string, unknown>; result?: unknown; duration_ms?: number; pending: boolean; denied?: "denied" | "timeout"; simulated?: boolean; requested_at?: number; timeout_s?: number }>;
  logs: Array<{ content: string; level: "info" | "warn" | "error"; timestamp: number }>;
  usage?: { input_tokens: number; output_tokens: number; cost_usd: number };
}

export interface MessageEdge {
  from_agent_id: string;
  to_agent_id: string;
  messages: Array<{ content: string; timestamp: number; from: string; to: string }>;
}

export interface OperationTick {
  n: number;
  label: string;
  status: string;
  detail: Record<string, unknown>;
  timestamp: number;
}

export interface OperationState {
  op_id: string;
  op_type: string;
  family: string;
  parent_op_id: string | null;
  agent_id: string | null;
  label: string;
  status: string;
  detail: Record<string, unknown>;
  ticks: OperationTick[];
  started_at: number;
  ended_at: number | null;
  end_status: string | null;
  children: string[];
}
