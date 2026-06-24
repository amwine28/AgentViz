import * as fs from "fs";
import * as path from "path";

/** Read access to the recorder's per-run logs (~/.agentviz/runs/<run_id>.jsonl) so the
 * UI can browse and replay past runs. Pure functions over a directory — testable. */

export interface RunSummary {
  run_id: string;
  name: string;
  events: number;
  mtime: number;
  agentCount: number;                                 // distinct agent_spawn ids
  outcome: { value: number; measured: boolean } | null; // last terminal outcome, if any
  finished: boolean;                                  // a terminal outcome OR ≥1 agent_complete
  source: string | null;                              // session_start.source (sdk/shell/claude-code)
  baselineRunId: string | null;                       // set on re-runs → nest under the base run
}

export function listRuns(dir: string): RunSummary[] {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];   // no runs dir yet
  }
  const out: RunSummary[] = [];
  for (const f of files) {
    const full = path.join(dir, f);
    try {
      const stat = fs.statSync(full);
      const lines = fs.readFileSync(full, "utf8").split("\n").filter(Boolean);
      let name = f.replace(/\.jsonl$/, "");
      let nameSet = false;
      let source: string | null = null;
      let baselineRunId: string | null = null;
      let outcome: { value: number; measured: boolean } | null = null;
      let sawComplete = false;
      const agentIds = new Set<string>();
      for (const l of lines) {
        try {
          const e = JSON.parse(l);
          if (!e || typeof e !== "object") continue;
          if (e.kind === "session_start") {
            if (!nameSet && e.name) { name = e.name; nameSet = true; }
            if (e.source) source = e.source;
            if (e.baseline_run_id) baselineRunId = e.baseline_run_id;
          } else if (e.kind === "agent_spawn" && e.agent_id) {
            agentIds.add(e.agent_id);
          } else if (e.kind === "agent_complete") {
            sawComplete = true;
          } else if (e.kind === "outcome" && (e.agent_id == null || e.stage === "terminal")) {
            outcome = { value: typeof e.value === "number" ? e.value : 0, measured: !!e.measured };
          }
        } catch { /* skip malformed line */ }
      }
      out.push({
        run_id: f.replace(/\.jsonl$/, ""),
        name, events: lines.length, mtime: stat.mtimeMs,
        agentCount: agentIds.size,
        outcome,
        finished: outcome !== null || sawComplete,
        source, baselineRunId,
      });
    } catch { /* skip unreadable file */ }
  }
  out.sort((a, b) => b.mtime - a.mtime);   // newest first
  return out;
}

export function readRun(dir: string, id: string): unknown[] | null {
  const safe = id.replace(/[^a-zA-Z0-9._-]/g, "_");   // same sanitization as the recorder
  try {
    return fs.readFileSync(path.join(dir, `${safe}.jsonl`), "utf8")
      .split("\n").filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return null;
  }
}
