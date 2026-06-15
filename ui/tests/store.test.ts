import { describe, test, expect } from "vitest";
import { reducer, initialState } from "../src/store";
import type { AgentSpawnEvent, AgentStatusEvent, ToolCallPendingEvent, AgentMessageEvent, ToolResultEvent, ToolDeniedEvent, AgentCompleteEvent, OutcomeEvent } from "../src/types";

const outcome = (o: Partial<OutcomeEvent>): OutcomeEvent => ({
  kind: "outcome", agent_id: null, channel: "reward", value: 0, scale: "binary",
  value_min: null, value_max: null, stage: "terminal", source: "manual",
  measured: true, detail: {}, run_id: null, ablated_agent_id: null,
  baseline_run_id: null, baseline_value: null, timestamp: 1, ...o,
});

describe("store reducer", () => {
  test("agent_spawn adds node", () => {
    const event: AgentSpawnEvent = { kind: "agent_spawn", agent_id: "a1", parent_id: null, name: "orch", timestamp: 1 };
    const state = reducer(initialState, { type: "event", event });
    expect(state.agents["a1"]).toBeDefined();
    expect(state.agents["a1"].name).toBe("orch");
    expect(state.agents["a1"].status).toBe("running");
  });

  test("agent_status updates status", () => {
    const spawn: AgentSpawnEvent = { kind: "agent_spawn", agent_id: "a1", parent_id: null, name: "orch", timestamp: 1 };
    const status: AgentStatusEvent = { kind: "agent_status", agent_id: "a1", status: "waiting", timestamp: 2 };
    let state = reducer(initialState, { type: "event", event: spawn });
    state = reducer(state, { type: "event", event: status });
    expect(state.agents["a1"].status).toBe("waiting");
  });

  test("tool_call_pending appends to agent tool_calls as pending", () => {
    const spawn: AgentSpawnEvent = { kind: "agent_spawn", agent_id: "a1", parent_id: null, name: "orch", timestamp: 1 };
    const toolCall: ToolCallPendingEvent = { kind: "tool_call_pending", agent_id: "a1", call_id: "c1", name: "my_tool", args: { x: 1 }, timestamp: 2 };
    let state = reducer(initialState, { type: "event", event: spawn });
    state = reducer(state, { type: "event", event: toolCall });
    expect(state.agents["a1"].tool_calls).toHaveLength(1);
    expect(state.agents["a1"].tool_calls[0].pending).toBe(true);
    expect(state.agents["a1"].tool_calls[0].name).toBe("my_tool");
  });

  test("agent_message creates message edge", () => {
    const msg: AgentMessageEvent = { kind: "agent_message", from_agent_id: "a1", to_agent_id: "a2", content: "hello", timestamp: 1 };
    const state = reducer(initialState, { type: "event", event: msg });
    const edgeKey = "a1:a2";
    expect(state.messageEdges[edgeKey]).toBeDefined();
    expect(state.messageEdges[edgeKey].messages).toHaveLength(1);
    expect(state.messageEdges[edgeKey].messages[0].content).toBe("hello");
  });

  test("select_node sets selectedNodeId", () => {
    const state = reducer(initialState, { type: "select_node", agent_id: "a1" });
    expect(state.selectedNodeId).toBe("a1");
  });

  test("select_edge sets selectedEdgeKey", () => {
    const state = reducer(initialState, { type: "select_edge", edge_key: "a1:a2" });
    expect(state.selectedEdgeKey).toBe("a1:a2");
  });

  test("tool_result resolves pending tool call", () => {
    const spawn: AgentSpawnEvent = { kind: "agent_spawn", agent_id: "a1", parent_id: null, name: "orch", timestamp: 1 };
    const toolCall: ToolCallPendingEvent = { kind: "tool_call_pending", agent_id: "a1", call_id: "c1", name: "my_tool", args: {}, timestamp: 2 };
    const result: ToolResultEvent = { kind: "tool_result", agent_id: "a1", call_id: "c1", result: "done", duration_ms: 42, timestamp: 3 };
    let state = reducer(initialState, { type: "event", event: spawn });
    state = reducer(state, { type: "event", event: toolCall });
    state = reducer(state, { type: "event", event: result });
    expect(state.agents["a1"].tool_calls[0].pending).toBe(false);
    expect(state.agents["a1"].tool_calls[0].result).toBe("done");
    expect(state.agents["a1"].tool_calls[0].duration_ms).toBe(42);
  });

  test("tool_denied resolves pending tool call with denial reason", () => {
    const spawn: AgentSpawnEvent = { kind: "agent_spawn", agent_id: "a1", parent_id: null, name: "orch", timestamp: 1 };
    const toolCall: ToolCallPendingEvent = { kind: "tool_call_pending", agent_id: "a1", call_id: "c1", name: "my_tool", args: {}, timestamp: 2 };
    const denied: ToolDeniedEvent = { kind: "tool_denied", agent_id: "a1", call_id: "c1", name: "my_tool", reason: "timeout", timestamp: 3 };
    let state = reducer(initialState, { type: "event", event: spawn });
    state = reducer(state, { type: "event", event: toolCall });
    state = reducer(state, { type: "event", event: denied });
    expect(state.agents["a1"].tool_calls[0].pending).toBe(false);
    expect(state.agents["a1"].tool_calls[0].denied).toBe("timeout");
  });

  test("agent_complete ok maps to complete status", () => {
    const spawn: AgentSpawnEvent = { kind: "agent_spawn", agent_id: "a1", parent_id: null, name: "orch", timestamp: 1 };
    const complete: AgentCompleteEvent = { kind: "agent_complete", agent_id: "a1", exit_status: "ok", summary: "", timestamp: 2 };
    let state = reducer(initialState, { type: "event", event: spawn });
    state = reducer(state, { type: "event", event: complete });
    expect(state.agents["a1"].status).toBe("complete");
  });

  test("agent_complete error maps to error status", () => {
    const spawn: AgentSpawnEvent = { kind: "agent_spawn", agent_id: "a1", parent_id: null, name: "orch", timestamp: 1 };
    const complete: AgentCompleteEvent = { kind: "agent_complete", agent_id: "a1", exit_status: "error", summary: "", timestamp: 2 };
    let state = reducer(initialState, { type: "event", event: spawn });
    state = reducer(state, { type: "event", event: complete });
    expect(state.agents["a1"].status).toBe("error");
  });

  test("batch_events processes events in order", () => {
    const spawn1: AgentSpawnEvent = { kind: "agent_spawn", agent_id: "a1", parent_id: null, name: "a", timestamp: 1 };
    const spawn2: AgentSpawnEvent = { kind: "agent_spawn", agent_id: "a2", parent_id: null, name: "b", timestamp: 2 };
    const state = reducer(initialState, { type: "batch_events", events: [spawn1, spawn2] });
    expect(state.agents["a1"]).toBeDefined();
    expect(state.agents["a2"]).toBeDefined();
  });

  test("select_node clears selectedEdgeKey", () => {
    let state = reducer(initialState, { type: "select_edge", edge_key: "a1:a2" });
    state = reducer(state, { type: "select_node", agent_id: "a1" });
    expect(state.selectedNodeId).toBe("a1");
    expect(state.selectedEdgeKey).toBeNull();
  });

  test("seq gap increments droppedCount", () => {
    const spawn: AgentSpawnEvent = { kind: "agent_spawn", agent_id: "a1", parent_id: null, name: "x", timestamp: 1, seq: 0 };
    const log1 = { kind: "log" as const, agent_id: "a1", content: "one", level: "info" as const, timestamp: 2, seq: 1 };
    const log4 = { kind: "log" as const, agent_id: "a1", content: "four", level: "info" as const, timestamp: 3, seq: 4 };
    let state = reducer(initialState, { type: "event", event: spawn });
    state = reducer(state, { type: "event", event: log1 });
    expect(state.droppedCount).toBe(0);
    state = reducer(state, { type: "event", event: log4 });
    expect(state.droppedCount).toBe(2); // seq 2 and 3 missing
  });

  test("contiguous seqs do not increment droppedCount", () => {
    const spawn: AgentSpawnEvent = { kind: "agent_spawn", agent_id: "a1", parent_id: null, name: "x", timestamp: 1, seq: 0 };
    const log1 = { kind: "log" as const, agent_id: "a1", content: "one", level: "info" as const, timestamp: 2, seq: 1 };
    let state = reducer(initialState, { type: "event", event: spawn });
    state = reducer(state, { type: "event", event: log1 });
    expect(state.droppedCount).toBe(0);
    expect(state.eventCount).toBe(2);
  });

  test("session_start resets agents and sets session name", () => {
    const spawn: AgentSpawnEvent = { kind: "agent_spawn", agent_id: "ghost", parent_id: null, name: "old", timestamp: 1 };
    let state = reducer(initialState, { type: "event", event: spawn });
    state = reducer(state, { type: "connected", value: true });
    state = reducer(state, { type: "event", event: { kind: "session_start", name: "fresh-run", timestamp: 2 } });
    expect(Object.keys(state.agents)).toHaveLength(0);
    expect(state.sessionName).toBe("fresh-run");
    expect(state.connected).toBe(true); // connection survives session reset
  });

  test("credit_report records causal credit by method and resets on session_start", () => {
    let state = reducer(initialState, { type: "event", event: {
      kind: "credit_report", method: "counterfactual", channel: "tests",
      agents: [{ agent: "retriever", credit: 0.7, ci: [0.69, 0.71], credit_state: "estimated", basis: "measured" }],
      timestamp: 1,
    } });
    expect(state.creditReports["counterfactual"].agents[0].agent).toBe("retriever");
    expect(state.creditReports["counterfactual"].agents[0].ci).toEqual([0.69, 0.71]);
    state = reducer(state, { type: "event", event: { kind: "session_start", name: "fresh", timestamp: 2 } });
    expect(state.creditReports).toEqual({});
  });

  test("command_ack records status by cmd_id", () => {
    const state = reducer(initialState, { type: "event", event: { kind: "command_ack", cmd_id: "c-9", status: "applied", timestamp: 1 } });
    expect(state.acks["c-9"]).toBe("applied");
  });

  test("timeline records narrative events in order", () => {
    const spawn: AgentSpawnEvent = { kind: "agent_spawn", agent_id: "a1", parent_id: null, name: "x", timestamp: 1 };
    const msg: AgentMessageEvent = { kind: "agent_message", from_agent_id: "a1", to_agent_id: "a2", content: "hi", timestamp: 2 };
    const ack = { kind: "command_ack" as const, cmd_id: "c", status: "applied" as const, timestamp: 3 };
    let state = reducer(initialState, { type: "event", event: spawn });
    state = reducer(state, { type: "event", event: msg });
    state = reducer(state, { type: "event", event: ack });
    expect(state.timeline.map((e) => e.kind)).toEqual(["agent_spawn", "agent_message"]); // acks are plumbing, not narrative
  });

  test("usage events aggregate tokens and cost on the agent", () => {
    const spawn: AgentSpawnEvent = { kind: "agent_spawn", agent_id: "a1", parent_id: null, name: "x", timestamp: 1 };
    let state = reducer(initialState, { type: "event", event: spawn });
    state = reducer(state, { type: "event", event: { kind: "usage", agent_id: "a1", input_tokens: 100, output_tokens: 40, model: "m", cost_usd: 0.01, timestamp: 2 } });
    state = reducer(state, { type: "event", event: { kind: "usage", agent_id: "a1", input_tokens: 50, output_tokens: 10, model: "m", cost_usd: 0.005, timestamp: 3 } });
    expect(state.agents["a1"].usage).toEqual({ input_tokens: 150, output_tokens: 50, cost_usd: 0.015 });
  });

  test("run-level outcome keeps the latest-timestamp value (last-write-wins)", () => {
    let state = reducer(initialState, { type: "event", event: outcome({ channel: "tests", value: 0, timestamp: 5 }) });
    // earlier-timestamp re-grade must NOT overwrite
    state = reducer(state, { type: "event", event: outcome({ channel: "tests", value: 1, timestamp: 2 }) });
    expect(state.outcomes["tests"].terminal!.value).toBe(0);
    // later-timestamp re-grade wins
    state = reducer(state, { type: "event", event: outcome({ channel: "tests", value: 1, timestamp: 9 }) });
    expect(state.outcomes["tests"].terminal!.value).toBe(1);
  });

  test("run-level outcome carries result_agent_ids from detail", () => {
    const state = reducer(initialState, { type: "event", event: outcome({ channel: "tests", detail: { result_agent_ids: ["a1", "a2"] } }) });
    expect(state.outcomes["tests"].terminal!.result_agent_ids).toEqual(["a1", "a2"]);
  });

  test("agent-scoped outcome accumulates per agent", () => {
    let state = reducer(initialState, { type: "event", event: outcome({ agent_id: "a1", channel: "rubric", stage: "intermediate", value: 0.5, scale: "unit" }) });
    state = reducer(state, { type: "event", event: outcome({ agent_id: "a1", channel: "rubric", stage: "intermediate", value: 0.25, scale: "unit" }) });
    expect(state.outcomes["rubric"].perAgent["a1"].value).toBeCloseTo(0.75);
    expect(state.outcomes["rubric"].perAgent["a1"].count).toBe(2);
  });

  test("outcome is recorded even when it arrives after agent_complete (no !agent guard)", () => {
    const spawn: AgentSpawnEvent = { kind: "agent_spawn", agent_id: "a1", parent_id: null, name: "x", timestamp: 1 };
    const complete: AgentCompleteEvent = { kind: "agent_complete", agent_id: "a1", exit_status: "ok", summary: "", timestamp: 2 };
    let state = reducer(initialState, { type: "event", event: spawn });
    state = reducer(state, { type: "event", event: complete });
    state = reducer(state, { type: "event", event: outcome({ agent_id: "a1", channel: "rubric", stage: "intermediate", value: 1 }) });
    expect(state.outcomes["rubric"].perAgent["a1"].value).toBe(1);
  });

  test("agent_complete persists completed_at and exit_status on the node", () => {
    const spawn: AgentSpawnEvent = { kind: "agent_spawn", agent_id: "a1", parent_id: null, name: "x", timestamp: 1 };
    const complete: AgentCompleteEvent = { kind: "agent_complete", agent_id: "a1", exit_status: "error", summary: "boom", timestamp: 7 };
    let state = reducer(initialState, { type: "event", event: spawn });
    expect(state.agents["a1"].completed_at).toBeNull();
    state = reducer(state, { type: "event", event: complete });
    expect(state.agents["a1"].completed_at).toBe(7);
    expect(state.agents["a1"].exit_status).toBe("error");
  });

  test("outcomes reset to {} on session_start", () => {
    let state = reducer(initialState, { type: "event", event: outcome({ channel: "tests", value: 1 }) });
    state = reducer(state, { type: "event", event: { kind: "session_start", name: "fresh", timestamp: 2 } });
    expect(state.outcomes).toEqual({});
  });

  test("timeline resets on session_start", () => {
    const spawn: AgentSpawnEvent = { kind: "agent_spawn", agent_id: "a1", parent_id: null, name: "x", timestamp: 1 };
    let state = reducer(initialState, { type: "event", event: spawn });
    state = reducer(state, { type: "event", event: { kind: "session_start", name: "fresh", timestamp: 2 } });
    expect(state.timeline).toHaveLength(0);
  });
});
