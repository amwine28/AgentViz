import type { AgentVizEvent } from "../types";

/** OpenTelemetry GenAI / OpenInference → AgentViz events (observer ingestion, §5.2).
 *
 * Translates an OTLP/JSON trace export (or the live OTLP body) into the existing
 * event vocabulary. The nearest-enclosing-agent walk over parent_span_id IS the
 * handoff DAG — Rung 1 reverse-reachability runs purely over trace structure.
 * Pure + deterministic; replicates the SDK per-key seq stamping.
 *
 * Accepts both stable and deprecated attribute names, gen_ai.* and OpenInference
 * (openinference.span.kind, llm.token_count.*, llm.cost.total, graph.node.*).
 * Cost: prefer instrumentation (llm.cost.total); else derive from a versioned
 * price table; else null (honest unknown) — never guessed. */

interface OtelValue { stringValue?: string; intValue?: string | number; doubleValue?: number; boolValue?: boolean; }
interface OtelAttr { key: string; value?: OtelValue; }
interface OtelSpan {
  traceId?: string; spanId: string; parentSpanId?: string; name?: string;
  startTimeUnixNano?: string | number; endTimeUnixNano?: string | number;
  attributes?: OtelAttr[]; status?: { code?: number | string };
}
interface OtelScopeSpans { spans?: OtelSpan[]; }
interface OtelResourceSpans { resource?: { attributes?: OtelAttr[] }; scopeSpans?: OtelScopeSpans[]; }
export interface OtelExport { resourceSpans?: OtelResourceSpans[]; }

// Versioned model price table — USD per token [input, output]. Miss => cost null.
const PRICE_TABLE_VERSION = "2026-06";
const PRICE: Record<string, [number, number]> = {
  "gpt-4o": [2.5e-6, 1e-5],
  "gpt-4o-mini": [1.5e-7, 6e-7],
  "claude-sonnet-4-6": [3e-6, 1.5e-5],
  "claude-opus-4-8": [1.5e-5, 7.5e-5],
  "claude-haiku-4-5": [8e-7, 4e-6],
};
export { PRICE_TABLE_VERSION };

const AGENT_OPS = new Set(["invoke_agent", "create_agent", "invoke_workflow"]);
const LLM_OPS = new Set(["chat", "generate_content", "text_completion", "embeddings"]);

function readVal(v?: OtelValue): string | number | boolean | undefined {
  if (!v) return undefined;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return typeof v.intValue === "string" ? parseInt(v.intValue, 10) : v.intValue;
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.boolValue !== undefined) return v.boolValue;
  return undefined;
}
function attrMap(attrs?: OtelAttr[]): Map<string, string | number | boolean> {
  const m = new Map<string, string | number | boolean>();
  for (const a of attrs ?? []) { const v = readVal(a.value); if (v !== undefined) m.set(a.key, v); }
  return m;
}
const toSec = (n?: string | number): number => (n == null ? 0 : Number(n) / 1e9);
const isError = (code?: number | string): boolean =>
  code === 2 || code === "STATUS_CODE_ERROR" || code === "ERROR";

type Kind = "agent" | "llm" | "tool" | "handoff" | "other";
function kindOf(a: Map<string, string | number | boolean>): Kind {
  const op = a.get("gen_ai.operation.name");
  if (op === "handoff") return "handoff";
  if (typeof op === "string" && AGENT_OPS.has(op)) return "agent";
  if (typeof op === "string" && LLM_OPS.has(op)) return "llm";
  if (op === "execute_tool") return "tool";
  const oi = String(a.get("openinference.span.kind") ?? "").toLowerCase();
  if (oi === "agent") return "agent";
  if (oi === "llm") return "llm";
  if (oi === "tool" || oi === "retriever" || oi === "embedding") return "tool";
  return "other";
}

export function otelToEvents(exportObj: OtelExport): AgentVizEvent[] {
  const out: AgentVizEvent[] = [];
  const seqCounter = new Map<string, number>();
  const push = (e: Record<string, unknown>) => {
    const key = (e.agent_id as string | null | undefined) ?? (e.from_agent_id as string | undefined) ?? "_session";
    const n = seqCounter.get(key) ?? 0;
    e.seq = n; seqCounter.set(key, n + 1);
    out.push(e as unknown as AgentVizEvent);
  };

  // flatten spans + resource attrs
  let serviceName: string | undefined;
  const spans: OtelSpan[] = [];
  for (const rs of exportObj.resourceSpans ?? []) {
    const ra = attrMap(rs.resource?.attributes);
    if (ra.has("service.name")) serviceName = String(ra.get("service.name"));
    for (const ss of rs.scopeSpans ?? []) for (const sp of ss.spans ?? []) spans.push(sp);
  }
  spans.sort((a, b) => toSec(a.startTimeUnixNano) - toSec(b.startTimeUnixNano));
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  const amOf = new Map(spans.map((s) => [s.spanId, attrMap(s.attributes)]));

  const agentIdOf = (s: OtelSpan): string => {
    const a = amOf.get(s.spanId)!;
    return String(a.get("graph.node.id") ?? a.get("gen_ai.agent.id") ?? s.spanId);
  };
  const nameOf = (s: OtelSpan): string => {
    const a = amOf.get(s.spanId)!;
    return String(a.get("gen_ai.agent.name") ?? a.get("graph.node.id") ?? agentIdOf(s));
  };
  // walk up parent_span_id to the first enclosing AGENT span
  const enclosingAgentId = (s: OtelSpan): string | null => {
    let cur = s.parentSpanId;
    while (cur) {
      const p = byId.get(cur);
      if (!p) break;
      if (kindOf(amOf.get(p.spanId)!) === "agent") return agentIdOf(p);
      cur = p.parentSpanId;
    }
    return null;
  };

  const rootSpan = spans.find((s) => !s.parentSpanId);
  push({ kind: "session_start", name: serviceName ?? rootSpan?.name ?? "otel session",
         timestamp: toSec(rootSpan?.startTimeUnixNano) });

  const agentSpans = spans.filter((s) => kindOf(amOf.get(s.spanId)!) === "agent");
  const knownAgentIds = new Set(agentSpans.map(agentIdOf));

  // ---- agent spawns (topo: parent before child) ----
  const parentOfAgent = new Map<string, string | null>();
  for (const s of agentSpans) {
    const a = amOf.get(s.spanId)!;
    const gnParent = a.get("graph.node.parent_id");
    const parent = (typeof gnParent === "string" && knownAgentIds.has(gnParent))
      ? gnParent
      : enclosingAgentId(s);
    parentOfAgent.set(agentIdOf(s), parent);
  }
  const spawnSpanByAgent = new Map(agentSpans.map((s) => [agentIdOf(s), s]));
  const emittedSpawn = new Set<string>();
  const emitSpawn = (agentId: string) => {
    if (emittedSpawn.has(agentId)) return;
    const parent = parentOfAgent.get(agentId) ?? null;
    if (parent && !emittedSpawn.has(parent) && spawnSpanByAgent.has(parent)) emitSpawn(parent); // parent first
    const s = spawnSpanByAgent.get(agentId)!;
    emittedSpawn.add(agentId);
    push({ kind: "agent_spawn", agent_id: agentId, parent_id: parent, name: nameOf(s),
           timestamp: toSec(s.startTimeUnixNano) });
  };
  for (const s of agentSpans) emitSpawn(agentIdOf(s));

  // ---- activity (tools, llm usage, handoffs) in start order ----
  for (const s of spans) {
    const a = amOf.get(s.spanId)!;
    const kind = kindOf(a);
    const t0 = toSec(s.startTimeUnixNano);
    const t1 = toSec(s.endTimeUnixNano);
    if (kind === "tool") {
      const callId = String(a.get("gen_ai.tool.call.id") ?? s.spanId);
      const toolName = String(a.get("gen_ai.tool.name") ?? a.get("tool.name") ?? s.name ?? "tool");
      const agentId = enclosingAgentId(s);
      push({ kind: "tool_call_pending", agent_id: agentId, call_id: callId, name: toolName, args: {}, timeout_s: 0, timestamp: t0 });
      if (isError(s.status?.code)) {
        push({ kind: "tool_denied", agent_id: agentId, call_id: callId, name: toolName, reason: "denied", timestamp: t1 });
      } else {
        push({ kind: "tool_result", agent_id: agentId, call_id: callId, result: "ok", duration_ms: Math.round((t1 - t0) * 1000), timestamp: t1 });
      }
    } else if (kind === "llm") {
      const inTok = Number(a.get("gen_ai.usage.input_tokens") ?? a.get("gen_ai.usage.prompt_tokens") ?? a.get("prompt_tokens") ?? a.get("llm.token_count.prompt") ?? 0);
      const outTok = Number(a.get("gen_ai.usage.output_tokens") ?? a.get("gen_ai.usage.completion_tokens") ?? a.get("completion_tokens") ?? a.get("llm.token_count.completion") ?? 0);
      const model = (a.get("gen_ai.response.model") ?? a.get("gen_ai.request.model") ?? a.get("llm.model_name")) as string | undefined;
      const instrCost = a.get("llm.cost.total");
      let cost: number | null;
      if (typeof instrCost === "number") cost = instrCost;
      else { const p = model ? PRICE[model] : undefined; cost = p ? inTok * p[0] + outTok * p[1] : null; }
      push({ kind: "usage", agent_id: enclosingAgentId(s), input_tokens: inTok, output_tokens: outTok, model: model ?? null, cost_usd: cost, timestamp: t0 });
    } else if (kind === "handoff") {
      const from = enclosingAgentId(s);
      const to = a.get("gen_ai.agent.id");
      if (from && typeof to === "string") {
        push({ kind: "agent_message", from_agent_id: from, to_agent_id: to, content: "handoff", timestamp: t0 });
      }
    }
  }

  // ---- agent completions (end-time order) ----
  for (const s of [...agentSpans].sort((a, b) => toSec(a.endTimeUnixNano) - toSec(b.endTimeUnixNano))) {
    push({ kind: "agent_complete", agent_id: agentIdOf(s),
           exit_status: isError(s.status?.code) ? "error" : "ok", summary: "",
           timestamp: toSec(s.endTimeUnixNano) });
  }
  return out;
}
