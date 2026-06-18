"""Measure grounded counterfactual credit on a LangGraph pipeline.

Run:  python3 examples/langgraph_credit_demo.py

The pipeline is a 4-node research graph: retriever -> reasoner -> verifier -> stylist.
The SAME declarative spec (NODES + EDGES) drives both your real LangGraph (built below
if `langgraph` is installed) and AgentViz's credit measurement — one source of truth, no
hand-wrapping. AgentViz re-runs the graph with each node ablated and measures how much the
reward drops; that delta is the node's causal credit, with a confidence interval. The
numbers are measured, never an LLM opinion — and a node that does nothing is surfaced as a
confident ~0 (tight_null), not hidden.

This demo uses a stochastic reward (so the confidence intervals have real width) with each
node's true marginal contribution baked in, so you can see the measurement recover them:
    retriever ~0.45 · reasoner ~0.30 · verifier ~0.15 · stylist ~0.00 (cosmetic)
"""
import random

from agentviz.integrations.langgraph import measure_langgraph_credit, topology_from_compiled
from agentviz.recommend import recommend, format_recommendations

# Illustrative per-run cost ($) per node — in practice this comes from usage data.
COST_BY_NODE = {"retriever": 0.030, "reasoner": 0.020, "verifier": 0.010, "stylist": 0.006}


def _crn_noise(name: str, state: dict, sd: float = 0.04) -> float:
    """Reproducible-but-varied noise keyed on (node, sample): Common Random Numbers, so
    baseline and ablated runs share the wobble and only the removed node's effect survives."""
    k = state.get("__agentviz_sample__", 0)
    return random.Random(hash((name, k)) & 0xFFFFFFFF).gauss(0, sd)


def retriever(state: dict) -> dict:
    return {"score": state.get("score", 0.0) + 0.45 + _crn_noise("retriever", state)}


def reasoner(state: dict) -> dict:
    return {"score": state.get("score", 0.0) + 0.30 + _crn_noise("reasoner", state)}


def verifier(state: dict) -> dict:
    return {"score": state.get("score", 0.0) + 0.15 + _crn_noise("verifier", state)}


def stylist(state: dict) -> dict:
    # cosmetic pass — touches phrasing, contributes nothing to answer quality
    return {"score": state.get("score", 0.0) + 0.0}


# The single source of truth: the graph spec you'd pass to LangGraph's add_node / add_edge.
NODES = {"retriever": retriever, "reasoner": reasoner,
         "verifier": verifier, "stylist": stylist}
EDGES = [("retriever", "reasoner"), ("reasoner", "verifier"), ("verifier", "stylist")]


def build_real_langgraph():
    """Build the SAME graph as a real LangGraph, to prove the spec is faithful. Optional —
    skipped (with a note) if `langgraph` isn't installed. Returns the compiled graph or None."""
    try:
        from langgraph.graph import StateGraph, START, END
    except ImportError:
        return None
    b = StateGraph(dict)
    for name, fn in NODES.items():
        b.add_node(name, fn)
    b.add_edge(START, "retriever")
    for src, dst in EDGES:
        b.add_edge(src, dst)
    b.add_edge("stylist", END)
    return b.compile()


def main() -> None:
    graph = build_real_langgraph()
    if graph is not None:
        final = graph.invoke({"score": 0.0})
        names, edges, entry = topology_from_compiled(graph)
        print(f"Ran the REAL LangGraph once → score={final.get('score'):.3f}")
        print(f"  topology: nodes={names} entry={entry}\n")
    else:
        print("(`langgraph` not installed — measuring on the spec directly; "
              "`pip install langgraph` to also run the real graph.)\n")

    print("Measuring counterfactual credit (re-running with each node ablated)…\n")
    results = measure_langgraph_credit(
        NODES, EDGES,
        input={"score": 0.0},
        reward=lambda st: st.get("score", 0.0),
        channel="answer_quality",
        samples=200,
        seed=0,
        publish=True,            # publishes a credit_report so an open AgentViz UI lights up
    )

    print(f"{'node':<12}{'credit':>9}   {'95% CI':<18}{'state'}")
    print("-" * 52)
    for r in sorted(results, key=lambda r: -r.credit):
        ci = f"[{r.ci[0]:+.3f}, {r.ci[1]:+.3f}]"
        print(f"{r.agent_id:<12}{r.credit:>+9.3f}   {ci:<18}{r.credit_state}")
    print("\nMeasured reward deltas — the stylist shows ~0 (tight_null): real, not hidden.")

    # Turn the measurement into a decision — grounded, every rec traces to a measured fact.
    recs = recommend(results, cost_by_node=COST_BY_NODE, total_reward=0.90,
                     channel="answer_quality")
    print("\n── Recommendations ───────────────────────────────────────")
    print(format_recommendations(recs))


if __name__ == "__main__":
    main()
