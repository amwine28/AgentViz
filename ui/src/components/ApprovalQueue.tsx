import { useEffect, useRef, useState } from "react";
import type { AgentNode } from "../types";

interface Props {
  agents: Record<string, AgentNode>;
  acks: Record<string, "applied" | "failed">;
  onCommand: (cmd: Record<string, unknown>) => string; // returns cmd_id
}

interface PendingCall {
  agent: AgentNode;
  call_id: string;
  name: string;
  args: Record<string, unknown>;
  requested_at?: number;
  timeout_s?: number;
}

export function ApprovalQueue({ agents, acks, onCommand }: Props) {
  // local map of call_id -> cmd_id for ack display
  const [sent, setSent] = useState<Record<string, string>>({});
  // calls the user manually cleared (the escape hatch when no live agent answers)
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [, forceTick] = useState(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const nowS = Date.now() / 1000;
  const pending: PendingCall[] = [];
  for (const agent of Object.values(agents)) {
    for (const tc of agent.tool_calls) {
      if (!tc.pending) continue;
      if (dismissed.has(tc.call_id)) continue;
      // Auto-clear calls whose approval window has demonstrably closed: a replayed
      // or passively-observed run has no live SDK behind it, so no result/denial
      // will ever arrive — once the deadline has passed, stop showing the prompt.
      if (tc.requested_at != null && nowS - tc.requested_at > (tc.timeout_s ?? 30) + 2) continue;
      pending.push({
        agent, call_id: tc.call_id, name: tc.name, args: tc.args,
        requested_at: tc.requested_at, timeout_s: tc.timeout_s,
      });
    }
  }

  // drive the countdown bars while anything is pending
  useEffect(() => {
    if (pending.length > 0 && tickRef.current === null) {
      tickRef.current = setInterval(() => forceTick((n) => n + 1), 250);
    }
    if (pending.length === 0 && tickRef.current !== null) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    return () => {
      if (tickRef.current !== null) { clearInterval(tickRef.current); tickRef.current = null; }
    };
  }, [pending.length]);

  const dismiss = (call_id: string) => setDismissed((s) => new Set(s).add(call_id));

  if (pending.length === 0) return null;

  const act = (kind: "tool_approve" | "tool_deny", pc: PendingCall) => {
    const cmdId = onCommand({ kind, agent_id: pc.agent.id, call_id: pc.call_id });
    setSent((s) => ({ ...s, [pc.call_id]: cmdId }));
  };

  return (
    <div className="approval-queue panel">
      <div className="panel-title">
        <span>◈ Approval queue — {pending.length}</span>
      </div>
      <div className="scroll-area">
        {pending.map((pc) => {
          const total = pc.timeout_s ?? 30;
          const elapsed = pc.requested_at ? nowS - pc.requested_at : 0;
          const remaining = Math.max(0, total - elapsed);
          const frac = total > 0 ? remaining / total : 0;
          const cmdId = sent[pc.call_id];
          const ack = cmdId ? acks[cmdId] : undefined;
          return (
            <div key={pc.call_id} className="approval-card">
              <button className="approval-dismiss" title="Dismiss" onClick={() => dismiss(pc.call_id)}>×</button>
              <div className="who">{pc.agent.name}</div>
              <div className="what">{pc.name}()</div>
              <div className="args">{JSON.stringify(pc.args, null, 0)}</div>
              <div className="countdown-track">
                <div
                  className={`countdown-fill ${frac < 0.25 ? "urgent" : ""}`}
                  style={{ width: `${frac * 100}%` }}
                />
              </div>
              <div className="approve-row">
                {cmdId ? (
                  <span className={`ack-tag ${ack ? `ack-${ack}` : "ack-sent"}`}>
                    {ack === "applied" ? "✓ applied" : ack === "failed" ? "✗ failed" : "… sent"}
                  </span>
                ) : (
                  <>
                    <button className="btn-approve" onClick={() => act("tool_approve", pc)}>Approve</button>
                    <button className="btn-deny" onClick={() => act("tool_deny", pc)}>Deny</button>
                  </>
                )}
                <span className="ack-tag ack-sent" style={{ marginLeft: "auto" }}>
                  {remaining.toFixed(0)}s
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
