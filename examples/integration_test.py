"""
Automated integration test — no browser required.
Starts the relay, runs the SDK, verifies events are received correctly.
"""
import asyncio
import json
import sys
sys.path.insert(0, "sdk")
sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent.parent / "sdk"))

import websockets
from agentviz import session

async def main():
    # Start relay
    s = session(name="integration-test")
    await s.connect()

    # Connect a fake browser client to capture events
    captured = []
    async def collect():
        try:
            async with websockets.connect("ws://localhost:3333") as ws:
                # Receive catch-up buffer (if any)
                try:
                    msg = await asyncio.wait_for(ws.recv(), timeout=0.5)
                    data = json.loads(msg)
                    if isinstance(data, list):
                        captured.extend(data)
                    else:
                        captured.append(data)
                except asyncio.TimeoutError:
                    pass
                # Listen for live events
                async for msg in ws:
                    captured.append(json.loads(msg))
        except Exception:
            pass

    collector = asyncio.create_task(collect())
    await asyncio.sleep(0.1)

    async with s.agent("orch") as orch:
        async with s.agent("worker", parent_id=orch.agent_id) as worker:
            result = await worker.tool_call(
                name="test_tool",
                args={"x": 1},
                fn=lambda: "ok",
                approval_timeout=0.1,  # auto-approve immediately
            )

    await s.close()
    await asyncio.sleep(0.2)
    collector.cancel()
    try:
        await collector
    except asyncio.CancelledError:
        pass

    # Verify events
    kinds = {e["kind"] for e in captured}
    print(f"Events received: {sorted(kinds)}")

    assert "agent_spawn" in kinds, f"Missing agent_spawn. Got: {kinds}"
    assert "tool_call_pending" in kinds, f"Missing tool_call_pending. Got: {kinds}"
    assert "tool_result" in kinds, f"Missing tool_result. Got: {kinds}"
    assert "agent_complete" in kinds, f"Missing agent_complete. Got: {kinds}"
    assert result == "ok", f"Wrong tool result: {result}"

    spawns = [e for e in captured if e["kind"] == "agent_spawn"]
    assert len(spawns) == 2, f"Expected 2 spawns, got {len(spawns)}"
    worker_spawn = next(e for e in spawns if e["name"] == "worker")
    orch_spawn = next(e for e in spawns if e["name"] == "orch")
    assert worker_spawn["parent_id"] == orch_spawn["agent_id"], "Worker parent_id mismatch"

    print("All assertions passed. Integration test PASSED.")

asyncio.run(main())
