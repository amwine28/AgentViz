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
  closed: Set<string>;           // sessions the user dismissed — ignore their stray events
}

export const initialMultiState: MultiState = {
  sessions: {},
  order: [],
  activeId: null,
  names: {},
  connected: false,
  closed: new Set(),
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
  // A dismissed tab stays gone until it explicitly restarts (a fresh
  // session_start re-opens it); all other stray events for it are ignored, so
  // it can't silently resurrect on the next event or a browser reconnect.
  if (s.closed.has(sid)) {
    if (event.kind !== "session_start") return s;
    const closed = new Set(s.closed); closed.delete(sid);
    s = { ...s, closed };
  }
  const existed = s.sessions[sid] !== undefined;
  const world = existed ? s.sessions[sid] : emptyWorld();
  const nextWorld = sessionReducer(world, { type: "event", event });

  let names = s.names;
  let activeId = s.activeId ?? sid; // first session to appear becomes the active tab
  if (event.kind === "session_start") {
    const start = event as { name?: string; source?: string };
    if (start.name && names[sid] === undefined) names = { ...names, [sid]: start.name };
    // A user explicitly running `agentviz` in a terminal (source=shell) wants to
    // SEE that terminal — focus it, so it isn't hidden behind older/stale tabs.
    if (start.source === "shell") activeId = sid;
  }

  return {
    ...s,
    sessions: { ...s.sessions, [sid]: nextWorld },
    order: existed ? s.order : [...s.order, sid],
    activeId,
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
      const closed = new Set(s.closed); closed.add(action.session_id);
      return { ...s, sessions, order, names, activeId, closed };
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
