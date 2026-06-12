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
    <div className="message-thread panel">
      <div className="panel-title">
        <span>◇ {fromName} ⇄ {toName}</span>
        <button className="panel-close" onClick={onClose}>✕</button>
      </div>
      <div className="scroll-area">
        {edge.messages.map((msg, i) => {
          const senderName = agents[msg.from]?.name ?? msg.from;
          const recipientName = agents[msg.to]?.name ?? msg.to;
          return (
            <div key={i} className="msg-row">
              <div className="msg-meta">
                {senderName} → {recipientName} · {new Date(msg.timestamp * 1000).toLocaleTimeString()}
              </div>
              <div className="msg-body">{msg.content}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
