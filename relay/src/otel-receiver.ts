/**
 * OTLP/JSON receiver bridge — live OpenTelemetry GenAI ingest for AgentViz (§5.2).
 *
 * Runs a small HTTP server that accepts `POST /v1/traces` (OTLP/JSON), translates
 * spans with the shared, tested ui/src/ingest/otel translator, and forwards the
 * resulting events to the running relay as an SDK client — so any OTel-emitting
 * agent framework (OpenAI Agents SDK, AgentOps, OpenLLMetry, OpenInference for
 * LangGraph/CrewAI/AutoGen) shows up live in the world.
 *
 * Point your tracer's OTLP/HTTP exporter at  http://localhost:4318  (the standard
 * OTLP/HTTP port). Run:  cd relay && npm run otel-receiver
 */
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import WebSocket from "ws";
import { otelToEvents } from "../../ui/src/ingest/otel";
import type { OtelExport } from "../../ui/src/ingest/otel";

function relayPort(): number {
  const pf = path.join(os.homedir(), ".agentviz", "relay.json");
  if (fs.existsSync(pf)) {
    try { return JSON.parse(fs.readFileSync(pf, "utf8")).port; } catch { /* fall through */ }
  }
  return parseInt(process.env.AGENTVIZ_PORT ?? "3333", 10);
}

const RECV_PORT = parseInt(process.env.AGENTVIZ_OTLP_PORT ?? "4318", 10);
const PORT = relayPort();

// Fail-open WS to the relay /sdk channel, with reconnect.
let ws: WebSocket | null = null;
let closing = false;
function connect(): void {
  ws = new WebSocket(`ws://localhost:${PORT}/sdk`);
  ws.on("error", () => { /* relay may be down; retry on close */ });
  ws.on("close", () => { if (!closing) setTimeout(connect, 1000); });
}
connect();

function forward(events: unknown[]): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    for (const e of events) ws.send(JSON.stringify(e));
  }
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && (req.url ?? "").startsWith("/v1/traces")) {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      try {
        const obj = JSON.parse(body) as OtelExport;
        const events = otelToEvents(obj);
        forward(events);
        console.log(`[otel] ${events.length} events -> relay :${PORT}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}"); // OTLP success: empty ExportTraceServiceResponse
      } catch (e) {
        console.error("[otel] parse/translate error:", e);
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end(String(e));
      }
    });
  } else {
    res.writeHead(404);
    res.end("AgentViz OTLP receiver — POST OTLP/JSON to /v1/traces");
  }
});

server.listen(RECV_PORT, () => {
  console.log(`[otel] OTLP/JSON receiver on http://localhost:${RECV_PORT}/v1/traces -> relay :${PORT}`);
});

process.on("SIGINT", () => { closing = true; ws?.close(); server.close(); process.exit(0); });
process.on("SIGTERM", () => { closing = true; ws?.close(); server.close(); process.exit(0); });
