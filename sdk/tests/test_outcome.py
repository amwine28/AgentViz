"""Outcome primitive (credit-assignment Phase A): agent-scoped intermediate
outcomes and run-level terminal outcomes, with seq routing."""
import asyncio
import json
import pytest
import websockets
from agentviz import session


def make_capture_relay(events_received):
    async def fake_relay(ws):
        async for raw in ws:
            events_received.append(json.loads(raw))
    return fake_relay


@pytest.mark.asyncio
async def test_agent_report_outcome_is_agent_scoped_intermediate(unused_tcp_port):
    events = []
    async with websockets.serve(make_capture_relay(events), "localhost", unused_tcp_port):
        s = session(name="t", port=unused_tcp_port, autostart_relay=False)
        await s.connect()
        async with s.agent("worker") as a:
            await a.report_outcome(1.0, channel="rubric", scale="unit", source="eval_harness")
        await s.close()

    outs = [e for e in events if e["kind"] == "outcome"]
    assert len(outs) == 1
    o = outs[0]
    assert o["agent_id"] == a.agent_id          # agent-scoped
    assert o["value"] == 1.0
    assert o["channel"] == "rubric"
    assert o["scale"] == "unit"
    assert o["stage"] == "intermediate"          # agent default
    assert o["source"] == "eval_harness"
    assert o["measured"] is True


@pytest.mark.asyncio
async def test_session_report_outcome_is_run_level_terminal(unused_tcp_port):
    events = []
    async with websockets.serve(make_capture_relay(events), "localhost", unused_tcp_port):
        s = session(name="t", port=unused_tcp_port, autostart_relay=False)
        await s.connect()
        async with s.agent("worker"):
            pass
        await s.report_outcome(1.0, channel="tests", source="test_suite",
                               detail={"result_agent_ids": ["x"]})
        await s.close()

    outs = [e for e in events if e["kind"] == "outcome"]
    assert len(outs) == 1
    o = outs[0]
    assert o["agent_id"] is None                  # run-level
    assert o["stage"] == "terminal"               # session default
    assert o["channel"] == "tests"
    assert o["detail"]["result_agent_ids"] == ["x"]


@pytest.mark.asyncio
async def test_run_level_outcome_shares_session_seq_stream(unused_tcp_port):
    # session_start (agent_id=None) is seq 0 of the _session stream; a run-level
    # outcome (also agent_id=None) continues that same counter -> seq 1.
    events = []
    async with websockets.serve(make_capture_relay(events), "localhost", unused_tcp_port):
        s = session(name="t", port=unused_tcp_port, autostart_relay=False)
        await s.connect()
        await s.report_outcome(0.0, channel="tests", source="ci")
        await s.close()

    start = next(e for e in events if e["kind"] == "session_start")
    out = next(e for e in events if e["kind"] == "outcome")
    assert start["seq"] == 0
    assert out["seq"] == 1
