import { describe, test, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { operationsFromTools } from "../src/ingest/operations";
import { claudeCodeToEvents, type CCSession } from "../src/ingest/claudeCode";
import type { OperationStartEvent, OperationTickEvent, OperationEndEvent } from "../src/types";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(resolve(here, "../../examples/fixtures/claude_code_operations.json"), "utf8")
) as CCSession;

const ops = operationsFromTools(fixture);
const starts = ops.filter((e) => e.kind === "operation_start") as OperationStartEvent[];
const ticks = ops.filter((e) => e.kind === "operation_tick") as OperationTickEvent[];
const ends = ops.filter((e) => e.kind === "operation_end") as OperationEndEvent[];
const startByType = (t: string) => starts.filter((s) => s.op_type === t);

describe("operationsFromTools — real Claude Code transcript → operation events", () => {
  test("a Workflow tool call becomes a workflow operation with parsed name + description", () => {
    const wf = startByType("workflow");
    expect(wf).toHaveLength(1);
    expect(wf[0].family).toBe("orchestration");
    expect(wf[0].detail.name).toBe("procurement-hub-audit");
    expect(typeof wf[0].detail.description).toBe("string");
  });

  test("workflow phases are parsed from the meta literal and emitted as child phase ops", () => {
    const wf = startByType("workflow")[0];
    const phases = startByType("phase");
    expect(phases).toHaveLength(3);                                  // Audit, Consolidate, Synthesize
    expect(phases.every((p) => p.parent_op_id === wf.op_id)).toBe(true);
    expect(phases.map((p) => p.detail.title)).toEqual(["Audit", "Consolidate", "Synthesize"]);
    expect((wf.detail.phase_titles as string[])).toEqual(["Audit", "Consolidate", "Synthesize"]);
  });

  test("Skill tool call becomes a skill operation carrying skill name + args", () => {
    const sk = startByType("skill");
    expect(sk).toHaveLength(1);
    expect(sk[0].family).toBe("command");
    expect(sk[0].detail.skill).toBe("update-config");
    expect(sk[0].detail.args).toContain("permission");
  });

  test("Agent/Task call adds a spawn operation overlay (the spawn edge stays in claudeCode.ts)", () => {
    const sp = startByType("spawn");
    expect(sp).toHaveLength(1);
    expect(sp[0].family).toBe("orchestration");
    expect(sp[0].detail.agent_type).toBe("Explore");
  });

  test("run_in_background:true on an Agent is recorded in the spawn op detail", () => {
    const sp = startByType("spawn")[0];
    expect(sp.detail.background).toBe(true);
  });

  test("repeated ScheduleWakeup fires on the same prompt collapse into ONE loop op with ticks", () => {
    const loops = startByType("loop");
    expect(loops).toHaveLength(1);                                   // 3 fires -> 1 op
    expect(loops[0].detail.interval_s).toBe(300);
    const loopTicks = ticks.filter((t) => t.op_id === loops[0].op_id);
    expect(loopTicks.length).toBe(2);                               // first fire = start, next 2 = ticks
    expect(loopTicks.map((t) => t.n)).toEqual([1, 2]);
  });

  test("a self-paced ScheduleWakeup (autonomous sentinel in the PROMPT) becomes a goal op, not a loop", () => {
    const goals = startByType("goal");
    expect(goals).toHaveLength(1);
    expect(goals[0].family).toBe("recurrence");
    // the sentinel rides in prompt (delaySeconds is always a number); reason carries intent
    expect(goals[0].detail.prompt).toContain("autonomous-loop-dynamic");
    expect(goals[0].detail.reason).toContain("refining");
  });

  test("two CronCreate routines sharing a cron expression but differing by prompt stay DISTINCT", () => {
    // real shape {cron,prompt,durable,recurring}; both '3 7 * * *' but different prompts
    const sched = startByType("schedule");
    expect(sched).toHaveLength(2);                                   // NOT merged into one
    expect(sched.every((s) => s.detail.cron === "3 7 * * *")).toBe(true);
    const prompts = sched.map((s) => s.detail.prompt).sort();
    expect(prompts[0]).not.toBe(prompts[1]);
    // no fabricated `name`; grounded label is the prompt
    expect(sched.every((s) => typeof s.detail.prompt === "string" && (s.detail.prompt as string).length > 0)).toBe(true);
  });

  test("an mcp__<server>__<tool> call becomes an mcp (command) op with parsed server + tool", () => {
    const mcp = startByType("mcp");
    expect(mcp).toHaveLength(1);
    expect(mcp[0].family).toBe("command");
    expect(mcp[0].detail.server).toBe("claude_ai_Gmail");
    expect(mcp[0].detail.tool).toBe("create_draft");
  });

  test("the real TaskCreate/TaskUpdate stream accumulates into ONE evolving todo op", () => {
    const todos = startByType("todo");
    expect(todos).toHaveLength(1);                                   // 2 creates + 2 updates -> 1 op
    expect(todos[0].family).toBe("state");
    // start detail: first TaskCreate => total 1
    expect(todos[0].detail.total).toBe(1);
    const todoTicks = ticks.filter((t) => t.op_id === todos[0].op_id);
    expect(todoTicks.length).toBe(3);                               // create#2 + 2 updates
    // final tick reflects the accumulated, grounded state: 2 created, 1 completed
    const last = todoTicks[todoTicks.length - 1];
    expect(last.detail.total).toBe(2);
    expect(last.detail.completed).toBe(1);
    expect(last.detail.in_progress).toBe(0);
  });

  test("operation_end correlates by tool_use_id and carries a duration", () => {
    const wf = startByType("workflow")[0];
    const end = ends.find((e) => e.op_id === wf.op_id)!;
    expect(end).toBeDefined();
    expect(end.status).toBe("complete");
    expect(typeof end.detail.duration_ms).toBe("number");
    expect(end.detail.duration_ms as number).toBeGreaterThan(0);
  });

  test("operation events carry monotonic per-key seq keyed on agent_id ?? _session", () => {
    const byKey = new Map<string, number[]>();
    for (const e of ops) {
      const k = (e as { agent_id?: string | null }).agent_id ?? "_session";
      if (typeof e.seq === "number") (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(e.seq);
    }
    for (const seqs of byKey.values()) {
      expect(seqs).toEqual(seqs.map((_, i) => i));
    }
  });
});

describe("claudeCodeToEvents — operations merged in additively", () => {
  const events = claudeCodeToEvents(fixture);
  const byKind = (k: string) => events.filter((e) => e.kind === k);

  test("operation events appear alongside the existing event vocabulary", () => {
    expect(byKind("operation_start").length).toBeGreaterThan(0);
    expect(byKind("operation_tick").length).toBeGreaterThan(0);
    expect(byKind("operation_end").length).toBeGreaterThan(0);
  });

  test("the existing spawn edge for the Agent call is preserved (agent_spawn still emitted)", () => {
    const spawns = byKind("agent_spawn") as Array<{ agent_id: string }>;
    expect(spawns.some((s) => s.agent_id === "agent-ux")).toBe(true);
  });

  test("Workflow/Agent are NOT leaf tool calls but the sub-agent's Read is", () => {
    const tools = byKind("tool_call_pending") as Array<{ name: string }>;
    expect(tools.some((t) => t.name === "Workflow")).toBe(false);
    expect(tools.some((t) => t.name === "Agent")).toBe(false);
    expect(tools.some((t) => t.name === "Read")).toBe(true);
  });
});
