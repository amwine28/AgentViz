import { describe, test, expect } from "vitest";
import { counterfactualCredit } from "../src/counterfactual";

// A deterministic value function: reward = sum of each live agent's fixed contribution.
const contribFn = (w: Record<string, number>) => (live: Set<string>) =>
  [...live].reduce((s, id) => s + (w[id] ?? 0), 0);

const find = (rows: ReturnType<typeof counterfactualCredit>, id: string) =>
  rows.find((r) => r.agent_id === id)!;

describe("counterfactualCredit — Rung 2 leave-one-out estimator (grounded, injected v)", () => {
  test("deterministic v: recovers each agent's marginal contribution", () => {
    const rows = counterfactualCredit(["A", "B", "C"], contribFn({ A: 0.5, B: 0, C: -0.3 }), { seed: 1 });
    expect(find(rows, "A").credit).toBeCloseTo(0.5);
    expect(find(rows, "B").credit).toBeCloseTo(0);
    expect(find(rows, "C").credit).toBeCloseTo(-0.3);
  });

  test("a real positive contributor is 'estimated' with a CI that excludes 0", () => {
    const rows = counterfactualCredit(["A", "B"], contribFn({ A: 0.5, B: 0 }), { seed: 2 });
    const a = find(rows, "A");
    expect(a.credit_state).toBe("estimated");
    expect(a.ci[0]).toBeGreaterThan(0);     // CI excludes zero -> a real effect
  });

  test("a deterministic zero contributor is 'tight_null' (confidently ~0), not unknown", () => {
    const rows = counterfactualCredit(["A", "B"], contribFn({ A: 0.5, B: 0 }), { seed: 3 });
    const b = find(rows, "B");
    expect(b.credit_state).toBe("tight_null");
    expect(b.ci[0]).toBeLessThanOrEqual(0);
    expect(b.ci[1]).toBeGreaterThanOrEqual(0);
  });

  test("noisy contributor: CI has width and brackets the true effect", () => {
    // A's contribution is noisy per sample (does not cancel under CRN); B is clean noise.
    const vFn = (live: Set<string>, k: number) =>
      (live.has("A") ? 0.5 + Math.sin(k) * 0.3 : 0) + (live.has("B") ? 0.1 : 0);
    const rows = counterfactualCredit(["A", "B"], vFn, { seed: 4, samples: 200 });
    const a = find(rows, "A");
    expect(a.ci[1] - a.ci[0]).toBeGreaterThan(0);          // genuine width
    expect(a.ci[0]).toBeLessThan(0.5);
    expect(a.ci[1]).toBeGreaterThan(0.5);                   // brackets truth
  });

  test("a wide CI straddling zero is 'low_power_unknown', never a fabricated number", () => {
    // large per-sample noise around a ~0 mean
    const vFn = (live: Set<string>, k: number) =>
      live.has("A") ? Math.sin(k * 1.7) * 5 + Math.cos(k * 0.9) * 5 : 0;
    const rows = counterfactualCredit(["A"], vFn, { seed: 5, samples: 200 });
    expect(find(rows, "A").credit_state).toBe("low_power_unknown");
  });

  test("below the min-sample guard -> low_power_unknown", () => {
    const rows = counterfactualCredit(["A"], contribFn({ A: 0.5 }), { seed: 6, samples: 5, minK: 20 });
    expect(find(rows, "A").credit_state).toBe("low_power_unknown");
  });

  test("spawn-cascade: ablating a parent removes its child, so the parent is credited for the cascade", () => {
    // P spawns Q; Q contributes 0.4, P 0.2. Ablating P removes Q too (spawn closure).
    const vFn = contribFn({ P: 0.2, Q: 0.4 });
    const liveSetFor = (removed: string, all: Set<string>) => {
      const s = new Set(all);
      s.delete(removed);
      if (removed === "P") s.delete("Q");   // Q only exists because P spawned it
      return s;
    };
    const rows = counterfactualCredit(["P", "Q"], vFn, { seed: 7, liveSetFor });
    expect(find(rows, "P").credit).toBeCloseTo(0.6);   // 0.2 (self) + 0.4 (cascade)
    expect(find(rows, "Q").credit).toBeCloseTo(0.4);
  });

  test("deterministic estimator is reproducible for a fixed seed", () => {
    const w = { A: 0.5, B: 0.2 };
    const r1 = counterfactualCredit(["A", "B"], contribFn(w), { seed: 42 });
    const r2 = counterfactualCredit(["A", "B"], contribFn(w), { seed: 42 });
    expect(r1).toEqual(r2);
  });
});
