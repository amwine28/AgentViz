"""Operations primitive tests.

Covers the live SDK emission API for agentic operations: operation_start /
operation_tick / operation_end, the async context-manager lifecycle (auto-end on
normal exit AND on exception), nesting (parent_op_id wiring + Operation.child),
Session(session-level, agent_id=None) vs Agent(agent_id set) scope, and the
FAMILY_OF single-source-of-truth derivation.

Uses the same fake-relay capture harness as test_session.py / test_outcome.py.
"""
import json
import typing

import pytest
import websockets

from agentviz import session, Operation
from agentviz.events import FAMILY_OF, OperationKind, OperationFamily
from agentviz.operations import family_of


def make_capture_relay(events_received):
    async def fake_relay(ws):
        async for raw in ws:
            events_received.append(json.loads(raw))
    return fake_relay


# --------------------------------------------------------------------------- #
# FAMILY_OF — single source of truth
# --------------------------------------------------------------------------- #

def test_family_of_covers_every_operation_kind_exactly_once():
    """FAMILY_OF is the single source of truth: every OperationKind maps to a
    valid OperationFamily, exactly once, with no extras."""
    op_kinds = set(typing.get_args(OperationKind))
    families = set(typing.get_args(OperationFamily))

    # Every op_type is present in the map exactly once (dict keys are unique),
    # and the key set matches the Literal exactly (no missing, no extra).
    assert set(FAMILY_OF.keys()) == op_kinds

    # Every mapped value is a declared family.
    assert set(FAMILY_OF.values()) <= families
    for op_type, family in FAMILY_OF.items():
        assert family in families, f"{op_type} -> unknown family {family!r}"


def test_family_of_helper_derives_family_per_op_type():
    """The family_of() helper agrees with FAMILY_OF for every declared kind and
    degrades gracefully (to 'state') for an unknown kind rather than raising."""
    for op_type, family in FAMILY_OF.items():
        assert family_of(op_type) == family
    # Representative spot checks across families.
    assert family_of("loop") == "recurrence"
    assert family_of("schedule") == "recurrence"
    assert family_of("workflow") == "orchestration"
    assert family_of("phase") == "orchestration"
    assert family_of("skill") == "command"
    assert family_of("mcp") == "command"
    assert family_of("plan_mode") == "mode"
    assert family_of("todo") == "state"
    # Unknown kind -> graceful fallback, no raise.
    assert family_of("not_a_real_op") == "state"


def test_operation_is_exported_from_package():
    assert Operation is not None


# --------------------------------------------------------------------------- #
# start / tick / end emission + field correctness
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_session_operation_emits_start_tick_end(unused_tcp_port):
    events = []
    async with websockets.serve(make_capture_relay(events), "localhost", unused_tcp_port):
        s = session(name="t", port=unused_tcp_port, autostart_relay=False)
        await s.connect()
        async with s.operation("loop", label="poll deploy",
                               detail={"interval_s": 300}) as op:
            assert isinstance(op, Operation)
            await op.tick(0, detail={"status_seen": "pending"})
            await op.tick(1, detail={"status_seen": "running"})
        await s.close()

    starts = [e for e in events if e["kind"] == "operation_start"]
    ticks = [e for e in events if e["kind"] == "operation_tick"]
    ends = [e for e in events if e["kind"] == "operation_end"]

    assert len(starts) == 1 and len(ticks) == 2 and len(ends) == 1
    start = starts[0]
    assert start["op_type"] == "loop"
    assert start["family"] == "recurrence"        # derived via FAMILY_OF
    assert start["label"] == "poll deploy"
    assert start["status"] == "running"
    assert start["parent_op_id"] is None
    assert start["agent_id"] is None              # session-level scope
    assert start["detail"]["interval_s"] == 300
    assert "op_id" in start and start["op_id"] == op.op_id

    # ticks carry op_id, 0-based n, and detail; same op as the start.
    assert [t["n"] for t in ticks] == [0, 1]
    assert all(t["op_id"] == op.op_id for t in ticks)
    assert ticks[0]["detail"]["status_seen"] == "pending"

    end = ends[0]
    assert end["op_id"] == op.op_id
    assert end["status"] == "complete"            # normal exit
    assert end["summary"] == ""


@pytest.mark.asyncio
async def test_tick_auto_increments_when_n_omitted(unused_tcp_port):
    """A self-paced op (no explicit n) gets 0-based monotonic tick indices."""
    events = []
    async with websockets.serve(make_capture_relay(events), "localhost", unused_tcp_port):
        s = session(name="t", port=unused_tcp_port, autostart_relay=False)
        await s.connect()
        async with s.operation("goal", label="self-paced") as op:
            n0 = await op.tick(detail={"progress": "step a"})
            n1 = await op.tick(detail={"progress": "step b"})
            n2 = await op.tick(detail={"progress": "step c"})
        await s.close()

    assert (n0, n1, n2) == (0, 1, 2)
    ticks = [e for e in events if e["kind"] == "operation_tick"]
    assert [t["n"] for t in ticks] == [0, 1, 2]
    # family derivation for a recurrence op_type other than loop.
    start = next(e for e in events if e["kind"] == "operation_start")
    assert start["op_type"] == "goal" and start["family"] == "recurrence"


# --------------------------------------------------------------------------- #
# context-manager auto-end: normal exit AND exception
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_operation_auto_ends_on_exception_with_error_status(unused_tcp_port):
    events = []
    async with websockets.serve(make_capture_relay(events), "localhost", unused_tcp_port):
        s = session(name="t", port=unused_tcp_port, autostart_relay=False)
        await s.connect()
        op_id = None
        with pytest.raises(RuntimeError, match="boom"):
            async with s.operation("workflow", label="risky") as op:
                op_id = op.op_id
                raise RuntimeError("boom")
        await s.close()

    ends = [e for e in events if e["kind"] == "operation_end"]
    assert len(ends) == 1
    end = ends[0]
    assert end["op_id"] == op_id
    assert end["status"] == "error"               # exception propagated
    assert end["summary"] == "boom"               # summary=str(exc)


# --------------------------------------------------------------------------- #
# nesting: parent_op_id wiring + Operation.child
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_nesting_via_parent_argument(unused_tcp_port):
    """session.operation(..., parent=op) wires parent_op_id to the parent's op_id."""
    events = []
    async with websockets.serve(make_capture_relay(events), "localhost", unused_tcp_port):
        s = session(name="t", port=unused_tcp_port, autostart_relay=False)
        await s.connect()
        async with s.operation("workflow", label="pipeline") as wf:
            async with s.operation("phase", label="phase 1", parent=wf) as ph:
                await ph.tick(0)
        await s.close()

    starts = [e for e in events if e["kind"] == "operation_start"]
    wf_start = next(e for e in starts if e["op_type"] == "workflow")
    ph_start = next(e for e in starts if e["op_type"] == "phase")
    assert ph_start["parent_op_id"] == wf_start["op_id"]
    assert wf_start["parent_op_id"] is None


@pytest.mark.asyncio
async def test_nesting_via_child_inherits_scope_and_parent(unused_tcp_port):
    """Operation.child(...) nests under the parent op AND inherits its agent_id scope."""
    events = []
    async with websockets.serve(make_capture_relay(events), "localhost", unused_tcp_port):
        s = session(name="t", port=unused_tcp_port, autostart_relay=False)
        await s.connect()
        async with s.agent("orchestrator") as a:
            async with a.operation("workflow", label="build") as wf:
                async with wf.child("phase", label="compile",
                                    detail={"index": 0, "title": "compile"}) as ph:
                    await ph.tick(0)
        await s.close()

    starts = [e for e in events if e["kind"] == "operation_start"]
    wf_start = next(e for e in starts if e["op_type"] == "workflow")
    ph_start = next(e for e in starts if e["op_type"] == "phase")
    # child wired to parent op_id
    assert ph_start["parent_op_id"] == wf_start["op_id"]
    # child inherits the agent scope of the parent
    assert wf_start["agent_id"] == a.agent_id
    assert ph_start["agent_id"] == a.agent_id
    assert ph_start["detail"]["title"] == "compile"


# --------------------------------------------------------------------------- #
# scope: Session (agent_id=None) vs Agent (agent_id set)
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_agent_operation_is_agent_scoped(unused_tcp_port):
    events = []
    async with websockets.serve(make_capture_relay(events), "localhost", unused_tcp_port):
        s = session(name="t", port=unused_tcp_port, autostart_relay=False)
        await s.connect()
        async with s.agent("worker") as a:
            async with a.operation("skill", label="/code-review",
                                   detail={"skill": "code-review", "args": "--high"}) as op:
                await op.tick(0)
        await s.close()

    start = next(e for e in events
                 if e["kind"] == "operation_start" and e["op_type"] == "skill")
    assert start["agent_id"] == a.agent_id        # agent-scoped
    assert start["family"] == "command"
    assert start["detail"]["skill"] == "code-review"


@pytest.mark.asyncio
async def test_session_operation_is_session_scoped(unused_tcp_port):
    events = []
    async with websockets.serve(make_capture_relay(events), "localhost", unused_tcp_port):
        s = session(name="t", port=unused_tcp_port, autostart_relay=False)
        await s.connect()
        async with s.operation("schedule", label="nightly close",
                               detail={"cron": "0 7 * * *"}) as op:
            await op.tick(0, status="recurring")
        await s.close()

    start = next(e for e in events
                 if e["kind"] == "operation_start" and e["op_type"] == "schedule")
    assert start["agent_id"] is None              # session-level scope
    assert start["family"] == "recurrence"
    tick = next(e for e in events if e["kind"] == "operation_tick")
    assert tick["status"] == "recurring"


# --------------------------------------------------------------------------- #
# seq + run_id stamping (rides the existing transport)
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_operation_events_carry_run_id_and_session_seq(unused_tcp_port):
    """Session-level operations (agent_id=None) share the _session seq stream with
    session_start, and every operation event carries the run's run_id."""
    events = []
    async with websockets.serve(make_capture_relay(events), "localhost", unused_tcp_port):
        s = session(name="t", port=unused_tcp_port, autostart_relay=False)
        await s.connect()
        async with s.operation("monitor", label="watch") as op:
            await op.tick(0)
        await s.close()

    op_events = [e for e in events if e["kind"].startswith("operation_")]
    assert op_events, "expected operation events"
    assert all("run_id" in e and e["run_id"] == s.run_id for e in op_events)
    # session_start is seq 0 of _session; session-level ops continue that counter.
    start = next(e for e in events if e["kind"] == "session_start")
    op_start = next(e for e in events if e["kind"] == "operation_start")
    assert start["seq"] == 0
    assert op_start["seq"] > 0
