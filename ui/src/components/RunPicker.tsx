import { useEffect, useState } from "react";

interface RunSummary { run_id: string; name: string; events: number; mtime: number; }

interface Props {
  port: number;
  onLoad: (events: object[]) => void;
  onClose: () => void;
}

/** Browse the relay's recorded runs (~/.agentviz/runs/*.jsonl) and replay one into the
 * store. Loading a run dispatches its events as a batch — the recorded session_start
 * resets the canvas, so the past run renders exactly as it did live. */
export function RunPicker({ port, onLoad, onClose }: Props) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch(`http://localhost:${port}/runs`)
      .then((r) => r.json())
      .then((rs: RunSummary[]) => setRuns(rs))
      .catch(() => setErr("could not reach the relay"));
  }, [port]);

  const load = (id: string) => {
    fetch(`http://localhost:${port}/runs/${id}`)
      .then((r) => r.json())
      .then((events: object[]) => { onLoad(events); onClose(); })
      .catch(() => setErr("could not load that run"));
  };

  return (
    <div className="run-picker panel">
      <div className="panel-title">
        <span>⟲ Recorded runs — {runs.length}</span>
        <button className="panel-close" onClick={onClose}>✕</button>
      </div>
      <div className="scroll-area">
        {err && <div className="muted run-empty">{err}</div>}
        {!err && runs.length === 0 && <div className="muted run-empty">no recorded runs yet</div>}
        {runs.map((r) => (
          <button key={r.run_id} className="run-row" onClick={() => load(r.run_id)} title={r.run_id}>
            <span className="run-name">{r.name}</span>
            <span className="run-meta">{r.events} events · {new Date(r.mtime).toLocaleString()}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
