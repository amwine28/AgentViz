import type { MessageEdge, AgentNode } from "../types";

interface Props {
  edge: MessageEdge;
  agents: Record<string, AgentNode>;
  onClose: () => void;
}

export function MessageThread({ edge, agents, onClose }: Props) {
  const fromName = agents[edge.from_agent_id]?.name ?? edge.from_agent_id;
  const toName = agents[edge.to_agent_id]?.name ?? edge.to_agent_id;

  return (
    <div style={{ width: 300, background: "#111120", borderLeft: "1px solid #1e1e30", display: "flex", flexDirection: "column", overflow: "hidden", flexShrink: 0 }}>
      <div style={{ padding: "10px 14px", borderBottom: "1px solid #1e1e30", display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#a78bfa", display: "inline-block", flexShrink: 0 }} />
        <span style={{ fontSize: 11, fontWeight: 600 }}>{fromName} ↔ {toName}</span>
        <span style={{ marginLeft: "auto", fontSize: 9, color: "#444", flexShrink: 0 }}>{edge.messages.length} messages</span>
        <button onClick={onClose} style={{ background: "none", border: "none", color: "#333", cursor: "pointer", fontSize: 12, flexShrink: 0 }}>✕</button>
      </div>
      <div style={{ flex: 1, overflowY: "auto" }}>
        {edge.messages.map((msg, i) => {
          const senderName = agents[msg.from]?.name ?? msg.from;
          const recipientName = agents[msg.to]?.name ?? msg.to;
          const isLast = i === edge.messages.length - 1;
          return (
            <div key={i} style={{ padding: "8px 14px", borderBottom: "1px solid #1a1a28", background: isLast ? "#14142a" : undefined }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 9, color: "#444", marginBottom: 3 }}>
                <span style={{ fontWeight: 700, color: "#a78bfa" }}>{senderName}</span>
                <span>→</span>
                <span style={{ fontWeight: 700, color: "#60a5fa" }}>{recipientName}</span>
                <span style={{ marginLeft: "auto" }}>{new Date(msg.timestamp * 1000).toLocaleTimeString()}</span>
              </div>
              <div style={{ fontSize: 10, color: isLast ? "#c4b5fd" : "#888", lineHeight: 1.5 }}>{msg.content}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
