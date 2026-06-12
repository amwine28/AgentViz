"""Reliability floor: seq numbers, fail-open send, reconnect, acks, QoL."""
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
async def test_events_carry_per_agent_seq(unused_tcp_port):
    events_received = []
    async with websockets.serve(make_capture_relay(events_received), "localhost", unused_tcp_port):
        s = session(name="t", port=unused_tcp_port, autostart_relay=False)
        await s.connect()
        async with s.agent("worker") as agent:
            await agent.log("one")
            await agent.log("two")
        await s.close()

    agent_events = [e for e in events_received if e.get("agent_id")]
    by_agent = {}
    for e in agent_events:
        by_agent.setdefault(e["agent_id"], []).append(e["seq"])
    for seqs in by_agent.values():
        assert seqs == list(range(seqs[0], seqs[0] + len(seqs))), f"non-contiguous seqs: {seqs}"


@pytest.mark.asyncio
async def test_session_start_is_first_event(unused_tcp_port):
    events_received = []
    async with websockets.serve(make_capture_relay(events_received), "localhost", unused_tcp_port):
        s = session(name="my-session", port=unused_tcp_port, autostart_relay=False)
        await s.connect()
        async with s.agent("worker"):
            pass
        await s.close()

    assert events_received[0]["kind"] == "session_start"
    assert events_received[0]["name"] == "my-session"


@pytest.mark.asyncio
async def test_send_is_fail_open_when_relay_down(unused_tcp_port):
    # Nothing listening on the port: connect and agent ops must not raise.
    s = session(name="t", port=unused_tcp_port, autostart_relay=False)
    await s.connect()
    async with s.agent("worker") as agent:
        await agent.log("into the void")
    await s.close()


@pytest.mark.asyncio
async def test_reconnect_delivers_buffered_events(unused_tcp_port):
    events_received = []
    relay = await websockets.serve(make_capture_relay(events_received), "localhost", unused_tcp_port)

    s = session(name="t", port=unused_tcp_port, autostart_relay=False)
    await s.connect()
    async with s.agent("worker") as agent:
        await agent.log("before outage")
        await asyncio.sleep(0.2)

        relay.close()
        await relay.wait_closed()
        await asyncio.sleep(0.1)

        await agent.log("during outage")

        relay = await websockets.serve(make_capture_relay(events_received), "localhost", unused_tcp_port)
        await asyncio.sleep(1.5)  # allow reconnect backoff to fire
    await s.close()
    relay.close()
    await relay.wait_closed()

    logs = [e["content"] for e in events_received if e["kind"] == "log"]
    assert "before outage" in logs
    assert "during outage" in logs, f"buffered event lost across reconnect: {logs}"


@pytest.mark.asyncio
async def test_command_with_cmd_id_gets_ack(unused_tcp_port):
    events_received = []

    async def fake_relay(ws):
        async for raw in ws:
            msg = json.loads(raw)
            events_received.append(msg)
            if msg["kind"] == "tool_call_pending":
                await ws.send(json.dumps({
                    "kind": "tool_approve",
                    "agent_id": msg["agent_id"],
                    "call_id": msg["call_id"],
                    "cmd_id": "cmd-123",
                }))

    async with websockets.serve(fake_relay, "localhost", unused_tcp_port):
        s = session(name="t", port=unused_tcp_port, autostart_relay=False)
        await s.connect()
        async with s.agent("worker") as agent:
            await agent.tool_call(name="x", args={}, fn=lambda: 1, approval_timeout=5.0)
        await asyncio.sleep(0.1)
        await s.close()

    acks = [e for e in events_received if e["kind"] == "command_ack"]
    assert len(acks) == 1
    assert acks[0]["cmd_id"] == "cmd-123"
    assert acks[0]["status"] == "applied"


@pytest.mark.asyncio
async def test_command_for_unknown_agent_acks_failed(unused_tcp_port):
    events_received = []

    async def fake_relay(ws):
        async for raw in ws:
            msg = json.loads(raw)
            events_received.append(msg)
            if msg["kind"] == "session_start":
                await ws.send(json.dumps({
                    "kind": "tool_approve",
                    "agent_id": "ghost-agent",
                    "call_id": "nope",
                    "cmd_id": "cmd-404",
                }))

    async with websockets.serve(fake_relay, "localhost", unused_tcp_port):
        s = session(name="t", port=unused_tcp_port, autostart_relay=False)
        await s.connect()
        await asyncio.sleep(0.3)
        await s.close()

    acks = [e for e in events_received if e["kind"] == "command_ack"]
    assert len(acks) == 1
    assert acks[0]["cmd_id"] == "cmd-404"
    assert acks[0]["status"] == "failed"


@pytest.mark.asyncio
async def test_tool_call_accepts_async_fn(unused_tcp_port):
    events_received = []

    async def fake_relay(ws):
        async for raw in ws:
            msg = json.loads(raw)
            events_received.append(msg)
            if msg["kind"] == "tool_call_pending":
                await ws.send(json.dumps({
                    "kind": "tool_approve",
                    "agent_id": msg["agent_id"],
                    "call_id": msg["call_id"],
                }))

    async def slow_tool():
        await asyncio.sleep(0.01)
        return "async-ok"

    async with websockets.serve(fake_relay, "localhost", unused_tcp_port):
        s = session(name="t", port=unused_tcp_port, autostart_relay=False)
        await s.connect()
        async with s.agent("worker") as agent:
            result = await agent.tool_call(name="x", args={}, fn=slow_tool, approval_timeout=5.0)
        await s.close()

    assert result == "async-ok"


@pytest.mark.asyncio
async def test_pending_event_includes_timeout_s(unused_tcp_port):
    events_received = []

    async def fake_relay(ws):
        async for raw in ws:
            msg = json.loads(raw)
            events_received.append(msg)
            if msg["kind"] == "tool_call_pending":
                await ws.send(json.dumps({
                    "kind": "tool_approve",
                    "agent_id": msg["agent_id"],
                    "call_id": msg["call_id"],
                }))

    async with websockets.serve(fake_relay, "localhost", unused_tcp_port):
        s = session(name="t", port=unused_tcp_port, autostart_relay=False)
        await s.connect()
        async with s.agent("worker") as agent:
            await agent.tool_call(name="x", args={}, fn=lambda: 1, approval_timeout=7.5)
        await s.close()

    pending = next(e for e in events_received if e["kind"] == "tool_call_pending")
    assert pending["timeout_s"] == 7.5


@pytest.mark.asyncio
async def test_agent_log_emits_log_event(unused_tcp_port):
    events_received = []
    async with websockets.serve(make_capture_relay(events_received), "localhost", unused_tcp_port):
        s = session(name="t", port=unused_tcp_port, autostart_relay=False)
        await s.connect()
        async with s.agent("worker") as agent:
            await agent.log("hello", level="warn")
        await s.close()

    logs = [e for e in events_received if e["kind"] == "log"]
    assert len(logs) == 1
    assert logs[0]["content"] == "hello"
    assert logs[0]["level"] == "warn"
