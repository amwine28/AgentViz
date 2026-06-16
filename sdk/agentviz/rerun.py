"""Re-run engine — LIVE Rung 2 counterfactual credit by re-executing a workflow.

Given an author's re-runnable async workflow `workflow(session)`, this re-executes it
once per coalition with one agent (and its spawn-cascade) ablated, captures the terminal
reward, and feeds the measured rewards to counterfactual_credit. EVERY re-run is forced
through dry_run=True, so the adversarially-verified safety layer guarantees zero real
external side effects.

Credit numbers are pure measured deltas of terminal reward across re-runs — grounded,
never opinions. The workflow must be in the C1-C3 grounding envelope (see
docs/credit-assignment-phaseE.md): reward is session-scope, value flows through SDK
channels, and an `if agent.is_ablated(): ...` short-circuit removes an ablated agent's
contribution.

Threading model: this is a PLAIN def (not async). It drives the async workflow via
asyncio.run() — one fresh loop per coalition run — so it owns no running event loop.
If you call it from async code, offload with `await asyncio.to_thread(measure_credit_by_rerun, ...)`.
"""
import asyncio
from collections.abc import Awaitable, Callable

from .session import Session
from .counterfactual import counterfactual_credit, CounterfactualResult

Workflow = Callable[[Session], Awaitable[None]]


def _run_once(workflow: Workflow, ablated: set[str], channel: str, port: int | None) -> float:
    """Re-execute the workflow with `ablated` agents neutralized; return the terminal reward."""
    async def drive() -> float:
        s = Session(name=f"rerun ablate={sorted(ablated) or 'none'}", port=port,
                    autostart_relay=False, dry_run=True)
        s._ablated = set(ablated)
        await s.connect(wait_timeout=0)        # headless: reward is captured locally
        try:
            await workflow(s)
            oc = s.last_outcome.get(channel)
            return float(oc["value"]) if oc else 0.0
        finally:
            await s.close(flush_timeout=0)
    return asyncio.run(drive())


def measure_credit_by_rerun(
    workflow: Workflow,
    agent_names: list[str],
    *,
    samples: int = 60,
    channel: str = "reward",
    seed: int = 0,
    port: int | None = None,
    method: str = "counterfactual",
    publish: bool = True,
) -> list[CounterfactualResult]:
    all_names = set(agent_names)

    def v_fn(live_set, _sample):
        ablated = all_names - set(live_set)
        return _run_once(workflow, ablated, channel, port)

    results = counterfactual_credit(agent_names, v_fn, samples=samples, seed=seed)

    if publish:
        async def _publish() -> None:
            s = Session(name="credit-report", port=port, autostart_relay=False)
            await s.connect(wait_timeout=1.0)
            try:
                await s.report_credit(method=method, channel=channel, agents=[{
                    "agent": r.agent_id, "credit": round(r.credit, 4),
                    "ci": [round(r.ci[0], 4), round(r.ci[1], 4)],
                    "credit_state": r.credit_state, "basis": "measured",
                } for r in results])
            finally:
                await s.close(flush_timeout=1.0)
        try:
            asyncio.run(_publish())
        except Exception:
            pass   # publishing is best-effort; the measured results are returned regardless

    return results
