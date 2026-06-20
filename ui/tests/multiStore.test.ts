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
