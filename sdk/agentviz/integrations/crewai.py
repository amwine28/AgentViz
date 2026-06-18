"""CrewAI adapter — grounded counterfactual credit on a crew you already built.

CrewAI runs a Crew: an ordered list of `Task`s, each owned by an `Agent` (with a `role`).
Under the SEQUENTIAL process, each task runs in order and its output becomes the context for
the next. This adapter consumes that SAME shape — an ordered list of `(name, task_fn)` — and
maps it onto the linear `nodes`/`edges` graph the verified LangGraph re-run engine already
consumes (tasks -> nodes, sequential order -> edges `[(t0,t1),(t1,t2),...]`). So you get LIVE
Rung-2 counterfactual credit on your real crew with no reimplementation of the credit math or
the dry-run safety layer — this module DELEGATES to `agentviz.integrations.langgraph`; it does
not re-implement the executor.

How a task maps:
  - Each task becomes an AgentViz agent (visible in 3D / 2D / FLOW), spawned in crew order
    with a handoff edge drawn from the previous task.
  - `task_fn(context: dict) -> dict` returns a partial state update (CrewAI's output-becomes-
    context model). For a real crew this wraps the task's agent call — the USER supplies it.
  - When the re-run engine ABLATES a task, that task's body NEVER runs and it merges no state
    — downstream tasks see the real consequence of its absence. That delta IS its causal
    credit. Nothing is faked; a removed task genuinely contributes nothing.
  - After the crew runs, your `reward(final_state)` is reported as the terminal outcome.
    These measured credit numbers can feed `agentviz.recommend` (prune an idle task, harden a
    load-bearing one) — every recommendation traces to a measured fact, never an opinion.

Grounding boundaries (honest scope — the same boundary the LangGraph adapter draws):
  - SEQUENTIAL process only in v1. Hierarchical (a manager Agent delegates to workers) is a
    documented NEXT STEP: it adds dynamic, manager-driven routing whose counterfactual is a
    different (and richer) estimand than a fixed sequential chain.
  - The adapter does NOT reach into `crew.kickoff`. Measuring counterfactual credit REQUIRES
    re-running the crew many times with one task ablated, and CrewAI exposes no public
    per-task ablation seam inside kickoff — so YOU supply runnable `task_fn`s (the same
    boundary as the LangGraph adapter, which consumes the spec you wrote rather than hooking
    framework internals). `crew_topology` can still read a real Crew's shape for visualization.
  - Re-runs RE-EXECUTE non-ablated task bodies (the engine forces dry_run=True, so any side
    effect routed through `agent.tool_call` is mocked — but a task that performs an external
    side effect *directly* will repeat it). Route real side effects through
    `tool_call(side_effect="external")`, or measure on a side-effect-free crew. Measuring
    causal credit costs real re-runs (and real LLM tokens) — the honest price of a MEASURED
    answer over a guessed one. A re-run is headless and finite (a linear chain has no loop),
    so it never hangs and never fabricates a reward.

No import dependency on `crewai`: the adapter consumes the task_fns you wrote, and the
real-Crew topology helper is duck-typed against CrewAI's stable public surface.
"""
from collections.abc import Awaitable, Callable
from typing import Any

from ..counterfactual import CounterfactualResult
from .langgraph import langgraph_workflow, measure_langgraph_credit

# A CrewAI task body: (context) -> a partial state update (sync or async), CrewAI-style
# (the previous task's output becomes the next task's context).
TaskFn = Callable[[dict], "dict | Awaitable[dict]"]

# An ordered crew task: (node_name, task_fn). `name` may be None when an agent role is
# supplied positionally via `agent_names` (the node name then falls back to that role).
Task = tuple["str | None", TaskFn]


def _nodes_and_edges(
    tasks: list[Task], agent_names: list[str] | None,
) -> tuple[dict[str, TaskFn], list[tuple[str, str]], list[str]]:
    """Map an ordered crew task list onto the LangGraph (nodes, edges, names) shape.

    Node name = the task name if given, else the corresponding `agent_names[i]` (the agent's
    role). Edges are the sequential chain `[(t0,t1),(t1,t2),...]` — each task's output becomes
    the next task's context, exactly CrewAI's sequential process. Raises on a missing or
    duplicate name so credit keys are unambiguous (an honest measurement needs distinct ids)."""
    names: list[str] = []
    nodes: dict[str, TaskFn] = {}
    for i, (name, fn) in enumerate(tasks):
        resolved = name
        if resolved is None and agent_names is not None and i < len(agent_names):
            resolved = agent_names[i]
        if resolved is None:
            raise ValueError(
                f"crew task #{i} has no name; pass a name in the (name, task_fn) tuple "
                "or supply agent_names with the agent's role"
            )
        if resolved in nodes:
            raise ValueError(f"duplicate crew task name {resolved!r}; names must be unique")
        names.append(resolved)
        nodes[resolved] = fn
    edges = [(names[i], names[i + 1]) for i in range(len(names) - 1)]
    return nodes, edges, names


def crew_workflow(
    tasks: list[Task],
    *,
    reward: Callable[[dict], float],
    input: dict | None = None,
    channel: str = "reward",
    reward_source: str = "eval_harness",
):
    """Build the `workflow(session)` callable the re-run engine consumes from a sequential
    crew. Tasks map to nodes and the crew's order maps to a linear edge chain; this DELEGATES
    to `langgraph_workflow` (no executor duplication). An ablated task's body never runs and
    merges no state; `reward(final_state)` is the terminal outcome."""
    nodes, edges, _names = _nodes_and_edges(tasks, agent_names=None)
    return langgraph_workflow(
        nodes, edges, input=input, reward=reward, channel=channel,
        reward_source=reward_source,
    )


def measure_crew_credit(
    tasks: list[Task],
    *,
    reward: Callable[[dict], float],
    input: dict | None = None,
    samples: int = 80,
    channel: str = "reward",
    seed: int = 0,
    port: int | None = None,
    publish: bool = True,
    agent_names: list[str] | None = None,
    reward_source: str = "eval_harness",
    **kw: Any,
) -> list[CounterfactualResult]:
    """Measure each crew task's grounded counterfactual credit by re-running the crew with
    that task ablated. Thin wrapper over the verified re-run engine (via the LangGraph
    adapter) — the credit numbers are MEASURED reward deltas with confidence intervals, never
    an LLM opinion. A node that contributes ~0 is surfaced as `tight_null` (confidently no
    effect), not a fabricated number; a wide-CI result is `low_power_unknown` (honest unknown).

    `tasks` is an ordered list of `(name, task_fn)`; node names default to the task name (or
    the agent role at the same index in `agent_names`). The sequential process becomes a linear
    edge chain, so re-runs are headless and finite — they never hang and never fake a reward.
    Results feed `agentviz.recommend` directly. Extra keyword args are forwarded to the engine."""
    nodes, edges, names = _nodes_and_edges(tasks, agent_names=agent_names)
    return measure_langgraph_credit(
        nodes, edges, input=input, reward=reward, agent_names=names,
        samples=samples, channel=channel, seed=seed, port=port,
        publish=publish, reward_source=reward_source, **kw,
    )


def crew_topology(crew: Any) -> tuple[list[str], list[tuple[str, str]]]:
    """Extract (task_names, sequential_edges) from a real CrewAI `Crew` via its stable public
    surface (`crew.tasks`, each with a `.name` or an `.agent.role`). Duck-typed — NO import
    dependency on the `crewai` package. Everything is guarded: a task with neither a name nor
    an agent role falls back to a positional `task_{i}` so the topology is always extractable
    for visualization. The runnable task_fns for credit measurement come from the spec you
    supply (the adapter does not reach into crew.kickoff)."""
    tasks = list(getattr(crew, "tasks", None) or [])
    names: list[str] = []
    for i, t in enumerate(tasks):
        name = getattr(t, "name", None)
        if not name:
            agent = getattr(t, "agent", None)
            name = getattr(agent, "role", None) if agent is not None else None
        if not name:
            name = f"task_{i}"
        names.append(str(name))
    edges = [(names[i], names[i + 1]) for i in range(len(names) - 1)]
    return names, edges
