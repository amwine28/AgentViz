/// <reference types="vite/client" />
import { useReducer, useEffect, useRef, useCallback, useState } from "react";
import { rootReducer, initialMultiState, activeWorld, sessionTabs } from "./multiStore";
import { emptyWorld } from "./store";
import { getShell, setShellView, cycleView, type ShellMap } from "./shell/useShellState";
import { createWsConnection } from "./ws";
import { Graph } from "./components/Graph";
import { Scene3D } from "./components/Scene3D";
import { NodeDetailPanel } from "./components/NodeDetailPanel";
import { MessageThread } from "./components/MessageThread";
import { TopBar } from "./components/TopBar";
import { TabStrip } from "./components/TabStrip";
import { ViewSwitch } from "./components/ViewSwitch";
import { SettingsMenu } from "./components/SettingsMenu";
import { loadTheme, applyTheme, otherTheme, type Theme } from "./theme/theme";
import { ApprovalQueue } from "./components/ApprovalQueue";
import { FlowView } from "./components/FlowView";
import { FileSystemView } from "./components/FileSystemView";
import { LogsPanel } from "./components/LogsPanel";
import { AnalyticsPanel } from "./components/analytics/AnalyticsPanel";
import { getAnalytics, setDock, toggleSection, type AnalyticsMap } from "./components/analytics/analyticsState";
import type { ViewMode, AgentVizEvent } from "./types";

// Served by the relay itself in production, so the ws port is our own port.
const RELAY_PORT = import.meta.env.DEV ? 3333 : Number(window.location.port) || 3333;

const LEGEND = [
  { color: "#3fe0ff", label: "running", ring: false },
  { color: "#ff9e3d", label: "waiting", ring: false },
  { color: "#34d17e", label: "complete", ring: false },
  { color: "#ff5277", label: "error", ring: false },
  { color: "#8b9bb4", label: "paused", ring: false },
  { color: "#ffd166", label: "needs approval", ring: true },
] as const;

export function App() {
  const [state, dispatch] = useReducer(rootReducer, initialMultiState);
  const world = activeWorld(state) ?? emptyWorld();

  const [logsOpen, setLogsOpen] = useState(false);   // the Logs side panel (left rail when closed)
  const [logsRefresh, setLogsRefresh] = useState(0); // bump to refetch /runs (on auto-archive)
  const archivedRef = useRef<Set<string>>(new Set()); // sessions we've auto-archived (dedupe)
  const [shell, setShell] = useState<ShellMap>({});
  const [analytics, setAnalytics] = useState<AnalyticsMap>({});
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const sendRef = useRef<((cmd: object) => string) | null>(null);

  // Reflect the chosen theme onto <html data-theme> + persist it.
  useEffect(() => { applyTheme(theme); }, [theme]);

  // Per-tab view (each tab remembers its own). Read and write must use the SAME
  // key — including the "_pending" fallback when there's no active session yet —
  // or the view switch looks stuck. getShell(map, null) returns the default, so
  // never read with null.
  const shellKey = state.activeId ?? "_pending";
  const ui = getShell(shell, shellKey);
  const view = ui.view;
  const setView = (v: ViewMode) => setShell((m) => setShellView(m, shellKey, v));
  const analyticsUi = getAnalytics(analytics, shellKey);

  const tabs = sessionTabs(state);

  const loadRun = useCallback((events: object[]) => {
    // Re-stamp a loaded run into its OWN tab so replaying can never clobber a
    // live session that shares a session_id (or "_legacy").
    const stamped = (events as AgentVizEvent[]).map((e) => ({
      ...e, session_id: `replay:${(e as { run_id?: string }).run_id ?? "run"}`,
    }));
    dispatch({ type: "batch_events", events: stamped });
  }, []);

  useEffect(() => {
    const conn = createWsConnection(RELAY_PORT, dispatch as (a: { type: string; [key: string]: unknown }) => void);
    sendRef.current = conn.send;
    return conn.cleanup;
  }, []);

  // V cycles the active tab's view. Re-bound on tab switch.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
      const id = state.activeId ?? "_pending";
      if (e.key.toLowerCase() === "v") setShell((m) => setShellView(m, id, cycleView(getShell(m, id).view)));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.activeId]);

  // Finish → archive + reset: when a session emits a terminal outcome, let the
  // final state breathe for a moment, then auto-close its tab. The run is already
  // recorded on disk, so it lands in the Logs panel; the canvas resets to
  // AWAITING SIGNAL and the next workflow opens fresh. One timer per session.
  useEffect(() => {
    for (const sid of state.finished) {
      if (archivedRef.current.has(sid) || !state.sessions[sid]) continue;
      archivedRef.current.add(sid);
      setTimeout(() => {
        dispatch({ type: "close_session", session_id: sid });
        setLogsRefresh((n) => n + 1);
      }, 3000);
    }
  }, [state.finished, state.sessions]);

  // When the first real session activates, carry over any per-tab UI state the
  // user set on the "_pending" (no-session) screen so it isn't lost.
  useEffect(() => {
    const id = state.activeId;
    if (!id || id === "_pending") return;
    setShell((m) => (m["_pending"] && !m[id] ? { ...m, [id]: m["_pending"] } : m));
    setAnalytics((m) => (m["_pending"] && !m[id] ? { ...m, [id]: m["_pending"] } : m));
  }, [state.activeId]);

  // Stamp the active tab's session id onto outgoing commands so an approve /
  // inject / close can't leak into a different terminal's session (which may
  // share an agent_id like "shell"). Commands that already name a session win.
  const activeIdRef = useRef(state.activeId);
  activeIdRef.current = state.activeId;
  const sendCommand = useCallback((cmd: object): string => {
    const sid = activeIdRef.current;
    const hasSid = typeof (cmd as { session_id?: unknown }).session_id === "string";
    const out = !hasSid && sid && sid !== "_legacy" ? { ...cmd, session_id: sid } : cmd;
    return sendRef.current?.(out) ?? "";
  }, []);

  const selectNode = useCallback((id: string | null) => dispatch({ type: "select_node", agent_id: id }), []);
  const selectEdge = useCallback((key: string | null) => dispatch({ type: "select_edge", edge_key: key }), []);

  // Escape dismisses the topmost transient surface (run picker → node → edge).
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (logsOpen) setLogsOpen(false);
      else if (world.selectedNodeId) selectNode(null);
      else if (world.selectedEdgeKey) selectEdge(null);
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [logsOpen, world.selectedNodeId, world.selectedEdgeKey, selectNode, selectEdge]);

  const agentList = Object.values(world.agents);
  const runningCount = agentList.filter((a) => a.status === "running").length;
  const selectedAgent = world.selectedNodeId ? world.agents[world.selectedNodeId] : null;
  const panelOpen = Boolean(selectedAgent || (world.selectedEdgeKey && world.messageEdges[world.selectedEdgeKey]));

  return (
    <div className="app">
      <TabStrip
        tabs={tabs}
        onSelect={(id) => dispatch({ type: "set_active_session", session_id: id })}
        onClose={(id) => {
          dispatch({ type: "close_session", session_id: id });
          sendCommand({ kind: "close_session", session_id: id }); // tell the relay to forget its buffer
        }}
        onRename={(id, name) => dispatch({ type: "rename_session", session_id: id, name })}
      />

      <TopBar
        connected={state.connected}
        sessionName={world.sessionName}
        runningCount={runningCount}
        agentCount={agentList.length}
        eventCount={world.eventCount}
        droppedCount={world.droppedCount}
        dryRun={world.dryRun}
        onOpenRuns={() => setLogsOpen((o) => !o)}
      >
        <ViewSwitch
          view={view}
          onSetView={setView}
          theme={theme}
          onToggleTheme={() => setTheme((t) => otherTheme(t))}
        />
        <SettingsMenu theme={theme} onSetTheme={setTheme} />
      </TopBar>

      <div className="stage">
        {view === "3d" ? (
          <Scene3D
            agents={world.agents}
            messageEdges={world.messageEdges}
            operations={world.operations}
            selectedNodeId={world.selectedNodeId}
            theme={theme}
            onSelectNode={selectNode}
          />
        ) : view === "flow" ? (
          <FlowView
            timeline={world.timeline}
            agents={world.agents}
            onSelectNode={selectNode}
          />
        ) : view === "files" ? (
          <FileSystemView agents={world.agents} onSelectNode={selectNode} />
        ) : (
          <div className="stage-2d">
            <Graph
              agents={world.agents}
              messageEdges={world.messageEdges}
              operations={world.operations}
              selectedNodeId={world.selectedNodeId}
              onSelectNode={selectNode}
              onSelectEdge={selectEdge}
            />
          </div>
        )}

        {(view === "3d" || view === "2d") && agentList.length === 0 && world.operations.size === 0 && (
          <div className="empty-state">
            <div className="big">{state.connected ? "AWAITING SIGNAL" : "RELAY OFFLINE"}</div>
            <div className="hint">
              {state.connected
                ? <>install the shell hook (<code>bash scripts/agentviz.sh install</code>), then run <code>agentviz</code> in any terminal — or wrap your agents with the SDK</>
                : <>can't reach the relay on port {RELAY_PORT} — start it, then this reconnects automatically</>}
            </div>
          </div>
        )}

        {selectedAgent && (
          <NodeDetailPanel
            agent={selectedAgent}
            onClose={() => selectNode(null)}
            onCommand={sendCommand}
            live={state.connected && !(state.activeId ?? "").startsWith("replay:")}
          />
        )}
        {!selectedAgent && world.selectedEdgeKey && world.messageEdges[world.selectedEdgeKey] && (
          <MessageThread
            edge={world.messageEdges[world.selectedEdgeKey]}
            agents={world.agents}
            onClose={() => selectEdge(null)}
          />
        )}

        <AnalyticsPanel
          world={world}
          ui={analyticsUi}
          onSetDock={(d) => setAnalytics((m) => setDock(m, shellKey, d))}
          onToggleSection={(s) => setAnalytics((m) => toggleSection(m, shellKey, s))}
          onSelectNode={selectNode}
        />

        <ApprovalQueue agents={world.agents} acks={world.acks} onCommand={sendCommand} />

        <LogsPanel port={RELAY_PORT} open={logsOpen} onSetOpen={setLogsOpen} onLoad={loadRun} refreshKey={logsRefresh} />

        {(view === "3d" || view === "2d") && (
          <div className={`legend panel ${panelOpen ? "shifted" : ""}`}>
            {/* the "needs approval" ring only exists in the 3D field — don't promise it in 2D */}
            {LEGEND.filter((l) => !(l.ring && view === "2d")).map((l) => (
              <div key={l.label} className="legend-row">
                <span
                  className="legend-dot"
                  style={l.ring
                    ? { border: `1.5px solid ${l.color}`, boxShadow: `0 0 6px ${l.color}` }
                    : { background: l.color, boxShadow: `0 0 6px ${l.color}` }}
                />
                {l.label}
              </div>
            ))}
            <div className="legend-row">
              <span className="legend-line" style={{ background: "#8294b4" }} />
              spawn
            </div>
            <div className="legend-row">
              <span className="legend-line" style={{ background: "#7df3ff", boxShadow: "0 0 6px #7df3ff" }} />
              message
            </div>
            {view === "2d" && (
              <div className="legend-row" style={{ color: "var(--ink-faint)" }}>
                <span className="legend-dot" style={{ background: "var(--ink-faint)", width: 5, height: 5 }} />
                size = activity
              </div>
            )}
          </div>
        )}
      </div>

      <div className="atmosphere" />
    </div>
  );
}
