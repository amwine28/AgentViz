"""Actionable recommendations from measured credit — the 'use it twice' layer.

Turns CounterfactualResults into concrete decisions (prune this, harden that, gather more
samples, investigate a regression). GROUNDED: every recommendation traces to a measured fact
— the credit_state, the confidence interval, the cost — never an opinion. A healthy node
with a normal measured contribution produces NO recommendation (keep the signal clean).
"""
from agentviz.counterfactual import CounterfactualResult
from agentviz.recommend import recommend, Recommendation, format_recommendations


def _r(aid, credit, ci, state, samples=200):
    return CounterfactualResult(aid, credit, ci, state, samples)


def test_prune_candidate_for_tight_null_with_savings():
    results = [_r("retriever", 0.5, (0.45, 0.55), "estimated"),
               _r("stylist", 0.0, (-0.01, 0.01), "tight_null")]
    recs = recommend(results, cost_by_node={"stylist": 0.012, "retriever": 0.03},
                     channel="quality")
    prune = [x for x in recs if x.rule == "prune_candidate"]
    assert len(prune) == 1
    assert prune[0].agents == ["stylist"]
    assert abs(prune[0].savings_usd - 0.012) < 1e-9
    assert prune[0].severity in ("medium", "high")
    assert "quality" in prune[0].rationale          # names the channel it's null on


def test_no_recommendation_for_healthy_estimated_node():
    results = [_r("reasoner", 0.3, (0.28, 0.32), "estimated")]
    assert recommend(results, total_reward=1.0) == []   # nothing to act on — stay quiet


def test_single_point_of_failure_flagged():
    results = [_r("planner", 0.82, (0.80, 0.84), "estimated"),
               _r("helper", 0.10, (0.08, 0.12), "estimated")]
    recs = recommend(results, total_reward=1.0, spof_fraction=0.7)
    spof = [x for x in recs if x.rule == "single_point_of_failure"]
    assert len(spof) == 1
    assert spof[0].agents == ["planner"]
    assert spof[0].severity == "high"


def test_low_power_unknown_suggests_more_samples():
    results = [_r("noisy", 0.2, (-0.3, 0.7), "low_power_unknown", samples=15)]
    recs = recommend(results)
    assert any(x.rule == "increase_samples" and x.agents == ["noisy"] for x in recs)


def test_regression_detected_against_baseline():
    baseline = [_r("verifier", 0.40, (0.36, 0.44), "estimated")]
    current = [_r("verifier", 0.05, (0.02, 0.08), "estimated")]
    recs = recommend(current, baseline=baseline, regression_drop=0.1)
    reg = [x for x in recs if x.rule == "regression"]
    assert len(reg) == 1
    assert reg[0].agents == ["verifier"]
    assert reg[0].severity == "high"
    assert "0.40" in reg[0].rationale and "0.05" in reg[0].rationale


def test_overlapping_cis_is_not_a_regression():
    # a drop within noise (CIs overlap) must NOT be flagged — honest, no false alarms
    baseline = [_r("verifier", 0.40, (0.30, 0.50), "estimated")]
    current = [_r("verifier", 0.34, (0.24, 0.44), "estimated")]
    recs = recommend(current, baseline=baseline, regression_drop=0.05)
    assert not [x for x in recs if x.rule == "regression"]


def test_format_recommendations_is_readable_text():
    recs = recommend([_r("stylist", 0.0, (-0.01, 0.01), "tight_null")],
                     cost_by_node={"stylist": 0.02})
    text = format_recommendations(recs)
    assert isinstance(text, str)
    assert "prune_candidate" in text and "stylist" in text
