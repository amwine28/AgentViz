"""
Minimal AgentViz smoke test.
Run: python3 examples/basic_run.py
Then open http://localhost:3333 in your browser.
"""
import asyncio
import sys
sys.path.insert(0, "sdk")

from agentviz import session, ToolCallDenied

async def main():
    s = session(name="smoke-test")
    await s.connect()
    print("Session started. Open http://localhost:3333")

    async with s.agent("orchestrator") as orch:
        await s.send_message("orchestrator", "orchestrator", "Starting run...")

        async with s.agent("worker-a", parent_id=orch.agent_id) as worker:
            await worker.set_status("waiting")
            print("Waiting for tool approval in the browser (denies after 30s)...")
            try:
                result = await worker.tool_call(
                    name="fetch_data",
                    args={"source": "api"},
                    fn=lambda: {"rows": 42},
                    approval_timeout=30.0,
                )
                print(f"Tool result: {result}")
                await s.send_message("worker-a", "orchestrator", f"Fetched {result['rows']} rows.")
            except ToolCallDenied:
                print("Tool call denied (no approval within timeout).")
                await worker.set_status("running")

        async with s.agent("worker-b", parent_id=orch.agent_id):
            await asyncio.sleep(1)

    await s.close()
    print("Done.")

asyncio.run(main())
