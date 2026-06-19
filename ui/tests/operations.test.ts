import { describe, test, expect } from "vitest";
import { buildOpsLayout, opSubtitle, phaseTitles, operationBadge } from "../src/operations";
import type { OperationState, OperationTick } from "../src/types";

const tick = (n: number, o: Partial<OperationTick> = {}): OperationTick => ({
  n, label: "", status: "recurring", detail: {}, timestamp: n, ...o,
});

const op = (o: Partial<OperationState> & Pick<OperationState, "op_id" | "op_type" | "family">): OperationState => ({
  parent_op_id: null, agent_id: null, label: o.op_type, status: "running",
  detail: {}, ticks: [], started_at: 0, ended_at: null, end_status: null, children: [],
  ...o,
});

const toMap = (ops: OperationState[]) => new Map(ops.map((o) => [o.op_id, o]));

describe("buildOpsLayout — operation forest grouped by family", () => {
  test("groups top-level ops by family", () => {
    const ops = toMap([
      op({ op_id: "l1", op_type: "loop", family: "recurrence" }),
      op({ op_id: "w1", op_type: "workflow", family: "orchestration" }),
      op({ op_id: "sk1", op_type: "skill", family: "command" }),
    ]);
    const { groups } = buildOpsLayout(ops);
    const fams = groups.map((g) => g.family).sort();
    expect(fams).toEqual(["command", "orchestration", "recurrence"]);
    const recurrence = groups.find((g) => g.family === "recurrence")!;
    expect(recurrence.roots.map((r) => r.op.op_id)).toEqual(["l1"]);
  });

  test("nests workflow -> phase -> spawn under the workflow root", () => {
    const ops = toMap([
      op({ op_id: "wf", op_type: "workflow", family: "orchestration", children: ["ph0"] }),
      op({ op_id: "ph0", op_type: "phase", family: "orchestration", parent_op_id: "wf", children: ["sp0"] }),
      op({ op_id: "sp0", op_type: "spawn", family: "orchestration", parent_op_id: "ph0" }),
    ]);
    const { groups } = buildOpsLayout(ops);
    const orch = groups.find((g) => g.family === "orchestration")!;
    // only the workflow is a root; phase + spawn are nested children
    expect(orch.roots.map((r) => r.op.op_id)).toEqual(["wf"]);
    const wf = orch.roots[0];
    expect(wf.children.map((c) => c.op.op_id)).toEqual(["ph0"]);
    expect(wf.children[0].children.map((c) => c.op.op_id)).toEqual(["sp0"]);
  });

  test("recurrence ops expose ticks as a sparkline series (one point per tick)", () => {
    const ops = toMap([
      op({ op_id: "loopA", op_type: "loop", family: "recurrence",
        detail: { interval_s: 300 }, ticks: [tick(0), tick(1), tick(2)] }),
    ]);
    const { groups } = buildOpsLayout(ops);
    const node = groups.find((g) => g.family === "recurrence")!.roots[0];
    expect(node.sparkline).toEqual([0, 1, 2]);
    expect(node.tickCount).toBe(3);
  });

  test("an op with zero ticks reports an empty sparkline (honest-unknown, no fake bar)", () => {
    const ops = toMap([
      op({ op_id: "loopEmpty", op_type: "loop", family: "recurrence", ticks: [] }),
    ]);
    const { groups } = buildOpsLayout(ops);
    const node = groups.find((g) => g.family === "recurrence")!.roots[0];
    expect(node.sparkline).toEqual([]);
    expect(node.tickCount).toBe(0);
  });

  test("a child whose parent is missing is promoted to a root (no orphan dropped)", () => {
    const ops = toMap([
      op({ op_id: "orphan", op_type: "spawn", family: "orchestration", parent_op_id: "ghost" }),
    ]);
    const { groups } = buildOpsLayout(ops);
    const orch = groups.find((g) => g.family === "orchestration")!;
    expect(orch.roots.map((r) => r.op.op_id)).toEqual(["orphan"]);
  });

  test("groups are ordered by canonical family order; roots ordered by started_at", () => {
    const ops = toMap([
      op({ op_id: "s2", op_type: "skill", family: "command", started_at: 20 }),
      op({ op_id: "s1", op_type: "skill", family: "command", started_at: 10 }),
    ]);
    const { groups } = buildOpsLayout(ops);
    const command = groups.find((g) => g.family === "command")!;
    expect(command.roots.map((r) => r.op.op_id)).toEqual(["s1", "s2"]);
  });

  test("empty operations map yields no groups", () => {
    expect(buildOpsLayout(new Map())).toEqual({ groups: [] });
  });
});

describe("opSubtitle — grounded one-liner from known detail keys only", () => {
  test("loop reports its measured interval", () => {
    expect(opSubtitle(op({ op_id: "l", op_type: "loop", family: "recurrence", detail: { interval_s: 300 } })))
      .toBe("every 300s");
  });
  test("schedule reports cron + next_fire when present", () => {
    expect(opSubtitle(op({ op_id: "s", op_type: "schedule", family: "recurrence", detail: { cron: "0 0 * * *", next_fire: "03:00" } })))
      .toBe("0 0 * * * · next 03:00");
  });
  test("skill reports skill name + args", () => {
    expect(opSubtitle(op({ op_id: "sk", op_type: "skill", family: "command", detail: { skill: "/build", args: "--fast" } })))
      .toBe("/build --fast");
  });
  test("missing detail keys yield an empty subtitle (honest-unknown, never faked)", () => {
    expect(opSubtitle(op({ op_id: "l", op_type: "loop", family: "recurrence", detail: {} }))).toBe("");
    expect(opSubtitle(op({ op_id: "x", op_type: "compact", family: "state", detail: {} }))).toBe("");
  });
});

describe("operationBadge — live-op glyph for a node", () => {
  test("returns the glyph of a live op owned by the agent", () => {
    const ops = toMap([
      op({ op_id: "l", op_type: "loop", family: "recurrence", agent_id: "a1", label: "poll" }),
    ]);
    expect(operationBadge("a1", ops)).toEqual({ glyph: "◌", op_type: "loop", label: "poll" });
  });
  test("ignores ended ops (only live operations earn a badge)", () => {
    const ops = toMap([
      op({ op_id: "l", op_type: "loop", family: "recurrence", agent_id: "a1", ended_at: 99, end_status: "complete" }),
    ]);
    expect(operationBadge("a1", ops)).toBeNull();
  });
  test("ignores ops owned by other agents / session-level ops", () => {
    const ops = toMap([
      op({ op_id: "x", op_type: "schedule", family: "recurrence", agent_id: null }),
      op({ op_id: "y", op_type: "skill", family: "command", agent_id: "other" }),
    ]);
    expect(operationBadge("a1", ops)).toBeNull();
  });
  test("prefers the higher-priority family when multiple live ops exist", () => {
    const ops = toMap([
      op({ op_id: "s", op_type: "skill", family: "command", agent_id: "a1", started_at: 50 }),
      op({ op_id: "l", op_type: "loop", family: "recurrence", agent_id: "a1", started_at: 10 }),
    ]);
    // recurrence outranks command even though it started earlier
    expect(operationBadge("a1", ops)!.op_type).toBe("loop");
  });
});

describe("phaseTitles — workflow phase ribbon", () => {
  test("prefers the workflow's declared phase_titles detail", () => {
    const ops = toMap([
      op({ op_id: "wf", op_type: "workflow", family: "orchestration", detail: { phase_titles: ["A", "B", "C"] } }),
    ]);
    const node = buildOpsLayout(ops).groups[0].roots[0];
    expect(phaseTitles(node)).toEqual(["A", "B", "C"]);
  });
  test("falls back to child phase op titles when not declared", () => {
    const ops = toMap([
      op({ op_id: "wf", op_type: "workflow", family: "orchestration", children: ["p0", "p1"] }),
      op({ op_id: "p0", op_type: "phase", family: "orchestration", parent_op_id: "wf", detail: { title: "Audit" } }),
      op({ op_id: "p1", op_type: "phase", family: "orchestration", parent_op_id: "wf", detail: { title: "Ship" } }),
    ]);
    const node = buildOpsLayout(ops).groups[0].roots[0];
    expect(phaseTitles(node)).toEqual(["Audit", "Ship"]);
  });
  test("a workflow with no phases yields an empty ribbon (honest-unknown)", () => {
    const ops = toMap([op({ op_id: "wf", op_type: "workflow", family: "orchestration" })]);
    const node = buildOpsLayout(ops).groups[0].roots[0];
    expect(phaseTitles(node)).toEqual([]);
  });
});
