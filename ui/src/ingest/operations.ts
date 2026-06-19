import type { AgentVizEvent, OperationKind } from "../types";
import { FAMILY_OF } from "../types";
import type { CCSession, CCLine, CCBlock } from "./claudeCode";

/** Claude Code transcript → operation events (operation_start/tick/end).
 *
 * Pure + deterministic. Recognizes the agentic/workflow operations the harness
 * surfaces as tool_use blocks and lifts them into the operation vocabulary
 * (§4 of docs/superpowers/specs/2026-06-19-agentic-operations-design.md). The
 * existing leaf-tool / spawn-edge translation in claudeCode.ts is untouched; this
 * is a purely additive overlay that claudeCode.ts merges in.
 *
 * Grounded-only: every operation traces to a real tool_use fact. Where progress
 * is not measured (no ticks), the op simply has no ticks — never a faked beat.
 *
 * The self-paced loop sentinel used to distinguish goal from loop. */
const AUTONOMOUS_SENTINEL = "<<autonomous-loop-dynamic>>";

interface RegistryEntry {
  op_type: OperationKind;
  extractDetail: (input: Record<string, unknown>) => Record<string, unknown>;
}

const asStr = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

/** tool name → operation mapping. The op_type's family comes from FAMILY_OF,
 * the single source of truth (mirrors events.py). */
const REGISTRY: Record<string, RegistryEntry> = {
  // recurrence
  ScheduleWakeup: {
    // loop (fixed delay) vs goal (self-paced sentinel) is resolved at emit time;
    // op_type here is the default; opTypeFor() overrides for the sentinel.
    op_type: "loop",
    extractDetail: (i) => {
      const delay = i.delaySeconds;
      const d: Record<string, unknown> = { prompt: asStr(i.prompt), reason: asStr(i.reason) };
      if (typeof delay === "number") d.interval_s = delay;
      return d;
    },
  },
  // Real CronCreate input is {cron, prompt, durable, recurring} — the human label is
  // the prompt, NOT a `name` (the harness never sends one).
  CronCreate: { op_type: "schedule", extractDetail: (i) => ({
    cron: asStr(i.cron ?? i.schedule), prompt: asStr(i.prompt),
    recurring: i.recurring === true, durable: i.durable === true }) },
  CronList:   { op_type: "schedule", extractDetail: () => ({}) },
  CronDelete: { op_type: "schedule", extractDetail: (i) => ({ cron: asStr(i.cron ?? i.id), prompt: asStr(i.prompt) }) },

  // orchestration
  Workflow: { op_type: "workflow", extractDetail: (i) => parseWorkflowMeta(asStr(i.script)) },
  Agent:    { op_type: "spawn", extractDetail: spawnDetail },
  Task:     { op_type: "spawn", extractDetail: spawnDetail },
  SendMessage: { op_type: "message", extractDetail: (i) => ({ to: asStr(i.to), content: asStr(i.content) }) },

  // command
  Skill: { op_type: "skill", extractDetail: (i) => ({ skill: asStr(i.skill), args: asStr(i.args) }) },

  // mode
  EnterPlanMode: { op_type: "plan_mode", extractDetail: () => ({ phase: "enter" }) },
  ExitPlanMode:  { op_type: "plan_mode", extractDetail: () => ({ phase: "exit" }) },
  EnterWorktree: { op_type: "worktree", extractDetail: (i) => ({ phase: "enter", path: asStr(i.path) }) },
  ExitWorktree:  { op_type: "worktree", extractDetail: () => ({ phase: "exit" }) },
  Monitor:       { op_type: "monitor", extractDetail: (i) => ({ command: asStr(i.command ?? i.until) }) },
  RemoteTrigger: { op_type: "remote", extractDetail: (i) => ({ target: asStr(i.target) }) },

  // state — detail is computed via the per-agent accumulator in the loop, not here.
  TaskCreate: { op_type: "todo", extractDetail: () => ({}) },
  TaskUpdate: { op_type: "todo", extractDetail: () => ({}) },
};

function spawnDetail(i: Record<string, unknown>): Record<string, unknown> {
  const d: Record<string, unknown> = {
    agent_type: asStr(i.subagent_type ?? i.agentType ?? i.agent_type),
    description: asStr(i.description),
  };
  if (i.run_in_background === true) d.background = true;
  return d;
}

/** Per-agent todo-list accumulator. The real harness models todos as a stream of
 * single-task ops: TaskCreate {subject,description,activeForm} (one creation, no id)
 * and TaskUpdate {taskId,status} (one status change). We accumulate them into ONE
 * evolving todo op per agent: total = creations seen, completed/in_progress derived
 * from the latest status per taskId. A {tasks:[...]} array (the SDK live snapshot
 * shape) is honored as a self-contained fallback. */
interface TodoAccum { created: number; byId: Map<string, string>; }

function applyTodo(st: TodoAccum, toolName: string, i: Record<string, unknown>): Record<string, unknown> {
  const arr = Array.isArray(i.tasks) ? i.tasks : Array.isArray(i.todos) ? i.todos : null;
  if (arr) {                                            // SDK live snapshot fallback
    const total = arr.length;
    const completed = arr.filter((t) => (t as { status?: string })?.status === "completed").length;
    const in_progress = arr.filter((t) => (t as { status?: string })?.status === "in_progress").length;
    return { total, completed, in_progress };
  }
  if (toolName === "TaskCreate") st.created += 1;
  else if (toolName === "TaskUpdate") {
    const id = asStr(i.taskId);
    if (id) st.byId.set(id, asStr(i.status));
  }
  let completed = 0, in_progress = 0;
  for (const s of st.byId.values()) { if (s === "completed") completed++; else if (s === "in_progress") in_progress++; }
  return { total: st.created, completed, in_progress };
}

/** mcp__<server>__<tool> → grounded {server, tool}. */
function mcpDetail(name: string): Record<string, unknown> {
  const parts = name.split("__");
  return { server: parts[1] ?? "", tool: parts.slice(2).join("__") };
}

/** loop (recurring wakeup) vs goal (self-paced/autonomous). The
 * <<autonomous-loop-dynamic>> sentinel arrives in the PROMPT field (delaySeconds is
 * always a clamped number), so discriminate on the prompt, not the delay. */
function opTypeFor(toolName: string, input: Record<string, unknown>, fallback: OperationKind): OperationKind {
  if (toolName === "ScheduleWakeup") {
    return asStr(input.prompt).includes(AUTONOMOUS_SENTINEL) ? "goal" : "loop";
  }
  // run_in_background:true on a Bash/Agent surfaces a background mode op overlay.
  if (toolName === "Bash" && input.run_in_background === true) return "background";
  return fallback;
}

/** Balanced-brace scan to pull the `meta = { ... }` object literal out of a
 * Workflow `input.script`, then read its name/description/phases. Tolerant:
 * any parse failure yields a workflow op with no phases (honest-unknown). */
function parseWorkflowMeta(script: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!script) return out;
  const metaIdx = script.search(/\bmeta\b\s*=/);
  if (metaIdx === -1) return out;
  const braceStart = script.indexOf("{", metaIdx);
  if (braceStart === -1) return out;
  // balanced-brace scan from braceStart
  let depth = 0, end = -1;
  for (let i = braceStart; i < script.length; i++) {
    const c = script[i];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) return out;
  const body = script.slice(braceStart, end + 1);

  const name = body.match(/name\s*:\s*['"`]([^'"`]*)['"`]/);
  if (name) out.name = name[1];
  const desc = body.match(/description\s*:\s*['"`]([^'"`]*)['"`]/);
  if (desc) out.description = desc[1];

  // phases: [ { title: '...', detail: '...' }, ... ] — pull each title in order.
  const phasesIdx = body.search(/\bphases\b\s*:/);
  const phase_titles: string[] = [];
  if (phasesIdx !== -1) {
    const arrStart = body.indexOf("[", phasesIdx);
    if (arrStart !== -1) {
      let d = 0, arrEnd = -1;
      for (let i = arrStart; i < body.length; i++) {
        const c = body[i];
        if (c === "[") d++;
        else if (c === "]") { d--; if (d === 0) { arrEnd = i; break; } }
      }
      if (arrEnd !== -1) {
        const arr = body.slice(arrStart, arrEnd + 1);
        const re = /title\s*:\s*['"`]([^'"`]*)['"`]/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(arr)) !== null) phase_titles.push(m[1]);
      }
    }
  }
  out.phase_titles = phase_titles;
  return out;
}

const toSec = (line: CCLine | undefined): number =>
  line?.timestamp ? Date.parse(line.timestamp) / 1000 : 0;

interface UsageBlock { line: CCLine; block: CCBlock; agentId: string; }

/** Collapse key for recurrence ops: same op_type + same target prompt = one op.
 * Repeated ScheduleWakeup / cron fires targeting the same prompt fold into one
 * operation with operation_ticks (one per subsequent fire). */
function collapseKey(opType: OperationKind, detail: Record<string, unknown>, agentKey: string): string | null {
  if (opType === "loop" || opType === "goal") return `${opType}:${asStr(detail.prompt)}`;
  if (opType === "schedule") {
    const cron = asStr(detail.cron);
    if (!cron) return null;                                  // CronList / no-cron → never merge
    // Distinct routines can share a cron expression but differ by prompt — keep them distinct.
    return `schedule:${cron}:${asStr(detail.prompt)}`;
  }
  if (opType === "todo") return `todo:${agentKey}`;          // one evolving todo list per agent
  return null;
}

export function operationsFromTools(session: CCSession): AgentVizEvent[] {
  const out: AgentVizEvent[] = [];
  const seqCounter = new Map<string, number>();
  const push = (e: Record<string, unknown>) => {
    const key = (e.agent_id as string | null | undefined) ?? "_session";
    const n = seqCounter.get(key) ?? 0;
    e.seq = n;
    seqCounter.set(key, n + 1);
    out.push(e as unknown as AgentVizEvent);
  };

  // gather every recognized tool_use, in transcript order, with its owning agent.
  const uses: UsageBlock[] = [];
  const collect = (agentId: string, lines: CCLine[]) => {
    const seen = new Set<string>();   // streamed lines repeat tool_use blocks
    for (const line of lines) {
      if (line.type !== "assistant" || !Array.isArray(line.message?.content)) continue;
      for (const b of line.message!.content!) {
        if (b.type !== "tool_use" || !b.id) continue;
        if (seen.has(b.id)) continue;
        seen.add(b.id);
        const isOp = b.name && (b.name in REGISTRY || b.name.startsWith("mcp__") ||
          (b.name === "Bash" && (b.input as Record<string, unknown> | undefined)?.run_in_background === true));
        if (isOp) uses.push({ line, block: b, agentId });
      }
    }
  };
  collect(session.sessionId, session.lines);
  for (const sub of session.subagents) collect(sub.agentId, sub.lines);

  // tool_use_id → end timestamp (first matching tool_result, any agent)
  const resultTs = new Map<string, { ts: number; is_error: boolean }>();
  const collectResults = (lines: CCLine[]) => {
    for (const line of lines) {
      if (line.type !== "user" || !Array.isArray(line.message?.content)) continue;
      for (const b of line.message!.content!) {
        if (b.type === "tool_result" && b.tool_use_id && !resultTs.has(b.tool_use_id)) {
          resultTs.set(b.tool_use_id, { ts: toSec(line), is_error: b.is_error === true });
        }
      }
    }
  };
  collectResults(session.lines);
  for (const sub of session.subagents) collectResults(sub.lines);

  // op_id assigned per collapse-group (or per tool_use for non-collapsing ops).
  // lastFireId tracks the tool_use_id of the most recent fire (for end correlation).
  const collapsed = new Map<string, { op_id: string; n: number; lastFireId: string }>();
  const todoAccum = new Map<string, TodoAccum>();   // per-agent evolving todo list

  for (const { line, block, agentId } of uses) {
    const toolName = block.name!;
    const input = (block.input ?? {}) as Record<string, unknown>;
    const reg = REGISTRY[toolName];
    // Fallthrough for un-registered op tools: an mcp__<server>__<tool> call is a
    // command-family op; a backgrounded Bash is a mode op.
    const base: RegistryEntry = reg ??
      (toolName.startsWith("mcp__")
        ? { op_type: "mcp", extractDetail: () => mcpDetail(toolName) }
        : { op_type: "background", extractDetail: () => ({}) });
    const op_type = opTypeFor(toolName, input, base.op_type);
    const agentScoped = agentId === session.sessionId ? null : agentId;

    // todo detail accumulates per agent across the TaskCreate/TaskUpdate stream.
    let detail: Record<string, unknown>;
    if (op_type === "todo") {
      let st = todoAccum.get(agentId);
      if (!st) { st = { created: 0, byId: new Map() }; todoAccum.set(agentId, st); }
      detail = applyTodo(st, toolName, input);
    } else {
      detail = base.extractDetail(input);
    }
    const family = FAMILY_OF[op_type];
    const ts = toSec(line);

    const key = collapseKey(op_type, detail, agentId);
    if (key && collapsed.has(key)) {
      // a repeat fire of an already-open collapsing op → operation_tick
      const g = collapsed.get(key)!;
      g.n += 1;
      g.lastFireId = block.id!;
      push({ kind: "operation_tick", op_id: g.op_id, n: g.n, label: opLabel(op_type, detail),
             status: family === "recurrence" ? "recurring" : "running",
             detail, timestamp: ts, agent_id: agentScoped });
      continue;
    }

    const op_id = block.id!;
    if (key) collapsed.set(key, { op_id, n: 0, lastFireId: op_id });

    const status = family === "recurrence" ? "recurring" : "running";
    push({ kind: "operation_start", op_id, op_type, family,
           parent_op_id: null, agent_id: agentScoped,
           label: opLabel(op_type, detail), status, detail, timestamp: ts });

    // Workflow → emit a child phase op per parsed phase title.
    if (op_type === "workflow") {
      const titles = (detail.phase_titles as string[]) ?? [];
      titles.forEach((title, index) => {
        push({ kind: "operation_start", op_id: `${op_id}:phase:${index}`, op_type: "phase",
               family: "orchestration", parent_op_id: op_id, agent_id: agentScoped,
               label: title, status: "running", detail: { index, title }, timestamp: ts });
      });
    }

    // operation_end correlated by tool_use_id (recurrence ops end after their ticks).
    const res = resultTs.get(op_id);
    if (res && !key) {
      const duration_ms = res.ts > ts ? Math.round((res.ts - ts) * 1000) : 0;
      push({ kind: "operation_end", op_id, status: res.is_error ? "error" : "complete",
             summary: "", detail: { duration_ms }, timestamp: res.ts });
    }
  }

  // close out collapsed recurrence ops at their LAST fire's result (if any).
  for (const [, g] of collapsed) {
    const res = resultTs.get(g.lastFireId);
    if (res) {
      push({ kind: "operation_end", op_id: g.op_id, status: res.is_error ? "error" : "complete",
             summary: "", detail: { fires: g.n + 1 }, timestamp: res.ts });
    }
  }

  return out;
}

function opLabel(op_type: OperationKind, detail: Record<string, unknown>): string {
  switch (op_type) {
    case "workflow": return asStr(detail.name) || "workflow";
    case "skill": return asStr(detail.skill) || "skill";
    case "spawn": return asStr(detail.description) || "spawn";
    case "loop":
    case "goal": return asStr(detail.prompt) || op_type;
    case "schedule": return asStr(detail.prompt) || asStr(detail.cron) || "schedule";
    case "mcp": return asStr(detail.tool) || "mcp";
    case "todo": return "todos";
    default: return op_type;
  }
}
