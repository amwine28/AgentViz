"""Rung 2 — counterfactual leave-one-out credit (Python sibling of
ui/src/counterfactual.ts, for the live re-run harness).

Given a value function v(live_set, sample) — the reward when exactly `live_set`
agents are live on a given paired re-run sample — estimate each agent's causal
marginal contribution v(N) - v(N\\{i}) over K paired samples, with a bootstrap
confidence interval.

Honesty (the point): a sampled measurement is a DISTRIBUTION, not a scalar.
Every result carries a CI and a credit_state:
  estimated         — CI excludes 0: a measured effect.
  tight_null        — CI tightly brackets 0: confidently ~no effect.
  low_power_unknown — CI wide and straddling 0, or below min samples: unknown,
                      never a fabricated number.
"""
import random
from dataclasses import dataclass


@dataclass
class CounterfactualResult:
    agent_id: str
    credit: float
    ci: tuple[float, float]
    credit_state: str       # estimated | tight_null | low_power_unknown
    samples: int
    method: str = "counterfactual"
    basis: str = "measured"


def _bootstrap_ci(draws, B, alpha, rng):
    n = len(draws)
    if n == 0:
        return (0.0, 0.0)
    means = []
    for _ in range(B):
        s = 0.0
        for _ in range(n):
            s += draws[rng.randrange(n)]
        means.append(s / n)
    means.sort()
    lo = means[min(B - 1, int((alpha / 2) * B))]
    hi = means[min(B - 1, int((1 - alpha / 2) * B))]
    return (lo, hi)


def counterfactual_credit(
    agent_ids, v_fn, *,
    samples=80, bootstrap=2000, seed=0x9E3779B9,
    min_k=20, alpha=0.05, tight_width=0.05, live_set_for=None,
):
    rng = random.Random(seed)
    allset = set(agent_ids)
    if live_set_for is None:
        def live_set_for(removed, a):
            s = set(a)
            s.discard(removed)
            return s

    out = []
    for aid in agent_ids:
        without = live_set_for(aid, allset)
        draws = [v_fn(allset, k) - v_fn(without, k) for k in range(samples)]  # paired (CRN)
        mean = sum(draws) / samples if samples else 0.0
        ci = _bootstrap_ci(draws, bootstrap, alpha, rng)
        straddles = ci[0] <= 0 <= ci[1]
        if samples < min_k:
            state = "low_power_unknown"
        elif straddles:
            state = "tight_null" if (ci[1] - ci[0]) <= tight_width else "low_power_unknown"
        else:
            state = "estimated"
        out.append(CounterfactualResult(aid, mean, ci, state, samples))
    return out
