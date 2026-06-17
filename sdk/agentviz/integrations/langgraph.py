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

Grounding boundaries (honest scope, slice 1):
  - DAGs with deterministic edges (linear / branching). Conditional routing that depends
    on an ablated node's output is a documented next step (needs baseline-routing CRN).
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


def langgraph_workflow(
    nodes: dict[str, NodeFn],
    edges: list[tuple[str, str]],
    *,
    entry: Any = None,        # accepted for API symmetry; DAG entry is derived from edges
    input: dict | None = None,
    reward: Callable[[dict], float],
    channel: str = "reward",
    reward_source: str = "eval_harness",
):
    """Build the `workflow(session)` callable the re-run engine consumes from a LangGraph
    spec. Each node is an agent; an ablated node's body never runs; `reward(final_state)`
    is the terminal outcome."""
    order, _succ, preds = _topo_order(list(nodes), edges)

    async def workflow(s: Session) -> None:
        state = dict(input or {})
        # Expose the per-run sample index so stochastic nodes can apply Common Random
        # Numbers (reproducible-but-varied noise) — the engine threads it via s.sample,
        # giving baseline/ablated pairs shared noise and the CI honest width.
        state["__agentviz_sample__"] = s.sample
        ids: dict[str, str] = {}
        for name in order:
            async with s.agent(name) as a:
                ids[name] = a.agent_id
                # Draw handoff edges from already-run predecessors (UUIDs, so the live
                # view connects the right nodes). Headless re-runs have no relay; harmless.
                for p in preds[name]:
                    pid = ids.get(p)
                    if pid is not None:
                        await s.client.send(serialize(AgentMessageEvent(
                            from_agent_id=pid, to_agent_id=a.agent_id,
                            content=f"{p} → {name}")))
                if a.is_ablated():
                    continue                       # removed node: contributes nothing
                out = nodes[name](state)
                if inspect.isawaitable(out):
                    out = await out
                if out:
                    state.update(out)              # last-writer-wins (LangGraph default)
        await s.report_outcome(float(reward(state)), channel=channel, source=reward_source)

    return workflow


def measure_langgraph_credit(
    nodes: dict[str, NodeFn],
    edges: list[tuple[str, str]],
    *,
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
    credit numbers are measured reward deltas with confidence intervals, never opinions."""
    wf = langgraph_workflow(nodes, edges, entry=entry, input=input, reward=reward,
                            channel=channel, reward_source=reward_source)
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
