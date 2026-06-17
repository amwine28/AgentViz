"""Re-run engine, slice 1: the ablation primitive + measure_credit_by_rerun.

Proves LIVE counterfactual credit by actually re-executing a workflow with an agent
ablated — every re-run forced through dry_run=True, so the verified safety layer
guarantees zero real side effects. The demo workflow is in-envelope (C1-C3): value
flows through SDK channels, reward is session-scope, no out-of-band dataflow."""
import asyncio
import pytest
from agentviz import session
from agentviz.rerun import measure_credit_by_rerun
from agentviz.exceptions import RerunRefused


@pytest.mark.asyncio
async def test_ablated_agent_is_neutralized(unused_tcp_port):
    called = {"v": False}
    s = session(name="t", port=unused_tcp_port, autostart_relay=False, dry_run=True)
    s._ablated = {"worker"}                       # the engine sets which agents to ablate
    await s.connect(wait_timeout=0)               # headless: no relay needed for the measurement
    async with s.agent("worker") as a:
        assert a.is_ablated() is True
        r = await a.tool_call(name="x", args={}, fn=lambda: called.__setitem__("v", True),
                              side_effect="pure")  # even a PURE tool is muted when ablated
    await s.close(flush_timeout=0)
    assert called["v"] is False
    assert r is None


@pytest.mark.asyncio
async def test_non_ablated_agent_runs_pure_tool(unused_tcp_port):
    called = {"v": False}
    s = session(name="t", port=unused_tcp_port, autostart_relay=False, dry_run=True)
    await s.connect(wait_timeout=0)
    async with s.agent("worker") as a:
        assert a.is_ablated() is False
        r = await a.tool_call(name="x", args={},
                              fn=lambda: (called.__setitem__("v", True), 7)[1], side_effect="pure")
    await s.close(flush_timeout=0)
    assert called["v"] is True
    assert r == 7


@pytest.mark.asyncio
async def test_ablation_cascades_to_children(unused_tcp_port):
    s = session(name="t", port=unused_tcp_port, autostart_relay=False, dry_run=True)
    s._ablated = {"parent"}
    await s.connect(wait_timeout=0)
    async with s.agent("parent") as p:
        assert p.is_ablated() is True
        async with s.agent("child", parent_id=p.agent_id) as c:
            assert c.is_ablated() is True         # cascade: parent_id (UUID) in _dead_ids
    await s.close(flush_timeout=0)


@pytest.mark.asyncio
async def test_session_captures_last_outcome(unused_tcp_port):
    s = session(name="t", port=unused_tcp_port, autostart_relay=False, dry_run=True)
    await s.connect(wait_timeout=0)
    await s.report_outcome(0.7, channel="q")
    assert s.last_outcome["q"]["value"] == 0.7
    await s.close(flush_timeout=0)


def test_measure_credit_by_rerun_recovers_contributions():
    # in-envelope workflow: retriever contributes 0.5, reasoner 0.3, slacker 0 (redundant/idle)
    async def workflow(s):
        async with s.agent("planner") as p:
            quality = 0.0
            for name, w in [("retriever", 0.5), ("reasoner", 0.3), ("slacker", 0.0)]:
                async with s.agent(name, parent_id=p.agent_id) as a:
                    if a.is_ablated():
                        continue                  # ablated agent contributes nothing (short-circuit)
                    await a.tool_call(name="work", args={}, fn=(lambda w=w: w), side_effect="pure")
                    await s.send_message(name, "planner", f"{name} done")
                    quality += w
            await s.report_outcome(quality, channel="quality", source="eval_harness")

    res = measure_credit_by_rerun(
        workflow, ["retriever", "reasoner", "slacker"],
        samples=25, channel="quality", seed=1, publish=False,
    )
    by = {r.agent_id: r for r in res}
    assert abs(by["retriever"].credit - 0.5) < 0.02      # measured by re-run, not opinion
    assert abs(by["reasoner"].credit - 0.3) < 0.02
    assert by["slacker"].credit_state == "tight_null"     # confidently ~0 (idle), not hidden


def test_rerun_refuses_when_no_terminal_outcome():
    # workflow that never reports a terminal reward -> engine refuses (honest-unknown)
    async def workflow(s):
        async with s.agent("a") as a:
            await a.tool_call(name="x", args={}, fn=lambda: 1, side_effect="pure")
        # no s.report_outcome
    with pytest.raises(RerunRefused):
        measure_credit_by_rerun(workflow, ["a"], samples=20, channel="quality", seed=1, publish=False)


def test_rerun_refuses_when_reward_unmeasured():
    # an outcome explicitly tagged measured=False is NOT a real measurement
    async def workflow(s):
        async with s.agent("a"):
            pass
        await s.report_outcome(0.0, channel="quality", measured=False)
    with pytest.raises(RerunRefused):
        measure_credit_by_rerun(workflow, ["a"], samples=20, channel="quality", seed=1, publish=False)
