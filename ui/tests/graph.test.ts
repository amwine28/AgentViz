import { describe, test, expect } from "vitest";
import { buildWorkflowGraph } from "../src/graph";
import { reducer, initialState, AppState } from "../src/store";
import type { AgentVizEvent } from "../src/types";

function play(events: object[]): AppState {
  return (events as AgentVizEvent[]).reduce(
    (s, event) => reducer(s, { type: "event", event }),
    initialState
  );
}

const BASE = [
  { kind: "agent_spawn", agent_id: "orch", parent_id: null, name: "orch", timestamp: 1 },
  { kind: "agent_spawn", agent_id: "w1", parent_id: "orch", name: "w1", timestamp: 2 },
  { kind: "agent_spawn", agent_id: "w2", parent_id: "orch", name: "w2", timestamp: 3 },
];

describe("buildWorkflowGraph", () => {
  test("node features: tool calls, latency, messages, errors", () => {
    const state = play([
      ...BASE,
      { kind: "tool_call_pending", agent_id: "w1", call_id: "c1", name: "fetch", args: {}, timestamp: 4 },
      { kind: "tool_result", agent_id: "w1", call_id: "c1", result: "ok", duration_ms: 100, timestamp: 5 },
      { kind: "tool_call_pending", agent_id: "w1", call_id: "c2", name: "fetch", args: {}, timestamp: 6 },
      { kind: "tool_result", agent_id: "w1", call_id: "c2", result: "ok", duration_ms: 300, timestamp: 7 },
      { kind: "tool_call_pending", agent_id: "w2", call_id: "c3", name: "purge", args: {}, timestamp: 8 },
      { kind: "tool_denied", agent_id: "w2", call_id: "c3", name: "purge", reason: "timeout", timestamp: 9 },
      { kind: "agent_message", from_agent_id: "w1", to_agent_id: "orch", content: "done", timestamp: 10 },
    ]);
    const g = buildWorkflowGraph(state);
    const w1 = g.nodes.find((n) => n.id === "w1")!;
    expect(w1.tool_calls).toBe(2);
    expect(w1.avg_tool_ms).toBe(200);
    expect(w1.messages_sent).toBe(1);
    const w2 = g.nodes.find((n) => n.id === "w2")!;
    expect(w2.denials).toBe(1);
    const orch = g.nodes.find((n) => n.id === "orch")!;
    expect(orch.messages_received).toBe(1);
  });

  test("message edges aggregate weight and spawn edges are typed", () => {
    const state = play([
      ...BASE,
      { kind: "agent_message", from_agent_id: "w1", to_agent_id: "orch", content: "aa", timestamp: 4 },
      { kind: "agent_message", from_agent_id: "w1", to_agent_id: "orch", content: "bbbb", timestamp: 5 },
    ]);
    const g = buildWorkflowGraph(state);
    const msg = g.links.find((l) => l.type === "message" && l.source === "w1")!;
    expect(msg.weight).toBe(2);
    expect(msg.chars).toBe(6);
    expect(g.links.filter((l) => l.type === "spawn")).toHaveLength(2);
  });

  test("betweenness: middle of a path graph is the bottleneck", () => {
    // a -msg- b -msg- c : b sits on the only path between a and c
    const state = play([
      { kind: "agent_spawn", agent_id: "a", parent_id: null, name: "a", timestamp: 1 },
      { kind: "agent_spawn", agent_id: "b", parent_id: null, name: "b", timestamp: 2 },
      { kind: "agent_spawn", agent_id: "c", parent_id: null, name: "c", timestamp: 3 },
      { kind: "agent_message", from_agent_id: "a", to_agent_id: "b", content: "x", timestamp: 4 },
      { kind: "agent_message", from_agent_id: "b", to_agent_id: "c", content: "y", timestamp: 5 },
    ]);
    const g = buildWorkflowGraph(state);
    expect(g.metrics.bottleneck).toBe("b");
    const b = g.nodes.find((n) => n.id === "b")!;
    const a = g.nodes.find((n) => n.id === "a")!;
    expect(b.betweenness).toBeGreaterThan(a.betweenness);
  });

  test("hub, isolates and density", () => {
    const state = play([
      ...BASE,
      { kind: "agent_spawn", agent_id: "loner", parent_id: null, name: "loner", timestamp: 4 },
      { kind: "agent_message", from_agent_id: "w1", to_agent_id: "orch", content: "x", timestamp: 5 },
      { kind: "agent_message", from_agent_id: "w2", to_agent_id: "orch", content: "y", timestamp: 6 },
    ]);
    const g = buildWorkflowGraph(state);
    expect(g.metrics.hub).toBe("orch"); // highest degree (2 spawns + 2 msg partners)
    expect(g.metrics.isolates).toEqual(["loner"]);
    expect(g.metrics.density).toBeGreaterThan(0);
    expect(g.metrics.density).toBeLessThanOrEqual(1);
  });

  test("exports NetworkX node-link shape", () => {
    const g = buildWorkflowGraph(play(BASE));
    expect(g.directed).toBe(true);
    expect(g.multigraph).toBe(false);
    expect(g.graph.session).toBeDefined();
    // every link endpoint resolves to a node id
    const ids = new Set(g.nodes.map((n) => n.id));
    for (const l of g.links) {
      expect(ids.has(l.source as string)).toBe(true);
      expect(ids.has(l.target as string)).toBe(true);
    }
  });
});
