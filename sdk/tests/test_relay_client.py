import asyncio
import json
import pytest
import websockets
from agentviz.relay_client import RelayClient
from agentviz.events import AgentSpawnEvent, serialize

@pytest.mark.asyncio
async def test_relay_client_sends_event(unused_tcp_port):
    received = []

    async def fake_relay(ws):
        msg = await ws.recv()
        received.append(json.loads(msg))

    async with websockets.serve(fake_relay, "localhost", unused_tcp_port):
        client = RelayClient(port=unused_tcp_port)
        await client.connect()
        event = AgentSpawnEvent(agent_id="a1", name="test-agent")
        await client.send(serialize(event))
        await asyncio.sleep(0.05)

    assert len(received) == 1
    assert received[0]["kind"] == "agent_spawn"
    assert received[0]["agent_id"] == "a1"

@pytest.mark.asyncio
async def test_relay_client_dispatches_command(unused_tcp_port):
    received_command = {}

    async def fake_relay(ws):
        await ws.send(json.dumps({"kind": "tool_approve", "call_id": "c1"}))
        await asyncio.sleep(0.1)

    async with websockets.serve(fake_relay, "localhost", unused_tcp_port):
        client = RelayClient(port=unused_tcp_port)
        client.on_command("tool_approve", lambda cmd: received_command.update(cmd))
        await client.connect()
        await asyncio.sleep(0.1)

    assert received_command.get("call_id") == "c1"
