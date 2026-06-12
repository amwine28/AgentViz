import { useMemo } from "react";
import { buildWorkflowGraph } from "../graph";
import type { AppState } from "../store";

interface Props {
  state: AppState;
}

export function GraphStats({ state }: Props) {
  const graph = useMemo(() => buildWorkflowGraph(state), [state]);
  const m = graph.metrics;
  if (m.agent_count === 0) return null;

  const exportGraph = () => {
    // strip UI-only metrics? no — keep them; NetworkX ignores unknown top-level
    // keys except graph/nodes/links, and metrics ride along under `graph`.
    const payload = {
      directed: graph.directed,
      multigraph: graph.multigraph,
      graph: { ...graph.graph, metrics: m },
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
    </div>
  );
}
