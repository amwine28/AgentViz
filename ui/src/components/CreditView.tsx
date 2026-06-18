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
  const causalReports = Object.values(state.creditReports);
  const methodLabel: Record<string, string> = {
    counterfactual: "Rung 2 · counterfactual", shapley: "Rung 3 · Shapley", densified: "Rung 4 · densified",
  };

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

      {state.recommendations.length > 0 && (
        <div className="credit-table panel recs">
          <div className="panel-title">
            <span>▸ Recommendations — grounded, measured{state.recommendationsChannel ? ` · [${state.recommendationsChannel}]` : ""}</span>
          </div>
          <div className="scroll-area">
            {state.recommendations.map((r, i) => (
              <div className={`rec-row sev-${r.severity}`} key={i}>
                <div className="rec-head">
                  <span className={`badge rec-sev sev-${r.severity}`}>{r.severity}</span>
                  <span className="rec-rule">{r.rule}</span>
                  <span className="rec-agents">{r.agents.join(", ")}</span>
                  {r.savings_usd ? <span className="rec-savings">~${r.savings_usd.toFixed(4)}/run</span> : null}
                </div>
                <div className="rec-action">{r.action}</div>
                <div className="rec-why muted">why: {r.rationale}</div>
              </div>
            ))}
          </div>
          <div className="muted credit-note">every recommendation traces to a measured fact — a healthy node yields none, and each says "review", not "delete"</div>
        </div>
      )}

      {causalReports.map((rep) => {
        const maxAbs = Math.max(1e-9, ...rep.agents.map((a) => Math.abs(a.credit)));
        return (
          <div className="credit-table panel causal" key={rep.method}>
            <div className="panel-title"><span>◎ Causal credit — {methodLabel[rep.method] ?? rep.method} · [{rep.channel}]</span></div>
            <div className="scroll-area">
              <div className="cftab-head">
                <span>agent</span><span>credit</span><span>95% CI</span><span>state</span>
              </div>
              {[...rep.agents].sort((a, b) => b.credit - a.credit).map((a) => (
                <div className="cftab-row" key={a.agent}>
                  <span className="ctab-name">{a.agent}</span>
                  <span className="cf-credit">
                    <span className="cf-bar" style={{
                      width: `${Math.min(100, Math.abs(a.credit) / maxAbs * 100)}%`,
                      background: a.credit >= 0 ? "var(--c-run)" : "var(--c-err)",
                    }} />
                    <span className="cf-num">{a.credit >= 0 ? "+" : ""}{a.credit.toFixed(3)}</span>
                  </span>
                  <span className="cf-ci">{a.ci ? `[${a.ci[0].toFixed(3)}, ${a.ci[1].toFixed(3)}]` : "—"}</span>
                  <span className={`badge cstate-${a.credit_state ?? "none"}`}>{a.credit_state ?? a.basis}</span>
                </div>
              ))}
            </div>
            <div className="muted credit-note">measured by re-run / axiomatic decomposition — confident ~0 effects shown as such, never hidden</div>
          </div>
        );
      })}

      <div className="credit-table panel">
        <div className="panel-title"><span>Contributors (Rung 1 · structural) — {report.contributors.length}</span></div>
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
