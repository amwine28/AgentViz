import { useReducer, useEffect, useRef, useCallback } from "react";
import { reducer, initialState } from "./store";
import { createWsConnection } from "./ws";
import { Graph } from "./components/Graph";
import { NodeDetailPanel } from "./components/NodeDetailPanel";
import { MessageThread } from "./components/MessageThread";
import { TopBar } from "./components/TopBar";

const RELAY_PORT = 3333;

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const sendRef = useRef<((cmd: object) => void) | null>(null);

  useEffect(() => {
    const conn = createWsConnection(RELAY_PORT, dispatch as (a: { type: string; [key: string]: unknown }) => void);
    sendRef.current = conn.send;
    return conn.cleanup;
  }, []);

  const sendCommand = useCallback((cmd: object) => {
    sendRef.current?.(cmd);
  }, []);

  const runningCount = Object.values(state.agents).filter((a) => a.status === "running").length;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <TopBar
        connected={state.connected}
        runningCount={runningCount}
        onPauseAll={() => sendCommand({ kind: "agent_pause", agent_id: null })}
        onStopAll={() => sendCommand({ kind: "agent_stop", agent_id: null })}
      />
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        <div style={{ flex: 1, position: "relative" }}>
          <Graph
            agents={state.agents}
            messageEdges={state.messageEdges}
            selectedNodeId={state.selectedNodeId}
            onSelectNode={(id) => dispatch({ type: "select_node", agent_id: id })}
            onSelectEdge={(key) => dispatch({ type: "select_edge", edge_key: key })}
            onCommand={sendCommand}
          />
        </div>
        {state.selectedNodeId && state.agents[state.selectedNodeId] && (
          <NodeDetailPanel
            agent={state.agents[state.selectedNodeId]}
            onClose={() => dispatch({ type: "select_node", agent_id: null })}
            onCommand={sendCommand}
          />
        )}
        {state.selectedEdgeKey && state.messageEdges[state.selectedEdgeKey] && (
          <MessageThread
            edge={state.messageEdges[state.selectedEdgeKey]}
            agents={state.agents}
            onClose={() => dispatch({ type: "select_edge", edge_key: null })}
          />
        )}
      </div>
    </div>
  );
}
