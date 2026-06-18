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
  - Graphs: linear, branching, joins, conditional routing (add_conditional_edges), AND
    cycles / retry loops. A router runs on the live, possibly-ablated state, so a
    deterministic reroute (or an extra loop iteration) caused by a node's absence is measured
    as a real consequence — the honest counterfactual. A cyclic spec runs under a bounded
    `max_steps` cap so a re-run can never hang; a capped run reports the real current-state
    reward (a degraded but genuine outcome), never a fabricated one.
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


def _is_acyclic(real_names: list[str], full_edges: list[tuple[str, str]]) -> bool:
    """True iff the (static + declared-conditional) edge graph over the real nodes is a DAG.
    A Kahn pass that consumes every node means no cycle. Used to decide which executor runs:
    a DAG keeps the byte-for-byte topo behavior; a cyclic spec uses the bounded scheduler."""
    real_set = set(real_names)
    indeg: dict[str, int] = {n: 0 for n in real_names}
    succ: dict[str, list[str]] = {n: [] for n in real_names}
    for src, dst in full_edges:
        if src in real_set and dst in real_set:
            succ[src].append(dst)
            indeg[dst] += 1
    ready = [n for n in real_names if indeg[n] == 0]
    seen = 0
    while ready:
        n = ready.pop()
        seen += 1
        for m in succ[n]:
            indeg[m] -= 1
            if indeg[m] == 0:
                ready.append(m)
    return seen == len(real_names)


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
    max_steps: int = 1000,
):
    """Build the `workflow(session)` callable the re-run engine consumes from a LangGraph
    spec. The runner is a frontier-gated DAG traversal: a node runs only when an incoming
    edge activates it (so conditional branches and joins are honored, not "run everything").
    Each node is an agent; an ablated node's body never runs (contributes nothing);
    `reward(final_state)` is the terminal outcome.

    Cycles / retry loops: if a conditional edge can route BACK to an already-run node (e.g.
    `worker -> check -> (not done -> worker, else END)`), the spec is not a DAG and the topo
    executor would raise. For a cyclic spec the runner switches to a BOUNDED iterative
    scheduler: a deterministic FIFO worklist (declared-order tiebreak) seeded from the entry
    nodes; each step pops the next active node, runs its body (unless ablated — body skipped
    but routing STILL evaluated on the live state), merges its update (last-writer-wins),
    evaluates outgoing edges on the CURRENT state, and re-activates targets — which may be a
    node already executed (the loop-back). `max_steps` is a HARD CAP on total node executions
    (default 1000): when hit the run STOPS and reports `reward` on the current state — it never
    hangs and never raises inside the run. A capped run is a real, if degraded, outcome
    (grounded), so re-runs stay headless and finite on every input and every ablation. An
    acyclic spec keeps the byte-for-byte topo behavior, so existing DAGs are unaffected.

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
    acyclic = _is_acyclic(real_names, full_edges)
    # An acyclic spec keeps the byte-for-byte topo behavior (the DAG executor below); a
    # cyclic spec (a router can route back to an earlier node) uses the bounded scheduler.
    order: list[str] = _topo_order(real_names, full_edges)[0] if acyclic else []

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

    async def _run_node(s: Session, name: str, state: dict, ids: dict[str, str],
                        activated_by: list[str]) -> list[str]:
        """Open `name`'s agent, draw handoff edges from the predecessors that activated it,
        run its body (UNLESS ablated — body skipped but routing STILL evaluated on the live
        state), merge its update last-writer-wins, and return the resolved outgoing targets.
        Shared by both executors so cyclic and acyclic runs treat a node identically."""
        async with s.agent(name) as a:
            ids[name] = a.agent_id
            for p in activated_by:
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
                    state.update(out)              # last-writer-wins (LangGraph default)

            # Routing runs on the live (possibly ablated) state — the honest counterfactual:
            # a deterministic reroute (or extra loop iteration) caused by a node's absence is
            # a real consequence, not an artifact (noise is cancelled by sample-CRN).
            if name in cond_map:
                router, pmap = cond_map[name]
                return _resolve_targets(router(state), pmap)
            return static_succ[name]

    async def workflow(s: Session) -> None:
        state = dict(input or {})
        # Expose the per-run sample index so stochastic nodes (and routers) can apply Common
        # Random Numbers (reproducible-but-varied noise) — baseline/ablated pairs share noise,
        # giving the CI honest width and cancelling noise-driven reroutes.
        state["__agentviz_sample__"] = s.sample
        ids: dict[str, str] = {}

        if acyclic:
            # DAG executor — frontier-gated topological traversal (unchanged behavior).
            active = {n: False for n in real_names}
            for n in entry_nodes:
                active[n] = True
            activated_by: dict[str, list[str]] = {n: [] for n in real_names}
            for name in order:
                if not active[name]:
                    continue                       # not on the taken path this run
                targets = await _run_node(s, name, state, ids, activated_by[name])
                for t in targets:
                    if t in active:
                        active[t] = True
                        activated_by[t].append(name)
        else:
            # Cyclic executor — bounded deterministic FIFO worklist. Each item carries the
            # predecessor that activated it (for the handoff edge). A target may be a node
            # that already ran (the loop-back). `max_steps` caps TOTAL node executions on
            # EVERY path so no input or ablation can loop forever: when hit we STOP and
            # report on the current state — a capped run is a real, if degraded, outcome.
            queue: list[tuple[str, str | None]] = [(n, None) for n in entry_nodes]
            steps = 0
            while queue and steps < max_steps:
                name, pred = queue.pop(0)          # FIFO; declared-order seeding/tiebreak
                steps += 1
                targets = await _run_node(s, name, state, ids,
                                          [pred] if pred is not None else [])
                for t in targets:
                    if t in rset:
                        queue.append((t, name))    # may re-enqueue an already-run node

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
    max_steps: int = 1000,
) -> list[CounterfactualResult]:
    """Measure each LangGraph node's grounded counterfactual credit by re-running the
    pipeline with that node ablated. Thin wrapper over the verified re-run engine — the
    credit numbers are measured reward deltas with confidence intervals, never opinions.
    Conditional edges are honored as the HONEST counterfactual: a router runs on the live,
    possibly-ablated state, so a deterministic reroute caused by a node's absence is measured
    as a real consequence (not held to a fixed baseline path). Per-sample CRN cancels only
    noise — the rerouting itself is a real causal effect, never papered over.

    For a cyclic (retry-loop) spec, ablation is the HONEST counterfactual: if removing a node
    changes how many times the loop runs (a router depends on its output), that is a REAL
    consequence and is measured, not held fixed. `max_steps` caps total node executions per
    re-run so the headless, many-times-per-measurement loop NEVER hangs — a capped run is a
    real, if degraded, outcome (e.g. a reward that never reached `done`)."""
    wf = langgraph_workflow(nodes, edges, conditional_edges=conditional_edges, entry=entry,
                            input=input, reward=reward, channel=channel,
                            reward_source=reward_source, max_steps=max_steps)
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
