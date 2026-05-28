import type React from "react";

interface Props {
  connected: boolean;
  runningCount: number;
  onPauseAll: () => void;
  onStopAll: () => void;
}

export function TopBar({ connected, runningCount, onPauseAll, onStopAll }: Props) {
  return (
    <div style={{
      height: 40, background: "#111120", borderBottom: "1px solid #1e1e30",
      display: "flex", alignItems: "center", padding: "0 16px", gap: 16
    }}>
      <span style={{ color: "#a78bfa", fontWeight: 700, fontSize: 13 }}>AgentViz</span>
      <span style={{ color: "#555", fontSize: 11, display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{
          display: "inline-block", width: 7, height: 7, borderRadius: "50%",
          background: connected ? "#34d399" : "#555",
          boxShadow: connected ? "0 0 6px #34d39988" : "none",
        }} />
        {connected ? `${runningCount} agent${runningCount !== 1 ? "s" : ""} running` : "disconnected"}
      </span>
      <div style={{ flex: 1 }} />
      <button onClick={onPauseAll} style={btnStyle}>Pause All</button>
      <button onClick={onStopAll} style={{ ...btnStyle, color: "#f87171", borderColor: "#f8717155" }}>Stop All</button>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  background: "#1e1e30", border: "1px solid #2d2d4e", color: "#888",
  borderRadius: 5, padding: "4px 10px", fontSize: 11, cursor: "pointer"
};
