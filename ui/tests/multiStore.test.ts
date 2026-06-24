import { describe, it, expect } from "vitest";
import { rootReducer, initialMultiState, activeWorld, sessionTabs, type MultiState } from "../src/multiStore";
import type { AgentVizEvent } from "../src/types";

const ev = (e: Partial<AgentVizEvent> & { kind: string }) => e as AgentVizEvent;
function feed(s: MultiState, ...events: AgentVizEvent[]): MultiState {
  return events.reduce((acc, event) => rootReducer(acc, { type: "event", event }), s);
}

describe("multiStore", () => {
  it("routes events to independent sessions by session_id", () => {
    let s = initialMultiState;
    s = feed(s,
      ev({ kind: "session_start", name: "Run A", session_id: "A", timestamp: 1 }),
      ev({ kind: "agent_spawn", agent_id: "a1", name: "x", parent_id: null, session_id: "A", timestamp: 2 }),
      ev({ kind: "session_start", name: "Run B", session_id: "B", timestamp: 3 }),
      ev({ kind: "agent_spawn", agent_id: "b1", name: "y", parent_id: null, session_id: "B", timestamp: 4 }),
    );
    expect(Object.keys(s.sessions).sort()).toEqual(["A", "B"]);
    expect(Object.keys(s.sessions.A.agents)).toEqual(["a1"]); // A not clobbered by B
    expect(Object.keys(s.sessions.B.agents)).toEqual(["b1"]);
    expect(s.order).toEqual(["A", "B"]);
    expect(s.activeId).toBe("A"); // first session becomes active
    expect(s.names).toMatchObject({ A: "Run A", B: "Run B" });
  });

  it("events without session_id go to _legacy (single-session compat)", () => {
    let s = feed(initialMultiState, ev({ kind: "agent_spawn", agent_id: "z", name: "z", parent_id: null, timestamp: 1 }));
    expect(s.order).toEqual(["_legacy"]);
    expect(activeWorld(s)!.agents.z).toBeTruthy();
  });

  it("batch_events fold per session", () => {
    const s = rootReducer(initialMultiState, { type: "batch_events", events: [
      ev({ kind: "agent_spawn", agent_id: "a1", name: "x", parent_id: null, session_id: "A", timestamp: 1 }),
      ev({ kind: "agent_spawn", agent_id: "b1", name: "y", parent_id: null, session_id: "B", timestamp: 2 }),
    ] });
    expect(Object.keys(s.sessions.A.agents)).toEqual(["a1"]);
    expect(Object.keys(s.sessions.B.agents)).toEqual(["b1"]);
  });

  it("connected is a global flag, not per-session", () => {
    let s = feed(initialMultiState, ev({ kind: "session_start", name: "A", session_id: "A", timestamp: 1 }));
    s = rootReducer(s, { type: "connected", value: true });
    expect(s.connected).toBe(true);
  });

  it("select_node acts on the active session only", () => {
    let s = feed(initialMultiState,
      ev({ kind: "session_start", name: "A", session_id: "A", timestamp: 1 }),
      ev({ kind: "session_start", name: "B", session_id: "B", timestamp: 2 }),
    );
    s = rootReducer(s, { type: "set_active_session", session_id: "B" });
    s = rootReducer(s, { type: "select_node", agent_id: "n1" });
    expect(s.sessions.B.selectedNodeId).toBe("n1");
    expect(s.sessions.A.selectedNodeId).toBeNull();
  });

  it("close_session removes it and reassigns active", () => {
    let s = feed(initialMultiState,
      ev({ kind: "session_start", name: "A", session_id: "A", timestamp: 1 }),
      ev({ kind: "session_start", name: "B", session_id: "B", timestamp: 2 }),
    );
    s = rootReducer(s, { type: "close_session", session_id: "A" });
    expect(Object.keys(s.sessions)).toEqual(["B"]);
    expect(s.order).toEqual(["B"]);
    expect(s.activeId).toBe("B");
  });

  it("a closed session does not resurrect on a stray event, but a fresh session_start re-opens it", () => {
    let s = feed(initialMultiState,
      ev({ kind: "session_start", name: "A", session_id: "A", timestamp: 1 }),
      ev({ kind: "agent_spawn", agent_id: "a1", name: "x", parent_id: null, session_id: "A", timestamp: 2 }),
    );
    s = rootReducer(s, { type: "close_session", session_id: "A" });
    expect(s.sessions.A).toBeUndefined();
    // a late stray event for the closed tab is ignored (no resurrection)
    s = feed(s, ev({ kind: "log", agent_id: "a1", content: "late", level: "info", session_id: "A", timestamp: 3 }));
    expect(s.sessions.A).toBeUndefined();
    expect(s.order).not.toContain("A");
    // but an explicit restart re-opens the tab
    s = feed(s, ev({ kind: "session_start", name: "A2", session_id: "A", timestamp: 4 }));
    expect(s.sessions.A).toBeDefined();
    expect(s.closed.has("A")).toBe(false);
  });

  it("a terminal outcome marks the session finished (→ auto-archive); a fresh start clears it", () => {
    let s = feed(initialMultiState,
      ev({ kind: "session_start", name: "A", session_id: "A", timestamp: 1 }),
      ev({ kind: "agent_spawn", agent_id: "a1", name: "x", parent_id: null, session_id: "A", timestamp: 2 }),
    );
    expect(s.finished.has("A")).toBe(false);
    // run-level (agent_id null) terminal outcome → finished
    s = feed(s, ev({ kind: "outcome", agent_id: null, stage: "terminal", value: 1, detail: {}, session_id: "A", timestamp: 3 }));
    expect(s.finished.has("A")).toBe(true);
    // an intermediate, agent-scoped outcome must NOT mark finished
    let s2 = feed(initialMultiState,
      ev({ kind: "session_start", name: "B", session_id: "B", timestamp: 1 }),
      ev({ kind: "outcome", agent_id: "b1", stage: "intermediate", value: 0.5, detail: {}, session_id: "B", timestamp: 2 }),
    );
    expect(s2.finished.has("B")).toBe(false);
    // a fresh session_start re-opens (clears finished)
    s = feed(s, ev({ kind: "session_start", name: "A2", session_id: "A", timestamp: 4 }));
    expect(s.finished.has("A")).toBe(false);
  });

  it("sessionTabs reflects order, labels and status", () => {
    let s = feed(initialMultiState,
      ev({ kind: "session_start", name: "Run A", session_id: "A", timestamp: 1 }),
      ev({ kind: "agent_spawn", agent_id: "a1", name: "x", parent_id: null, session_id: "A", timestamp: 2 }),
    );
    const tabs = sessionTabs(s);
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ id: "A", label: "Run A", active: true, status: "running", agents: 1 });
  });
});
