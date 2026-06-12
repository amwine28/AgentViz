import { useMemo } from "react";
import { buildWorkflowGraph } from "../graph";
import { auditWorkflow } from "../audit";
import type { AppState } from "../store";

interface Props {
  state: AppState;
}

const GRADE_COLOR: Record<string, string> = {
  A: "#6ef7a0", B: "#3fe0ff", C: "#ffb454", D: "#ffb454", F: "#ff5277",
};

export function GraphStats({ state }: Props) {
  const graph = useMemo(() => buildWorkflowGraph(state), [state]);
  const audit = useMemo(() => auditWorkflow(state), [state]);
  const m = graph.metrics;
  if (m.agent_count === 0) return null;

  const exportGraph = () => {
    // metrics + audit ride along under `graph`; NetworkX keeps them as
    // graph-level attributes via node_link_graph.
    const payload = {
      directed: graph.directed,
      multigraph: graph.multigraph,
      graph: { ...graph.graph, metrics: m, audit },
      nodes: graph.nodes,
      links: graph.links,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(state.sessionName || "agentviz-run").replace(/[^a-z0-9-]+/gi, "_")}.graph.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="graph-stats panel">
      <div className="panel-title">
        <span>◬ Graph stats</span>
        <button className="hud-btn stats-export" onClick={exportGraph} title="Download as NetworkX node-link JSON">
          ⇩ export
        </button>
      </div>
      <div className="stats-grid">
        <div className="stat"><span className="k">agents</span><span className="v">{m.agent_count}</span></div>
        <div className="stat"><span className="k">edges</span><span className="v">{m.edge_count}</span></div>
        <div className="stat"><span className="k">messages</span><span className="v">{m.message_total}</span></div>
        <div className="stat"><span className="k">density</span><span className="v">{m.density.toFixed(2)}</span></div>
        <div className="stat wide"><span className="k">hub</span><span className="v hub">{m.hub ?? "—"}</span></div>
        <div className="stat wide"><span className="k">bottleneck</span><span className="v bottleneck">{m.bottleneck ?? "—"}</span></div>
        {m.isolates.length > 0 && (
          <div className="stat wide"><span className="k">isolates</span><span className="v isolates">{m.isolates.join(", ")}</span></div>
        )}
      </div>

      <div className="panel-title audit-title">
        <span>◍ Efficiency audit</span>
        <span className="audit-grade" style={{ color: GRADE_COLOR[audit.grade] }}>
          {audit.score} · {audit.grade}
        </span>
      </div>
      {audit.tokens_total > 0 && (
        <div className="stats-grid">
          <div className="stat"><span className="k">tokens</span><span className="v">{audit.tokens_total.toLocaleString()}</span></div>
          <div className="stat"><span className="k">cost</span><span className="v">${audit.cost_total.toFixed(3)}</span></div>
        </div>
      )}
      {audit.findings.length === 0 ? (
        <div className="audit-clean">no inefficiencies detected</div>
      ) : (
        <div className="audit-findings">
          {audit.findings.map((f) => (
            <div key={f.rule} className="audit-finding">
              <span className="penalty">−{f.penalty}</span>
              <span className="reason" title={f.agents.join(", ")}>{f.reason}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
