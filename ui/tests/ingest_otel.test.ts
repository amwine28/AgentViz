import { describe, test, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { otelToEvents, type OtelExport } from "../src/ingest/otel";
import { play } from "./helpers";
import { assignCredit } from "../src/credit";

const here = dirname(fileURLToPath(import.meta.url));
const load = (f: string) =>
  JSON.parse(readFileSync(resolve(here, `../../examples/fixtures/${f}`), "utf8")) as OtelExport;

const oai = otelToEvents(load("otel_openai_agents.json"));
const oi = otelToEvents(load("otel_openinference.json"));
const k = (evts: typeof oai, kind: string) => evts.filter((e) => e.kind === kind);

describe("otelToEvents — OpenAI Agents SDK / gen_ai conventions", () => {
  test("session_start from service.name", () => {
    expect((k(oai, "session_start")[0] as { name: string }).name).toBe("trip-planner");
  });

  test("agent spawns via nearest-enclosing-agent over parent_span_id", () => {
    const spawns = k(oai, "agent_spawn") as Array<{ agent_id: string; parent_id: string | null; name: string }>;
    const orch = spawns.find((s) => s.agent_id === "orch")!;
    expect(orch.parent_id).toBeNull();
    const research = spawns.find((s) => s.agent_id === "researcher")!;
    expect(research.parent_id).toBe("orch");        // nearest enclosing agent of s-orch
    expect(research.name).toBe("researcher");
  });

  test("tool spans become tool_call_pending + tool_result; ERROR status -> tool_denied", () => {
    const tools = k(oai, "tool_call_pending") as Array<{ call_id: string; name: string; agent_id: string }>;
    expect(tools.find((t) => t.call_id === "call-1")!.agent_id).toBe("orch");
    expect(k(oai, "tool_result").some((r) => (r as { call_id: string }).call_id === "call-1")).toBe(true);
    const denied = k(oai, "tool_denied") as Array<{ call_id: string }>;
    expect(denied).toHaveLength(1);
    expect(denied[0].call_id).toBe("call-2");
  });

  test("usage from gen_ai.usage.* with model + derived cost from the price table", () => {
    const u = k(oai, "usage") as Array<{ agent_id: string; input_tokens: number; output_tokens: number; model: string; cost_usd: number | null }>;
    expect(u).toHaveLength(1);
    expect(u[0].agent_id).toBe("orch");
    expect(u[0].input_tokens).toBe(1000);
    expect(u[0].output_tokens).toBe(200);
    expect(u[0].model).toBe("gpt-4o");
    expect(u[0].cost_usd).toBeGreaterThan(0);        // gpt-4o is in the versioned price table
  });

  test("handoff span -> agent_message from enclosing agent to target", () => {
    const msgs = k(oai, "agent_message") as Array<{ from_agent_id: string; to_agent_id: string }>;
    expect(msgs.some((m) => m.from_agent_id === "orch" && m.to_agent_id === "researcher")).toBe(true);
  });

  test("agent_complete carries completed_at; error status maps through", () => {
    const completes = k(oai, "agent_complete") as Array<{ agent_id: string; timestamp: number }>;
    expect(completes.map((c) => c.agent_id).sort()).toEqual(["orch", "researcher"]);
    expect(completes.every((c) => c.timestamp > 0)).toBe(true);
  });
});

describe("otelToEvents — OpenInference conventions", () => {
  test("span.kind discrimination + graph.node.parent_id for the spawn edge", () => {
    const spawns = k(oi, "agent_spawn") as Array<{ agent_id: string; parent_id: string | null }>;
    expect(spawns.find((s) => s.agent_id === "planner")!.parent_id).toBeNull();
    expect(spawns.find((s) => s.agent_id === "worker")!.parent_id).toBe("planner");  // graph.node.parent_id
  });

  test("usage from llm.token_count.* with instrumentation cost (llm.cost.total)", () => {
    const u = k(oi, "usage") as Array<{ input_tokens: number; output_tokens: number; model: string; cost_usd: number }>;
    expect(u).toHaveLength(1);
    expect(u[0].input_tokens).toBe(500);
    expect(u[0].output_tokens).toBe(100);
    expect(u[0].model).toBe("claude-sonnet-4-6");
    expect(u[0].cost_usd).toBeCloseTo(0.012);       // instrumentation cost preferred over derived
  });
});

describe("otelToEvents — shared invariants", () => {
  test("ingested events carry monotonic per-key seq", () => {
    for (const evts of [oai, oi]) {
      const byKey = new Map<string, number[]>();
      for (const e of evts) {
        const key = (e as { agent_id?: string | null; from_agent_id?: string }).agent_id
          ?? (e as { from_agent_id?: string }).from_agent_id ?? "_session";
        if (typeof e.seq === "number") (byKey.get(key) ?? byKey.set(key, []).get(key)!).push(e.seq);
      }
      for (const seqs of byKey.values()) expect(seqs).toEqual(seqs.map((_, i) => i));
    }
  });

  test("ingested events drive the store + credit engine end to end", () => {
    // delegation-down topology (orch hands off to researcher): the result lands
    // at researcher, so it is the sink; orch is the contributor that delegated.
    const rep = assignCredit(play([
      ...oai,
      { kind: "outcome", agent_id: null, channel: "tests", value: 1, scale: "binary",
        value_min: null, value_max: null, stage: "terminal", source: "manual",
        measured: true, detail: { result_agent_ids: ["researcher"] }, run_id: null,
        ablated_agent_id: null, baseline_run_id: null, baseline_value: null, timestamp: 9e9 },
    ]));
    expect(rep.contributors.some((c) => c.agent_id === "orch")).toBe(true);
    expect(rep.contributors.some((c) => c.agent_id === "researcher")).toBe(true);
  });
});
