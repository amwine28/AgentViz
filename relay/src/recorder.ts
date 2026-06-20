import * as fs from "fs";
import * as path from "path";

/**
 * Append-only run recorder (Phase E persistence). Tees every event to
 * ~/.agentviz/runs/<run_id>.jsonl so a run is durable — the substrate for replay and
 * for branching a baseline run into its ablation re-runs. Keyed by `run_id` (stamped on
 * every SDK event); events without one go to `_norun.jsonl`. Appends synchronously so a
 * crash never loses the tail — no close/fsync lifecycle to get wrong.
 */
export class RunRecorder {
  private dir: string;

  constructor(dir: string) {
    this.dir = dir;
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }
  }

  record(event: unknown): void {
    // Key by run_id first (SDK runs, preserves replay), then session_id (v2
    // non-SDK tabs), then _norun. Additive — never displaces run_id.
    const ev = event as { run_id?: unknown; session_id?: unknown } | null;
    const rid = (ev && typeof ev === "object" && (ev.run_id || ev.session_id)) || "_norun";
    const safe = String(rid).replace(/[^a-zA-Z0-9._-]/g, "_");
    try {
      fs.appendFileSync(path.join(this.dir, `${safe}.jsonl`), JSON.stringify(event) + "\n");
    } catch { /* recording is best-effort; never break the live relay */ }
  }
}
