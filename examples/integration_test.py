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
from agentviz import session, ToolCallDenied

async def main():
    # Start relay
    s = session(name="integration-test")
    await s.connect()

    # Connect a fake browser client: captures events and approves "test_tool"
    # via a real tool_approve command (exercises relay command routing)
    captured = []
    async def collect():
        try:
            async with websockets.connect("ws://localhost:3333") as ws:
                async for msg in ws:
                    data = json.loads(msg)
                    events = data if isinstance(data, list) else [data]
                    for event in events:
                        captured.append(event)
                        if event.get("kind") == "tool_call_pending" and event.get("name") == "test_tool":
                            await ws.send(json.dumps({
                                "kind": "tool_approve",
                                "agent_id": event["agent_id"],
                                "call_id": event["call_id"],
                            }))
        except Exception:
            pass

    collector = asyncio.create_task(collect())
    await asyncio.sleep(0.1)

    denied_raised = False
    async with s.agent("orch") as orch:
        async with s.agent("worker", parent_id=orch.agent_id) as worker:
            result = await worker.tool_call(
                name="test_tool",
                args={"x": 1},
                fn=lambda: "ok",
                approval_timeout=5.0,  # approved by the fake browser above
            )
            # Second call: nobody approves → default policy denies on timeout
            try:
                await worker.tool_call(
                    name="unapproved_tool",
                    args={},
                    fn=lambda: "never",
                    approval_timeout=0.3,
                )
            except ToolCallDenied:
                denied_raised = True

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

    # Approved call produced a real result via browser-side approval
    results = [e for e in captured if e["kind"] == "tool_result"]
    assert len(results) == 1, f"Expected 1 tool_result, got {len(results)}"
    assert results[0]["result"] == "ok"

    # Unapproved call was denied on timeout (never silently approved)
    assert denied_raised, "Expected ToolCallDenied for unapproved tool call"
    denied = [e for e in captured if e["kind"] == "tool_denied"]
    assert len(denied) == 1, f"Expected 1 tool_denied event, got {len(denied)}"
    assert denied[0]["reason"] == "timeout", f"Wrong denial reason: {denied[0]['reason']}"
    assert denied[0]["name"] == "unapproved_tool"

    print("All assertions passed. Integration test PASSED.")

asyncio.run(main())
