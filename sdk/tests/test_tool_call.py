import asyncio
import json
import pytest
import websockets
from agentviz import session, ToolCallDenied

@pytest.mark.asyncio
async def test_tool_call_approved(unused_tcp_port):
    result_holder = {}

    async def fake_relay(ws):
        async for raw in ws:
            msg = json.loads(raw)
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
        await s.close()

    assert result_holder["result"] == "tool_result_value"

@pytest.mark.asyncio
async def test_tool_call_denied_raises(unused_tcp_port):
    async def fake_relay(ws):
        async for raw in ws:
            msg = json.loads(raw)
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
        await s.close()

@pytest.mark.asyncio
async def test_tool_call_auto_approves_on_timeout(unused_tcp_port):
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
                approval_timeout=0.1
            )
            result_holder["result"] = result
        await s.close()

    assert result_holder["result"] == "auto"
