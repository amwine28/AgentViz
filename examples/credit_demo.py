"""Credit-assignment demo (Rung 1).

A research pipeline with structurally clear credit: planner → researcher →
writer → editor is a chain (each a spawn-and-handoff bottleneck), plus a
'slacker' that burns tokens but never feeds the result (a dead branch). A
terminal outcome (tests passed) is attributed to the editor's verified artifact.

Run it, open AgentViz, press V to the CREDIT view:
    python3 examples/credit_demo.py
"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "sdk"))
from agentviz import session


async def main():
    s = session(name="credit demo: research pipeline")
    await s.connect()
    print("Credit demo running — open AgentViz and switch to the CREDIT view.")

    async with s.agent("planner") as planner:
        async with s.agent("researcher", parent_id=planner.agent_id) as researcher:
            async with s.agent("writer", parent_id=researcher.agent_id) as writer:
                async with s.agent("editor", parent_id=writer.agent_id) as editor:
                    async with s.agent("slacker", parent_id=planner.agent_id) as slacker:
                        await researcher.report_usage(input_tokens=4000, output_tokens=900,
                                                      model="claude-sonnet-4-6", cost_usd=0.030)
                        await researcher.report_outcome(0.9, channel="quality", scale="unit", source="metric")
                        await s.send_message("researcher", "writer", "facts gathered")

                        await writer.report_usage(input_tokens=3200, output_tokens=1400,
                                                  model="claude-sonnet-4-6", cost_usd=0.045)
                        await writer.report_outcome(0.85, channel="quality", scale="unit", source="metric")
                        await s.send_message("writer", "editor", "draft ready")

                        await editor.report_usage(input_tokens=1800, output_tokens=500,
                                                  model="claude-sonnet-4-6", cost_usd=0.020)
                        # NOTE: editor does NOT message back to planner — a clean
                        # forward DAG keeps credit structurally separable, so the
                        # bottleneck chain is visible. (See demo_swarm.py for the
                        # converging/cyclic case the Credit lens honestly refuses to split.)
                        await editor.log("final artifact verified")

                        # slacker burns tokens but produces no handoff -> dead branch
                        await slacker.report_usage(input_tokens=150, output_tokens=40,
                                                   model="claude-haiku-4-5", cost_usd=0.001)
                        await slacker.log("idle — produced no handoff toward the result", level="warn")
                        await asyncio.sleep(0.3)
                        editor_id = editor.agent_id

        # terminal outcome: the sparse end-of-run reward, attributed to the
        # editor's verified artifact (a MEASURED sink via result_agent_ids).
        await s.report_outcome(1.0, channel="tests", source="test_suite",
                               detail={"result_agent_ids": [editor_id]})
        await planner.log("pipeline complete — tests passed")

    await asyncio.sleep(0.5)
    await s.close()
    print("Done.")


asyncio.run(main())
