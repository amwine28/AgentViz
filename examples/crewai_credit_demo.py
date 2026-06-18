"""Measure grounded counterfactual credit on a CrewAI crew.

Run:  python3 examples/crewai_credit_demo.py

CrewAI runs a Crew as an ordered list of tasks (sequential process): each task's output
becomes the next task's context. This adapter consumes that SAME shape — an ordered list of
`(name, task_fn)` — and measures each task's causal credit by re-running the crew with that
task ablated, reusing the verified graph-credit engine (no reimplementation).

Honest boundary (same as the LangGraph adapter): you supply the runnable `task_fn`s — the
adapter does not reach into `crew.kickoff` (CrewAI exposes no public per-task ablation seam).
For a real crew, a task_fn wraps that task's agent call; here they're simulated with known
contributions so you can watch the measurement recover them:
    researcher ~0.50 · writer ~0.30 · editor ~0.15 · proofreader ~0.00 (cosmetic)
"""
import random

from agentviz.integrations.crewai import measure_crew_credit, crew_topology
from agentviz.recommend import recommend, format_recommendations


def _crn(name: str, ctx: dict, sd: float = 0.04) -> float:
    """Common Random Numbers: noise keyed on (task, sample) so baseline and ablated re-runs
    share the wobble and only the removed task's effect survives — honest CI width."""
    k = ctx.get("__agentviz_sample__", 0)
    return random.Random(hash((name, k)) & 0xFFFFFFFF).gauss(0, sd)


def researcher(ctx):  return {"score": ctx.get("score", 0.0) + 0.50 + _crn("researcher", ctx)}
def writer(ctx):      return {"score": ctx.get("score", 0.0) + 0.30 + _crn("writer", ctx)}
def editor(ctx):      return {"score": ctx.get("score", 0.0) + 0.15 + _crn("editor", ctx)}
def proofreader(ctx): return {"score": ctx.get("score", 0.0) + 0.00}   # cosmetic pass


# The sequential crew, as the ordered (name, task_fn) spec the adapter consumes.
TASKS = [("researcher", researcher), ("writer", writer),
         ("editor", editor), ("proofreader", proofreader)]
COST_BY_NODE = {"researcher": 0.040, "writer": 0.025, "editor": 0.012, "proofreader": 0.005}


# A duck-typed stand-in for a real CrewAI Crew, so crew_topology can be demonstrated without
# the crewai package (a real Agent needs an LLM to actually run).
class _StubAgent:
    def __init__(self, role): self.role = role


class _StubTask:
    def __init__(self, name, role): self.name = name; self.agent = _StubAgent(role)


class _StubCrew:
    tasks = [_StubTask("researcher", "Senior Researcher"), _StubTask("writer", "Content Writer"),
             _StubTask("editor", "Editor"), _StubTask("proofreader", "Proofreader")]


def main() -> None:
    names, edges = crew_topology(_StubCrew())
    print(f"Crew topology (sequential): {names}")
    print(f"  handoffs: {edges}\n")
    print("(task_fns simulate each task's contribution; in a real crew they wrap the agent call)\n")

    print("Measuring counterfactual credit (re-running the crew with each task ablated)…\n")
    results = measure_crew_credit(
        TASKS,
        input={"score": 0.0},
        reward=lambda ctx: ctx.get("score", 0.0),
        channel="answer_quality",
        samples=200, seed=0, publish=False,
    )

    print(f"{'task':<14}{'credit':>9}   {'95% CI':<18}{'state'}")
    print("-" * 54)
    for r in sorted(results, key=lambda r: -r.credit):
        ci = f"[{r.ci[0]:+.3f}, {r.ci[1]:+.3f}]"
        print(f"{r.agent_id:<14}{r.credit:>+9.3f}   {ci:<18}{r.credit_state}")

    recs = recommend(results, cost_by_node=COST_BY_NODE, total_reward=0.95,
                     channel="answer_quality")
    print("\n── Recommendations ───────────────────────────────────────")
    print(format_recommendations(recs))


if __name__ == "__main__":
    main()
