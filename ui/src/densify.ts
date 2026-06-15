/** Rung 4 — reward densification via potential-based shaping (PBRS).
 *
 * When intermediate signals exist (per-handoff potentials Φ, supplied as
 * `stage="intermediate"`, `scale="delta"` outcomes on a channel distinct from the
 * terminal reward), the sparse terminal reward can be densified into per-handoff
 * credit using the PBRS shaping term  F = γ·Φ(s') − Φ(s)  for each transition,
 * credited to the agent that produced s'.
 *
 * Honesty: the Φ-VALUES are measured, but the CHOICE of potential function Φ is a
 * modeling ASSUMPTION (basis="assumed"). PBRS's policy-invariance theorem is about
 * preserving optimal RL policies — it says NOTHING about attribution rankings, so
 * no ranking-correctness claim is made or implied here. */

export interface Handoff { agent_id: string; potential: number; }   // Φ after this agent acted
export interface DensifyOptions { gamma?: number; phi0?: number; }
export interface DensifiedCredit { agent_id: string; credit: number; method: "densified"; basis: "assumed"; }

export function densifiedCredit(steps: Handoff[], opts: DensifyOptions = {}): DensifiedCredit[] {
  const gamma = opts.gamma ?? 1;
  let phiPrev = opts.phi0 ?? 0;
  const acc = new Map<string, number>();
  const order: string[] = [];
  for (const step of steps) {
    const F = gamma * step.potential - phiPrev;   // shaped reward for this transition
    if (!acc.has(step.agent_id)) order.push(step.agent_id);
    acc.set(step.agent_id, (acc.get(step.agent_id) ?? 0) + F);
    phiPrev = step.potential;
  }
  return order.map((id) => ({ agent_id: id, credit: acc.get(id)!, method: "densified", basis: "assumed" }));
}
