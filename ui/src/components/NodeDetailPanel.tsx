import { useRef } from "react";
import type React from "react";
import type { AgentNode } from "../types";

interface Props {
  agent: AgentNode;
  onClose: () => void;
  onCommand: (cmd: object) => void;
}

export function NodeDetailPanel({ agent, onClose, onCommand }: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingCalls = agent.tool_calls.filter((tc) => tc.pending);
  const doneCalls = agent.tool_calls.filter((tc) => !tc.pending);

  return (
    <div style={{
      width: 300, background: "#111120", borderLeft: "1px solid #1e1e30",
      display: "flex", flexDirection: "column", overflow: "hidden", flexShrink: 0
    }}>
      {/* Header */}
      <div style={{ padding: "14px 16px 10px", borderBottom: "1px solid #1e1e30", display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{agent.name}</div>
          <span style={{ ...badgeStyle, ...statusBadge(agent.status) }}>{agent.status}</span>
        </div>
        <button onClick={onClose} style={closeBtnStyle}>✕</button>
      </div>

      {/* Controls */}
      <div style={{ padding: "10px 16px", borderBottom: "1px solid #1e1e30", display: "flex", gap: 6 }}>
        <button style={ctrlBtnStyle} onClick={() => onCommand({ kind: "agent_pause", agent_id: agent.id })}>Pause</button>
        <button style={{ ...ctrlBtnStyle, color: "#a78bfa", borderColor: "#a78bfa55" }}
          onClick={() => onCommand({ kind: "agent_resume", agent_id: agent.id })}>Resume</button>
        <button style={{ ...ctrlBtnStyle, color: "#f87171", borderColor: "#f8717155" }}
          onClick={() => onCommand({ kind: "agent_stop", agent_id: agent.id })}>Stop</button>
      </div>

      {/* Tool calls */}
      <div style={{ padding: "10px 16px 4px", fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".08em", color: "#444" }}>
        Tool Calls
      </div>
      <div style={{ flex: 1, overflowY: "auto" }}>
        {pendingCalls.map((tc) => (
          <div key={tc.call_id} style={{ padding: "8px 16px", borderBottom: "1px solid #1a1a28", background: "#1e1a10", borderLeft: "2px solid #f59e0b" }}>
            <div style={{ fontFamily: "monospace", fontSize: 10, color: "#a78bfa" }}>{tc.name}</div>
            <div style={{ fontFamily: "monospace", fontSize: 9, color: "#555", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {JSON.stringify(tc.args)}
            </div>
            <div style={{ fontSize: 9, color: "#f59e0b", marginTop: 3 }}>Waiting for approval</div>
            <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
              <button style={approveBtn} onClick={() => onCommand({ kind: "tool_approve", agent_id: agent.id, call_id: tc.call_id })}>Approve</button>
              <button style={denyBtn} onClick={() => onCommand({ kind: "tool_deny", agent_id: agent.id, call_id: tc.call_id })}>Deny</button>
            </div>
          </div>
        ))}
        {doneCalls.map((tc) => (
          <div key={tc.call_id} style={{ padding: "8px 16px", borderBottom: "1px solid #1a1a28" }}>
            <div style={{ fontFamily: "monospace", fontSize: 10, color: "#a78bfa" }}>{tc.name}</div>
            <div style={{ fontFamily: "monospace", fontSize: 9, color: "#555", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {JSON.stringify(tc.args)}
            </div>
            <div style={{ fontFamily: "monospace", fontSize: 9, color: "#34d399" }}>
              {String(tc.result ?? "").slice(0, 60)}{tc.duration_ms != null ? ` (${tc.duration_ms}ms)` : ""}
            </div>
          </div>
        ))}
      </div>

      {/* Inject */}
      <div style={{ padding: "10px 16px", borderTop: "1px solid #1e1e30" }}>
        <textarea
          ref={textareaRef}
          rows={2}
          placeholder="Inject instruction to this agent..."
          style={{
            width: "100%", background: "#1a1a2e", border: "1px solid #2d2d4e",
            borderRadius: 6, color: "#ccc", fontSize: 11, padding: "7px 10px",
            resize: "none", fontFamily: "inherit", outline: "none"
          }}
        />
        <button
          style={{ marginTop: 6, width: "100%", background: "#a78bfa22", border: "1px solid #a78bfa44", color: "#a78bfa", borderRadius: 5, padding: 6, fontSize: 10, cursor: "pointer" }}
          onClick={() => {
            const val = textareaRef.current?.value.trim();
            if (val) {
              onCommand({ kind: "inject_message", agent_id: agent.id, content: val });
              if (textareaRef.current) textareaRef.current.value = "";
            }
          }}
        >
          Send to agent
        </button>
      </div>
    </div>
  );
}

const badgeStyle: React.CSSProperties = { padding: "2px 7px", borderRadius: 3, fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em" };
const closeBtnStyle: React.CSSProperties = { background: "none", border: "none", color: "#333", cursor: "pointer", fontSize: 12 };
const ctrlBtnStyle: React.CSSProperties = { flex: 1, background: "#1e1e30", border: "1px solid #2d2d4e", color: "#888", borderRadius: 5, padding: "6px 4px", fontSize: 10, textAlign: "center", cursor: "pointer" };
const approveBtn: React.CSSProperties = { flex: 1, padding: "4px 8px", borderRadius: 4, fontSize: 9, cursor: "pointer", background: "#34d39933", color: "#34d399", border: "1px solid #34d39955", fontWeight: 600 };
const denyBtn: React.CSSProperties = { flex: 1, padding: "4px 8px", borderRadius: 4, fontSize: 9, cursor: "pointer", background: "#f8717133", color: "#f87171", border: "1px solid #f8717155", fontWeight: 600 };

function statusBadge(status: string): React.CSSProperties {
  const map: Record<string, React.CSSProperties> = {
    running: { background: "#3b82f622", color: "#60a5fa" },
    complete: { background: "#34d39922", color: "#34d399" },
    waiting: { background: "#f59e0b22", color: "#f59e0b" },
    paused: { background: "#f59e0b22", color: "#f59e0b" },
    error: { background: "#f8717122", color: "#f87171" },
  };
  return map[status] ?? {};
}
