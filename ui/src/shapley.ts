/** Rung 3 — Shapley credit (classic, Mode A).
 *
 * The Shapley value is the unique allocation satisfying Efficiency, Symmetry,
 * Null-player, and Additivity FOR A GAME v DEFINED ON ALL SUBSETS of N. This
 * module computes exactly that: exact enumeration for small N, and an unbiased
 * Monte-Carlo permutation estimator (Castro et al.) for larger N.
 *
 * Honesty notes (per the design review):
 *  - This is CLASSIC Shapley over all coalitions. A precedence-constrained
 *    variant (Faigle–Kern, restricting to DAG-feasible coalitions) is a DIFFERENT
 *    solution concept with a MODIFIED axiom set — not implemented here; do not
 *    conflate the two.
 *  - The MC estimator is unbiased ONLY with uniform random permutations (done here).
 *  - Truncation (TMC) would introduce bias; it is intentionally NOT applied, so
 *    this estimator is not labelled with any truncation guarantee it doesn't have.
 *  - v(S) must be deterministic here. For a stochastic re-run value, estimate v(S)
 *    as a mean (compose with the Rung-2 sampler) before passing it in. */

export type CoalitionValueFn = (coalition: Set<string>) => number;

export interface ShapleyOptions {
  exact?: boolean;        // force exact enumeration (default: auto when n <= 12)
  permutations?: number;  // MC sample count when not exact
  seed?: number;
}

export interface ShapleyResult { agent_id: string; shapley: number; method: "shapley"; }

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function exactShapley(ids: string[], v: CoalitionValueFn): ShapleyResult[] {
  const n = ids.length;
  const fact: number[] = [1];
  for (let i = 1; i <= n; i++) fact[i] = fact[i - 1] * i;
  const phi = new Map<string, number>(ids.map((id) => [id, 0]));
  // iterate every subset S (bitmask over ids); add each absent member's weighted marginal
  for (let mask = 0; mask < (1 << n); mask++) {
    const S = new Set<string>();
    let size = 0;
    for (let i = 0; i < n; i++) if (mask & (1 << i)) { S.add(ids[i]); size++; }
    const vS = v(S);
    const weight = (fact[size] * fact[n - size - 1]) / fact[n];
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) continue;          // only members NOT in S
      const withI = new Set(S); withI.add(ids[i]);
      phi.set(ids[i], phi.get(ids[i])! + weight * (v(withI) - vS));
    }
  }
  return ids.map((id) => ({ agent_id: id, shapley: phi.get(id)!, method: "shapley" }));
}

function mcShapley(ids: string[], v: CoalitionValueFn, M: number, seed: number): ShapleyResult[] {
  const rng = mulberry32(seed);
  const phi = new Map<string, number>(ids.map((id) => [id, 0]));
  const order = [...ids];
  for (let m = 0; m < M; m++) {
    // Fisher–Yates shuffle -> uniform random permutation (unbiasedness depends on this)
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const prefix = new Set<string>();
    let vPrev = v(prefix);                     // v(∅)
    for (const id of order) {
      prefix.add(id);
      const vNow = v(prefix);
      phi.set(id, phi.get(id)! + (vNow - vPrev));   // marginal contribution in this ordering
      vPrev = vNow;
    }
  }
  return ids.map((id) => ({ agent_id: id, shapley: phi.get(id)! / M, method: "shapley" }));
}

export function shapleyValues(agentIds: string[], v: CoalitionValueFn, opts: ShapleyOptions = {}): ShapleyResult[] {
  const exact = opts.exact ?? agentIds.length <= 12;
  return exact
    ? exactShapley(agentIds, v)
    : mcShapley(agentIds, v, opts.permutations ?? 10000, opts.seed ?? 0x9e3779b9);
}
