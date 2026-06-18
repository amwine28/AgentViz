"""Counterfactual credit on a LangGraph with CONDITIONAL routing (a supervisor pattern).

Run:  python3 examples/langgraph_conditional_demo.py

The canonical multi-agent LangGraph shape: a supervisor routes the query to ONE specialist,
then a writer composes the answer. AgentViz honors the routing — a router runs on the live
(possibly ablated) state, so credit reflects what really happens:
  - the chosen specialist gets real credit,
  - the un-chosen specialist is a confident ~0 (tight_null) — it never ran,
  - removing a node that *causes* a reroute is measured as that real consequence (the honest
    counterfactual), not hidden behind a held-fixed path.

This demo fixes the query as "research", so the baseline routes to the research specialist.
Stochastic per-node jitter (seeded by the run sample = Common Random Numbers) gives the
confidence intervals real width.
"""
import random

from agentviz.integrations.langgraph import measure_langgraph_credit, topology_from_compiled
from agentviz.recommend import recommend, format_recommendations


def _crn(name: str, state: dict, sd: float = 0.03) -> float:
    k = state.get("__agentviz_sample__", 0)
    return random.Random(hash((name, k)) & 0xFFFFFFFF).gauss(0, sd)


def classifier(state: dict) -> dict:
    # real work: reads the query and tags its kind (drives the supervisor's route)
    return {"kind": state.get("query_kind", "research"),
            "score": state.get("score", 0.0) + 0.20 + _crn("classifier", state)}


def research_specialist(state: dict) -> dict:
    return {"score": state.get("score", 0.0) + 0.50 + _crn("research", state)}


def code_specialist(state: dict) -> dict:
    return {"score": state.get("score", 0.0) + 0.50 + _crn("code", state)}


def writer(state: dict) -> dict:
    return {"score": state.get("score", 0.0) + 0.30 + _crn("writer", state)}


def route(state: dict) -> str:
    # the supervisor's decision: which specialist handles this query
    return "code" if state.get("kind") == "code" else "research"


NODES = {"classifier": classifier, "research_specialist": research_specialist,
         "code_specialist": code_specialist, "writer": writer}
STATIC_EDGES = [("research_specialist", "writer"), ("code_specialist", "writer")]
COND_EDGES = [("classifier", route,
               {"code": "code_specialist", "research": "research_specialist"})]


def build_real_langgraph():
    try:
        from typing import TypedDict
        from langgraph.graph import StateGraph, START, END
    except ImportError:
        return None

    # A typed schema = per-key last-writer-wins channels (normal LangGraph usage). This
    # matches how the adapter merges state, and keeps `kind` across nodes. (StateGraph(dict)
    # uses one root channel that replaces the whole state, dropping keys — a degenerate case.)
    class _State(TypedDict, total=False):
        query_kind: str
        kind: str
        score: float

    b = StateGraph(_State)
    for name, fn in NODES.items():
        b.add_node(name, fn)
    b.add_edge(START, "classifier")
    b.add_conditional_edges("classifier", route,
                            {"code": "code_specialist", "research": "research_specialist"})
    for src, dst in STATIC_EDGES:
        b.add_edge(src, dst)
    b.add_edge("writer", END)
    return b.compile()


def main() -> None:
    graph = build_real_langgraph()
    if graph is not None:
        final = graph.invoke({"query_kind": "research", "score": 0.0})
        print(f"Ran the REAL LangGraph (supervisor) once → score={final.get('score'):.3f}, "
              f"routed to {'research' if final.get('kind') == 'research' else 'code'}")
        try:                              # cosmetic topology print; LangGraph's static draw
            names, _edges, entry = topology_from_compiled(graph)   # dislikes some join shapes
            print(f"  nodes={names} entry={entry}\n")
        except Exception as exc:
            print(f"  (get_graph() topology unavailable for this join shape: "
                  f"{type(exc).__name__}; credit measurement is independent of it)\n")
    else:
        print("(`langgraph` not installed — measuring on the spec directly; "
              "`pip install langgraph` to also run the real graph.)\n")

    print("Measuring counterfactual credit across the conditional graph…\n")
    results = measure_langgraph_credit(
        NODES, STATIC_EDGES, conditional_edges=COND_EDGES, entry=["classifier"],
        input={"query_kind": "research", "score": 0.0},
        reward=lambda st: st.get("score", 0.0),
        channel="answer_quality", samples=200, seed=0, publish=True,
    )

    print(f"{'node':<22}{'credit':>9}   {'95% CI':<18}{'state'}")
    print("-" * 62)
    for r in sorted(results, key=lambda r: -r.credit):
        ci = f"[{r.ci[0]:+.3f}, {r.ci[1]:+.3f}]"
        print(f"{r.agent_id:<22}{r.credit:>+9.3f}   {ci:<18}{r.credit_state}")
    print("\ncode_specialist is ~0 (tight_null) — it never ran on the 'research' route. "
          "Honest, not hidden.")

    recs = recommend(results, total_reward=1.0, channel="answer_quality")
    print("\n── Recommendations ───────────────────────────────────────")
    print(format_recommendations(recs))
    print("\nNote the honesty: code_specialist is flagged a prune CANDIDATE, but the action says "
          "'review / verify', not 'delete' —\nit's tight_null only on THIS research query; it's "
          "essential for code queries. The measurement answers one\nreward channel; the human owns "
          "the decision. That caveat is the whole point.")


if __name__ == "__main__":
    main()
