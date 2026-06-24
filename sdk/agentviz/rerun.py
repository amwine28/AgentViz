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
import uuid
from collections.abc import Awaitable, Callable

from .session import Session
from .counterfactual import counterfactual_credit, CounterfactualResult
from .exceptions import RerunRefused

Workflow = Callable[[Session], Awaitable[None]]


def spawn_closure(roots: set[str], parent_of: dict[str, str]) -> set[str]:
    """The spawn-feasible closure of `roots`: the roots plus every transitive descendant,
    using the baseline-observed name->parent map. Ablating a parent removes the cascade
    it would spawn (§3.2), so the closure is ablated by NAME — robust even if a descendant
    is re-parented to a live agent at runtime (which would escape the UUID cascade)."""
    dead = set(roots)
    changed = True
    while changed:
        changed = False
        for child, parent in parent_of.items():
            if parent in dead and child not in dead:
                dead.add(child)
                changed = True
    return dead


def _probe_topology(workflow: Workflow, channel: str, port: int | None,
                    run_id: str | None = None) -> dict[str, str]:
    """Run the workflow once (baseline, no ablation) to observe its spawn topology
    (child name -> parent name), used to build the ablation closure. `run_id` pins
    the probe to the re-run batch's BASE id so its siblings nest under it in Logs."""
    async def drive() -> dict[str, str]:
        s = Session(name="rerun-probe", port=port, autostart_relay=False, dry_run=True, run_id=run_id)
        await s.connect(wait_timeout=0)
        try:
            await workflow(s)
            return {sp["name"]: sp["parent"] for sp in s._spawns if sp["parent"]}
        finally:
            await s.close(flush_timeout=0)
    return asyncio.run(drive())


def _run_once(workflow: Workflow, ablated: set[str], channel: str, port: int | None,
              sample: int = 0, baseline_run_id: str | None = None) -> float | None:
    """Re-execute the workflow with `ablated` agents neutralized; return the terminal
    reward, or None if the run produced NO measured outcome on `channel` (a dropped
    sample — never silently treated as 0.0, which would pollute v(N)).

    `sample` is threaded onto the Session (s.sample) with COMMON RANDOM NUMBERS: the
    baseline and each ablation share the same sample index, so a stochastic workflow's
    shared noise cancels in the marginal v(N)-v(N\\{i}) while the ablated agent's own
    variation survives — giving honest confidence intervals."""
    async def drive() -> float | None:
        s = Session(name=f"rerun ablate={sorted(ablated) or 'none'}", port=port,
                    autostart_relay=False, dry_run=True, baseline_run_id=baseline_run_id)
        s._ablated = set(ablated)
        s.sample = sample
        await s.connect(wait_timeout=0)        # headless: reward is captured locally
        try:
            await workflow(s)
            oc = s.last_outcome.get(channel)
            if oc is None or not oc.get("measured", True):
                return None                    # no real measurement — honest unknown
            return float(oc["value"])
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
    gate_samples: int = 5,
    gate_fraction: float = 1.0,
) -> list[CounterfactualResult]:
    all_names = set(agent_names)

    # One BASE run id for this whole re-run batch: the probe is pinned to it, and
    # every sibling re-run (gate, ablations, credit-report) carries it as
    # baseline_run_id so they nest under the base run in the Logs panel.
    base_run_id = str(uuid.uuid4())

    # Acceptance gate: the baseline grand coalition must produce a reliably MEASURED
    # reward, or we refuse to ground credit on it (honest-unknown over confidently-wrong).
    measured = sum(1 for _ in range(gate_samples)
                   if _run_once(workflow, set(), channel, port, baseline_run_id=base_run_id) is not None)
    if measured / gate_samples < gate_fraction:
        raise RerunRefused(
            f"baseline reward on channel '{channel}' is absent or flaky "
            f"({measured}/{gate_samples} runs produced a measured outcome) — "
            f"refusing to publish credit grounded on it"
        )

    # Spawn-closure: ablating an agent also ablates the cascade it would spawn (§3.2).
    # Built from the baseline topology and ablated by NAME (robust to re-parenting).
    parent_of = _probe_topology(workflow, channel, port, run_id=base_run_id)

    def live_set_for(removed, names):
        return set(names) - spawn_closure({removed}, parent_of)

    def v_fn(live_set, sample):
        ablated = all_names - set(live_set)
        r = _run_once(workflow, ablated, channel, port, sample, baseline_run_id=base_run_id)   # CRN: same sample both sides
        if r is None:
            # a coalition dropped its reward post-gate — fail loudly, never fake a 0.0
            raise RerunRefused(
                f"a re-run produced no measured outcome on '{channel}' "
                f"(ablated={sorted(ablated)}) — cannot ground a marginal on a missing reward"
            )
        return r

    results = counterfactual_credit(agent_names, v_fn, samples=samples, seed=seed,
                                    live_set_for=live_set_for)

    if publish:
        async def _publish() -> None:
            s = Session(name="credit-report", port=port, autostart_relay=False, baseline_run_id=base_run_id)
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
