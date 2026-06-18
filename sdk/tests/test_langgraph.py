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


@pytest.mark.asyncio
async def test_retry_loop_converges(unused_tcp_port):
    # worker -> check -> (router: not done -> worker, else END).
    # worker adds 0.25 each pass and counts passes; check marks done once score >= 1.0.
    # This graph is CYCLIC (check routes back to worker) — the topo-only runner raised.
    def worker(st):
        return {"score": st.get("score", 0) + 0.25, "passes": st.get("passes", 0) + 1}

    def check(st):
        return {"done": st.get("score", 0) >= 1.0}

    nodes = {"worker": worker, "check": check}
    edges = [("worker", "check")]                      # static forward edge
    cond = [("check", lambda st: "END" if st.get("done") else "worker",
             {"worker": "worker", "END": "END"})]      # loop back until done
    wf = langgraph_workflow(nodes, edges, conditional_edges=cond, entry=["worker"],
                            reward=lambda st: st.get("score", 0.0), channel="q")
    s = session(name="t", port=unused_tcp_port, autostart_relay=False, dry_run=True)
    await s.connect(wait_timeout=0)
    await wf(s)                                         # must terminate, not hang
    await s.close(flush_timeout=0)
    # 0.25 * 4 passes == 1.0 ; loop stops the pass that reaches done.
    assert abs(s.last_outcome["q"]["value"] - 1.0) < 1e-9


def test_ablation_in_loop_is_a_real_consequence():
    # worker advances score; check loops back until score >= 1.0 (capped at max_steps so a
    # degraded run is still a REAL outcome). Ablating `worker` means the loop never advances
    # toward done — it spins until the hard cap and the reward stays 0.0. That extra looping
    # is the HONEST counterfactual: worker is load-bearing, measured, not held fixed. The
    # measurement must RETURN (the cap guarantees no hang under ablation).
    def worker(st):
        return {"score": st.get("score", 0) + 0.25}

    def check(st):
        return {"done": st.get("score", 0) >= 1.0}

    nodes = {"worker": worker, "check": check}
    edges = [("worker", "check")]
    cond = [("check", lambda st: "END" if st.get("done") else "worker",
             {"worker": "worker", "END": "END"})]
    res = measure_langgraph_credit(
        nodes, edges, conditional_edges=cond, entry=["worker"], input={},
        reward=lambda st: st.get("score", 0.0), channel="q",
        max_steps=50, samples=10, seed=1, publish=False,
    )
    by = {r.agent_id: r for r in res}
    # Baseline reward is 1.0 (converges); ablating worker drops it to 0.0 (loop never
    # advances, caps out) — worker's credit is the full, real drop.
    assert abs(by["worker"].credit - 1.0) < 0.02


@pytest.mark.asyncio
async def test_termination_cap_stops_a_nonconverging_loop(unused_tcp_port):
    # A router that NEVER says done — without a hard cap this loops forever. The cap must
    # STOP it at max_steps and still report a reward on the current state (a capped run is
    # a real, if degraded, outcome — grounded). Assert the call RETURNS (no hang).
    def worker(st):
        return {"score": st.get("score", 0) + 0.1, "passes": st.get("passes", 0) + 1}

    nodes = {"worker": worker}
    edges = []
    cond = [("worker", lambda st: "worker", {"worker": "worker"})]   # always loop back
    wf = langgraph_workflow(nodes, edges, conditional_edges=cond, entry=["worker"],
                            reward=lambda st: st.get("passes", 0), channel="q",
                            max_steps=20)
    s = session(name="t", port=unused_tcp_port, autostart_relay=False, dry_run=True)
    await s.connect(wait_timeout=0)
    await wf(s)                                         # must return; the cap prevents a hang
    await s.close(flush_timeout=0)
    # exactly max_steps node executions, then stop and report on current state.
    assert s.last_outcome["q"]["value"] == 20


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
