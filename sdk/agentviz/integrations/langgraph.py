"""LangGraph adapter — grounded counterfactual credit on a graph you already built.

LangGraph is a graph of nodes (functions/agents) and edges (transitions). You build it
declaratively: `add_node(name, fn)` and `add_edge(src, dst)`. This adapter consumes that
SAME spec — a `nodes: {name: fn}` dict and an `edges: [(src, dst)]` list — and turns it
into the `workflow(session)` callable the verified re-run engine consumes. So you get
LIVE Rung-2 counterfactual credit on your real pipeline with no hand-wrapping and no
reimplementation of the credit math or the dry-run safety layer.

How a node maps:
  - Each node becomes an AgentViz agent (visible in 3D / 2D / FLOW), spawned in
    topological order with handoff edges drawn between connected nodes.
  - When the re-run engine ABLATES a node, that node's body NEVER runs and it merges
    no state — downstream nodes see the real consequence of its absence. That delta IS
    its causal credit. Nothing is faked; a removed node genuinely contributes nothing.
  - After the DAG runs, your `reward(final_state)` is reported as the terminal outcome.

Grounding boundaries (honest scope):
  - DAGs: linear, branching, joins, AND conditional routing (add_conditional_edges). A
    router runs on the live, possibly-ablated state, so a deterministic reroute caused by a
    node's absence is measured as a real consequence — the honest counterfactual. NOT yet:
    cycles / retry loops (the runner requires a DAG and raises on a cycle).
  - This measures TOTAL causal effect (let the graph reroute). A "content-only" estimand
    that holds the orchestration fixed is deliberately different and not the default — it
    would conceal a real causal pathway; it's a documented opt-in for later.
  - State is merged last-writer-wins (LangGraph's default for un-reduced channels).
    Accumulate inside the node (`{"x": state.get("x",0)+v}`) rather than relying on a
    custom channel reducer in this slice.
  - Re-runs RE-EXECUTE non-ablated node bodies (the engine forces dry_run=True, so any
    side effect routed through `agent.tool_call` is mocked — but a node that performs an
    external side effect *directly* will repeat it). Route real side effects through
    `tool_call(side_effect="external")`, or measure on a side-effect-free pipeline.
    Measuring causal credit costs real re-runs (and real LLM tokens) — that is the
    honest price of a measured answer over a guessed one.

No import dependency on `langgraph`: the adapter consumes the spec you wrote, and the
compiled-graph helper is duck-typed against LangGraph's stable public surface.
"""
import inspect
from collections.abc import Awaitable, Callable
from typing import Any

from ..session import Session
from ..rerun import measure_credit_by_rerun
from ..counterfactual import CounterfactualResult
from ..events import AgentMessageEvent, serialize

# A LangGraph node: (state) -> a partial state update (sync or async), LangGraph-style.
NodeFn = Callable[[dict], "dict | Awaitable[dict]"]

# LangGraph's virtual entry/exit markers — never real agents.
_SENTINELS = frozenset({"__start__", "__end__", "START", "END"})


def _topo_order(node_names: list[str], edges: list[tuple[str, str]]):
    """Kahn topological sort over the real (non-sentinel) nodes. Deterministic:
    among nodes that are ready at the same time, declared order wins, so a fixed
    pipeline replays identically across re-runs. Returns (order, successors, predecessors).
    Raises ValueError on a cycle (slice 1 supports DAGs)."""
    real = [n for n in node_names if n not in _SENTINELS]
    real_set = set(real)
    pos = {n: i for i, n in enumerate(real)}
    succ: dict[str, list[str]] = {n: [] for n in real}
    preds: dict[str, list[str]] = {n: [] for n in real}
    indeg: dict[str, int] = {n: 0 for n in real}
    for src, dst in edges:
        if src in real_set and dst in real_set:
            succ[src].append(dst)
            preds[dst].append(src)
            indeg[dst] += 1
    ready = [n for n in real if indeg[n] == 0]
    order: list[str] = []
    while ready:
        ready.sort(key=lambda x: pos[x])
        n = ready.pop(0)
        order.append(n)
        for m in succ[n]:
            indeg[m] -= 1
            if indeg[m] == 0:
                ready.append(m)
    if len(order) != len(real):
        raise ValueError(
            "LangGraph spec has a cycle; the counterfactual runner supports DAGs (slice 1)"
        )
    return order, succ, preds


def _resolve_targets(ret: Any, path_map: dict | None) -> list[str]:
    """Map a router's return value to a list of target node names. The router may return
    a key in `path_map`, a target node name directly, or a list of either; sentinels
    (__end__ etc.) resolve to nothing (that branch terminates)."""
    raw = list(ret) if isinstance(ret, (list, tuple)) else [ret]
    out: list[str] = []
    for v in raw:
        if path_map and v in path_map:
            mapped = path_map[v]
            out.extend(mapped if isinstance(mapped, (list, tuple)) else [mapped])
        else:
            out.append(v)                          # a node name returned directly
    return [t for t in out if t not in _SENTINELS]


# A conditional edge: (source_node, router_fn(state)->key|name|list, path_map | None).
ConditionalEdge = tuple[str, Callable[[dict], Any], "dict | None"]


def langgraph_workflow(
    nodes: dict[str, NodeFn],
    edges: list[tuple[str, str]],
    *,
    conditional_edges: list[ConditionalEdge] | None = None,
    entry: Any = None,        # entry node(s); derived from in-degree-0 nodes if omitted
    input: dict | None = None,
    reward: Callable[[dict], float],
    channel: str = "reward",
    reward_source: str = "eval_harness",
):
    """Build the `workflow(session)` callable the re-run engine consumes from a LangGraph
    spec. The runner is a frontier-gated DAG traversal: a node runs only when an incoming
    edge activates it (so conditional branches and joins are honored, not "run everything").
    Each node is an agent; an ablated node's body never runs (contributes nothing);
    `reward(final_state)` is the terminal outcome.

    Conditional routing is the HONEST counterfactual: routers run on the live (possibly
    ablated) state, so if removing a node deterministically reroutes the graph, that
    rerouting is measured as the real consequence of the node's absence — not hidden. The
    per-sample CRN already threaded by the engine (s.sample) cancels stochastic NOISE (the
    only true artifact); a stochastic router should seed on `state["__agentviz_sample__"]`
    so baseline and ablated share its coin. (A "content-only" mode that holds routes fixed
    is a deliberately DIFFERENT estimand — see the module docstring — and is not the default,
    because it would conceal a real causal pathway.)

    Note: a pure router node whose decision lives in the edge `router_fn` (not in its body)
    shows ~0 content credit — ablating its body changes nothing while the router still runs.
    Crediting a routing DECISION is a separate counterfactual (documented next step)."""
    real_names = [n for n in nodes if n not in _SENTINELS]
    rset = set(real_names)
    cond_map: dict[str, tuple[Callable[[dict], Any], dict | None]] = {
        src: (router, pmap) for (src, router, pmap) in (conditional_edges or [])
    }

    # Full edge set (static + declared conditional targets) → topological order + in-degree.
    full_edges: list[tuple[str, str]] = [(u, v) for (u, v) in edges if u in rset and v in rset]
    for src, (_router, pmap) in cond_map.items():
        for mapped in (pmap or {}).values():
            for t in (mapped if isinstance(mapped, (list, tuple)) else [mapped]):
                if t in rset:
                    full_edges.append((src, t))
    order, _succ, _preds = _topo_order(real_names, full_edges)

    static_succ: dict[str, list[str]] = {n: [] for n in real_names}
    for (u, v) in edges:
        if u in rset and v in rset:
            static_succ[u].append(v)

    if entry:
        entry_nodes = [e for e in (entry if isinstance(entry, (list, tuple)) else [entry])
                       if e in rset]
    else:
        indeg = {n: 0 for n in real_names}
        for (_u, v) in full_edges:
            indeg[v] += 1
        entry_nodes = [n for n in real_names if indeg[n] == 0]

    async def workflow(s: Session) -> None:
        state = dict(input or {})
        # Expose the per-run sample index so stochastic nodes (and routers) can apply Common
        # Random Numbers (reproducible-but-varied noise) — baseline/ablated pairs share noise,
        # giving the CI honest width and cancelling noise-driven reroutes.
        state["__agentviz_sample__"] = s.sample
        active = {n: False for n in real_names}
        for n in entry_nodes:
            active[n] = True
        activated_by: dict[str, list[str]] = {n: [] for n in real_names}
        ids: dict[str, str] = {}

        for name in order:
            if not active[name]:
                continue                           # not on the taken path this run
            async with s.agent(name) as a:
                ids[name] = a.agent_id
                # Draw handoff edges from the predecessors that actually activated this node.
                for p in activated_by[name]:
                    pid = ids.get(p)
                    if pid is not None:
                        await s.client.send(serialize(AgentMessageEvent(
                            from_agent_id=pid, to_agent_id=a.agent_id,
                            content=f"{p} → {name}")))
                if not a.is_ablated():
                    out = nodes[name](state)
                    if inspect.isawaitable(out):
                        out = await out
                    if out:
                        state.update(out)          # last-writer-wins (LangGraph default)

                # Routing runs on the live (possibly ablated) state — the honest
                # counterfactual: a deterministic reroute caused by a node's absence is a
                # real consequence, not an artifact (noise is cancelled by sample-CRN).
                if name in cond_map:
                    router, pmap = cond_map[name]
                    targets = _resolve_targets(router(state), pmap)
                else:
                    targets = static_succ[name]
                for t in targets:
                    if t in active:
                        active[t] = True
                        activated_by[t].append(name)

        await s.report_outcome(float(reward(state)), channel=channel, source=reward_source)

    return workflow


def measure_langgraph_credit(
    nodes: dict[str, NodeFn],
    edges: list[tuple[str, str]],
    *,
    conditional_edges: list[ConditionalEdge] | None = None,
    entry: Any = None,
    input: dict | None = None,
    reward: Callable[[dict], float],
    agent_names: list[str] | None = None,
    samples: int = 80,
    channel: str = "reward",
    seed: int = 0,
    port: int | None = None,
    method: str = "counterfactual",
    publish: bool = True,
    reward_source: str = "eval_harness",
) -> list[CounterfactualResult]:
    """Measure each LangGraph node's grounded counterfactual credit by re-running the
    pipeline with that node ablated. Thin wrapper over the verified re-run engine — the
    credit numbers are measured reward deltas with confidence intervals, never opinions.
    Conditional edges are honored with routing-CRN (the baseline path is replayed under
    ablation, so credit reflects content, not rerouting)."""
    wf = langgraph_workflow(nodes, edges, conditional_edges=conditional_edges, entry=entry,
                            input=input, reward=reward, channel=channel,
                            reward_source=reward_source)
    names = list(agent_names) if agent_names is not None else [
        n for n in nodes if n not in _SENTINELS
    ]
    return measure_credit_by_rerun(
        wf, names, samples=samples, channel=channel, seed=seed, port=port,
        method=method, publish=publish,
    )


def topology_from_compiled(compiled: Any) -> tuple[list[str], list[tuple[str, str]], list[str]]:
    """Extract (node_names, edges, entry) from a real LangGraph CompiledStateGraph via
    its stable public `.get_graph()` surface, dropping the __start__/__end__ sentinels.
    Duck-typed — no import dependency on langgraph. Useful for visualizing a real graph's
    shape; the node callables for credit measurement come from the spec you already wrote."""
    g = compiled.get_graph()
    names = [n for n in g.nodes if n not in _SENTINELS]
    edges = [(e.source, e.target) for e in g.edges
             if e.source not in _SENTINELS and e.target not in _SENTINELS]
    entry = [e.target for e in g.edges
             if e.source in _SENTINELS and e.target not in _SENTINELS]
    return names, edges, entry
