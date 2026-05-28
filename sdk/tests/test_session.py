import asyncio
import json
import pytest
import websockets
from agentviz import session

@pytest.mark.asyncio
async def test_session_emits_agent_spawn_and_complete(unused_tcp_port):
    events = []

    async def fake_relay(ws):
        async for msg in ws:
            events.append(json.loads(msg))

    async with websockets.serve(fake_relay, "localhost", unused_tcp_port):
        s = session(name="test-run", port=unused_tcp_port, autostart_relay=False)
        await s.connect()
        async with s.agent("orchestrator") as agent:
            assert agent.agent_id is not None
        await asyncio.sleep(0.05)
        await s.close()

    kinds = [e["kind"] for e in events]
    assert "agent_spawn" in kinds
    assert "agent_complete" in kinds

@pytest.mark.asyncio
async def test_agent_emits_status_changes(unused_tcp_port):
    events = []

    async def fake_relay(ws):
        async for msg in ws:
            events.append(json.loads(msg))

    async with websockets.serve(fake_relay, "localhost", unused_tcp_port):
        s = session(name="test-run", port=unused_tcp_port, autostart_relay=False)
        await s.connect()
        async with s.agent("worker") as agent:
            await agent.set_status("waiting")
        await asyncio.sleep(0.05)
        await s.close()

    status_events = [e for e in events if e["kind"] == "agent_status"]
    statuses = [e["status"] for e in status_events]
    assert "running" in statuses
    assert "waiting" in statuses
    assert "complete" in statuses

@pytest.mark.asyncio
async def test_child_agent_has_parent_id(unused_tcp_port):
    events = []

    async def fake_relay(ws):
        async for msg in ws:
            events.append(json.loads(msg))

    async with websockets.serve(fake_relay, "localhost", unused_tcp_port):
        s = session(name="test-run", port=unused_tcp_port, autostart_relay=False)
        await s.connect()
        async with s.agent("parent") as parent:
            async with s.agent("child", parent_id=parent.agent_id):
                pass
        await asyncio.sleep(0.05)
        await s.close()

    spawns = [e for e in events if e["kind"] == "agent_spawn"]
    child_spawn = next(e for e in spawns if e["name"] == "child")
    parent_spawn = next(e for e in spawns if e["name"] == "parent")
    assert child_spawn["parent_id"] == parent_spawn["agent_id"]
