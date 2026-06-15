"""Phase E foundation: every event carries a stable run_id (the key the future
re-run engine and append-only log are keyed on). Observer-only — no re-execution."""
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
async def test_run_id_stamped_on_every_event(unused_tcp_port):
    events = []
    async with websockets.serve(make_capture_relay(events), "localhost", unused_tcp_port):
        s = session(name="t", port=unused_tcp_port, autostart_relay=False)
        await s.connect()
        async with s.agent("worker") as a:
            await a.log("hi")
            await a.report_usage(input_tokens=10, output_tokens=2)
        await s.report_outcome(1.0, channel="tests")
        await s.close()

    assert len(events) > 3
    run_ids = {e.get("run_id") for e in events}
    assert run_ids == {s.run_id}            # one stable run_id, on every event
    assert None not in run_ids
    assert isinstance(s.run_id, str) and len(s.run_id) > 0


@pytest.mark.asyncio
async def test_distinct_sessions_get_distinct_run_ids(unused_tcp_port):
    ev1, ev2 = [], []
    async with websockets.serve(make_capture_relay(ev1), "localhost", unused_tcp_port):
        s1 = session(name="a", port=unused_tcp_port, autostart_relay=False)
        await s1.connect()
        async with s1.agent("w"):
            pass
        await s1.close()
    async with websockets.serve(make_capture_relay(ev2), "localhost", unused_tcp_port):
        s2 = session(name="b", port=unused_tcp_port, autostart_relay=False)
        await s2.connect()
        async with s2.agent("w"):
            pass
        await s2.close()

    assert s1.run_id != s2.run_id
    assert {e.get("run_id") for e in ev1} == {s1.run_id}
    assert {e.get("run_id") for e in ev2} == {s2.run_id}
