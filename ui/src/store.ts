import type {
  AgentVizEvent, AgentNode, MessageEdge, AgentStatus, OutcomeEvent, CreditAgentEntry,
} from "./types";

// One per credit method (counterfactual/shapley/densified); published by a harness.
export interface CreditReportState {
  method: string;
  channel: string;
  agents: CreditAgentEntry[];
  timestamp: number;
}

// One per reward channel; aggregated by the `outcome` reducer case. Consumed by
// credit.ts (the credit ladder) — the terminal reward to reverse-reach from.
export interface OutcomeChannel {
  channel: string;
  scale: OutcomeEvent["scale"];
  value_min: number | null;
  value_max: number | null;
  terminal: {
    value: number; measured: boolean; source: string; timestamp: number;
    agent_id: string | null;          // sink scope: null = run-level, else agent-scoped
    result_agent_ids: string[] | null;
  } | null;
  perAgent: Record<string, { value: number; count: number; measured: boolean }>;
}

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
  outcomes: Record<string, OutcomeChannel>; // key = channel; for credit assignment
  creditReports: Record<string, CreditReportState>; // key = method; causal credit (Rungs 2-4)
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
  outcomes: {},
  creditReports: {},
};

const TIMELINE_CAP = 5000;
const NARRATIVE_KINDS = new Set<string>([
  "agent_spawn", "agent_message", "tool_call_pending", "tool_result",
  "tool_denied", "log", "agent_complete", "outcome",
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
    case "credit_report":
      // externally-computed causal credit (Rungs 2-4), keyed by method (last wins)
      return { ...state, creditReports: { ...state.creditReports, [event.method]: {
        method: event.method, channel: event.channel, agents: event.agents, timestamp: event.timestamp,
      } } };
    case "agent_spawn": {
      const node: AgentNode = {
        id: event.agent_id,
        name: event.name,
        parent_id: event.parent_id,
        status: "running",
        completed_at: null,
        exit_status: null,
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
    case "usage": {
      const agent = state.agents[event.agent_id];
      if (!agent) return state;
      const prev = agent.usage ?? { input_tokens: 0, output_tokens: 0, cost_usd: 0 };
      const usage = {
        input_tokens: prev.input_tokens + (event.input_tokens || 0),
        output_tokens: prev.output_tokens + (event.output_tokens || 0),
        cost_usd: prev.cost_usd + (event.cost_usd || 0),
      };
      return { ...state, agents: { ...state.agents, [event.agent_id]: { ...agent, usage } } };
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
      // persist completion data for Rung 1 sink inference (last-completing-leaf fallback)
      return { ...state, agents: { ...state.agents, [event.agent_id]: { ...agent, status, completed_at: event.timestamp, exit_status: event.exit_status } } };
    }
    case "outcome": {
      // NOTE: touches only state.outcomes (never state.agents) — so it must NOT
      // copy the `if (!agent) return state` guard. An outcome may legitimately
      // arrive after agent_complete, or (ingested) for an agent whose spawn was lost.
      const ch: OutcomeChannel = state.outcomes[event.channel] ?? {
        channel: event.channel, scale: event.scale,
        value_min: event.value_min, value_max: event.value_max,
        terminal: null, perAgent: {},
      };
      if (event.agent_id == null || event.stage === "terminal") {
        // TERMINAL sink reward (run-level if agent_id null, else agent-scoped).
        // Keep the LATEST-timestamp value so buffer-replay order and live order
        // converge (deterministic last-write-wins).
        const incoming = {
          value: event.value, measured: event.measured, source: event.source,
          timestamp: event.timestamp, agent_id: event.agent_id,
          result_agent_ids: Array.isArray((event.detail as { result_agent_ids?: unknown }).result_agent_ids)
            ? ((event.detail as { result_agent_ids: string[] }).result_agent_ids)
            : null,
        };
        const keep = ch.terminal && ch.terminal.timestamp > incoming.timestamp ? ch.terminal : incoming;
        return { ...state, outcomes: { ...state.outcomes, [event.channel]: {
          ...ch, scale: event.scale, value_min: event.value_min, value_max: event.value_max, terminal: keep,
        } } };
      }
      // agent-scoped INTERMEDIATE: accumulate per agent, like usage
      const prev = ch.perAgent[event.agent_id] ?? { value: 0, count: 0, measured: true };
      return { ...state, outcomes: { ...state.outcomes, [event.channel]: {
        ...ch, scale: event.scale,
        perAgent: { ...ch.perAgent, [event.agent_id]: {
          value: prev.value + event.value, count: prev.count + 1,
          measured: prev.measured && event.measured,
        } },
      } } };
    }
    default:
      return state;
  }
}
