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


def test_rerun_cascade_credits_parent_for_its_descendants():
    # planner -> lead -> worker. The worker is spawned REGARDLESS of lead's state, so this
    # exercises the STRUCTURAL cascade (_dead_ids): ablating lead neutralizes worker too,
    # and lead is credited for the whole subtree (lead 0.2 + cascaded worker 0.4 = 0.6).
    async def workflow(s):
        async with s.agent("planner") as p:
            q = 0.0
            async with s.agent("lead", parent_id=p.agent_id) as lead:
                if not lead.is_ablated():
                    await lead.tool_call(name="t", args={}, fn=lambda: 1, side_effect="pure")
                    q += 0.2
                async with s.agent("worker", parent_id=lead.agent_id) as w:
                    if not w.is_ablated():               # True via cascade when lead ablated
                        await w.tool_call(name="t", args={}, fn=lambda: 1, side_effect="pure")
                        q += 0.4
            await s.report_outcome(q, channel="quality", source="eval_harness")

    res = measure_credit_by_rerun(workflow, ["lead", "worker"],
                                  samples=25, channel="quality", seed=1, publish=False)
    by = {r.agent_id: r for r in res}
    assert abs(by["lead"].credit - 0.6) < 0.02     # 0.2 self + 0.4 cascaded worker
    assert abs(by["worker"].credit - 0.4) < 0.02


def test_rerun_produces_real_confidence_intervals_for_stochastic_workflow():
    import random
    def jitter(name, k):                      # reproducible per-(agent, sample) noise
        return random.Random(hash((name, k)) & 0xFFFFFFFF).gauss(0, 0.05)

    async def workflow(s):
        async with s.agent("planner") as p:
            q = 0.0
            for name, w in [("worker", 0.5), ("idle", 0.0)]:
                async with s.agent(name, parent_id=p.agent_id) as a:
                    if a.is_ablated():
                        continue
                    await a.tool_call(name="t", args={}, fn=lambda: 1, side_effect="pure")
                    q += w + jitter(name, s.sample)   # s.sample threaded by the engine
            await s.report_outcome(q, channel="quality", source="eval_harness")

    res = measure_credit_by_rerun(workflow, ["worker", "idle"],
                                  samples=150, channel="quality", seed=1, publish=False)
    by = {r.agent_id: r for r in res}
    w = by["worker"]
    assert w.ci[1] - w.ci[0] > 0          # a REAL interval, not a [x, x] point
    assert abs(w.credit - 0.5) < 0.05     # measured near the true contribution (the CI
                                          # brackets the ESTIMATE, not necessarily exactly 0.5)
    assert w.credit_state == "estimated"


def test_spawn_closure_includes_transitive_descendants():
    from agentviz.rerun import spawn_closure
    parent_of = {"lead": "planner", "worker": "lead", "sub": "worker", "other": "planner"}
    assert spawn_closure({"lead"}, parent_of) == {"lead", "worker", "sub"}
    assert spawn_closure({"planner"}, parent_of) == {"planner", "lead", "worker", "sub", "other"}
    assert spawn_closure({"other"}, parent_of) == {"other"}


def test_closure_neutralizes_a_reparented_descendant():
    # When 'parent' is ablated, this workflow RE-PARENTS 'child' to the (live) planner to
    # escape the UUID-based cascade. The name-based closure ablation (built from the baseline
    # topology) still neutralizes child, so 'parent' is correctly credited for the cascade
    # (0.6) instead of being under-credited (0.2) by a leak.
    async def workflow(s):
        async with s.agent("planner") as p:
            q = 0.0
            async with s.agent("parent", parent_id=p.agent_id) as parent:
                if not parent.is_ablated():
                    await parent.tool_call(name="t", args={}, fn=lambda: 1, side_effect="pure")
                    q += 0.2
                    async with s.agent("child", parent_id=parent.agent_id) as c:
                        if not c.is_ablated():
                            await c.tool_call(name="t", args={}, fn=lambda: 1, side_effect="pure")
                            q += 0.4
                else:
                    # re-parent to a LIVE agent — would escape the _dead_ids UUID cascade
                    async with s.agent("child", parent_id=p.agent_id) as c:
                        if not c.is_ablated():
                            await c.tool_call(name="t", args={}, fn=lambda: 1, side_effect="pure")
                            q += 0.4
            await s.report_outcome(q, channel="quality", source="eval_harness")

    res = measure_credit_by_rerun(workflow, ["parent", "child"],
                                  samples=25, channel="quality", seed=1, publish=False)
    by = {r.agent_id: r for r in res}
    assert abs(by["parent"].credit - 0.6) < 0.02     # cascade preserved despite re-parenting


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
