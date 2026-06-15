import { describe, test, expect } from "vitest";
import { densifiedCredit } from "../src/densify";

const find = (rows: ReturnType<typeof densifiedCredit>, id: string) => rows.find((r) => r.agent_id === id)!;

describe("densifiedCredit — Rung 4 potential-based shaping (per-handoff)", () => {
  test("per-step shaped reward F = γ·Φ(s') − Φ(s), credited to the acting agent", () => {
    // potentials measured after each agent acts (intermediate 'delta' outcomes)
    const rows = densifiedCredit([
      { agent_id: "A", potential: 0.3 },
      { agent_id: "B", potential: 0.7 },
      { agent_id: "C", potential: 1.0 },
    ], { gamma: 1, phi0: 0 });
    expect(find(rows, "A").credit).toBeCloseTo(0.3);   // 0.3 - 0
    expect(find(rows, "B").credit).toBeCloseTo(0.4);   // 0.7 - 0.3
    expect(find(rows, "C").credit).toBeCloseTo(0.3);   // 1.0 - 0.7
  });

  test("telescopes: Σ credit = γ·Φ(last) − Φ(0)", () => {
    const rows = densifiedCredit([
      { agent_id: "A", potential: 0.3 },
      { agent_id: "B", potential: 1.0 },
    ], { gamma: 1, phi0: 0 });
    expect(rows.reduce((s, r) => s + r.credit, 0)).toBeCloseTo(1.0);
  });

  test("the same agent acting twice accumulates its shaped credit", () => {
    const rows = densifiedCredit([
      { agent_id: "A", potential: 0.2 },
      { agent_id: "B", potential: 0.5 },
      { agent_id: "A", potential: 0.9 },
    ], { gamma: 1, phi0: 0 });
    expect(find(rows, "A").credit).toBeCloseTo(0.2 + 0.4);  // (0.2-0) + (0.9-0.5)
    expect(find(rows, "B").credit).toBeCloseTo(0.3);        // 0.5-0.2
  });

  test("results are tagged assumed/densified (Φ-choice is a modeling assumption)", () => {
    const rows = densifiedCredit([{ agent_id: "A", potential: 1 }]);
    expect(rows[0].method).toBe("densified");
    expect(rows[0].basis).toBe("assumed");
  });

  test("gamma discounts the next-state potential", () => {
    const rows = densifiedCredit([
      { agent_id: "A", potential: 1.0 },
    ], { gamma: 0.5, phi0: 0 });
    expect(find(rows, "A").credit).toBeCloseTo(0.5);   // 0.5·1.0 − 0
  });
});
