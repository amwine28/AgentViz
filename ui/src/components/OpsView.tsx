import { useMemo } from "react";
import {
  buildOpsLayout, opSubtitle, phaseTitles, OP_GLYPH, FAMILY_LABEL,
  type OpsNode,
} from "../operations";
import type { OperationState } from "../types";

interface Props {
  operations: Map<string, OperationState>;
  onSelectNode: (id: string | null) => void;
}

const END_COLOR: Record<string, string> = {
  complete: "var(--c-done)",
  error: "var(--c-err)",
  stopped: "var(--c-paused)",
  expired: "var(--c-wait)",
};

function statusClass(op: OperationState): string {
  if (op.ended_at != null) return `ops-end-${op.end_status ?? "complete"}`;
  return `ops-live-${op.status}`;
}

/* recurrence sparkline: one notch per MEASURED tick. Zero ticks → honest empty,
   never a fabricated bar. */
function Sparkline({ node }: { node: OpsNode }) {
  if (node.tickCount === 0) {
    return <span className="ops-empty">no ticks recorded</span>;
  }
  const W = 90, H = 16, n = node.sparkline.length;
  const step = n > 1 ? W / (n - 1) : 0;
  const pts = node.sparkline.map((_, i) => `${(i * step).toFixed(1)},${(H - 3 - (i % 2) * 4).toFixed(1)}`);
  return (
    <span className="ops-spark" title={`${node.tickCount} ticks`}>
      <svg width={W} height={H} aria-hidden>
        <polyline points={pts.join(" ")} fill="none" stroke="var(--c-run)" strokeWidth={1.4} />
        {node.sparkline.map((_, i) => (
          <circle key={i} cx={i * step} cy={H - 3 - (i % 2) * 4} r={1.6} fill="var(--c-run)" />
        ))}
      </svg>
      <em className="ops-spark-n">×{node.tickCount}</em>
    </span>
  );
}

function PhaseRibbon({ node }: { node: OpsNode }) {
  const titles = phaseTitles(node);
  if (titles.length === 0) {
    return <span className="ops-empty">no phases parsed</span>;
  }
  return (
    <span className="ops-ribbon">
      {titles.map((t, i) => (
        <span key={i} className="ops-phase-pill" title={`phase ${i + 1}`}>{t}</span>
      ))}
    </span>
  );
}

function OpRow({ node, onSelectNode }: { node: OpsNode; onSelectNode: (id: string | null) => void }) {
  const { op } = node;
  const subtitle = opSubtitle(op);
  const isRecurrence = op.family === "recurrence";
  const isWorkflow = op.op_type === "workflow";
  const clickable = op.agent_id != null;

  return (
    <div className="ops-node">
      <div className={`ops-row ${statusClass(op)}`}>
        <span className="ops-glyph">{OP_GLYPH[op.op_type] ?? "◆"}</span>
        <button
          className="ops-label"
          disabled={!clickable}
          onClick={() => clickable && onSelectNode(op.agent_id)}
          title={clickable ? `owned by ${op.agent_id}` : "session-level operation"}
        >
          {op.label || op.op_type}
        </button>
        <span className="ops-type">{op.op_type}</span>
        {subtitle && <span className="ops-sub">{subtitle}</span>}

        {/* family-specific body — grounded only */}
        {isRecurrence && <Sparkline node={node} />}
        {isWorkflow && <PhaseRibbon node={node} />}

        <span className={`ops-status ${statusClass(op)}`}>
          {op.ended_at != null
            ? <em style={{ color: END_COLOR[op.end_status ?? "complete"] }}>{op.end_status}</em>
            : op.status}
        </span>
      </div>

      {/* nested children (workflow → phase → spawn fan-out, etc.) */}
      {node.children.length > 0 && (
        <div className="ops-children">
          {node.children.map((c) => (
            <OpRow key={c.op.op_id} node={c} onSelectNode={onSelectNode} />
          ))}
        </div>
      )}
    </div>
  );
}

export function OpsView({ operations, onSelectNode }: Props) {
  const layout = useMemo(() => buildOpsLayout(operations), [operations]);

  if (layout.groups.length === 0) {
    return (
      <div className="ops-view">
        <div className="ops-empty-stage">
          no operations yet — loops, workflows, schedules, skills and modes will surface here as agents run
        </div>
      </div>
    );
  }

  return (
    <div className="ops-view">
      {layout.groups.map((g) => (
        <div className="ops-group panel" key={g.family}>
          <div className="panel-title">
            <span>{FAMILY_LABEL[g.family]} — {g.roots.length}</span>
          </div>
          <div className="ops-group-body">
            {g.roots.map((node) => (
              <OpRow key={node.op.op_id} node={node} onSelectNode={onSelectNode} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
