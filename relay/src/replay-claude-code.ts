/**
 * Replay a real Claude Code session into a running AgentViz relay.
 *
 * Reads a session transcript (the top-level JSONL + its sidechain sub-agent
 * transcripts), translates it with the shared, tested ui/src/ingest translator,
 * connects to the relay as an SDK client, and streams the events — so a past
 * session plays back live in the browser (3D / FLOW / CREDIT).
 *
 * Usage:  cd relay && npm run replay -- <path-to-session.jsonl> [--speed=30] [--outcome=1]
 *   --speed   = ms between events (0 = instant; default 30 so it animates).
 *   --outcome = operator-supplied terminal reward (you ran the session, you know
 *               it passed/failed). Attaches a run-level outcome (source=manual) so
 *               the CREDIT lens populates. Outcomes are always external — never
 *               inferred from the transcript.
 */
import WebSocket from "ws";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { claudeCodeToEvents } from "../../ui/src/ingest/claudeCode";
import type { CCSession, CCLine, CCSubagent } from "../../ui/src/ingest/claudeCode";

function readJsonl(p: string): CCLine[] {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l) as CCLine; } catch { return null; } })
    .filter((x): x is CCLine => x !== null);
}

/** Load a session dir (main jsonl + <sessionId>/subagents/agent-*.jsonl + .meta.json). */
export function loadClaudeCodeSession(mainJsonlPath: string): CCSession {
  const dir = path.dirname(mainJsonlPath);
  const sessionId = path.basename(mainJsonlPath, ".jsonl");
  const lines = readJsonl(mainJsonlPath);
  const subDir = path.join(dir, sessionId, "subagents");
  const subagents: CCSubagent[] = [];
  if (fs.existsSync(subDir)) {
    for (const f of fs.readdirSync(subDir)) {
      if (f.startsWith("agent-") && f.endsWith(".jsonl")) {
        const agentId = f.replace(/\.jsonl$/, "");
        const metaPath = path.join(subDir, `${agentId}.meta.json`);
        const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, "utf8")) : {};
        subagents.push({ agentId, meta, lines: readJsonl(path.join(subDir, f)) });
      }
    }
  }
  return { sessionId, lines, subagents };
}

function relayPort(): number {
  const pf = path.join(os.homedir(), ".agentviz", "relay.json");
  if (fs.existsSync(pf)) {
    try { return JSON.parse(fs.readFileSync(pf, "utf8")).port; } catch { /* fall through */ }
  }
  return parseInt(process.env.AGENTVIZ_PORT ?? "3333", 10);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mainPath = args.find((a) => !a.startsWith("--"));
  const speedArg = args.find((a) => a.startsWith("--speed="));
  const speed = speedArg ? parseInt(speedArg.split("=")[1], 10) : 30;
  if (!mainPath) {
    console.error("usage: npm run replay -- <path-to-session.jsonl> [--speed=30]");
    process.exit(1);
  }
  const outcomeArg = args.find((a) => a.startsWith("--outcome="));
  const session = loadClaudeCodeSession(path.resolve(mainPath));
  const events = claudeCodeToEvents(session) as Array<Record<string, unknown>>;

  // Operator-supplied terminal outcome (external by design — never inferred).
  if (outcomeArg) {
    const value = parseFloat(outcomeArg.split("=")[1]);
    const sessionSeq = events.filter(
      (e) => (e.agent_id ?? e.from_agent_id ?? "_session") === "_session"
    ).length;
    events.push({
      kind: "outcome", agent_id: null, channel: "tests", value,
      scale: "binary", value_min: null, value_max: null, stage: "terminal",
      source: "manual", measured: true, detail: {}, run_id: null,
      ablated_agent_id: null, baseline_run_id: null, baseline_value: null,
      timestamp: Date.parse("2099-01-01") / 1000, seq: sessionSeq,
    });
  }

  const port = relayPort();
  console.log(`[replay] ${session.subagents.length} subagents, ${events.length} events -> ws://localhost:${port}/sdk`);

  const ws = new WebSocket(`ws://localhost:${port}/sdk`);
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });
  for (const e of events) {
    ws.send(JSON.stringify(e));
    if (speed > 0) await new Promise((r) => setTimeout(r, speed));
  }
  await new Promise((r) => setTimeout(r, 400)); // let the relay flush to browsers
  ws.close();
  console.log(`[replay] done — open http://localhost:${port} and press V to the CREDIT view.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
