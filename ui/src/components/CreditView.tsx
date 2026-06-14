import { useMemo } from "react";
import { assignCredit, buildCreditExport, RUNG1_DISCLAIMER } from "../credit";
import type { AppState } from "../store";

interface Props {
  state: AppState;
  onSelectNode: (id: string | null) => void;
}

export function CreditView({ state, onSelectNode }: Props) {
  const report = useMemo(() => assignCredit(state), [state]);

  const exportCredit = () => {
    const payload = buildCreditExport(state);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(state.sessionName || "agentviz-run").replace(/[^a-z0-9-]+/gi, "_")}.credit.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const o = report.outcome;
  const sinkNames = report.sink.ids.map((id) => state.agents[id]?.name ?? id);

  return (
    <div className="credit-view">
      <div className="credit-head panel">
        <div className="panel-title">
          <span>◍ Credit — Rung 1 · structural</span>
          <button className="hud-btn stats-export" onClick={exportCredit} title="Download credit-annotated NetworkX node-link JSON">⇩ export</button>
        </div>

        {o ? (
          <div className="credit-outcome">
            <span className="k">outcome</span>
            <span className="v">[{o.channel}] = {o.value}</span>
            <span className="credit-tag">{o.scale}</span>
            <span className="credit-tag">{o.source}</span>
            {o.grounded
              ? <span className="credit-tag ok">grounded</span>
              : <span className="credit-tag bad">⚠ non-grounded ({o.source})</span>}
            {o.measured ? null : <span className="credit-tag warn">assumed</span>}
          </div>
        ) : (
          <div className="credit-outcome"><span className="muted">no outcome reported — call <code>session.report_outcome(...)</code> or <code>agent.report_outcome(...)</code></span></div>
        )}

        <div className="credit-disclaimer">{RUNG1_DISCLAIMER}</div>

        {o && (
          <div className="credit-sink">
            sink: <b>{sinkNames.length ? sinkNames.join(", ") : "— unresolved —"}</b>
            <span className={`credit-tag ${report.sink.basis === "measured" ? "ok" : "warn"}`}>{report.sink.basis}</span>
            {!report.sink.resolved && <span className="credit-tag bad">orphaned outcome — agent not found</span>}
          </div>
        )}

        {report.sink.converging && (
          <div className="credit-warn">
            ⚠ This workflow's results converge at the orchestrator, so nearly every agent is
            reverse-reachable. Reachability is near-useless here — run counterfactual replay (Rung 2)
            for causal credit. Bottleneck and dead-branch facts remain meaningful.
          </div>
        )}
      </div>

      <div className="credit-table panel">
        <div className="panel-title"><span>Contributors — {report.contributors.length}</span></div>
        {report.contributors.length === 0 ? (
          <div className="muted credit-empty">no agent output reaches the resolved outcome</div>
        ) : (
          <div className="scroll-area">
            <div className="ctab-head">
              <span className="ctab-name">agent</span>
              <span className="ctab-badges">facts</span>
              <span className="ctab-reason">why (a verifiable fact)</span>
            </div>
            {report.contributors.map((c) => (
              <button key={c.agent_id} className="ctab-row" onClick={() => onSelectNode(c.agent_id)}>
                <span className="ctab-name">{c.name}</span>
                <span className="ctab-badges">
                  {c.on_critical_path && <span className="badge path">reaches result</span>}
                  {c.is_bottleneck && <span className="badge bottleneck">bottleneck</span>}
                  {c.in_feedback_loop && <span className="badge loop">feedback loop</span>}
                  <span className={`badge basis-${c.basis}`}>{c.basis}</span>
                  {/* Rung 1 deliberately shows NO causal number — credit is null */}
                  <span className="badge nocredit">credit n/a</span>
                </span>
                <span className="ctab-reason">{c.reason}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {report.dead_branches.length > 0 && (
        <div className="credit-group panel dead">
          <div className="panel-title"><span>Dead branches — {report.dead_branches.length}</span></div>
          <div className="credit-chips">
            {report.dead_branches.map((n) => <span key={n} className="dead-chip">{n}</span>)}
          </div>
          <div className="muted credit-note">acted, but no output path reached the outcome (reachability fact — distinct from the audit's activity-based dead-weight)</div>
        </div>
      )}

      {report.feedback_loops.length > 0 && (
        <div className="credit-group panel loop">
          <div className="panel-title"><span>Feedback loops — {report.feedback_loops.length}</span></div>
          {report.feedback_loops.map((grp, i) => (
            <div key={i} className="credit-chips">
              {grp.map((n) => <span key={n} className="loop-chip">{n}</span>)}
              <span className="muted credit-note">credit not separable structurally</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
