import { describe, test, expect } from "vitest";
import { shapleyValues } from "../src/shapley";

// a coalition value function from an explicit table keyed by sorted-member string
const tableV = (t: Record<string, number>) => (S: Set<string>) => t[[...S].sort().join(",")] ?? 0;
const find = (rows: ReturnType<typeof shapleyValues>, id: string) => rows.find((r) => r.agent_id === id)!;
const total = (rows: ReturnType<typeof shapleyValues>) => rows.reduce((s, r) => s + r.shapley, 0);

describe("shapleyValues — classic Shapley (Mode A), exact", () => {
  test("additive game: each player's Shapley equals their own value", () => {
    const w: Record<string, number> = { A: 3, B: 1, C: 0 };
    const v = (S: Set<string>) => [...S].reduce((s, id) => s + (w[id] ?? 0), 0);
    const rows = shapleyValues(["A", "B", "C"], v, { exact: true });
    expect(find(rows, "A").shapley).toBeCloseTo(3);
    expect(find(rows, "B").shapley).toBeCloseTo(1);
    expect(find(rows, "C").shapley).toBeCloseTo(0);
  });

  test("unanimity game (all needed): symmetry -> 1/3 each; efficiency holds", () => {
    const v = tableV({ "A,B,C": 1 });   // only the grand coalition is worth anything
    const rows = shapleyValues(["A", "B", "C"], v, { exact: true });
    for (const id of ["A", "B", "C"]) expect(find(rows, id).shapley).toBeCloseTo(1 / 3);
    expect(total(rows)).toBeCloseTo(1);  // efficiency: Σφ = v(N) - v(∅)
  });

  test("null player gets exactly zero", () => {
    const v = (S: Set<string>) => (S.has("A") && S.has("B") ? 1 : 0);   // D never matters
    const rows = shapleyValues(["A", "B", "D"], v, { exact: true });
    expect(find(rows, "D").shapley).toBeCloseTo(0);
    expect(find(rows, "A").shapley).toBeCloseTo(0.5);
    expect(find(rows, "B").shapley).toBeCloseTo(0.5);
  });

  test("symmetric players get equal value", () => {
    const v = tableV({ "A,B": 4 });
    const rows = shapleyValues(["A", "B"], v, { exact: true });
    expect(find(rows, "A").shapley).toBeCloseTo(2);
    expect(find(rows, "A").shapley).toBeCloseTo(find(rows, "B").shapley);
  });
});

describe("shapleyValues — Monte-Carlo permutation estimator", () => {
  test("MC approximates exact classic Shapley and preserves efficiency exactly", () => {
    const v = tableV({ "A,B,C": 1, "A,B": 0.5, "A,C": 0.5, "B,C": 0 });
    const exact = shapleyValues(["A", "B", "C"], v, { exact: true });
    const mc = shapleyValues(["A", "B", "C"], v, { permutations: 20000, seed: 1 });
    for (const id of ["A", "B", "C"]) expect(find(mc, id).shapley).toBeCloseTo(find(exact, id).shapley, 1);
    expect(total(mc)).toBeCloseTo(1, 5);   // telescoping => Σφ = v(N)-v(∅) by construction
  });

  test("MC is reproducible for a fixed seed", () => {
    const v = tableV({ "A,B,C": 1, "A,B": 0.5 });
    const a = shapleyValues(["A", "B", "C"], v, { permutations: 5000, seed: 7 });
    const b = shapleyValues(["A", "B", "C"], v, { permutations: 5000, seed: 7 });
    expect(a).toEqual(b);
  });
});
