import type { OperationState, OperationFamily } from "./types";

/** Pure layout for the OPS lens: an operation forest grouped by family.
 *
 * Top-level operations are grouped by their `family` (recurrence / orchestration
 * / command / mode / state); children nest under their parent (workflow → phase →
 * spawn). Recurrence ops expose their `ticks` as a sparkline series.
 *
 * Grounded-only: the sparkline is exactly the measured tick indices — an op with
 * zero recorded ticks yields an empty series (honest-unknown), never a faked bar.
 * No React; unit-testable in isolation. */

export interface OpsNode {
  op: OperationState;
  children: OpsNode[];
  sparkline: number[];   // one point per measured tick (the tick.n indices)
  tickCount: number;     // 0 => no ticks recorded (render honest-unknown, not a fake bar)
}

export interface OpsGroup {
  family: OperationFamily;
  roots: OpsNode[];
}

export interface OpsLayout {
  groups: OpsGroup[];
}

// Canonical family display order (matches the taxonomy table in the spec).
const FAMILY_ORDER: OperationFamily[] = [
  "recurrence", "orchestration", "command", "mode", "state",
];

// one glyph per operation kind — shared by the OPS lens, FLOW, and node badges.
export const OP_GLYPH: Record<string, string> = {
  loop: "◌", goal: "◎", schedule: "⏱", workflow: "▤", phase: "▸", spawn: "⎇",
  message: "✉", skill: "/", mcp: "⧉", plan_mode: "✎", worktree: "⌥", background: "▷",
  monitor: "👁", remote: "☁", todo: "☑", compact: "⊟", hook: "⚓",
};

// human label for a family group header (matches the spec taxonomy).
export const FAMILY_LABEL: Record<OperationFamily, string> = {
  recurrence: "Recurrence", orchestration: "Orchestration", command: "Commands",
  mode: "Modes", state: "State",
};

/** A grounded, one-line subtitle for an op from KNOWN detail keys only.
 * Returns "" when nothing is measured — the caller renders honest-unknown,
 * never a fabricated value. Pure + tested. */
export function opSubtitle(op: OperationState): string {
  const d = op.detail ?? {};
  const s = (k: string) => (typeof d[k] === "string" ? (d[k] as string) : null);
  const n = (k: string) => (typeof d[k] === "number" ? (d[k] as number) : null);
  switch (op.op_type) {
    case "loop": {
      const iv = n("interval_s");
      return iv != null ? `every ${iv}s` : "";
    }
    case "goal":
      return s("goal") ?? s("prompt") ?? "";
    case "schedule": {
      const parts = [s("cron"), s("next_fire") ? `next ${s("next_fire")}` : null].filter(Boolean);
      return parts.join(" · ");
    }
    case "workflow":
      return s("name") ?? s("description") ?? "";
    case "spawn":
      return s("agent_type") ?? s("description") ?? "";
    case "skill": {
      const parts = [s("skill"), s("args")].filter(Boolean);
      return parts.join(" ");
    }
    case "todo": {
      const total = n("total"); const done = n("completed");
      return total != null ? `${done ?? 0}/${total} done` : "";
    }
    case "mcp": {
      const parts = [s("server"), s("tool")].filter(Boolean);
      return parts.join(" · ");
    }
    default:
      return "";
  }
}

/** The parsed phase titles of a workflow, in declared order — for the phase
 * ribbon. Prefers the workflow's own `phase_titles` detail; falls back to its
 * child phase ops' titles. Empty array = honest-unknown (no ribbon). Pure. */
export function phaseTitles(node: OpsNode): string[] {
  const declared = node.op.detail?.phase_titles;
  if (Array.isArray(declared) && declared.every((t) => typeof t === "string")) {
    return declared as string[];
  }
  return node.children
    .filter((c) => c.op.op_type === "phase")
    .map((c) => {
      const title = c.op.detail?.title;
      return typeof title === "string" ? title : c.op.label;
    });
}

/** The badge glyph for a node that owns a LIVE (not-yet-ended) operation, or
 * null if it owns none. Picks the most salient live op by family priority
 * (recurrence > orchestration > command > mode > state), then most recent.
 * Grounded: only operations actually attributed to this agent that have not
 * ended count. Pure + tested. */
export function operationBadge(
  agentId: string,
  operations: Map<string, OperationState>,
): { glyph: string; op_type: string; label: string } | null {
  const FAM_PRIORITY: Record<string, number> = {
    recurrence: 5, orchestration: 4, command: 3, mode: 2, state: 1,
  };
  let best: OperationState | null = null;
  for (const op of operations.values()) {
    if (op.agent_id !== agentId) continue;
    if (op.ended_at != null) continue;            // only LIVE ops earn a badge
    if (
      best == null ||
      (FAM_PRIORITY[op.family] ?? 0) > (FAM_PRIORITY[best.family] ?? 0) ||
      ((FAM_PRIORITY[op.family] ?? 0) === (FAM_PRIORITY[best.family] ?? 0) && op.started_at > best.started_at)
    ) {
      best = op;
    }
  }
  if (!best) return null;
  return { glyph: OP_GLYPH[best.op_type] ?? "◆", op_type: best.op_type, label: best.label };
}

export function buildOpsLayout(operations: Map<string, OperationState>): OpsLayout {
  const all = [...operations.values()];

  const build = (op: OperationState): OpsNode => {
    const children = op.children
      .map((id) => operations.get(id))
      .filter((c): c is OperationState => c !== undefined)
      .sort((a, b) => a.started_at - b.started_at)
      .map(build);
    return {
      op,
      children,
      sparkline: op.ticks.map((t) => t.n),
      tickCount: op.ticks.length,
    };
  };

  // A root is any op without a parent OR whose declared parent is missing
  // (orphans are promoted so nothing is silently dropped).
  const isRoot = (op: OperationState): boolean =>
    op.parent_op_id == null || !operations.has(op.parent_op_id);

  const groups: OpsGroup[] = [];
  for (const family of FAMILY_ORDER) {
    const roots = all
      .filter((op) => op.family === family && isRoot(op))
      .sort((a, b) => a.started_at - b.started_at)
      .map(build);
    if (roots.length) groups.push({ family, roots });
  }
  return { groups };
}
