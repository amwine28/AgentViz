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
  eventCount: number;
  droppedCount: number;
  lastSeq: Record<string, number>; // per-agent sequence tracking for gap detection
  acks: Record<string, "applied" | "failed">;
  timeline: AgentVizEvent[]; // narrative events in arrival order, for the FLOW view
}

export const initialState: AppState = {
  agents: {},
  messageEdges: {},
  selectedNodeId: null,
  selectedEdgeKey: null,
  sessionName: "",
  connected: false,
  eventCount: 0,
  droppedCount: 0,
  lastSeq: {},
  acks: {},
  timeline: [],
};

const TIMELINE_CAP = 5000;
const NARRATIVE_KINDS = new Set<string>([
  "agent_spawn", "agent_message", "tool_call_pending", "tool_result",
  "tool_denied", "log", "agent_complete",
]);

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

function trackSeq(state: AppState, event: AgentVizEvent): AppState {
  const e = event as AgentVizEvent & { agent_id?: string; from_agent_id?: string };
  const next = { ...state, eventCount: state.eventCount + 1 };
  if (typeof event.seq !== "number") return next;
  const key = e.agent_id ?? e.from_agent_id ?? "_session";
  const last = state.lastSeq[key];
  const gap = last !== undefined && event.seq > last + 1 ? event.seq - last - 1 : 0;
  return {
    ...next,
    droppedCount: next.droppedCount + gap,
    lastSeq: { ...next.lastSeq, [key]: Math.max(event.seq, last ?? -1) },
  };
}

function applyEvent(rawState: AppState, event: AgentVizEvent): AppState {
  let state = trackSeq(rawState, event);
  if (NARRATIVE_KINDS.has(event.kind)) {
    const timeline = state.timeline.length >= TIMELINE_CAP
      ? [...state.timeline.slice(-(TIMELINE_CAP - 1)), event]
      : [...state.timeline, event];
    state = { ...state, timeline };
  }
  switch (event.kind) {
    case "session_start":
      // New session owns the canvas: drop prior agents/edges, keep connection.
      return {
        ...initialState,
        connected: state.connected,
        sessionName: event.name,
        eventCount: 1,
      };
    case "command_ack":
      return { ...state, acks: { ...state.acks, [event.cmd_id]: event.status } };
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
        agents: { ...state.agents, [event.agent_id]: { ...agent, status: event.status } },
      };
    }
    case "tool_call_pending": {
      const agent = state.agents[event.agent_id];
      if (!agent) return state;
      const tc = {
        call_id: event.call_id, name: event.name, args: event.args, pending: true,
        requested_at: event.timestamp, timeout_s: event.timeout_s,
      };
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
    case "tool_denied": {
      const agent = state.agents[event.agent_id];
      if (!agent) return state;
      const updated = agent.tool_calls.map((tc) =>
        tc.call_id === event.call_id
          ? { ...tc, pending: false, denied: event.reason }
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
