"""LangGraph adapter: measure grounded counterfactual credit on a real framework.

The adapter is a thin BRIDGE — it turns a LangGraph's declarative spec (the same
`nodes` dict and `edges` list you pass to StateGraph.add_node / add_edge) into the
`workflow(session)` callable the verified re-run engine already consumes. Each node
becomes an AgentViz agent; an ABLATED node contributes nothing (its body never runs
and it merges no state), so downstream nodes see the real consequence of removing it.
That is the grounded counterfactual — measured, never an opinion.

No dependency on the `langgraph` package: the adapter consumes the spec you already
wrote, and the compiled-graph helpers are duck-typed (tested here against a stub).
"""
import pytest
from agentviz import session
from agentviz.integrations.langgraph import (
    langgraph_workflow, measure_langgraph_credit, topology_from_compiled,
)


@pytest.mark.asyncio
async def test_linear_pipeline_reports_reward(unused_tcp_port):
    # A -> B -> C, each adds to a running score; reward reads the final score.
    nodes = {
        "a": lambda s: {"score": s.get("score", 0) + 0.5},
        "b": lambda s: {"score": s.get("score", 0) + 0.3},
        "c": lambda s: {"score": s.get("score", 0) + 0.2},
    }
    edges = [("a", "b"), ("b", "c")]
    wf = langgraph_workflow(nodes, edges, reward=lambda st: st.get("score", 0.0),
                            channel="quality")
    s = session(name="t", port=unused_tcp_port, autostart_relay=False, dry_run=True)
    await s.connect(wait_timeout=0)
    await wf(s)
    await s.close(flush_timeout=0)
    assert abs(s.last_outcome["quality"]["value"] - 1.0) < 1e-9


@pytest.mark.asyncio
async def test_ablated_node_body_never_runs(unused_tcp_port):
    ran = {"b": False}

    def b(s):
        ran["b"] = True
        return {"score": s.get("score", 0) + 0.3}

    nodes = {"a": lambda s: {"score": 0.5}, "b": b}
    edges = [("a", "b")]
    wf = langgraph_workflow(nodes, edges, reward=lambda st: st.get("score", 0.0),
                            channel="quality")
    s = session(name="t", port=unused_tcp_port, autostart_relay=False, dry_run=True)
    s._ablated = {"b"}                       # the engine ablates by node name
    await s.connect(wait_timeout=0)
    await wf(s)
    await s.close(flush_timeout=0)
    assert ran["b"] is False                 # removed node contributes nothing
    assert abs(s.last_outcome["quality"]["value"] - 0.5) < 1e-9   # only A's 0.5 survives


def test_measure_credit_recovers_node_contributions():
    # A linear LangGraph pipeline where each node's marginal value is known.
    nodes = {
        "retriever": lambda s: {"score": s.get("score", 0) + 0.5},
        "reasoner":  lambda s: {"score": s.get("score", 0) + 0.3},
        "verifier":  lambda s: {"score": s.get("score", 0) + 0.15},
        "idle":      lambda s: {"score": s.get("score", 0) + 0.0},
    }
    edges = [("retriever", "reasoner"), ("reasoner", "verifier"), ("verifier", "idle")]
    res = measure_langgraph_credit(
        nodes, edges, reward=lambda st: st.get("score", 0.0),
        channel="quality", samples=25, seed=1, publish=False,
    )
    by = {r.agent_id: r for r in res}
    assert abs(by["retriever"].credit - 0.5) < 0.02    # measured by re-run, not opinion
    assert abs(by["reasoner"].credit - 0.3) < 0.02
    assert abs(by["verifier"].credit - 0.15) < 0.02
    assert by["idle"].credit_state == "tight_null"     # confidently ~0, surfaced not hidden


def test_async_nodes_and_branching_dag():
    # A -> B, A -> C, B -> D, C -> D ; B is async. Each adds a known amount.
    async def b(s):
        return {"score": s.get("score", 0) + 0.3}
    nodes = {
        "a": lambda s: {"score": s.get("score", 0) + 0.5},
        "b": b,
        "c": lambda s: {"score": s.get("score", 0) + 0.2},
        "d": lambda s: {"score": s.get("score", 0) + 0.1},
    }
    edges = [("a", "b"), ("a", "c"), ("b", "d"), ("c", "d")]
    res = measure_langgraph_credit(
        nodes, edges, reward=lambda st: st.get("score", 0.0),
        channel="quality", samples=25, seed=1, publish=False,
    )
    by = {r.agent_id: r for r in res}
    assert abs(by["a"].credit - 0.5) < 0.02
    assert abs(by["b"].credit - 0.3) < 0.02
    assert abs(by["c"].credit - 0.2) < 0.02
    assert abs(by["d"].credit - 0.1) < 0.02


@pytest.mark.asyncio
async def test_sample_injected_into_state_for_crn(unused_tcp_port):
    # A stochastic node needs the per-run sample index to apply Common Random Numbers,
    # so baseline and ablated runs share noise and the CI has honest width. The adapter
    # exposes it under a reserved state key.
    seen = {}

    def a(st):
        seen["sample"] = st.get("__agentviz_sample__")
        return {"score": 1.0}

    wf = langgraph_workflow({"a": a}, [], reward=lambda st: st.get("score", 0.0),
                            channel="q")
    s = session(name="t", port=unused_tcp_port, autostart_relay=False, dry_run=True)
    s.sample = 7
    await s.connect(wait_timeout=0)
    await wf(s)
    await s.close(flush_timeout=0)
    assert seen["sample"] == 7


@pytest.mark.asyncio
async def test_conditional_routing_takes_only_the_chosen_branch(unused_tcp_port):
    # A routes to B (per its output); C is the un-taken branch and must NEVER run.
    ran = {"c": 0}

    def c(st):
        ran["c"] += 1
        return {"score": st.get("score", 0) + 99.0}     # would wreck reward if taken

    nodes = {
        "a": lambda st: {"score": 0.5, "route": "go_b"},
        "b": lambda st: {"score": st.get("score", 0) + 0.3},
        "c": c,
        "d": lambda st: {"score": st.get("score", 0) + 0.1},
    }
    edges = [("b", "d"), ("c", "d")]
    cond = [("a", lambda st: st.get("route", "go_c"), {"go_b": "b", "go_c": "c"})]
    wf = langgraph_workflow(nodes, edges, conditional_edges=cond, entry=["a"],
                            reward=lambda st: st.get("score", 0.0), channel="q")
    s = session(name="t", port=unused_tcp_port, autostart_relay=False, dry_run=True)
    await s.connect(wait_timeout=0)
    await wf(s)
    await s.close(flush_timeout=0)
    assert ran["c"] == 0                                  # un-taken branch skipped
    assert abs(s.last_outcome["q"]["value"] - 0.9) < 1e-9  # A 0.5 + B 0.3 + D 0.1


def test_conditional_reroute_under_ablation_is_a_real_consequence():
    # A sets the route to B and adds 0.5; the router reads A's output. Ablating A removes
    # its content AND (deterministically) reroutes to C — the HONEST counterfactual: A is
    # load-bearing, so its measured credit is the full drop (0.8 = its 0.5 + the lost B 0.3),
    # not a route-held 0.5. The superadditivity (A 0.8 + B 0.3 > 0.8 total) is the real
    # complementarity signal that Shapley (Rung 3) exists to deconflate — not papered over.
    nodes = {
        "a": lambda st: {"score": st.get("score", 0) + 0.5, "route": "go_b"},
        "b": lambda st: {"score": st.get("score", 0) + 0.3},
        "c": lambda st: {"score": st.get("score", 0) + 0.0},
    }
    edges = []  # b and c exist only as conditional targets of a
    cond = [("a", lambda st: st.get("route", "go_c"), {"go_b": "b", "go_c": "c"})]
    res = measure_langgraph_credit(
        nodes, edges, conditional_edges=cond, entry=["a"], input={},
        reward=lambda st: st.get("score", 0.0), channel="q",
        samples=25, seed=1, publish=False,
    )
    by = {r.agent_id: r for r in res}
    assert abs(by["a"].credit - 0.8) < 0.02       # load-bearing: removing A reroutes + loses B
    assert abs(by["b"].credit - 0.3) < 0.02       # B's own content (A still routes to it)
    assert by["c"].credit_state == "tight_null"   # never on the taken path in baseline


def test_topology_from_compiled_duck_typed():
    # A stub mimicking the stable public surface of a LangGraph CompiledStateGraph:
    # .get_graph() -> object with .nodes (dict) and .edges (list of source/target).
    class _Edge:
        def __init__(self, source, target):
            self.source, self.target = source, target

    class _Graph:
        nodes = {"__start__": object(), "retriever": object(),
                 "reasoner": object(), "__end__": object()}
        edges = [_Edge("__start__", "retriever"), _Edge("retriever", "reasoner"),
                 _Edge("reasoner", "__end__")]

    class _Compiled:
        def get_graph(self):
            return _Graph()

    names, edges, entry = topology_from_compiled(_Compiled())
    assert names == ["retriever", "reasoner"]                 # sentinels dropped
    assert edges == [("retriever", "reasoner")]               # sentinel edges dropped
    assert entry == ["retriever"]                             # target of __start__
