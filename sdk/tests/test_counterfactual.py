"""Rung 2 counterfactual estimator (Python port for the live re-run harness).
Parity with ui/src/counterfactual.ts — verified against an injected v(.), no LLM."""
from agentviz.counterfactual import counterfactual_credit


def contrib_fn(weights):
    def v(live, _sample):
        return sum(weights.get(a, 0.0) for a in live)
    return v


def by_id(rows, aid):
    return next(r for r in rows if r.agent_id == aid)


def test_deterministic_recovers_marginal_contributions():
    rows = counterfactual_credit(["A", "B", "C"], contrib_fn({"A": 0.5, "B": 0.0, "C": -0.3}), seed=1)
    assert abs(by_id(rows, "A").credit - 0.5) < 1e-9
    assert abs(by_id(rows, "B").credit - 0.0) < 1e-9
    assert abs(by_id(rows, "C").credit + 0.3) < 1e-9


def test_real_positive_contributor_is_estimated_ci_excludes_zero():
    rows = counterfactual_credit(["A", "B"], contrib_fn({"A": 0.5, "B": 0.0}), seed=2)
    a = by_id(rows, "A")
    assert a.credit_state == "estimated"
    assert a.ci[0] > 0


def test_deterministic_zero_is_tight_null():
    rows = counterfactual_credit(["A", "B"], contrib_fn({"A": 0.5, "B": 0.0}), seed=3)
    b = by_id(rows, "B")
    assert b.credit_state == "tight_null"
    assert b.ci[0] <= 0 <= b.ci[1]


def test_noisy_contributor_ci_has_width_and_brackets_truth():
    import math
    def v(live, k):
        return (0.5 + math.sin(k) * 0.3 if "A" in live else 0.0) + (0.1 if "B" in live else 0.0)
    rows = counterfactual_credit(["A", "B"], v, seed=4, samples=200)
    a = by_id(rows, "A")
    assert a.ci[1] - a.ci[0] > 0
    assert a.ci[0] < 0.5 < a.ci[1]


def test_wide_ci_straddling_zero_is_low_power_unknown():
    import math
    def v(live, k):
        return math.sin(k * 1.7) * 5 + math.cos(k * 0.9) * 5 if "A" in live else 0.0
    rows = counterfactual_credit(["A"], v, seed=5, samples=200)
    assert by_id(rows, "A").credit_state == "low_power_unknown"


def test_min_k_guard():
    rows = counterfactual_credit(["A"], contrib_fn({"A": 0.5}), seed=6, samples=5, min_k=20)
    assert by_id(rows, "A").credit_state == "low_power_unknown"


def test_spawn_cascade_parent_credited_for_children():
    v = contrib_fn({"P": 0.2, "Q": 0.4})
    def live_set_for(removed, allset):
        s = set(allset)
        s.discard(removed)
        if removed == "P":
            s.discard("Q")   # Q only exists because P spawned it
        return s
    rows = counterfactual_credit(["P", "Q"], v, seed=7, live_set_for=live_set_for)
    assert abs(by_id(rows, "P").credit - 0.6) < 1e-9   # 0.2 self + 0.4 cascade
    assert abs(by_id(rows, "Q").credit - 0.4) < 1e-9


def test_reproducible_for_fixed_seed():
    w = {"A": 0.5, "B": 0.2}
    r1 = counterfactual_credit(["A", "B"], contrib_fn(w), seed=42)
    r2 = counterfactual_credit(["A", "B"], contrib_fn(w), seed=42)
    assert [(r.agent_id, r.credit, r.ci, r.credit_state) for r in r1] == \
           [(r.agent_id, r.credit, r.ci, r.credit_state) for r in r2]
