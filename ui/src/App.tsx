/// <reference types="vite/client" />
import { useReducer, useEffect, useRef, useCallback, useState } from "react";
import { reducer, initialState } from "./store";
import { createWsConnection } from "./ws";
import { Graph } from "./components/Graph";
import { Scene3D } from "./components/Scene3D";
import { NodeDetailPanel } from "./components/NodeDetailPanel";
import { MessageThread } from "./components/MessageThread";
import { TopBar } from "./components/TopBar";
import { ApprovalQueue } from "./components/ApprovalQueue";
import { FlowView } from "./components/FlowView";
import { GraphStats } from "./components/GraphStats";
import { CreditView } from "./components/CreditView";
import { RunPicker } from "./components/RunPicker";
import type { ViewMode, AgentVizEvent } from "./types";

// Served by the relay itself in production, so the ws port is our own port.
// Vite dev server is the only case where we fall back to the default.
const RELAY_PORT = import.meta.env.DEV ? 3333 : Number(window.location.port) || 3333;

const LEGEND = [
  { color: "#3fe0ff", label: "running" },
  { color: "#ffb454", label: "waiting" },
  { color: "#6ef7a0", label: "complete" },
  { color: "#ff5277", label: "error" },
  { color: "#ffd166", label: "needs approval" },
] as const;

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [view, setView] = useState<ViewMode>("3d");
  const [showRuns, setShowRuns] = useState(false);
  const sendRef = useRef<((cmd: object) => string) | null>(null);

  const loadRun = useCallback((events: object[]) =>
    dispatch({ type: "batch_events", events: events as AgentVizEvent[] }), []);

  useEffect(() => {
    const conn = createWsConnection(RELAY_PORT, dispatch as (a: { type: string; [key: string]: unknown }) => void);
    sendRef.current = conn.send;
    return conn.cleanup;
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "v" && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLInputElement)) {
        setView((v) => (v === "3d" ? "2d" : v === "2d" ? "flow" : v === "flow" ? "credit" : "3d"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const sendCommand = useCallback((cmd: object): string => {
    return sendRef.current?.(cmd) ?? "";
  }, []);

  const selectNode = useCallback((id: string | null) => dispatch({ type: "select_node", agent_id: id }), []);
  const selectEdge = useCallback((key: string | null) => dispatch({ type: "select_edge", edge_key: key }), []);

  const agentList = Object.values(state.agents);
  const runningCount = agentList.filter((a) => a.status === "running").length;
  const selectedAgent = state.selectedNodeId ? state.agents[state.selectedNodeId] : null;
  const panelOpen = Boolean(selectedAgent || (state.selectedEdgeKey && state.messageEdges[state.selectedEdgeKey]));

  return (
    <div className="app">
      <TopBar
        connected={state.connected}
        sessionName={state.sessionName}
        runningCount={runningCount}
        agentCount={agentList.length}
        eventCount={state.eventCount}
        droppedCount={state.droppedCount}
        view={view}
        dryRun={state.dryRun}
        onSetView={setView}
        onOpenRuns={() => setShowRuns(true)}
        onPauseAll={() => sendCommand({ kind: "agent_pause", agent_id: null })}
        onStopAll={() => sendCommand({ kind: "agent_stop", agent_id: null })}
      />

      <div className="stage">
        {view === "3d" ? (
          <Scene3D
            agents={state.agents}
            messageEdges={state.messageEdges}
            selectedNodeId={state.selectedNodeId}
            onSelectNode={selectNode}
          />
        ) : view === "flow" ? (
          <FlowView
            timeline={state.timeline}
            agents={state.agents}
            onSelectNode={selectNode}
          />
        ) : view === "credit" ? (
          <CreditView state={state} onSelectNode={selectNode} />
        ) : (
          <div className="stage-2d">
            <Graph
              agents={state.agents}
              messageEdges={state.messageEdges}
              selectedNodeId={state.selectedNodeId}
              onSelectNode={selectNode}
              onSelectEdge={selectEdge}
              onCommand={sendCommand}
            />
          </div>
        )}

        {agentList.length === 0 && (
          <div className="empty-state">
            <div className="big">AWAITING SIGNAL</div>
            <div className="hint">run <code>python3 examples/demo_swarm.py</code> — or wrap your agents with the SDK</div>
          </div>
        )}

        {selectedAgent && (
          <NodeDetailPanel
            agent={selectedAgent}
            onClose={() => selectNode(null)}
            onCommand={sendCommand}
          />
        )}
        {!selectedAgent && state.selectedEdgeKey && state.messageEdges[state.selectedEdgeKey] && (
          <MessageThread
            edge={state.messageEdges[state.selectedEdgeKey]}
            agents={state.agents}
            onClose={() => selectEdge(null)}
          />
        )}

        {view === "2d" && <GraphStats state={state} />}

        <ApprovalQueue agents={state.agents} acks={state.acks} onCommand={sendCommand} />

        {showRuns && (
          <RunPicker port={RELAY_PORT} onLoad={loadRun} onClose={() => setShowRuns(false)} />
        )}

        <div className={`legend panel ${panelOpen ? "shifted" : ""}`}>
          {LEGEND.map((l) => (
            <div key={l.label} className="legend-row">
              <span className="legend-dot" style={{ background: l.color, boxShadow: `0 0 6px ${l.color}` }} />
              {l.label}
            </div>
          ))}
          <div className="legend-row">
            <span className="legend-line" style={{ background: "#5d6f8d" }} />
            spawn
          </div>
          <div className="legend-row">
            <span className="legend-line" style={{ background: "#3fe0ff", boxShadow: "0 0 6px #3fe0ff" }} />
            message
          </div>
        </div>
      </div>

      <div className="atmosphere" />
    </div>
  );
}
