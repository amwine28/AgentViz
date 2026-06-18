"""CrewAI adapter: measure grounded counterfactual credit on a real framework.

A CrewAI Crew runs an ordered list of Tasks (sequential process): each Task's output
becomes context for the next. The adapter is a thin BRIDGE — it maps that ordered task
list onto the SAME `nodes`/`edges` shape the LangGraph engine already consumes (tasks ->
nodes, sequential order -> a linear chain of edges) and DELEGATES to the verified re-run
credit engine. Each task becomes an AgentViz agent; an ABLATED task contributes nothing
(its body never runs and it merges no state), so downstream tasks see the real consequence
of removing it. That is the grounded counterfactual — measured reward deltas with CIs,
never an LLM "rate this" opinion.

No dependency on the `crewai` package: the adapter consumes the runnable task_fns you
supply, and the real-Crew topology helper is duck-typed (tested here against a stub).
"""
import pytest
from agentviz import session
from agentviz.integrations.crewai import (
    crew_workflow, measure_crew_credit, crew_topology,
)


@pytest.mark.asyncio
async def test_sequential_crew_reports_reward(unused_tcp_port):
    # research -> draft -> edit, each adds to a running score; reward reads the final score.
    tasks = [
        ("research", lambda ctx: {"score": ctx.get("score", 0) + 0.5}),
        ("draft",    lambda ctx: {"score": ctx.get("score", 0) + 0.3}),
        ("edit",     lambda ctx: {"score": ctx.get("score", 0) + 0.2}),
    ]
    wf = crew_workflow(tasks, reward=lambda st: st.get("score", 0.0),
                       input=None, channel="quality", reward_source="eval_harness")
    s = session(name="t", port=unused_tcp_port, autostart_relay=False, dry_run=True)
    await s.connect(wait_timeout=0)
    await wf(s)
    await s.close(flush_timeout=0)
    assert abs(s.last_outcome["quality"]["value"] - 1.0) < 1e-9


@pytest.mark.asyncio
async def test_ablated_task_body_never_runs(unused_tcp_port):
    ran = {"draft": False}

    def draft(ctx):
        ran["draft"] = True
        return {"score": ctx.get("score", 0) + 0.3}

    tasks = [("research", lambda ctx: {"score": 0.5}), ("draft", draft)]
    wf = crew_workflow(tasks, reward=lambda st: st.get("score", 0.0),
                       input=None, channel="quality", reward_source="eval_harness")
    s = session(name="t", port=unused_tcp_port, autostart_relay=False, dry_run=True)
    s._ablated = {"draft"}                    # the engine ablates by task (node) name
    await s.connect(wait_timeout=0)
    await wf(s)
    await s.close(flush_timeout=0)
    assert ran["draft"] is False              # removed task contributes nothing
    assert abs(s.last_outcome["quality"]["value"] - 0.5) < 1e-9  # only research's 0.5 survives


def test_measure_credit_recovers_task_contributions():
    # A sequential crew of 3 tasks where each task's marginal value is known; the 4th is idle.
    tasks = [
        ("researcher", lambda ctx: {"score": ctx.get("score", 0) + 0.5}),
        ("writer",     lambda ctx: {"score": ctx.get("score", 0) + 0.3}),
        ("idle",       lambda ctx: {"score": ctx.get("score", 0) + 0.0}),
    ]
    res = measure_crew_credit(
        tasks, reward=lambda st: st.get("score", 0.0),
        channel="quality", samples=25, seed=1, publish=False,
    )
    by = {r.agent_id: r for r in res}
    assert abs(by["researcher"].credit - 0.5) < 0.02    # measured by re-run, not opinion
    assert abs(by["writer"].credit - 0.3) < 0.02
    assert by["idle"].credit_state == "tight_null"      # confidently ~0, surfaced not hidden


def test_node_name_falls_back_to_agent_role():
    # A task given without an explicit node name is allowed to be (None, fn) only when a
    # role is supplied via agent_names; here we just confirm names drive the credit keys.
    tasks = [
        ("plan", lambda ctx: {"score": ctx.get("score", 0) + 0.4}),
        ("act",  lambda ctx: {"score": ctx.get("score", 0) + 0.6}),
    ]
    res = measure_crew_credit(
        tasks, reward=lambda st: st.get("score", 0.0),
        channel="q", samples=20, seed=2, publish=False,
    )
    by = {r.agent_id: r for r in res}
    assert set(by) == {"plan", "act"}
    assert abs(by["plan"].credit - 0.4) < 0.03
    assert abs(by["act"].credit - 0.6) < 0.03


def test_crew_topology_duck_typed():
    # A stub mimicking a real CrewAI Crew: .tasks is an ordered list; each task exposes a
    # .name (or falls back to .agent.role). No import of the crewai package.
    class _Agent:
        def __init__(self, role):
            self.role = role

    class _Task:
        def __init__(self, name=None, role=None):
            if name is not None:
                self.name = name
            self.agent = _Agent(role) if role is not None else None

    class _Crew:
        tasks = [
            _Task(name="research"),
            _Task(role="Senior Writer"),     # no name -> agent.role
            _Task(name="edit"),
        ]

    names, edges = crew_topology(_Crew())
    assert names == ["research", "Senior Writer", "edit"]
    assert edges == [("research", "Senior Writer"), ("Senior Writer", "edit")]
