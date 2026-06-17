import * as fs from "fs";
import * as path from "path";

/** Read access to the recorder's per-run logs (~/.agentviz/runs/<run_id>.jsonl) so the
 * UI can browse and replay past runs. Pure functions over a directory — testable. */

export interface RunSummary {
  run_id: string;
  name: string;
  events: number;
  mtime: number;
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
      for (const l of lines) {
        try {
          const e = JSON.parse(l);
          if (e && e.kind === "session_start" && e.name) { name = e.name; break; }
        } catch { /* skip malformed line */ }
      }
      out.push({ run_id: f.replace(/\.jsonl$/, ""), name, events: lines.length, mtime: stat.mtimeMs });
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
