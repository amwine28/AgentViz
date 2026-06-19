import { describe, test, expect } from "vitest";
import { buildFlowLayout, groupFlowRows } from "../src/flow";
import type { AgentVizEvent } from "../src/types";

const t = (events: object[]) => events as AgentVizEvent[];

describe("buildFlowLayout", () => {
  test("lanes appear in spawn order with names", () => {
    const layout = buildFlowLayout(t([
      { kind: "agent_spawn", agent_id: "a1", parent_id: null, name: "orch", timestamp: 1 },
      { kind: "agent_spawn", agent_id: "a2", parent_id: "a1", name: "worker", timestamp: 2 },
    ]));
    expect(layout.lanes.map((l) => l.name)).toEqual(["orch", "worker"]);
    expect(layout.lanes[1].parentLane).toBe(0);
  });

  test("message rows carry from and to lane indices", () => {
    const layout = buildFlowLayout(t([
      { kind: "agent_spawn", agent_id: "a1", parent_id: null, name: "orch", timestamp: 1 },
      { kind: "agent_spawn", agent_id: "a2", parent_id: "a1", name: "worker", timestamp: 2 },
      { kind: "agent_message", from_agent_id: "a2", to_agent_id: "a1", content: "done", timestamp: 3 },
    ]));
    const msg = layout.rows.find((r) => r.event.kind === "agent_message")!;
    expect(msg.lane).toBe(1);
    expect(msg.targetLane).toBe(0);
  });

  test("tool events sit on their agent's lane and unknown agents get a lane", () => {
    const layout = buildFlowLayout(t([
      { kind: "agent_spawn", agent_id: "a1", parent_id: null, name: "orch", timestamp: 1 },
      { kind: "tool_call_pending", agent_id: "a1", call_id: "c1", name: "fetch", args: {}, timestamp: 2 },
      { kind: "tool_result", agent_id: "a1", call_id: "c1", result: "ok", duration_ms: 5, timestamp: 3 },
      { kind: "log", agent_id: "ghost", content: "??", level: "info", timestamp: 4 },
    ]));
    expect(layout.rows[1].lane).toBe(0);
    expect(layout.rows[2].lane).toBe(0);
    expect(layout.lanes).toHaveLength(2); // ghost got a lane
    expect(layout.rows[3].lane).toBe(1);
  });
});

describe("buildFlowLayout outcomes", () => {
  test("agent-scoped outcome sits on its agent's lane", () => {
    const layout = buildFlowLayout(t([
      { kind: "agent_spawn", agent_id: "a1", parent_id: null, name: "x", timestamp: 1 },
      { kind: "outcome", agent_id: "a1", channel: "rubric", value: 1, scale: "unit", stage: "intermediate", source: "eval", measured: true, detail: {}, value_min: null, value_max: null, run_id: null, ablated_agent_id: null, baseline_run_id: null, baseline_value: null, timestamp: 2 },
    ]));
    const row = layout.rows.find((r) => r.event.kind === "outcome")!;
    expect(row.lane).toBe(0);
    expect(row.fullWidth).toBeFalsy();
  });

  test("run-level terminal outcome is a full-width band (lane -1)", () => {
    const layout = buildFlowLayout(t([
      { kind: "agent_spawn", agent_id: "a1", parent_id: null, name: "x", timestamp: 1 },
      { kind: "outcome", agent_id: null, channel: "tests", value: 1, scale: "binary", stage: "terminal", source: "ci", measured: true, detail: {}, value_min: null, value_max: null, run_id: null, ablated_agent_id: null, baseline_run_id: null, baseline_value: null, timestamp: 2 },
    ]));
    const row = layout.rows.find((r) => r.event.kind === "outcome")!;
    expect(row.fullWidth).toBe(true);
    expect(row.lane).toBe(-1);
  });
});

describe("buildFlowLayout operations", () => {
  test("an agent-scoped operation sits on its agent's lane; its end + ticks follow it", () => {
    const layout = buildFlowLayout(t([
      { kind: "agent_spawn", agent_id: "a1", parent_id: null, name: "orch", timestamp: 1 },
      { kind: "operation_start", op_id: "op1", op_type: "skill", family: "command", parent_op_id: null, agent_id: "a1", label: "/build", status: "running", detail: {}, timestamp: 2 },
      { kind: "operation_tick", op_id: "op1", n: 0, label: "", status: "running", detail: {}, timestamp: 3 },
      { kind: "operation_end", op_id: "op1", status: "complete", summary: "done", detail: {}, timestamp: 4 },
    ]));
    const start = layout.rows.find((r) => r.event.kind === "operation_start")!;
    const tick = layout.rows.find((r) => r.event.kind === "operation_tick")!;
    const end = layout.rows.find((r) => r.event.kind === "operation_end")!;
    expect(start.lane).toBe(0);
    expect(start.fullWidth).toBeFalsy();
    expect(tick.lane).toBe(0);
    expect(end.lane).toBe(0);
  });

  test("a session-level schedule op is a full-width band (lane -1)", () => {
    const layout = buildFlowLayout(t([
      { kind: "agent_spawn", agent_id: "a1", parent_id: null, name: "orch", timestamp: 1 },
      { kind: "operation_start", op_id: "cron1", op_type: "schedule", family: "recurrence", parent_op_id: null, agent_id: null, label: "nightly", status: "recurring", detail: { cron: "0 0 * * *" }, timestamp: 2 },
      { kind: "operation_tick", op_id: "cron1", n: 1, label: "fire", status: "recurring", detail: {}, timestamp: 3 },
    ]));
    const start = layout.rows.find((r) => r.event.kind === "operation_start")!;
    const tick = layout.rows.find((r) => r.event.kind === "operation_tick")!;
    expect(start.lane).toBe(-1);
    expect(start.fullWidth).toBe(true);
    // a tick for a session-level op has no lane → full-width beat
    expect(tick.fullWidth).toBe(true);
  });
});

describe("groupFlowRows", () => {
  const noisy = buildFlowLayout(t([
    { kind: "agent_spawn", agent_id: "a", parent_id: null, name: "a", timestamp: 1 },
    { kind: "log", agent_id: "a", content: "1", level: "info", timestamp: 2 },
    { kind: "log", agent_id: "a", content: "2", level: "info", timestamp: 3 },
    { kind: "tool_call_pending", agent_id: "a", call_id: "c", name: "t", args: {}, timestamp: 4 },
    { kind: "tool_result", agent_id: "a", call_id: "c", result: "ok", duration_ms: 1, timestamp: 5 },
    { kind: "agent_message", from_agent_id: "a", to_agent_id: "a2", content: "hi", timestamp: 6 },
    { kind: "log", agent_id: "a", content: "3", level: "info", timestamp: 7 },
  ]));

  test("long same-lane runs collapse into a section", () => {
    const display = groupFlowRows(noisy.rows, new Set(), 4);
    const section = display.find((d) => d.type === "section");
    expect(section).toBeDefined();
    if (section?.type === "section") {
      expect(section.rows).toHaveLength(4); // logs+tool pair, spawn excluded
    }
    // spawn, section, message, trailing short log stay visible
    expect(display.filter((d) => d.type === "row").map((d) => d.type === "row" && d.row.event.kind))
      .toEqual(["agent_spawn", "agent_message", "log"]);
  });

  test("expanded sections emit their rows", () => {
    const collapsed = groupFlowRows(noisy.rows, new Set(), 4);
    const section = collapsed.find((d) => d.type === "section");
    const expanded = groupFlowRows(noisy.rows, new Set([section!.type === "section" ? section!.key : ""]), 4);
    expect(expanded.filter((d) => d.type === "row").length).toBeGreaterThan(
      collapsed.filter((d) => d.type === "row").length
    );
  });

  test("messages always break groups", () => {
    const display = groupFlowRows(noisy.rows, new Set(), 2);
    const msgIdx = display.findIndex((d) => d.type === "row" && d.row.event.kind === "agent_message");
    expect(msgIdx).toBeGreaterThan(-1);
  });
});
