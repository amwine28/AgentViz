import { useRef } from "react";
import type { AgentNode } from "../types";

interface Props {
  agent: AgentNode;
  onClose: () => void;
  onCommand: (cmd: Record<string, unknown>) => string;
}

export function NodeDetailPanel({ agent, onClose, onCommand }: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingCalls = agent.tool_calls.filter((tc) => tc.pending);
  const doneCalls = agent.tool_calls.filter((tc) => !tc.pending);

  return (
    <div className="detail-panel panel">
      <div className="panel-title">
        <span>◢ Agent telemetry</span>
        <button className="panel-close" onClick={onClose}>✕</button>
      </div>

      <div className="agent-headline">
        <div className="name">{agent.name}</div>
        <span className={`status-badge status-${agent.status}`}>{agent.status}</span>
      </div>

      <div className="ctrl-row">
        <button className="hud-btn" onClick={() => onCommand({ kind: "agent_pause", agent_id: agent.id })}>Pause</button>
        <button className="hud-btn" onClick={() => onCommand({ kind: "agent_resume", agent_id: agent.id })}>Resume</button>
        <button className="hud-btn danger" onClick={() => onCommand({ kind: "agent_stop", agent_id: agent.id })}>Stop</button>
      </div>

      <div className="section-label">Tool calls — {agent.tool_calls.length}</div>
      <div className="scroll-area">
        {pendingCalls.map((tc) => (
          <div key={tc.call_id} className="tc-row pending">
            <div className="tc-name">{tc.name}()</div>
            <div className="tc-args">{JSON.stringify(tc.args, null, 1)}</div>
            <div className="approve-row" style={{ marginTop: 6 }}>
              <button className="btn-approve" onClick={() => onCommand({ kind: "tool_approve", agent_id: agent.id, call_id: tc.call_id })}>Approve</button>
              <button className="btn-deny" onClick={() => onCommand({ kind: "tool_deny", agent_id: agent.id, call_id: tc.call_id })}>Deny</button>
            </div>
          </div>
        ))}
        {doneCalls.map((tc) => (
          <div key={tc.call_id} className="tc-row">
            <div className="tc-name">{tc.name}()</div>
            <div className="tc-args">{JSON.stringify(tc.args)}</div>
            {tc.denied ? (
              <div className="tc-denied">✗ denied ({tc.denied})</div>
            ) : (
              <div className="tc-result">
                {String(tc.result ?? "").slice(0, 120)}
                {tc.duration_ms != null ? `  ·  ${tc.duration_ms}ms` : ""}
              </div>
            )}
          </div>
        ))}

        {agent.logs.length > 0 && <div className="section-label">Log — {agent.logs.length}</div>}
        {agent.logs.slice(-50).map((log, i) => (
          <div key={i} className={`log-row ${log.level}`}>
            {log.content}
          </div>
        ))}
      </div>

      <div className="inject-area">
        <textarea ref={textareaRef} rows={2} placeholder="Inject instruction to this agent…" />
        <button
          className="hud-btn"
          onClick={() => {
            const val = textareaRef.current?.value.trim();
            if (val) {
              onCommand({ kind: "inject_message", agent_id: agent.id, content: val });
              if (textareaRef.current) textareaRef.current.value = "";
            }
          }}
        >
          Transmit
        </button>
      </div>
    </div>
  );
}
