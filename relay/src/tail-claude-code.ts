/**
 * Live-tail a Claude Code session transcript into a running AgentViz relay.
 *
 * The opt-in shell command (scripts/agentviz-attach.sh) launches one of these
 * per terminal that has an active Claude Code session. It connects to the relay
 * as an SDK client, registers the session (so a tab appears), then watches the
 * transcript file and streams *new* agent activity as it is appended — the same
 * tested translator used by `replay`, just incrementally and live.
 *
 * GROUNDED: every event derives from a real line the running session wrote. We
 * never invent activity, and we never stream a terminal that didn't opt in.
 *
 * Usage:  npm run tail -- --transcript <path.jsonl> --session <id> \
 *                         --name <tab name> [--cwd <dir>] [--branch <git>] [--port N]
 */
import WebSocket from "ws";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { claudeCodeToEvents } from "../../ui/src/ingest/claudeCode";
import { loadClaudeCodeSession } from "./replay-claude-code";

type Event = Record<string, unknown>;

/** Map a working directory to its Claude Code projects dir. Claude Code mangles
 *  the absolute path by turning every non-alphanumeric char into a dash. */
export function projectDirFor(cwd: string, home: string = os.homedir()): string {
  return path.join(home, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
}

/** The active transcript = the most recently modified *.jsonl in that dir
 *  (the session currently being written). Null if the project has none. */
export function discoverActiveTranscript(cwd: string, home: string = os.homedir()): string | null {
  const dir = projectDirFor(cwd, home);
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => path.join(dir, f));
  if (files.length === 0) return null;
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0];
}

/** Stamp session_id onto each event — additive, never mutates existing fields. */
export function stampSession(events: Event[], sessionId: string): Event[] {
  return events.map((e) => ({ ...e, session_id: sessionId }));
}

/** Pure incremental cursor: given how many events we have already streamed and
 *  the full re-translated list, return the new tail (stamped) + the new total.
 *  The translator is deterministic over append-only input, so the already-sent
 *  prefix is stable and we only ever emit the suffix. */
export function nextBatch(
  prevCount: number,
  allEvents: Event[],
  sessionId: string,
): { events: Event[]; count: number } {
  if (allEvents.length <= prevCount) return { events: [], count: prevCount };
  return { events: stampSession(allEvents.slice(prevCount), sessionId), count: allEvents.length };
}

function relayPort(): number {
  const pf = path.join(os.homedir(), ".agentviz", "relay.json");
  if (fs.existsSync(pf)) {
    try { return JSON.parse(fs.readFileSync(pf, "utf8")).port; } catch { /* fall through */ }
  }
  return parseInt(process.env.AGENTVIZ_PORT ?? "3333", 10);
}

export interface TailerOptions {
  transcriptPath: string;
  sessionId: string;
  name: string;
  cwd?: string;
  gitBranch?: string;
  port?: number;
}

export async function runTailer(opts: TailerOptions): Promise<void> {
  const port = opts.port ?? relayPort();
  const ws = new WebSocket(`ws://localhost:${port}/sdk`);
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });

  // Register the session so the tab appears immediately, even before activity.
  ws.send(JSON.stringify({
    kind: "session_start",
    name: opts.name,
    source: "claude-code",
    cwd: opts.cwd ?? null,
    git_branch: opts.gitBranch ?? null,
    session_id: opts.sessionId,
    timestamp: Date.now() / 1000,
  }));

  let sent = 0;
  let pumping = false;
  const pump = (): void => {
    if (pumping || ws.readyState !== WebSocket.OPEN) return;
    pumping = true;
    try {
      const session = loadClaudeCodeSession(opts.transcriptPath);
      // Drop the translator's own session_start: we already sent an authoritative
      // one (with source/cwd/branch), and a second would clear this session's
      // relay buffer mid-stream. Filtering deterministically keeps the cursor stable.
      const all = (claudeCodeToEvents(session) as unknown as Event[])
        .filter((e) => e.kind !== "session_start");
      const { events, count } = nextBatch(sent, all, opts.sessionId);
      for (const e of events) ws.send(JSON.stringify(e));
      sent = count;
    } catch { /* transient read/parse error — next tick retries */ }
    pumping = false;
  };

  pump();   // initial backfill of everything already in the transcript

  // fs.watch is event-driven but unreliable on some filesystems / editors;
  // a slow poll is the safety net. Both funnel into the same idempotent pump.
  let debounce: NodeJS.Timeout | null = null;
  const schedule = (): void => {
    if (debounce) return;
    debounce = setTimeout(() => { debounce = null; pump(); }, 150);
  };
  try { fs.watch(opts.transcriptPath, { persistent: true }, schedule); } catch { /* poll covers it */ }
  const poll = setInterval(pump, 1500);

  await new Promise<void>((resolve) => {
    const done = (): void => { clearInterval(poll); resolve(); };
    ws.on("close", done);
    ws.on("error", done);
    process.on("SIGINT", () => { ws.close(); done(); });
    process.on("SIGTERM", () => { ws.close(); done(); });
  });
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) { out[a.slice(2)] = argv[i + 1] ?? ""; i++; }
  }
  return out;
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  if (!a.transcript || !a.session || !a.name) {
    console.error("usage: npm run tail -- --transcript <path> --session <id> --name <tab> [--cwd <dir>] [--branch <git>] [--port N]");
    process.exit(1);
  }
  await runTailer({
    transcriptPath: path.resolve(a.transcript),
    sessionId: a.session,
    name: a.name,
    cwd: a.cwd,
    gitBranch: a.branch,
    port: a.port ? parseInt(a.port, 10) : undefined,
  });
}

// Run as a CLI only when invoked directly (not when imported by tests).
if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
