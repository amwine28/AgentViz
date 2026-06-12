import type { AppState } from "./store";

/** Rule-based workflow efficiency audit.
 *
 * Every point deducted traces to a verifiable fact in the event stream —
 * no model judgement anywhere. Each finding names its rule, the agents
 * involved, and the exact reason, so the score is an argument, not a vibe. */

export interface AuditFinding {
  rule: "dead_weight" | "error_exits" | "denied_tools" | "duplicate_roles" | "token_skew";
  reason: string;
  agents: string[]; // agent names
  penalty: number;
}

export interface WorkflowAudit {
  score: number; // 0–100
  grade: "A" | "B" | "C" | "D" | "F";
  findings: AuditFinding[];
  tokens_total: number;
  cost_total: number;
}

const CAPS = { dead_weight: 36, error_exits: 24, denied_tools: 10, duplicate_roles: 18, token_skew: 8 };

export function auditWorkflow(state: AppState): WorkflowAudit {
  const agents = Object.values(state.agents);
  const findings: AuditFinding[] = [];

  /* per-agent output counts (tool results + messages sent) */
  const sent = new Map<string, number>();
  for (const e of Object.values(state.messageEdges)) {
    sent.set(e.from_agent_id, (sent.get(e.from_agent_id) ?? 0) + e.messages.length);
  }
  const outputs = new Map<string, number>(agents.map((a) => [
    a.id,
    a.tool_calls.filter((tc) => !tc.pending && !tc.denied).length + (sent.get(a.id) ?? 0),
  ]));

  /* dead weight: spawned, did nothing, told nobody anything (root exempt —
     orchestrators legitimately only listen) */
  const dead = agents.filter(
    (a) => a.parent_id && a.tool_calls.length === 0 && (sent.get(a.id) ?? 0) === 0
  );
  if (dead.length > 0) {
    findings.push({
      rule: "dead_weight",
      reason: `${dead.length} agent(s) spawned but made no tool calls and sent no messages — fewer agents could do this job`,
      agents: dead.map((a) => a.name),
      penalty: Math.min(12 * dead.length, CAPS.dead_weight),
    });
  }

  /* error exits */
  const errored = agents.filter((a) => a.status === "error");
  if (errored.length > 0) {
    findings.push({
      rule: "error_exits",
      reason: `${errored.length} agent(s) exited with errors`,
      agents: errored.map((a) => a.name),
      penalty: Math.min(8 * errored.length, CAPS.error_exits),
    });
  }

  /* denied / timed-out tool calls: requested work that never ran */
  const deniedBy = agents.filter((a) => a.tool_calls.some((tc) => tc.denied));
  const deniedCount = agents.reduce((n, a) => n + a.tool_calls.filter((tc) => tc.denied).length, 0);
  if (deniedCount > 0) {
    findings.push({
      rule: "denied_tools",
      reason: `${deniedCount} tool call(s) denied or timed out — requested work that never executed`,
      agents: deniedBy.map((a) => a.name),
      penalty: Math.min(2 * deniedCount, CAPS.denied_tools),
    });
  }

  /* duplicate sibling roles: same parent, identical tool-name multiset */
  const byParent = new Map<string, typeof agents>();
  for (const a of agents) {
    if (!a.parent_id) continue;
    byParent.set(a.parent_id, [...(byParent.get(a.parent_id) ?? []), a]);
  }
  const dupNames = new Set<string>();
  let dupGroups = 0;
  for (const siblings of byParent.values()) {
    const sig = new Map<string, string[]>();
    for (const a of siblings) {
      if (a.tool_calls.length === 0) continue;
      const key = a.tool_calls.map((tc) => tc.name).sort().join(",");
      sig.set(key, [...(sig.get(key) ?? []), a.name]);
    }
    for (const names of sig.values()) {
      if (names.length > 1) {
        dupGroups++;
        names.forEach((n) => dupNames.add(n));
      }
    }
  }
  if (dupGroups > 0) {
    findings.push({
      rule: "duplicate_roles",
      reason: `${dupGroups} group(s) of sibling agents ran identical tool sets — candidates for merging`,
      agents: [...dupNames],
      penalty: Math.min(6 * dupGroups, CAPS.duplicate_roles),
    });
  }

  /* token skew: one agent burning the budget without producing output */
  const tokensOf = (a: (typeof agents)[number]) =>
    (a.usage?.input_tokens ?? 0) + (a.usage?.output_tokens ?? 0);
  const tokensTotal = agents.reduce((n, a) => n + tokensOf(a), 0);
  const costTotal = agents.reduce((n, a) => n + (a.usage?.cost_usd ?? 0), 0);
  const outputsTotal = [...outputs.values()].reduce((a, b) => a + b, 0);
  if (tokensTotal > 0 && outputsTotal > 0) {
    const skewed = agents.filter((a) => {
      const tShare = tokensOf(a) / tokensTotal;
      const oShare = (outputs.get(a.id) ?? 0) / outputsTotal;
      return tShare > 0.5 && oShare < 0.25;
    });
    if (skewed.length > 0) {
      const a = skewed[0];
      findings.push({
        rule: "token_skew",
        reason: `${a.name} consumed ${Math.round((tokensOf(a) / tokensTotal) * 100)}% of tokens but produced ${Math.round(((outputs.get(a.id) ?? 0) / outputsTotal) * 100)}% of outputs`,
        agents: skewed.map((s) => s.name),
        penalty: CAPS.token_skew,
      });
    }
  }

  const score = Math.max(0, 100 - findings.reduce((n, f) => n + f.penalty, 0));
  const grade = score >= 90 ? "A" : score >= 75 ? "B" : score >= 60 ? "C" : score >= 40 ? "D" : "F";

  return { score, grade, findings, tokens_total: tokensTotal, cost_total: costTotal };
}
