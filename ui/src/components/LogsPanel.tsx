import { useEffect, useState, useCallback } from "react";

// A run as summarized by the relay's /runs endpoint (relay/src/runs.ts RunSummary).
export interface RunSummary {
  run_id: string;
  name: string;
  events: number;
  mtime: number;
  agentCount: number;
  outcome: { value: number; measured: boolean } | null;
  finished: boolean;
  source: string | null;
  baselineRunId: string | null;
}

// Persistent, dockable "Logs" panel on the LEFT edge: every finished workflow the
// relay recorded shows here; click one to replay it into its own tab. Re-runs
// (carrying baselineRunId) nest under their base run. Mirrors AnalyticsPanel's
// rail-when-minimized / panel-when-open shape.
export function LogsPanel({
  port,
  open,
  onSetOpen,
  onLoad,
  refreshKey = 0,
}: {
  port: number;
  open: boolean;
  onSetOpen: (v: boolean) => void;
  onLoad: (events: object[]) => void; // replay a run's events into the store
  refreshKey?: number;                 // bump to force a refetch (e.g. on finish)
}) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(() => {
    fetch(`http://localhost:${port}/runs`)
      .then((r) => r.json())
      .then((rs: RunSummary[]) => { setRuns(rs); setErr(null); })
      .catch(() => setErr("can't reach the relay"));
  }, [port]);

  useEffect(() => { refresh(); }, [refresh, refreshKey]);
  // light poll while open so a just-finished run appears without a manual refresh
  useEffect(() => {
    if (!open) return;
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [open, refresh]);

  const load = (id: string) => {
    fetch(`http://localhost:${port}/runs/${id}`)
      .then((r) => r.json())
      .then((events: object[]) => onLoad(events))
      .catch(() => setErr("could not load that run"));
  };

  if (!open) {
    return (
      <button className="logs-rail" onClick={() => onSetOpen(true)} title="Recorded runs" aria-label="Open logs">
        <span className="logs-rail-label">LOGS</span>
      </button>
    );
  }

  // group re-runs under their base run (baselineRunId → parent run_id)
  const byId = new Map(runs.map((r) => [r.run_id, r]));
  const childrenOf = new Map<string, RunSummary[]>();
  const bases: RunSummary[] = [];
  for (const r of runs) {
    if (r.baselineRunId && byId.has(r.baselineRunId)) {
      const arr = childrenOf.get(r.baselineRunId) ?? [];
      arr.push(r);
      childrenOf.set(r.baselineRunId, arr);
    } else {
      bases.push(r);
    }
  }

  const row = (r: RunSummary, child: boolean) => (
    <button
      key={r.run_id}
      className={`logs-row ${child ? "child" : ""}`}
      onClick={() => load(r.run_id)}
      title={r.run_id}
    >
      <span className={`logs-dot ${r.finished ? "done" : "live"}`} />
      <span className="logs-row-main">
        <span className="logs-name">{child ? "↳ " : ""}{r.name}</span>
        <span className="logs-meta">
          {r.agentCount > 0 ? `${r.agentCount} agents · ` : ""}{r.events} events · {new Date(r.mtime).toLocaleString()}
        </span>
      </span>
      {r.outcome && (
        <span className={`logs-outcome ${r.outcome.value > 0 ? "ok" : "bad"}`} title={r.outcome.measured ? "measured" : "assumed"}>
          {r.outcome.value}
        </span>
      )}
    </button>
  );

  return (
    <aside className="logs-panel panel" aria-label="Logs">
      <div className="panel-title">
        <span>⟲ Logs — {runs.length}</span>
        <button className="panel-close" onClick={() => onSetOpen(false)} aria-label="Minimize logs">–</button>
      </div>
      <div className="logs-body">
        {err && <div className="muted run-empty">{err}</div>}
        {!err && runs.length === 0 && <div className="muted run-empty">no runs yet — finished workflows save here</div>}
        {bases.map((b) => (
          <div key={b.run_id} className="logs-group">
            {row(b, false)}
            {(childrenOf.get(b.run_id) ?? []).map((c) => row(c, true))}
          </div>
        ))}
      </div>
    </aside>
  );
}
