"""Rung 2 LIVE demo — measured causal credit on a SAFE, simulated re-runnable workflow.

No real agents or API calls: the reward model stands in for executing the workflow, so
re-running it with an agent ablated is free and side-effect-free. This demonstrates the
full counterfactual loop end-to-end — re-run (N+1) coalitions × K paired samples →
measured per-agent credit with confidence intervals and honest credit states — exactly
the machinery that, pointed at a real re-runnable workflow, gives causal credit.

It also streams one baseline run into AgentViz so you can watch the pipeline being credited.

Run: python3 examples/rung2_demo.py
"""
import asyncio
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "sdk"))
from agentviz import session
from agentviz.counterfactual import counterfactual_credit

AGENTS = ["retriever", "reasoner", "backup-reasoner", "verifier", "stylist"]


def _jitter(agent: str, k: int) -> float:
    # deterministic per-(agent, sample) noise -> reproducible CIs with real width
    return random.Random(hash((agent, k)) & 0xFFFFFFFF).gauss(0, 0.04)


def run_workflow(live, k: int) -> float:
    """Simulated re-run: terminal reward as a function of which agents were live.
    Stands in for actually executing the agents (safe — no real calls)."""
    have = set(live)
    essential_pair = {"retriever", "reasoner"} <= have
    if essential_pair:
        base = 1.0
    elif "retriever" in have and "backup-reasoner" in have and "reasoner" not in have:
        base = 0.9          # backup-reasoner substitutes for reasoner (slightly worse)
    else:
        base = 0.3          # an essential leg is missing
    base += 0.15 if "verifier" in have else 0.0   # verifier reliability bonus
    # "stylist" has no effect on answer-quality reward (cosmetic)
    noise = sum(_jitter(a, k) for a in have)
    return base + noise


async def stream_baseline() -> None:
    """Show the workflow once in AgentViz so you can watch what is being credited."""
    s = session(name="rung2 demo: research pipeline")
    await s.connect()
    async with s.agent("planner") as planner:
        for name in AGENTS:
            async with s.agent(name, parent_id=planner.agent_id) as a:
                await a.report_usage(input_tokens=1500, output_tokens=300,
                                     model="claude-sonnet-4-6", cost_usd=0.02)
                await s.send_message(name, "planner", f"{name} contributed")
        await s.report_outcome(1.0, channel="answer_quality", source="eval_harness")
    await asyncio.sleep(0.3)
    await s.close()


def main() -> None:
    try:
        asyncio.run(stream_baseline())
        print("Streamed a baseline run to AgentViz.\n")
    except Exception as e:  # relay may be down; the measurement below is independent
        print(f"(AgentViz stream skipped: {e})\n")

    # The actual Rung 2 measurement: re-run each coalition K times, measure deltas.
    rows = counterfactual_credit(AGENTS, run_workflow, samples=300, seed=2026)
    print("Rung 2 — measured causal credit (leave-one-out, 95% CI):")
    print(f"  {'agent':<17}{'credit':>9}{'95% CI':>22}   state")
    print(f"  {'-' * 17}{'-' * 9}{'-' * 22}   {'-' * 18}")
    for r in sorted(rows, key=lambda r: -r.credit):
        ci = f"[{r.ci[0]:+.3f}, {r.ci[1]:+.3f}]"
        print(f"  {r.agent_id:<17}{r.credit:>+9.3f}{ci:>22}   {r.credit_state}")
    print("\nEvery number is a measured re-run delta with a CI — no LLM opinion, "
          "and confident ~0 effects are reported as such, not hidden.")


if __name__ == "__main__":
    main()
