import type { AgentVizEvent } from "../types";
import { operationsFromTools } from "./operations";

/** Claude Code transcript → AgentViz events (observer-only ingestion, §5.1).
 *
 * Translates a normalized Claude Code session (the top-level JSONL plus its
 * sidechain sub-agent transcripts) into the existing event vocabulary, so real
 * sessions feed the same store/credit engine. Pure + deterministic; replicates
 * the SDK's per-key seq stamping so gap detection and outcome ordering work.
 *
 * Honest scope: handles the common, high-value mapping (spawn hierarchy via
 * meta.toolUseId, tool calls/results, denial-from-interrupt, usage dedupe by
 * message.id, completion + upward handoff). Deferred (tagged in HANDOFF):
 * compact_boundary stitching, nested workflow journals, retryAttempt de-dup,
 * and reward proxies (the terminal outcome is supplied externally, never inferred). */

const SPAWN_TOOLS = new Set(["Agent", "Task", "Workflow"]);

export interface CCBlock { type: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; is_error?: boolean; content?: unknown; }
interface CCMessage { id?: string; model?: string; content?: CCBlock[]; usage?: { input_tokens?: number; output_tokens?: number }; }
export interface CCLine { type: string; timestamp?: string; message?: CCMessage; aiTitle?: string; }
export interface CCSubagent { agentId: string; meta: { toolUseId?: string; description?: string; agentType?: string }; lines: CCLine[]; }
export interface CCSession { sessionId: string; title?: string; lines: CCLine[]; subagents: CCSubagent[]; }

const toSec = (line: CCLine | undefined): number =>
  line?.timestamp ? Date.parse(line.timestamp) / 1000 : 0;

export function claudeCodeToEvents(session: CCSession): AgentVizEvent[] {
  const out: AgentVizEvent[] = [];
  const seqCounter = new Map<string, number>();
  const push = (e: Record<string, unknown>) => {
    const key = (e.agent_id as string | null | undefined) ?? (e.from_agent_id as string | undefined) ?? "_session";
    const n = seqCounter.get(key) ?? 0;
    e.seq = n;
    seqCounter.set(key, n + 1);
    out.push(e as unknown as AgentVizEvent);
  };

  const rootId = session.sessionId;
  const title = session.title
    ?? (session.lines.find((l) => l.type === "ai-title")?.aiTitle)
    ?? "claude-code session";

  // ---- tool_use block ownership (subagent parent = owner of meta.toolUseId) ----
  const toolUseOwner = new Map<string, string>();
  const spawnCallIds = new Set<string>();
  const collectOwners = (agentId: string, lines: CCLine[]) => {
    for (const l of lines) {
      if (l.type === "assistant" && Array.isArray(l.message?.content)) {
        for (const b of l.message!.content!) {
          if (b.type === "tool_use" && b.id) {
            toolUseOwner.set(b.id, agentId);
            if (b.name && SPAWN_TOOLS.has(b.name)) spawnCallIds.add(b.id);
          }
        }
      }
    }
  };
  collectOwners(rootId, session.lines);
  for (const sub of session.subagents) collectOwners(sub.agentId, sub.lines);

  // ---- parent map + parent-before-child order ----
  const parentOf = new Map<string, string | null>([[rootId, null]]);
  for (const sub of session.subagents) {
    const p = sub.meta.toolUseId ? toolUseOwner.get(sub.meta.toolUseId) : undefined;
    parentOf.set(sub.agentId, p ?? rootId);
  }
  const subById = new Map(session.subagents.map((s) => [s.agentId, s]));
  const childrenOf = new Map<string, string[]>();
  for (const [c, p] of parentOf) if (p) childrenOf.set(p, [...(childrenOf.get(p) ?? []), c]);
  const order: string[] = [];
  const queue = [rootId];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const c of childrenOf.get(id) ?? []) queue.push(c);
  }

  const nameOf = (agentId: string): string =>
    agentId === rootId ? title : (subById.get(agentId)?.meta.description ?? agentId);

  push({ kind: "session_start", name: title, timestamp: toSec(session.lines[0]) });

  const processAgent = (agentId: string, lines: CCLine[]) => {
    push({ kind: "agent_spawn", agent_id: agentId, parent_id: parentOf.get(agentId) ?? null,
           name: nameOf(agentId), timestamp: toSec(lines[0]) });

    const seenUsage = new Set<string>();
    const seenToolUse = new Set<string>();   // streamed lines repeat tool_use blocks
    const toolName = new Map<string, string>();
    let lastTs = toSec(lines[0]);

    for (const l of lines) {
      const t = toSec(l);
      if (t) lastTs = t;
      if (l.type === "assistant" && l.message) {
        const m = l.message;
        if (m.id && m.usage && !seenUsage.has(m.id)) {            // dedupe by message.id
          seenUsage.add(m.id);
          push({ kind: "usage", agent_id: agentId,
                 input_tokens: m.usage.input_tokens ?? 0, output_tokens: m.usage.output_tokens ?? 0,
                 model: m.model ?? null, cost_usd: null, timestamp: t });
        }
        for (const b of m.content ?? []) {
          if (b.type === "tool_use" && b.id) {
            if (b.name && SPAWN_TOOLS.has(b.name)) continue;       // spawn edge, not a leaf tool
            if (seenToolUse.has(b.id)) continue;                  // dedupe streamed repeats
            seenToolUse.add(b.id);
            toolName.set(b.id, b.name ?? "");
            push({ kind: "tool_call_pending", agent_id: agentId, call_id: b.id,
                   name: b.name ?? "", args: b.input ?? {}, timeout_s: 0, timestamp: t });
          }
        }
      } else if (l.type === "user" && Array.isArray(l.message?.content)) {
        for (const b of l.message!.content!) {
          if (b.type === "tool_result" && b.tool_use_id) {
            if (spawnCallIds.has(b.tool_use_id)) continue;         // subagent return, not a leaf result
            const text = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
            if (b.is_error && /\[Request interrupted by user/.test(text)) {
              push({ kind: "tool_denied", agent_id: agentId, call_id: b.tool_use_id,
                     name: toolName.get(b.tool_use_id) ?? "", reason: "denied", timestamp: t });
            } else {
              push({ kind: "tool_result", agent_id: agentId, call_id: b.tool_use_id,
                     result: text, duration_ms: 0, timestamp: t });
            }
          }
        }
      }
    }

    const parent = parentOf.get(agentId);
    if (parent) {
      // child's result flows up to its parent — the converging handoff edge (§3.1)
      push({ kind: "agent_message", from_agent_id: agentId, to_agent_id: parent,
             content: `${nameOf(agentId)}: result handed up`, timestamp: lastTs });
    }
    // status proxies are weak in the corpus -> "ok"; carry completed_at
    push({ kind: "agent_complete", agent_id: agentId, exit_status: "ok", summary: "", timestamp: lastTs });
  };

  for (const id of order) {
    processAgent(id, id === rootId ? session.lines : subById.get(id)?.lines ?? []);
  }

  // ---- operation overlay (additive) ----
  // Lift agentic/workflow operations (Workflow/Skill/Agent/loop/...) into the
  // operation vocabulary and MERGE them in, re-stamping through the same per-key
  // seq counter so the combined stream stays contiguous per key (gap detection).
  // Existing leaf-tool, spawn-edge, message, usage events above are untouched.
  for (const op of operationsFromTools(session)) {
    const { seq: _drop, ...rest } = op as unknown as Record<string, unknown> & { seq?: number };
    void _drop;
    push(rest);
  }
  return out;
}
