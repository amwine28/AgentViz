"""
Operations demo — a swarm that exercises EVERY operation family so all four
existing views breathe with agentic operation glyphs and the new OPS lens has a
full story to tell.

Grounded-only: every tick carries a real fact in `detail` (a loop iteration's
observed status, a phase transition, a todo count). Nothing renders a faked bar.

Run it, open AgentViz, press V to cycle to the OPS view:
    python3 examples/operations_demo.py

Families exercised:
  recurrence    -> loop (fixed interval, with ticks), goal (self-paced), schedule (cron)
  orchestration -> workflow with 3 phases (.child) + a parallel spawn fan-out, message
  command       -> skill (a couple), mcp
  mode          -> plan_mode, worktree, background
  state         -> todo
"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "sdk"))

from agentviz import session


async def recurrence_ops(s):
    """A /loop (fixed interval), a /goal (self-paced), and a /schedule (cron)."""
    # /loop — poll a deploy on a fixed interval; each tick is one observed status.
    async with s.operation("loop", label="poll deploy",
                           detail={"interval_s": 5, "prompt": "check the deploy"}) as loop:
        for i, status_seen in enumerate(["queued", "building", "deploying", "live"]):
            await loop.tick(i, status="recurring",
                            detail={"status_seen": status_seen})
            await asyncio.sleep(0.4)

    # /goal — self-paced; runs until a condition is met (no fixed interval).
    async with s.operation("goal", label="raise coverage to 90%",
                           detail={"goal": "coverage>=90", "prompt": "keep improving"}) as goal:
        for cov in (71, 80, 88, 91):
            await goal.tick(detail={"coverage_pct": cov,
                                    "reason": "ran test suite"})
            await asyncio.sleep(0.3)

    # /schedule — a cron routine; each fire is a recurring tick.
    async with s.operation("schedule", label="nightly finance close",
                           detail={"cron": "0 7 * * *", "name": "daily-finance-run"}) as sched:
        for fire in range(3):
            await sched.tick(fire, status="recurring",
                             detail={"fired_for": f"day-{fire}"})
            await asyncio.sleep(0.3)


async def parallel_spawn(s, parent, idx: int):
    """One leg of a workflow's parallel fan-out — a spawn operation per worker."""
    async with s.agent(f"build-worker-{idx}", parent_id=parent.agent_id) as w:
        async with w.operation("spawn", parent=None,
                               label=f"build-worker-{idx}",
                               detail={"agent_type": "builder",
                                       "description": f"compile shard {idx}"}) as sp:
            await sp.tick(0, detail={"shard": idx, "files": 12 * (idx + 1)})
            await asyncio.sleep(0.3)


async def workflow_ops(s):
    """A Workflow with 3 phases (.child) plus a parallel spawn fan-out under it."""
    async with s.agent("orchestrator") as orch:
        await orch.log("running the build workflow")
        async with orch.operation(
            "workflow", label="ci pipeline",
            detail={"name": "ci pipeline", "description": "lint -> build -> test",
                    "phase_titles": ["lint", "build", "test"]},
        ) as wf:
            # phase 1 — lint (a child operation of the workflow)
            async with wf.child("phase", label="lint",
                                detail={"index": 0, "title": "lint"}) as ph:
                await ph.tick(0, detail={"warnings": 3})
                await asyncio.sleep(0.3)

            # phase 2 — build, with a PARALLEL spawn fan-out beneath it
            async with wf.child("phase", label="build",
                                detail={"index": 1, "title": "build"}) as ph:
                await ph.tick(0, detail={"started_workers": 3})
                await asyncio.gather(*[
                    parallel_spawn(s, orch, i) for i in range(3)
                ])
                await ph.tick(1, detail={"finished_workers": 3})

            # phase 3 — test
            async with wf.child("phase", label="test",
                                detail={"index": 2, "title": "test"}) as ph:
                await ph.tick(0, detail={"passed": 178, "failed": 0})
                await asyncio.sleep(0.3)

        await s.send_message("orchestrator", "orchestrator", "pipeline green")


async def command_ops(s):
    """A couple of skills (slash commands) and an MCP tool call."""
    async with s.agent("assistant") as a:
        async with a.operation("skill", label="/code-review",
                               detail={"skill": "code-review", "args": "--high"}) as sk:
            await sk.tick(0, detail={"findings": 2})
            await asyncio.sleep(0.3)
        async with a.operation("skill", label="/simplify",
                               detail={"skill": "simplify", "args": ""}) as sk:
            await sk.tick(0, detail={"edits": 5})
            await asyncio.sleep(0.2)
        async with a.operation("mcp", label="mcp__github__create_pr",
                               detail={"server": "github", "tool": "create_pr"}) as mcp:
            await mcp.tick(0, detail={"pr_number": 1421})
            await asyncio.sleep(0.2)


async def mode_ops(s):
    """plan_mode, worktree, and a background operation."""
    async with s.agent("planner") as p:
        # plan mode — no ticks measured; renders honest-unknown (no faked bar).
        async with p.operation("plan_mode", label="planning the refactor",
                               detail={"reason": "scope the change before editing"}):
            await asyncio.sleep(0.3)

        # worktree — isolated workspace span.
        async with p.operation("worktree", label="feat/ops-lens worktree",
                               detail={"branch": "feat/ops-lens",
                                       "path": "/tmp/wt-ops"}) as wt:
            await wt.tick(0, detail={"files_touched": 7})
            await asyncio.sleep(0.3)

        # background — a long-running detached task that beats while it runs.
        async with p.operation("background", label="npm run build (bg)",
                               detail={"command": "npm run build"}) as bg:
            for i in range(3):
                await bg.tick(i, status="running",
                              detail={"line": f"compiled module {i}"})
                await asyncio.sleep(0.3)


async def state_ops(s):
    """A todo list whose ticks are grounded in the real completed/total counts."""
    async with s.agent("worker") as w:
        steps = [
            {"total": 4, "completed": 0, "in_progress": 1},
            {"total": 4, "completed": 1, "in_progress": 1},
            {"total": 4, "completed": 2, "in_progress": 1},
            {"total": 4, "completed": 4, "in_progress": 0},
        ]
        async with w.operation("todo", label="ship the feature",
                               detail=steps[0]) as td:
            for i, snap in enumerate(steps):
                await td.tick(i, detail=snap)
                await asyncio.sleep(0.3)


async def main():
    s = session(name="operations demo: every family")
    await s.connect()
    print("Operations demo running — open AgentViz and press V to the OPS view.")
    try:
        await asyncio.gather(
            recurrence_ops(s),
            workflow_ops(s),
            command_ops(s),
            mode_ops(s),
            state_ops(s),
        )
        # a run-level terminal outcome so the CREDIT lens has something too.
        await s.report_outcome(1.0, channel="demo", source="eval_harness")
    finally:
        await asyncio.sleep(0.5)
        await s.close()
    print("Done — every operation family emitted.")


if __name__ == "__main__":
    asyncio.run(main())
