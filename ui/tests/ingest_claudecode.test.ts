import { describe, test, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { claudeCodeToEvents, type CCSession } from "../src/ingest/claudeCode";
import { play } from "./helpers";
import { assignCredit } from "../src/credit";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(resolve(here, "../../examples/fixtures/claude_code_session.json"), "utf8")
) as CCSession;

const events = claudeCodeToEvents(fixture);
const byKind = (k: string) => events.filter((e) => e.kind === k);

describe("claudeCodeToEvents — Claude Code transcript adapter", () => {
  test("emits a session_start named from the ai-title", () => {
    const ss = byKind("session_start");
    expect(ss).toHaveLength(1);
    expect((ss[0] as { name: string }).name).toBe("build the thing");
  });

  test("root session is a root agent_spawn; subagent parent resolves via meta.toolUseId", () => {
    const spawns = byKind("agent_spawn") as Array<{ agent_id: string; parent_id: string | null; name: string }>;
    const root = spawns.find((s) => s.agent_id === "sess-root")!;
    expect(root.parent_id).toBeNull();
    const sub = spawns.find((s) => s.agent_id === "agent-research")!;
    expect(sub.parent_id).toBe("sess-root");   // tu-agent block is owned by root
    expect(sub.name).toBe("do research");
  });

  test("Agent/Task/Workflow tool_use blocks are spawn edges, never leaf tool calls", () => {
    const tools = byKind("tool_call_pending") as Array<{ name: string; call_id: string; agent_id: string }>;
    expect(tools.some((t) => t.name === "Agent")).toBe(false);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["Read", "WebSearch"]);
    expect(tools.find((t) => t.name === "WebSearch")!.agent_id).toBe("agent-research");
  });

  test("tool_result matches by tool_use_id; interrupted is_error becomes tool_denied", () => {
    expect((byKind("tool_result") as Array<{ call_id: string }>).some((r) => r.call_id === "tu-read")).toBe(true);
    const denied = byKind("tool_denied") as Array<{ call_id: string; reason: string }>;
    expect(denied).toHaveLength(1);
    expect(denied[0].call_id).toBe("tu-web");
  });

  test("usage is deduped by message.id (m1 repeated across two lines counts once)", () => {
    const usage = byKind("usage") as Array<{ agent_id: string; input_tokens: number }>;
    const rootUsage = usage.filter((u) => u.agent_id === "sess-root");
    expect(rootUsage).toHaveLength(3);   // m1 (deduped), m2, m3 — not 4
    expect(usage.filter((u) => u.agent_id === "agent-research")).toHaveLength(1);
  });

  test("agent_complete carries completed_at; subagent hands result up to its parent", () => {
    const completes = byKind("agent_complete") as Array<{ agent_id: string; timestamp: number }>;
    expect(completes.map((c) => c.agent_id).sort()).toEqual(["agent-research", "sess-root"]);
    expect(completes.every((c) => typeof c.timestamp === "number" && c.timestamp > 0)).toBe(true);
    const handoff = byKind("agent_message") as Array<{ from_agent_id: string; to_agent_id: string }>;
    expect(handoff.some((m) => m.from_agent_id === "agent-research" && m.to_agent_id === "sess-root")).toBe(true);
  });

  test("ingested events carry monotonic per-key seq (replicating _stamp_seq)", () => {
    const byKey = new Map<string, number[]>();
    for (const e of events) {
      const k = (e as { agent_id?: string | null; from_agent_id?: string }).agent_id
        ?? (e as { from_agent_id?: string }).from_agent_id ?? "_session";
      if (typeof e.seq === "number") (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(e.seq);
    }
    for (const seqs of byKey.values()) {
      expect(seqs).toEqual(seqs.map((_, i) => i));   // 0,1,2,... contiguous per key
    }
  });

  test("the ingested events drive the same store + credit engine (end to end)", () => {
    const state = play(events);
    expect(Object.keys(state.agents).sort()).toEqual(["agent-research", "sess-root"]);
    // attach a terminal outcome at the root and confirm the subagent is a contributor
    const withOutcome = play([
      ...events,
      { kind: "outcome", agent_id: null, channel: "tests", value: 1, scale: "binary",
        value_min: null, value_max: null, stage: "terminal", source: "test_suite",
        measured: true, detail: { result_agent_ids: ["sess-root"] }, run_id: null,
        ablated_agent_id: null, baseline_run_id: null, baseline_value: null, timestamp: 99 },
    ]);
    const rep = assignCredit(withOutcome);
    expect(rep.contributors.some((c) => c.agent_id === "agent-research")).toBe(true);
  });
});
