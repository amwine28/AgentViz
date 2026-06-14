import type { AppState } from "./store";

/** Rung 1 credit assignment — provenance / reachability + dominators.
 *
 * GROUNDED, observer-only, deterministic, O(V+E)-ish. A pure peer of audit.ts
 * and graph.ts: `(state) => CreditReport`, reading only state.agents,
 * state.messageEdges, and state.outcomes.
 *
 * Rung 1 computes two genuinely MEASURED structural facts per agent:
 *   1. on_critical_path — could this agent's output have reached the terminal
 *      result (reverse-reachability to the sink)? A NECESSARY condition, NOT a
 *      causal claim.
 *   2. is_bottleneck — does EVERY path to the result pass through this agent
 *      (dominator)? A verifiable "removing it severs all flow" fact.
 * It NEVER writes the causal `credit` field (null) — structural reach is not
 * contribution. Causal credit is Rungs 2/3 (counterfactual / Shapley). */

export type CreditMethod = "structural" | "counterfactual" | "shapley" | "densified";

export interface AgentCredit {
  agent_id: string;
  name: string;
  credit: number | null;          // CAUSAL share — Rungs 2/3/4 only; null for Rung 1
  ci: [number, number] | null;    // null for deterministic (Rung 1)
  method: CreditMethod;
  basis: "measured" | "assumed";  // assumed only when the sink itself was inferred
  reason: string;                 // a verifiable fact, audit.ts-style — never an opinion
  on_critical_path: boolean;      // reverse-reachable to the sink (necessary condition)
  is_bottleneck: boolean;         // dominates the sink (every path passes through it)
  in_feedback_loop: boolean;      // member of a non-trivial SCC (credit not separable)
}

export interface CreditReport {
  outcome: {
    channel: string; value: number; scale: string;
    measured: boolean; source: string; grounded: boolean;
  } | null;
  method: CreditMethod;           // highest rung actually computed (Rung 1 => "structural")
  sink: { ids: string[]; basis: "measured" | "assumed"; resolved: boolean; converging: boolean };
  contributors: AgentCredit[];    // agents whose output reached the result
  dead_branches: string[];        // acted but output never reached the outcome (names)
  feedback_loops: string[][];     // SCCs whose members' credit cannot be separated (names)
}

// ---- Tarjan strongly-connected components (recursive; workflows are tiny) ----
function tarjanSCC(ids: string[], out: Map<string, Set<string>>): string[][] {
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];

  const strongconnect = (v: string) => {
    idx.set(v, index); low.set(v, index); index++;
    stack.push(v); onStack.add(v);
    for (const w of out.get(v) ?? []) {
      if (!idx.has(w)) {
        strongconnect(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, idx.get(w)!));
      }
    }
    if (low.get(v) === idx.get(v)) {
      const comp: string[] = [];
      let w: string;
      do { w = stack.pop()!; onStack.delete(w); comp.push(w); } while (w !== v);
      sccs.push(comp);
    }
  };

  for (const v of ids) if (!idx.has(v)) strongconnect(v);
  return sccs;
}

export function assignCredit(state: AppState, channel?: string): CreditReport {
  const agents = state.agents;
  const ids = Object.keys(agents);
  const idSet = new Set(ids);

  // ---- 1. filtered handoff DAG (ghost-edge filter + self-loop skip, per graph.ts) ----
  const out = new Map<string, Set<string>>();
  const inE = new Map<string, Set<string>>();
  for (const id of ids) { out.set(id, new Set()); inE.set(id, new Set()); }
  const addEdge = (u: string, v: string) => {
    if (u === v || !idSet.has(u) || !idSet.has(v)) return; // MANDATORY ghost filter
    out.get(u)!.add(v); inE.get(v)!.add(u);
  };
  for (const a of Object.values(agents)) {
    if (a.parent_id) addEdge(a.parent_id, a.id);          // spawn edge: parent -> child
  }
  for (const e of Object.values(state.messageEdges)) {
    addEdge(e.from_agent_id, e.to_agent_id);              // handoff edge: from -> to
  }

  // ---- pick the reward channel ----
  const chosen = channel
    ? state.outcomes[channel]
    : Object.values(state.outcomes).find((c) => c.terminal) ?? Object.values(state.outcomes)[0];
  const term = chosen?.terminal ?? null;
  const outcomeReport = term
    ? { channel: chosen!.channel, value: term.value, scale: chosen!.scale,
        measured: term.measured, source: term.source, grounded: term.source !== "llm_judge" }
    : null;

  // ---- 2. SCC condensation ----
  const sccs = tarjanSCC(ids, out);
  const sccOf = new Map<string, number>();
  sccs.forEach((comp, i) => comp.forEach((id) => sccOf.set(id, i)));
  const cOut = new Map<number, Set<number>>();
  const cIn = new Map<number, Set<number>>();
  for (let i = 0; i < sccs.length; i++) { cOut.set(i, new Set()); cIn.set(i, new Set()); }
  for (const [u, vs] of out) {
    for (const v of vs) {
      const su = sccOf.get(u)!, sv = sccOf.get(v)!;
      if (su !== sv) { cOut.get(su)!.add(sv); cIn.get(sv)!.add(su); }
    }
  }
  const feedback_loops = sccs.filter((c) => c.length > 1).map((c) => c.map((id) => agents[id].name));
  const loopMembers = new Set(sccs.filter((c) => c.length > 1).flat());

  // ---- 3. resolve sink set T ----
  let sinkIds: string[] = [];
  let basis: "measured" | "assumed" = "measured";
  if (term) {
    if (term.agent_id != null) {
      sinkIds = idSet.has(term.agent_id) ? [term.agent_id] : []; // not in idSet => orphaned
      basis = "measured";
    } else if (term.result_agent_ids && term.result_agent_ids.length) {
      sinkIds = term.result_agent_ids.filter((x) => idSet.has(x));
      basis = "measured";
    } else {
      // run-level, no hint: results converge at the root coordinator
      const roots = ids.filter((id) => {
        const p = agents[id].parent_id;
        return p == null || !idSet.has(p);
      });
      if (roots.length) {
        const pick = roots.slice().sort(
          (a, b) => (agents[b].completed_at ?? -Infinity) - (agents[a].completed_at ?? -Infinity)
        )[0];
        sinkIds = [pick];
      }
      basis = "assumed";
    }
  }
  const resolved = sinkIds.length > 0;

  if (!resolved) {
    return {
      outcome: outcomeReport, method: "structural",
      sink: { ids: [], basis, resolved: false, converging: false },
      contributors: [], dead_branches: ids.map((id) => agents[id].name), feedback_loops,
    };
  }

  // ---- 4. reverse-reachability from the sink SCC(s) ----
  const sinkSccs = new Set(sinkIds.map((id) => sccOf.get(id)!));
  const reachedSccs = new Set<number>(sinkSccs);
  const queue = [...sinkSccs];
  while (queue.length) {
    const s = queue.shift()!;
    for (const pred of cIn.get(s)!) {
      if (!reachedSccs.has(pred)) { reachedSccs.add(pred); queue.push(pred); }
    }
  }
  const contributorIds = new Set<string>();
  for (const sc of reachedSccs) for (const id of sccs[sc]) contributorIds.add(id);

  // ---- 5. dominators (removal test on the condensation) ----
  const sources = [...cIn.keys()].filter((s) => cIn.get(s)!.size === 0);
  const sinkReachableWithout = (removed: number): boolean => {
    const start = sources.filter((s) => s !== removed);
    const seen = new Set<number>(start);
    const q = [...start];
    while (q.length) {
      const n = q.shift()!;
      if (sinkSccs.has(n)) return true;
      for (const m of cOut.get(n)!) {
        if (m !== removed && !seen.has(m)) { seen.add(m); q.push(m); }
      }
    }
    // sink itself may be a source (start set) — covered above via sinkSccs check on dequeue
    return [...seen].some((n) => sinkSccs.has(n));
  };
  const bottleneckSccs = new Set<number>();
  for (const sc of reachedSccs) {
    if (sinkSccs.has(sc)) continue;          // the sink is not its own bottleneck
    if (sccs[sc].length !== 1) continue;     // a feedback loop is not a single decisive agent
    if (!sinkReachableWithout(sc)) bottleneckSccs.add(sc);
  }

  // ---- 6. assemble ----
  const converging = basis === "assumed" && contributorIds.size === ids.length && ids.length > 1;
  const contributors: AgentCredit[] = [];
  for (const id of contributorIds) {
    const scc = sccOf.get(id)!;
    const is_bottleneck = bottleneckSccs.has(scc);
    const in_feedback_loop = loopMembers.has(id);
    let reason: string;
    if (is_bottleneck) reason = "every path to the result passes through this agent (structural bottleneck)";
    else if (in_feedback_loop) reason = "in a feedback loop with peers; credit not separable structurally";
    else reason = "output reaches the terminal outcome (necessary condition)";
    contributors.push({
      agent_id: id, name: agents[id].name,
      credit: null, ci: null, method: "structural",
      basis: basis === "assumed" ? "assumed" : "measured",
      reason, on_critical_path: true, is_bottleneck, in_feedback_loop,
    });
  }
  contributors.sort((a, b) => a.name.localeCompare(b.name));
  const dead_branches = ids.filter((id) => !contributorIds.has(id)).map((id) => agents[id].name).sort();

  return {
    outcome: outcomeReport, method: "structural",
    sink: { ids: sinkIds, basis, resolved: true, converging },
    contributors, dead_branches, feedback_loops,
  };
}
