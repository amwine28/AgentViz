"""
Demo swarm — a choreographed multi-wave agent run built to look ALIVE in the
3D world: squads spawning, messages pulsing along edges, statuses shifting,
tool approvals blooming as golden rings (two are left for YOU to approve in
the browser), one dramatic failure, and a clean wind-down.

Run: python3 examples/demo_swarm.py        (one mission, ~75s)
     python3 examples/demo_swarm.py --loop (missions forever, for demos/GIFs)
"""
import asyncio
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "sdk"))

from agentviz import session, ToolCallDenied

SQUADS = {
    "recon": ["scout-alpha", "scout-bravo", "cartographer"],
    "analysis": ["pattern-miner", "signal-parser", "correlator", "archivist"],
    "synthesis": ["composer", "verifier"],
}

CHATTER = [
    "sector sweep complete, forwarding coordinates",
    "anomaly detected in band 7, requesting analysis",
    "cross-referencing against mission archive",
    "confidence 0.87 — promoting to candidate",
    "telemetry nominal, continuing sweep",
    "handing off partial result for synthesis",
    "checksum verified, artifact sealed",
]

TOOLS = ["fetch_sensor_grid", "decode_burst", "query_archive", "fuse_tracks", "render_report"]


async def worker_life(s, squad_lead, name: str, lead_name: str):
    async with s.agent(name, parent_id=squad_lead.agent_id) as w:
        await w.log(f"{name} online, reporting to {lead_name}")
        await s.send_message(name, lead_name, "checking in — ready for tasking")
        await asyncio.sleep(random.uniform(0.5, 1.5))

        for _ in range(random.randint(2, 4)):
            # quick auto-approved tool work (explicit opt-in keeps the demo hands-free)
            tool = random.choice(TOOLS)
            await w.set_status("waiting")
            try:
                await w.tool_call(
                    name=tool,
                    args={"sector": random.randint(1, 64), "depth": random.choice(["shallow", "full"])},
                    fn=lambda: {"records": random.randint(8, 512)},
                    approval_timeout=random.uniform(2.0, 4.0),
                    on_timeout="approve",
                )
            except ToolCallDenied:
                await w.log(f"{tool} denied — rerouting", level="warn")
            await w.set_status("running")
            await s.send_message(name, lead_name, random.choice(CHATTER))
            await asyncio.sleep(random.uniform(0.8, 2.2))

        await s.send_message(name, lead_name, "tasking complete, going dark")


async def squad_mission(s, orch, squad: str, members: list[str]):
    async with s.agent(f"{squad}-lead", parent_id=orch.agent_id) as lead:
        await lead.log(f"{squad} squad assembling — {len(members)} units")
        await s.send_message(f"{squad}-lead", "mission-control", f"{squad} squad deploying")

        # spawn the squad in a visible wave
        tasks = []
        for m in members:
            tasks.append(asyncio.create_task(worker_life(s, lead, m, f"{squad}-lead")))
            await asyncio.sleep(random.uniform(0.4, 0.9))

        await asyncio.gather(*tasks)
        await s.send_message(f"{squad}-lead", "mission-control", f"{squad} objectives met")


async def saboteur(s, orch):
    """One agent fails dramatically — error red looks great under bloom."""
    await asyncio.sleep(18)
    try:
        async with s.agent("rogue-probe", parent_id=orch.agent_id) as r:
            await r.log("entering uncharted sector", level="warn")
            await asyncio.sleep(4)
            await r.log("containment breach!", level="error")
            raise RuntimeError("signal lost in sector 13")
    except RuntimeError:
        pass  # the error state on the node is the point


async def the_big_ask(s, orch):
    """Two tool calls held for HUMAN approval — golden pulsing rings in the
    world and live countdowns in the approval queue. Approve one, deny one."""
    await asyncio.sleep(10)
    async with s.agent("gatekeeper", parent_id=orch.agent_id) as g:
        await g.log("two privileged operations queued for operator approval")
        for tool, args in [
            ("launch_deep_scan", {"target": "anomaly-7", "power": "MAXIMUM"}),
            ("purge_archive", {"scope": "mission-cache", "irreversible": True}),
        ]:
            try:
                await g.tool_call(
                    name=tool,
                    args=args,
                    fn=lambda: "executed",
                    approval_timeout=45.0,  # default deny-on-timeout: never silently approved
                )
                await g.log(f"{tool} approved by operator")
            except ToolCallDenied:
                await g.log(f"{tool} denied or timed out — standing down", level="warn")


async def mission(s):
    async with s.agent("mission-control") as orch:
        await orch.log("mission start — three squads, one rogue probe, two approvals")
        side_tasks = [
            asyncio.create_task(saboteur(s, orch)),
            asyncio.create_task(the_big_ask(s, orch)),
        ]
        squad_tasks = []
        for squad, members in SQUADS.items():
            squad_tasks.append(asyncio.create_task(squad_mission(s, orch, squad, members)))
            await asyncio.sleep(random.uniform(1.5, 2.5))

        await asyncio.gather(*squad_tasks)
        await asyncio.gather(*side_tasks)
        await orch.log("all squads accounted for — mission complete")


async def main():
    loop_forever = "--loop" in sys.argv
    s = session(name="demo: deep-field survey")
    await s.connect()
    print("Demo swarm running — watch the world breathe.")
    try:
        while True:
            await mission(s)
            if not loop_forever:
                break
            await asyncio.sleep(5)
    finally:
        await s.close()
    print("Mission complete.")


asyncio.run(main())
