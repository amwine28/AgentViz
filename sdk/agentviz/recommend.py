"""Actionable recommendations from measured credit — turn the numbers into decisions.

A credit measurement tells you what each agent contributed. This turns that into what to DO:
prune a node that contributes ~0, harden a load-bearing single point of failure, gather more
samples where the signal is undetermined, or investigate a contribution that regressed against
a baseline.

GROUNDED, like the rest of AgentViz: every recommendation traces to a measured fact — the
credit_state (a confidence-interval verdict), the CI itself, the cost — never an opinion. A
healthy node with a normal measured contribution yields NO recommendation; silence means
"nothing to act on", not "not analyzed". The suggested action is framed as "review / verify",
because the measurement answers ONE reward channel — the human owns the decision (a tight-null
node may still matter for latency, safety, or a different objective).
"""
from dataclasses import dataclass

from .counterfactual import CounterfactualResult


@dataclass
class Recommendation:
    rule: str               # prune_candidate | single_point_of_failure | increase_samples | regression
    severity: str           # high | medium | info
    agents: list[str]
    action: str             # the suggested decision (framed as review/verify)
    rationale: str          # the measured fact it traces to
    savings_usd: float | None = None


def recommend(
    results: list[CounterfactualResult],
    *,
    cost_by_node: dict[str, float] | None = None,
    total_reward: float | None = None,
    baseline: list[CounterfactualResult] | None = None,
    channel: str = "the measured outcome",
    spof_fraction: float = 0.7,
    regression_drop: float = 0.1,
) -> list[Recommendation]:
    """Derive grounded recommendations from measured counterfactual credit.

    cost_by_node   per-node $/run (from usage data) — enables prune savings.
    total_reward   the baseline grand-coalition reward — enables single-point-of-failure.
    baseline       a prior measurement to compare against — enables regression detection.
    """
    recs: list[Recommendation] = []
    base_by_id = {b.agent_id: b for b in (baseline or [])}

    for r in results:
        # R1 — prune candidate: confidently ~0 contribution to this channel.
        if r.credit_state == "tight_null":
            savings = cost_by_node.get(r.agent_id) if cost_by_node else None
            recs.append(Recommendation(
                rule="prune_candidate",
                severity="medium" if savings else "info",
                agents=[r.agent_id],
                action=(f"Review '{r.agent_id}' for removal — it contributes ~0 to {channel}"
                        + (f" while costing ${savings:.4f}/run" if savings else "")
                        + ". Verify it isn't needed for another objective, latency, or safety."),
                rationale=(f"credit {r.credit:+.3f}, 95% CI [{r.ci[0]:+.3f}, {r.ci[1]:+.3f}] "
                           f"tightly brackets 0 on {channel} ({r.samples} samples)"),
                savings_usd=savings,
            ))

        # R2 — single point of failure: a measured contribution that is most of the reward.
        if (total_reward is not None and total_reward > 0 and r.credit_state == "estimated"
                and r.credit >= spof_fraction * total_reward):
            pct = 100.0 * r.credit / total_reward
            recs.append(Recommendation(
                rule="single_point_of_failure",
                severity="high",
                agents=[r.agent_id],
                action=(f"Harden '{r.agent_id}' (tests / fallback / redundancy) — removing it "
                        f"collapses the outcome."),
                rationale=(f"credit {r.credit:+.3f} ≈ {pct:.0f}% of total reward "
                           f"{total_reward:.3f} (95% CI [{r.ci[0]:+.3f}, {r.ci[1]:+.3f}])"),
            ))

        # R3 — undetermined: not enough signal to decide; don't act, measure more.
        if r.credit_state == "low_power_unknown":
            recs.append(Recommendation(
                rule="increase_samples",
                severity="info",
                agents=[r.agent_id],
                action=(f"Increase samples for '{r.agent_id}' — its contribution is undetermined; "
                        f"don't prune or trust it yet."),
                rationale=(f"credit {r.credit:+.3f}, 95% CI [{r.ci[0]:+.3f}, {r.ci[1]:+.3f}] is "
                           f"wide and straddles 0 ({r.samples} samples)"),
            ))

        # R4 — regression vs a baseline measurement: a confident drop (CIs don't overlap).
        b = base_by_id.get(r.agent_id)
        if b is not None and (b.credit - r.credit) >= regression_drop and r.ci[1] < b.ci[0]:
            recs.append(Recommendation(
                rule="regression",
                severity="high",
                agents=[r.agent_id],
                action=(f"Investigate '{r.agent_id}' — its contribution dropped materially since "
                        f"the baseline."),
                rationale=(f"credit fell {b.credit:+.3f} → {r.credit:+.3f}; current CI "
                           f"[{r.ci[0]:+.3f}, {r.ci[1]:+.3f}] is entirely below baseline CI "
                           f"[{b.ci[0]:+.3f}, {b.ci[1]:+.3f}] — a confident drop, not noise"),
            ))

    _SEV_ORDER = {"high": 0, "medium": 1, "info": 2}
    recs.sort(key=lambda x: _SEV_ORDER.get(x.severity, 9))
    return recs


def format_recommendations(recs: list[Recommendation]) -> str:
    """Render recommendations as readable text for a CLI / email / report."""
    if not recs:
        return "No recommendations — every node's measured contribution is healthy."
    _ICON = {"high": "‼", "medium": "▲", "info": "·"}
    lines = []
    for r in recs:
        head = f"{_ICON.get(r.severity, '·')} [{r.rule}] {', '.join(r.agents)}"
        if r.savings_usd:
            head += f"  (~${r.savings_usd:.4f}/run)"
        lines.append(head)
        lines.append(f"    → {r.action}")
        lines.append(f"      why: {r.rationale}")
    return "\n".join(lines)
