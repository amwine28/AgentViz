import { describe, test, expect } from "vitest";
import { assignCredit, buildCreditExport, RUNG1_DISCLAIMER } from "../src/credit";
import { play } from "./helpers";

// terse event builders
const spawn = (id: string, parent: string | null, ts = 1) =>
  ({ kind: "agent_spawn", agent_id: id, parent_id: parent, name: id, timestamp: ts });
const msg = (from: string, to: string, ts = 1) =>
  ({ kind: "agent_message", from_agent_id: from, to_agent_id: to, content: "x", timestamp: ts });
const done = (id: string, status = "ok", ts = 5) =>
  ({ kind: "agent_complete", agent_id: id, exit_status: status, summary: "", timestamp: ts });
const outcome = (o: Record<string, unknown>) =>
  ({ kind: "outcome", agent_id: null, channel: "reward", value: 1, scale: "binary",
     value_min: null, value_max: null, stage: "terminal", source: "test_suite",
     measured: true, detail: {}, run_id: null, ablated_agent_id: null,
     baseline_run_id: null, baseline_value: null, timestamp: 10, ...o });
// agent-scoped TERMINAL sink at agent `id`
const sinkAt = (id: string, o: Record<string, unknown> = {}) =>
  outcome({ agent_id: id, stage: "terminal", ...o });

const credit = (s: ReturnType<typeof play>) => assignCredit(s);
const byName = (rep: ReturnType<typeof assignCredit>, n: string) =>
  rep.contributors.find((c) => c.name === n);

describe("assignCredit — Rung 1 (provenance / reachability + dominators)", () => {
  test("marks reverse-reachable contributors and excludes dead branches", () => {
    // A spawns B,C,D,R; B->R and C->R message; D never reaches R (dead branch)
    const rep = credit(play([
      spawn("A", null), spawn("B", "A"), spawn("C", "A"), spawn("D", "A"), spawn("R", "A"),
      msg("B", "R"), msg("C", "R"), sinkAt("R"),
    ]));
    const names = rep.contributors.map((c) => c.name).sort();
    expect(names).toEqual(["A", "B", "C", "R"]);   // not D
    expect(rep.dead_branches).toEqual(["D"]);
    expect(byName(rep, "B")!.on_critical_path).toBe(true);
  });

  test("structural rows never carry a causal number (credit & ci null, method structural)", () => {
    const rep = credit(play([
      spawn("A", null), spawn("R", "A"), msg("A", "R"), sinkAt("R"),
    ]));
    expect(rep.method).toBe("structural");
    for (const c of rep.contributors) {
      expect(c.credit).toBeNull();
      expect(c.ci).toBeNull();
      expect(c.method).toBe("structural");
      expect(c.reason.length).toBeGreaterThan(0);   // every row cites a fact
    }
  });

  test("dominator bottleneck: a chain makes interior nodes bottlenecks", () => {
    // A -> B -> C -> R (single path); every interior node dominates R
    const rep = credit(play([
      spawn("A", null), spawn("B", "A"), spawn("C", "B"), spawn("R", "C"),
      msg("A", "B"), msg("B", "C"), msg("C", "R"), sinkAt("R"),
    ]));
    expect(byName(rep, "B")!.is_bottleneck).toBe(true);
    expect(byName(rep, "C")!.is_bottleneck).toBe(true);
  });

  test("fan-out node is NOT a bottleneck (parallel paths to the sink)", () => {
    // A -> B -> R and A -> C -> R : neither B nor C alone dominates R
    const rep = credit(play([
      spawn("A", null), spawn("B", "A"), spawn("C", "A"), spawn("R", "A"),
      msg("A", "B"), msg("A", "C"), msg("B", "R"), msg("C", "R"), sinkAt("R"),
    ]));
    expect(byName(rep, "B")!.is_bottleneck).toBe(false);
    expect(byName(rep, "C")!.is_bottleneck).toBe(false);
  });

  test("ghost-edge filter: a message to a non-existent agent is ignored, no crash", () => {
    const rep = credit(play([
      spawn("A", null), spawn("R", "A"), msg("A", "R"),
      msg("A", "ghost"),    // ghost has no agent_spawn -> must be filtered
      sinkAt("R"),
    ]));
    expect(rep.contributors.map((c) => c.name).sort()).toEqual(["A", "R"]);
    expect(rep.contributors.some((c) => c.name === "ghost")).toBe(false);
  });

  test("dangling outcome agent_id -> orphaned sink, no crash, nothing credited", () => {
    const rep = credit(play([
      spawn("A", null), spawn("B", "A"), msg("A", "B"),
      sinkAt("nonexistent"),
    ]));
    expect(rep.sink.resolved).toBe(false);
    expect(rep.contributors).toHaveLength(0);   // no sink -> nothing reaches it
  });

  test("feedback loop: a 2-cycle is grouped as in_feedback_loop and credited as a unit", () => {
    // lead<->worker cycle (spawn down, message up) converging to a sink
    const rep = credit(play([
      spawn("lead", null), spawn("worker", "lead"),
      msg("worker", "lead"),                 // worker->lead ; lead->worker is the spawn edge => cycle
      spawn("R", "lead"), msg("lead", "R"),
      sinkAt("R"),
    ]));
    const loopMembers = rep.feedback_loops.flat().sort();
    expect(loopMembers).toContain("lead");
    expect(loopMembers).toContain("worker");
    // a member of a non-trivial SCC is flagged
    const w = byName(rep, "worker");
    if (w) expect(w.in_feedback_loop).toBe(true);
  });

  test("run-level sink with no hint resolves to the root (basis assumed)", () => {
    const rep = credit(play([
      spawn("root", null), spawn("w", "root"), msg("w", "root"),
      outcome({ agent_id: null }),    // run-level, no result_agent_ids
    ]));
    expect(rep.sink.basis).toBe("assumed");
    expect(rep.sink.ids).toEqual(["root"]);
  });

  test("explicit result_agent_ids resolve the sink (basis measured)", () => {
    const rep = credit(play([
      spawn("root", null), spawn("w", "root"), msg("w", "root"),
      outcome({ agent_id: null, detail: { result_agent_ids: ["root"] } }),
    ]));
    expect(rep.sink.basis).toBe("measured");
    expect(rep.sink.ids).toEqual(["root"]);
  });

  test("source=llm_judge is flagged non-grounded", () => {
    const rep = credit(play([
      spawn("A", null), spawn("R", "A"), msg("A", "R"),
      sinkAt("R", { source: "llm_judge" }),
    ]));
    expect(rep.outcome!.grounded).toBe(false);
  });

  test("no outcome present -> report has null outcome and no contributors", () => {
    const rep = credit(play([spawn("A", null), spawn("B", "A"), msg("A", "B")]));
    expect(rep.outcome).toBeNull();
    expect(rep.contributors).toHaveLength(0);
  });
});

describe("buildCreditExport (NetworkX node-link with credit facts)", () => {
  test("merges per-node credit facts and attaches the full report under graph.graph.credit", () => {
    const exp = buildCreditExport(play([
      spawn("A", null), spawn("B", "A"), spawn("R", "A"), msg("B", "R"), sinkAt("R"),
    ]));
    expect(exp.directed).toBe(true);
    expect(exp.multigraph).toBe(false);
    const b = exp.nodes.find((n) => n.name === "B")!;
    expect(b.on_critical_path).toBe(true);
    expect("is_bottleneck" in b).toBe(true);
    expect("in_feedback_loop" in b).toBe(true);
    expect(exp.graph.credit.method).toBe("structural");
    // node-link integrity: every link endpoint resolves to a node id
    const idset = new Set(exp.nodes.map((n) => n.id));
    for (const l of exp.links) {
      expect(idset.has(l.source as string)).toBe(true);
      expect(idset.has(l.target as string)).toBe(true);
    }
  });

  test("Rung-1 disclaimer states the necessary-condition (not causal) framing", () => {
    expect(RUNG1_DISCLAIMER.toLowerCase()).toContain("necessary");
    expect(RUNG1_DISCLAIMER.toLowerCase()).toContain("counterfactual");
  });
});
