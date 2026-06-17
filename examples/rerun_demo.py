"""Re-run engine LIVE demo — causal credit by ACTUALLY re-executing the workflow.

Unlike rung2_demo.py (which feeds an injected v_fn), this re-runs a real agent
workflow with each agent ablated, every re-run forced through dry_run=True so the
verified safety layer guarantees zero real side effects. It:
  1. streams one baseline run into AgentViz (so you watch the pipeline), then
  2. re-runs the workflow per coalition to MEASURE each agent's causal credit, then
  3. publishes the measured credit into the same session -> the CREDIT lens shows it.

The reward model exposes the classic redundancy: reasoner and backup-reasoner each
have small marginal credit because the other covers the work — measured, not guessed.

Run:  python3 examples/rerun_demo.py     (needs a relay up: bash scripts/agentviz.sh)
"""
import asyncio
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "sdk"))
from agentviz import session
from agentviz.session import discover_relay_port
from agentviz.rerun import measure_credit_by_rerun

AGENTS = ["retriever", "reasoner", "backup-reasoner", "verifier", "stylist"]
OFF_RELAY_PORT = 39871   # re-runs go here (no relay) so they stay headless, off the UI


def _jitter(name: str, sample: int) -> float:
    # reproducible per-(agent, sample) noise -> real confidence intervals, CRN-friendly
    return random.Random(hash((name, sample)) & 0xFFFFFFFF).gauss(0, 0.03)


async def run_workflow(s) -> None:
    """In-envelope re-runnable workflow (C1-C3): value flows through SDK channels,
    reward is session-scope, ablated agents short-circuit."""
    async with s.agent("planner") as planner:
        contributed = set()
        for name in AGENTS:
            async with s.agent(name, parent_id=planner.agent_id) as a:
                if a.is_ablated():
                    continue                       # removed agent contributes nothing
                await a.report_usage(input_tokens=1500, output_tokens=300,
                                     model="claude-sonnet-4-6", cost_usd=0.02)
                await a.tool_call(name="work", args={}, fn=(lambda n=name: n), side_effect="pure")
                await s.send_message(name, "planner", f"{name} contributed")
                contributed.add(name)
        # orchestrator-scope reward, a function of who actually contributed:
        q = 0.0
        if "retriever" in contributed:
            q += 0.45
        if "reasoner" in contributed:
            q += 0.30
        elif "backup-reasoner" in contributed:
            q += 0.27                              # backup substitutes (slightly worse)
        if "verifier" in contributed:
            q += 0.15
        # "stylist" is cosmetic — no effect on answer quality
        # per-(agent, sample) noise so the measured credit carries a real CI:
        q += sum(_jitter(name, s.sample) for name in contributed)
        await s.report_outcome(round(q, 4), channel="quality", source="eval_harness")


async def main() -> None:
    # 1. baseline run, visible in the world (dry_run: pure tools still run, approval bypassed)
    s = session(name="re-run demo: research pipeline", dry_run=True)
    await s.connect()
    await run_workflow(s)
    print("Streamed baseline. Measuring causal credit by re-running (dry-run safe)...")

    # 2. measure credit by re-execution (headless, off the UI relay)
    results = await asyncio.to_thread(
        measure_credit_by_rerun, run_workflow, AGENTS,
        samples=40, channel="quality", seed=2026, port=OFF_RELAY_PORT, publish=False,
    )

    # 3. publish the measured credit into the SAME visible session
    await s.report_credit(method="counterfactual", channel="quality", agents=[{
        "agent": r.agent_id, "credit": round(r.credit, 4),
        "ci": [round(r.ci[0], 4), round(r.ci[1], 4)],
        "credit_state": r.credit_state, "basis": "measured",
    } for r in results])
    await asyncio.sleep(0.3)
    await s.close()

    print("\nRung 2 (by LIVE re-run) — measured causal credit (95% CI):")
    for r in sorted(results, key=lambda r: -r.credit):
        ci = f"[{r.ci[0]:+.3f}, {r.ci[1]:+.3f}]"
        print(f"  {r.agent_id:<17}{r.credit:>+8.3f}{ci:>22}   {r.credit_state}")
    print("\nReasoner & backup-reasoner each show small credit — each covers the other. "
          "Open AgentViz and press V to CREDIT.")


if __name__ == "__main__":
    asyncio.run(main())
