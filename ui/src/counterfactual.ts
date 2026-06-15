/** Rung 2 — counterfactual leave-one-out credit (the grounded causal estimator).
 *
 * Given a value function v(liveSet, sample) — the reward when exactly `liveSet`
 * agents are live on a given (paired) re-run sample — estimate each agent's
 * causal marginal contribution v(N) - v(N\{i}) over K paired samples, with a
 * bootstrap confidence interval. Pure + deterministic for a fixed seed; tested
 * against an injected v(·) so the math is verified with NO real LLM calls.
 *
 * Honesty (the whole point): a sampled measurement is a DISTRIBUTION, never a
 * scalar. Every result carries a CI and a credit_state:
 *   estimated         — CI excludes 0: a measured effect.
 *   tight_null        — CI tightly brackets 0: confidently ~no effect.
 *   low_power_unknown — CI wide and straddling 0 (or too few samples): we cannot
 *                       tell. Reported as unknown, never as a fabricated number.
 *
 * Spawn cascade: ablating a parent removes the children it would have spawned;
 * pass `liveSetFor` to model the spawn-feasible closure so the parent is credited
 * for the whole downstream cascade (default = N \ {i}). */

export type ValueFn = (live: Set<string>, sample: number) => number;

export interface CounterfactualOptions {
  samples?: number;     // K paired samples per agent
  bootstrap?: number;   // bootstrap resamples for the CI
  seed?: number;        // deterministic RNG seed
  minK?: number;        // below this many samples -> low_power_unknown
  alpha?: number;       // CI level (0.05 => 95% CI)
  tightWidth?: number;  // a zero-straddling CI narrower than this => tight_null
  liveSetFor?: (removed: string, all: Set<string>) => Set<string>;
}

export interface CounterfactualResult {
  agent_id: string;
  credit: number;
  ci: [number, number];
  credit_state: "estimated" | "low_power_unknown" | "tight_null";
  samples: number;
  method: "counterfactual";
  basis: "measured";
}

// mulberry32 — small deterministic PRNG so bootstrap CIs are reproducible in tests.
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)));
  return sorted[idx];
}

function bootstrapCI(draws: number[], B: number, alpha: number, rng: () => number): [number, number] {
  const n = draws.length;
  if (n === 0) return [0, 0];
  const means = new Array<number>(B);
  for (let b = 0; b < B; b++) {
    let sum = 0;
    for (let j = 0; j < n; j++) sum += draws[Math.floor(rng() * n)];
    means[b] = sum / n;
  }
  means.sort((a, b) => a - b);
  return [percentile(means, alpha / 2), percentile(means, 1 - alpha / 2)];
}

export function counterfactualCredit(
  allIds: string[],
  vFn: ValueFn,
  opts: CounterfactualOptions = {}
): CounterfactualResult[] {
  const K = opts.samples ?? 80;
  const B = opts.bootstrap ?? 2000;
  const minK = opts.minK ?? 20;
  const alpha = opts.alpha ?? 0.05;
  const tight = opts.tightWidth ?? 0.05;
  const rng = mulberry32(opts.seed ?? 0x9e3779b9);
  const all = new Set(allIds);
  const liveFor = opts.liveSetFor ?? ((removed: string, a: Set<string>) => {
    const s = new Set(a); s.delete(removed); return s;
  });

  return allIds.map((id) => {
    const without = liveFor(id, all);
    const draws = new Array<number>(K);
    for (let k = 0; k < K; k++) draws[k] = vFn(all, k) - vFn(without, k);  // paired (CRN)
    const mean = draws.reduce((a, b) => a + b, 0) / K;
    const ci = bootstrapCI(draws, B, alpha, rng);
    const straddlesZero = ci[0] <= 0 && 0 <= ci[1];
    let credit_state: CounterfactualResult["credit_state"];
    if (K < minK) credit_state = "low_power_unknown";
    else if (straddlesZero) credit_state = (ci[1] - ci[0]) <= tight ? "tight_null" : "low_power_unknown";
    else credit_state = "estimated";
    return { agent_id: id, credit: mean, ci, credit_state, samples: K, method: "counterfactual", basis: "measured" };
  });
}
