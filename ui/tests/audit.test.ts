import { describe, test, expect } from "vitest";
import { auditWorkflow } from "../src/audit";
import { reducer, initialState, AppState } from "../src/store";
import type { AgentVizEvent } from "../src/types";

function play(events: object[]): AppState {
  return (events as AgentVizEvent[]).reduce(
    (s, event) => reducer(s, { type: "event", event }),
    initialState
  );
}

const busyWorker = (id: string, parent: string, t: number) => [
  { kind: "agent_spawn", agent_id: id, parent_id: parent, name: id, timestamp: t },
  { kind: "tool_call_pending", agent_id: id, call_id: `${id}-c`, name: `${id}_tool`, args: {}, timestamp: t + 1 },
  { kind: "tool_result", agent_id: id, call_id: `${id}-c`, result: "ok", duration_ms: 10, timestamp: t + 2 },
  { kind: "agent_message", from_agent_id: id, to_agent_id: "orch", content: "done", timestamp: t + 3 },
];

describe("auditWorkflow", () => {
  test("clean busy workflow scores high with no findings", () => {
    const state = play([
      { kind: "agent_spawn", agent_id: "orch", parent_id: null, name: "orch", timestamp: 1 },
      ...busyWorker("w1", "orch", 10),
      ...busyWorker("w2", "orch", 20),
      { kind: "agent_message", from_agent_id: "orch", to_agent_id: "w1", content: "go", timestamp: 30 },
    ]);
    const audit = auditWorkflow(state);
    expect(audit.score).toBe(100);
    expect(audit.findings).toHaveLength(0);
    expect(audit.grade).toBe("A");
  });

  test("dead-weight agents are flagged with reasons", () => {
    const state = play([
      { kind: "agent_spawn", agent_id: "orch", parent_id: null, name: "orch", timestamp: 1 },
      ...busyWorker("w1", "orch", 10),
      { kind: "agent_spawn", agent_id: "idle1", parent_id: "orch", name: "idle1", timestamp: 20 },
      { kind: "agent_spawn", agent_id: "idle2", parent_id: "orch", name: "idle2", timestamp: 21 },
    ]);
    const audit = auditWorkflow(state);
    const dead = audit.findings.find((f) => f.rule === "dead_weight")!;
    expect(dead.agents).toEqual(["idle1", "idle2"]);
    expect(audit.score).toBeLessThan(100);
  });

  test("denied tool calls and error exits cost points", () => {
    const state = play([
      { kind: "agent_spawn", agent_id: "orch", parent_id: null, name: "orch", timestamp: 1 },
      ...busyWorker("w1", "orch", 10),
      { kind: "tool_call_pending", agent_id: "w1", call_id: "d1", name: "x", args: {}, timestamp: 14 },
      { kind: "tool_denied", agent_id: "w1", call_id: "d1", name: "x", reason: "timeout", timestamp: 15 },
      { kind: "agent_complete", agent_id: "w1", exit_status: "error", summary: "boom", timestamp: 16 },
    ]);
    const audit = auditWorkflow(state);
    expect(audit.findings.some((f) => f.rule === "denied_tools")).toBe(true);
    expect(audit.findings.some((f) => f.rule === "error_exits")).toBe(true);
  });

  test("duplicate sibling roles are flagged", () => {
    const state = play([
      { kind: "agent_spawn", agent_id: "orch", parent_id: null, name: "orch", timestamp: 1 },
      // two siblings doing the identical tool set
      { kind: "agent_spawn", agent_id: "s1", parent_id: "orch", name: "s1", timestamp: 2 },
      { kind: "tool_call_pending", agent_id: "s1", call_id: "s1c", name: "same_tool", args: {}, timestamp: 3 },
      { kind: "tool_result", agent_id: "s1", call_id: "s1c", result: "ok", duration_ms: 1, timestamp: 4 },
      { kind: "agent_message", from_agent_id: "s1", to_agent_id: "orch", content: "x", timestamp: 5 },
      { kind: "agent_spawn", agent_id: "s2", parent_id: "orch", name: "s2", timestamp: 6 },
      { kind: "tool_call_pending", agent_id: "s2", call_id: "s2c", name: "same_tool", args: {}, timestamp: 7 },
      { kind: "tool_result", agent_id: "s2", call_id: "s2c", result: "ok", duration_ms: 1, timestamp: 8 },
      { kind: "agent_message", from_agent_id: "s2", to_agent_id: "orch", content: "y", timestamp: 9 },
    ]);
    const audit = auditWorkflow(state);
    const dup = audit.findings.find((f) => f.rule === "duplicate_roles");
    expect(dup).toBeDefined();
    expect(dup!.agents).toContain("s1");
    expect(dup!.agents).toContain("s2");
  });

  test("token skew: one agent burning most tokens for little output", () => {
    const state = play([
      { kind: "agent_spawn", agent_id: "orch", parent_id: null, name: "orch", timestamp: 1 },
      ...busyWorker("w1", "orch", 10),
      ...busyWorker("w2", "orch", 20),
      { kind: "agent_spawn", agent_id: "burner", parent_id: "orch", name: "burner", timestamp: 30 },
      { kind: "agent_message", from_agent_id: "burner", to_agent_id: "orch", content: "hi", timestamp: 31 },
      { kind: "usage", agent_id: "burner", input_tokens: 90000, output_tokens: 10000, model: "m", cost_usd: 1, timestamp: 32 },
      { kind: "usage", agent_id: "w1", input_tokens: 1000, output_tokens: 200, model: "m", cost_usd: 0.01, timestamp: 33 },
      { kind: "usage", agent_id: "w2", input_tokens: 1000, output_tokens: 200, model: "m", cost_usd: 0.01, timestamp: 34 },
    ]);
    const audit = auditWorkflow(state);
    const skew = audit.findings.find((f) => f.rule === "token_skew");
    expect(skew).toBeDefined();
    expect(skew!.agents).toEqual(["burner"]);
    expect(audit.tokens_total).toBe(102400);
  });

  test("score floors at 0 and grades map to bands", () => {
    const events: object[] = [{ kind: "agent_spawn", agent_id: "orch", parent_id: null, name: "orch", timestamp: 1 }];
    for (let i = 0; i < 12; i++) {
      events.push({ kind: "agent_spawn", agent_id: `z${i}`, parent_id: "orch", name: `z${i}`, timestamp: 2 + i });
      events.push({ kind: "agent_complete", agent_id: `z${i}`, exit_status: "error", summary: "", timestamp: 30 + i });
    }
    const audit = auditWorkflow(play(events));
    expect(audit.score).toBeGreaterThanOrEqual(0);
    expect(["D", "F"]).toContain(audit.grade);
  });
});
