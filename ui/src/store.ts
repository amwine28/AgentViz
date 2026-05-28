import type {
  AgentVizEvent, AgentNode, MessageEdge, AgentStatus,
} from "./types";

export interface AppState {
  agents: Record<string, AgentNode>;
  messageEdges: Record<string, MessageEdge>; // key: "from:to"
  selectedNodeId: string | null;
  selectedEdgeKey: string | null;
  sessionName: string;
  connected: boolean;
}

export const initialState: AppState = {
  agents: {},
  messageEdges: {},
  selectedNodeId: null,
  selectedEdgeKey: null,
  sessionName: "",
  connected: false,
};

type Action =
  | { type: "event"; event: AgentVizEvent }
  | { type: "select_node"; agent_id: string | null }
  | { type: "select_edge"; edge_key: string | null }
  | { type: "connected"; value: boolean }
  | { type: "batch_events"; events: AgentVizEvent[] };

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "batch_events":
      return action.events.reduce(
        (s, event) => reducer(s, { type: "event", event }),
        state
      );
    case "event":
      return applyEvent(state, action.event);
    case "select_node":
      return { ...state, selectedNodeId: action.agent_id, selectedEdgeKey: null };
    case "select_edge":
      return { ...state, selectedEdgeKey: action.edge_key, selectedNodeId: null };
    case "connected":
      return { ...state, connected: action.value };
    default:
      return state;
  }
}

function applyEvent(state: AppState, event: AgentVizEvent): AppState {
  switch (event.kind) {
    case "agent_spawn": {
      const node: AgentNode = {
        id: event.agent_id,
        name: event.name,
        parent_id: event.parent_id,
        status: "running",
        tool_calls: [],
        logs: [],
      };
      return { ...state, agents: { ...state.agents, [event.agent_id]: node } };
    }
    case "agent_status": {
      const agent = state.agents[event.agent_id];
      if (!agent) return state;
      return {
        ...state,
        agents: { ...state.agents, [event.agent_id]: { ...agent, status: event.status as AgentStatus } },
      };
    }
    case "tool_call_pending": {
      const agent = state.agents[event.agent_id];
      if (!agent) return state;
      const tc = { call_id: event.call_id, name: event.name, args: event.args, pending: true };
      return {
        ...state,
        agents: { ...state.agents, [event.agent_id]: { ...agent, tool_calls: [...agent.tool_calls, tc] } },
      };
    }
    case "tool_result": {
      const agent = state.agents[event.agent_id];
      if (!agent) return state;
      const updated = agent.tool_calls.map((tc) =>
        tc.call_id === event.call_id
          ? { ...tc, pending: false, result: event.result, duration_ms: event.duration_ms }
          : tc
      );
      return { ...state, agents: { ...state.agents, [event.agent_id]: { ...agent, tool_calls: updated } } };
    }
    case "agent_message": {
      const key = `${event.from_agent_id}:${event.to_agent_id}`;
      const existing = state.messageEdges[key] ?? {
        from_agent_id: event.from_agent_id,
        to_agent_id: event.to_agent_id,
        messages: [],
      };
      const msg = { content: event.content, timestamp: event.timestamp, from: event.from_agent_id, to: event.to_agent_id };
      const updated: MessageEdge = { ...existing, messages: [...existing.messages, msg] };
      return { ...state, messageEdges: { ...state.messageEdges, [key]: updated } };
    }
    case "log": {
      const agent = state.agents[event.agent_id];
      if (!agent) return state;
      const log = { content: event.content, level: event.level, timestamp: event.timestamp };
      return { ...state, agents: { ...state.agents, [event.agent_id]: { ...agent, logs: [...agent.logs, log] } } };
    }
    case "agent_complete": {
      const agent = state.agents[event.agent_id];
      if (!agent) return state;
      const status: AgentStatus = event.exit_status === "ok" ? "complete" : event.exit_status === "stopped" ? "paused" : "error";
      return { ...state, agents: { ...state.agents, [event.agent_id]: { ...agent, status } } };
    }
    default:
      return state;
  }
}
