export type AgentStatus = "running" | "waiting" | "complete" | "error" | "paused";
export type EventKind =
  | "agent_spawn" | "agent_status" | "tool_call_pending"
  | "tool_result" | "agent_message" | "log" | "agent_complete";
export type CommandKind =
  | "tool_approve" | "tool_deny" | "agent_pause" | "agent_resume"
  | "agent_stop" | "inject_message" | "spawn_agent";

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
export interface AgentCompleteEvent {
  kind: "agent_complete";
  agent_id: string;
  exit_status: "ok" | "error" | "stopped";
  summary: string;
  timestamp: number;
}

export type AgentVizEvent =
  | AgentSpawnEvent | AgentStatusEvent | ToolCallPendingEvent
  | ToolResultEvent | AgentMessageEvent | LogEvent | AgentCompleteEvent;

// UI state shapes
export interface AgentNode {
  id: string;
  name: string;
  parent_id: string | null;
  status: AgentStatus;
  tool_calls: Array<{ call_id: string; name: string; args: Record<string, unknown>; result?: unknown; duration_ms?: number; pending: boolean }>;
  logs: Array<{ content: string; level: string; timestamp: number }>;
}

export interface MessageEdge {
  from_agent_id: string;
  to_agent_id: string;
  messages: Array<{ content: string; timestamp: number; from: string; to: string }>;
}
