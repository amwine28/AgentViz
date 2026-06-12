import asyncio
import json
import pytest
import websockets
from agentviz import session, ToolCallDenied

@pytest.mark.asyncio
async def test_tool_call_approved(unused_tcp_port):
    result_holder = {}
    events_received = []

    async def fake_relay(ws):
        async for raw in ws:
            msg = json.loads(raw)
            events_received.append(msg)
            if msg["kind"] == "tool_call_pending":
                await ws.send(json.dumps({
                    "kind": "tool_approve",
                    "agent_id": msg["agent_id"],
                    "call_id": msg["call_id"]
                }))

    async with websockets.serve(fake_relay, "localhost", unused_tcp_port):
        s = session(name="test", port=unused_tcp_port, autostart_relay=False)
        await s.connect()
        async with s.agent("worker") as agent:
            result = await agent.tool_call(
                name="my_tool",
                args={"x": 1},
                fn=lambda: "tool_result_value",
                approval_timeout=2.0
            )
            result_holder["result"] = result
        await asyncio.sleep(0.05)
        await s.close()

    assert result_holder["result"] == "tool_result_value"
    tool_result_events = [e for e in events_received if e["kind"] == "tool_result"]
    assert len(tool_result_events) == 1
    assert tool_result_events[0]["result"] == "tool_result_value"
    assert "call_id" in tool_result_events[0]
    assert "duration_ms" in tool_result_events[0]

@pytest.mark.asyncio
async def test_tool_call_denied_raises_and_emits_tool_denied(unused_tcp_port):
    events_received = []

    async def fake_relay(ws):
        async for raw in ws:
            msg = json.loads(raw)
            events_received.append(msg)
            if msg["kind"] == "tool_call_pending":
                await ws.send(json.dumps({
                    "kind": "tool_deny",
                    "agent_id": msg["agent_id"],
                    "call_id": msg["call_id"]
                }))

    async with websockets.serve(fake_relay, "localhost", unused_tcp_port):
        s = session(name="test", port=unused_tcp_port, autostart_relay=False)
        await s.connect()
        with pytest.raises(ToolCallDenied):
            async with s.agent("worker") as agent:
                await agent.tool_call(
                    name="my_tool",
                    args={},
                    fn=lambda: "never",
                    approval_timeout=2.0
                )
        await asyncio.sleep(0.05)
        await s.close()

    denied_events = [e for e in events_received if e["kind"] == "tool_denied"]
    assert len(denied_events) == 1
    assert denied_events[0]["reason"] == "denied"
    pending = next(e for e in events_received if e["kind"] == "tool_call_pending")
    assert denied_events[0]["call_id"] == pending["call_id"]

@pytest.mark.asyncio
async def test_tool_call_denies_on_timeout_by_default(unused_tcp_port):
    events_received = []
    fn_called = {"value": False}

    async def fake_relay(ws):
        async for raw in ws:
            events_received.append(json.loads(raw))  # never responds

    def tool_fn():
        fn_called["value"] = True
        return "never"

    async with websockets.serve(fake_relay, "localhost", unused_tcp_port):
        s = session(name="test", port=unused_tcp_port, autostart_relay=False)
        await s.connect()
        with pytest.raises(ToolCallDenied):
            async with s.agent("worker") as agent:
                await agent.tool_call(
                    name="my_tool",
                    args={},
                    fn=tool_fn,
                    approval_timeout=0.1
                )
        await asyncio.sleep(0.05)
        await s.close()

    assert fn_called["value"] is False
    denied_events = [e for e in events_received if e["kind"] == "tool_denied"]
    assert len(denied_events) == 1
    assert denied_events[0]["reason"] == "timeout"

@pytest.mark.asyncio
async def test_tool_call_on_timeout_approve_is_explicit_opt_in(unused_tcp_port):
    result_holder = {}

    async def fake_relay(ws):
        async for _ in ws:
            pass  # never responds

    async with websockets.serve(fake_relay, "localhost", unused_tcp_port):
        s = session(name="test", port=unused_tcp_port, autostart_relay=False)
        await s.connect()
        async with s.agent("worker") as agent:
            result = await agent.tool_call(
                name="my_tool",
                args={},
                fn=lambda: "auto",
                approval_timeout=0.1,
                on_timeout="approve"
            )
            result_holder["result"] = result
        await s.close()

    assert result_holder["result"] == "auto"
