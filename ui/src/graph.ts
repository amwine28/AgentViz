import type { AppState } from "./store";

/** The workflow as a mathematical graph: G = (V, E) with node feature vectors,
 * weighted edges, and computed structural metrics. Serializes directly to
 * NetworkX node-link format — `networkx.node_link_graph(json.load(f))`. */

export interface GraphNode {
  id: string;
  name: string;
  parent: string | null;
  status: string;
  tool_calls: number;
  denials: number;
  avg_tool_ms: number;
  messages_sent: number;
  messages_received: number;
  logs: number;
  degree: number;
  betweenness: number;
}

export interface GraphLink {
  source: string;
  target: string;
  type: "spawn" | "message";
  weight: number; // message count (1 for spawn)
  chars: number;  // total message payload size
}

export interface GraphMetrics {
  agent_count: number;
  edge_count: number;
  message_total: number;
  density: number;       // edges / possible edges (undirected simple graph)
  hub: string | null;        // highest degree
  bottleneck: string | null; // highest betweenness centrality
  isolates: string[];        // no message edges at all
}

export interface WorkflowGraph {
  directed: true;
  multigraph: false;
  graph: { session: string; generated_by: string; event_count: number };
  nodes: GraphNode[];
  links: GraphLink[];
  metrics: GraphMetrics;
}

/** Brandes' algorithm, unweighted, on the undirected simple projection.
 * Workflows are small (tens of nodes) so O(V·E) is nothing. */
function betweenness(ids: string[], neighbors: Map<string, Set<string>>): Map<string, number> {
  const cb = new Map<string, number>(ids.map((v) => [v, 0]));
  for (const s of ids) {
    const stack: string[] = [];
    const pred = new Map<string, string[]>(ids.map((v) => [v, []]));
    const sigma = new Map<string, number>(ids.map((v) => [v, 0]));
    const dist = new Map<string, number>(ids.map((v) => [v, -1]));
    sigma.set(s, 1);
    dist.set(s, 0);
    const queue: string[] = [s];
    while (queue.length > 0) {
      const v = queue.shift()!;
      stack.push(v);
      for (const w of neighbors.get(v) ?? []) {
        if (dist.get(w)! < 0) {
          dist.set(w, dist.get(v)! + 1);
          queue.push(w);
        }
        if (dist.get(w) === dist.get(v)! + 1) {
          sigma.set(w, sigma.get(w)! + sigma.get(v)!);
          pred.get(w)!.push(v);
        }
      }
    }
    const delta = new Map<string, number>(ids.map((v) => [v, 0]));
    while (stack.length > 0) {
      const w = stack.pop()!;
      for (const v of pred.get(w)!) {
        delta.set(v, delta.get(v)! + (sigma.get(v)! / sigma.get(w)!) * (1 + delta.get(w)!));
      }
      if (w !== s) cb.set(w, cb.get(w)! + delta.get(w)!);
    }
  }
  // undirected: every pair counted twice
  for (const [v, c] of cb) cb.set(v, c / 2);
  return cb;
}

export function buildWorkflowGraph(state: AppState): WorkflowGraph {
  const agents = Object.values(state.agents);
  const ids = agents.map((a) => a.id);
  const idSet = new Set(ids);

  /* ---- edges ---- */
  const links: GraphLink[] = [];
  for (const a of agents) {
    if (a.parent_id && idSet.has(a.parent_id)) {
      links.push({ source: a.parent_id, target: a.id, type: "spawn", weight: 1, chars: 0 });
    }
  }
  const msgSent = new Map<string, number>();
  const msgRecv = new Map<string, number>();
  let messageTotal = 0;
  for (const e of Object.values(state.messageEdges)) {
    if (!idSet.has(e.from_agent_id) || !idSet.has(e.to_agent_id)) continue;
    msgSent.set(e.from_agent_id, (msgSent.get(e.from_agent_id) ?? 0) + e.messages.length);
    msgRecv.set(e.to_agent_id, (msgRecv.get(e.to_agent_id) ?? 0) + e.messages.length);
    messageTotal += e.messages.length;
    if (e.from_agent_id === e.to_agent_id) continue; // self-loops carry no structure
    links.push({
      source: e.from_agent_id,
      target: e.to_agent_id,
      type: "message",
      weight: e.messages.length,
      chars: e.messages.reduce((n, m) => n + m.content.length, 0),
    });
  }

  /* ---- undirected projection for structural metrics ---- */
  const neighbors = new Map<string, Set<string>>(ids.map((v) => [v, new Set<string>()]));
  for (const l of links) {
    neighbors.get(l.source)!.add(l.target);
    neighbors.get(l.target)!.add(l.source);
  }
  const cb = betweenness(ids, neighbors);

  /* ---- node feature vectors ---- */
  const nodes: GraphNode[] = agents.map((a) => {
    const done = a.tool_calls.filter((tc) => !tc.pending && !tc.denied && tc.duration_ms != null);
    return {
      id: a.id,
      name: a.name,
      parent: a.parent_id,
      status: a.status,
      tool_calls: a.tool_calls.length,
      denials: a.tool_calls.filter((tc) => tc.denied).length,
      avg_tool_ms: done.length
        ? Math.round(done.reduce((n, tc) => n + (tc.duration_ms ?? 0), 0) / done.length)
        : 0,
      messages_sent: msgSent.get(a.id) ?? 0,
      messages_received: msgRecv.get(a.id) ?? 0,
      logs: a.logs.length,
      degree: neighbors.get(a.id)!.size,
      betweenness: cb.get(a.id) ?? 0,
    };
  });

  /* ---- graph-level metrics ---- */
  const n = nodes.length;
  const undirectedEdges = new Set(links.map((l) => [l.source, l.target].sort().join("|"))).size;
  const byDegree = [...nodes].sort((x, y) => y.degree - x.degree);
  const byBetweenness = [...nodes].sort((x, y) => y.betweenness - x.betweenness);
  const metrics: GraphMetrics = {
    agent_count: n,
    edge_count: links.length,
    message_total: messageTotal,
    density: n > 1 ? undirectedEdges / ((n * (n - 1)) / 2) : 0,
    hub: byDegree[0]?.degree ? byDegree[0].name : null,
    bottleneck: byBetweenness[0]?.betweenness ? byBetweenness[0].name : null,
    isolates: nodes
      .filter((v) => v.messages_sent + v.messages_received === 0)
      .map((v) => v.name),
  };

  return {
    directed: true,
    multigraph: false,
    graph: {
      session: state.sessionName || "agentviz-run",
      generated_by: "agentviz",
      event_count: state.eventCount,
    },
    nodes,
    links,
    metrics,
  };
}
