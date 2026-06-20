import { sessionReducer, emptyWorld, type SessionWorld } from "./store";
import type { AgentVizEvent } from "./types";

// Top-level multi-session store: a map of sessionId → that tab's world. Every
// incoming event is routed to its session's SessionWorld via the existing pure
// per-session reducer. Events without a session_id go to "_legacy" (single
// demos, replays, old SDKs) — so the whole thing degrades to today's behavior.

const LEGACY = "_legacy";

export interface MultiState {
  sessions: Record<string, SessionWorld>;
  order: string[];               // tab order = first-seen order of session ids
  activeId: string | null;       // the tab currently shown
  names: Record<string, string>; // auto/user tab-name overrides
  connected: boolean;            // the GLOBAL socket flag (per-session connected is vestigial)
}

export const initialMultiState: MultiState = {
  sessions: {},
  order: [],
  activeId: null,
  names: {},
  connected: false,
};

export type RootAction =
  | { type: "event"; event: AgentVizEvent }
  | { type: "batch_events"; events: AgentVizEvent[] }
  | { type: "connected"; value: boolean }
  | { type: "select_node"; agent_id: string | null }
  | { type: "select_edge"; edge_key: string | null }
  | { type: "set_active_session"; session_id: string }
  | { type: "rename_session"; session_id: string; name: string }
  | { type: "close_session"; session_id: string };

function sidOf(event: AgentVizEvent): string {
  return (typeof event.session_id === "string" && event.session_id) || LEGACY;
}

function routeEvent(s: MultiState, event: AgentVizEvent): MultiState {
  const sid = sidOf(event);
  const existed = s.sessions[sid] !== undefined;
  const world = existed ? s.sessions[sid] : emptyWorld();
  const nextWorld = sessionReducer(world, { type: "event", event });

  let names = s.names;
  if (event.kind === "session_start") {
    const name = (event as { name?: string }).name;
    if (name && names[sid] === undefined) names = { ...names, [sid]: name };
  }

  return {
    ...s,
    sessions: { ...s.sessions, [sid]: nextWorld },
    order: existed ? s.order : [...s.order, sid],
    activeId: s.activeId ?? sid, // first session to appear becomes the active tab
    names,
  };
}

export function rootReducer(s: MultiState, action: RootAction): MultiState {
  switch (action.type) {
    case "event":
      return routeEvent(s, action.event);
    case "batch_events":
      return action.events.reduce(routeEvent, s);
    case "connected":
      return { ...s, connected: action.value };
    case "select_node":
    case "select_edge": {
      // selection acts on the active session's world
      const id = s.activeId;
      if (!id || !s.sessions[id]) return s;
      const world = sessionReducer(s.sessions[id], action);
      return { ...s, sessions: { ...s.sessions, [id]: world } };
    }
    case "set_active_session":
      return s.sessions[action.session_id] ? { ...s, activeId: action.session_id } : s;
    case "rename_session":
      return { ...s, names: { ...s.names, [action.session_id]: action.name } };
    case "close_session": {
      if (!s.sessions[action.session_id]) return s;
      const sessions = { ...s.sessions };
      delete sessions[action.session_id];
      const names = { ...s.names };
      delete names[action.session_id];
      const order = s.order.filter((id) => id !== action.session_id);
      const activeId = s.activeId === action.session_id ? (order[order.length - 1] ?? null) : s.activeId;
      return { ...s, sessions, order, names, activeId };
    }
    default:
      return s;
  }
}

// ---- selectors --------------------------------------------------------------

export function activeWorld(s: MultiState): SessionWorld | null {
  return s.activeId ? s.sessions[s.activeId] ?? null : null;
}

export interface TabMeta {
  id: string;
  label: string;
  active: boolean;
  status: "running" | "idle" | "error" | "complete";
  running: number;
  agents: number;
  eventCount: number;
}

export function sessionTabs(s: MultiState): TabMeta[] {
  return s.order.map((id) => {
    const w = s.sessions[id];
    const agents = Object.values(w.agents);
    const running = agents.filter((a) => a.status === "running").length;
    const status: TabMeta["status"] =
      running > 0 ? "running"
      : agents.some((a) => a.status === "error") ? "error"
      : agents.length > 0 && agents.every((a) => a.status === "complete") ? "complete"
      : "idle";
    return {
      id,
      label: s.names[id] ?? w.sessionName ?? id,
      active: id === s.activeId,
      status,
      running,
      agents: agents.length,
      eventCount: w.eventCount,
    };
  });
}
