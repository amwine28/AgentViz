import type { ViewMode } from "../types";

interface Props {
  connected: boolean;
  sessionName: string;
  runningCount: number;
  agentCount: number;
  eventCount: number;
  droppedCount: number;
  view: ViewMode;
  dryRun: boolean;
  funMode: boolean;
  onToggleFun: () => void;
  onSetView: (v: ViewMode) => void;
  onOpenRuns: () => void;
  onPauseAll: () => void;
  onStopAll: () => void;
}

export function TopBar({
  connected, sessionName, runningCount, agentCount, eventCount, droppedCount,
  view, dryRun, funMode, onToggleFun, onSetView, onOpenRuns, onPauseAll, onStopAll,
}: Props) {
  return (
    <div className="topbar">
      <div className="brand">AGENT<b>VIZ</b></div>
      {sessionName && <div className="session-name">{sessionName}</div>}
      {dryRun && <div className="dryrun-chip" title="Mock-side-effects re-run: external side-effecting tools are not executed">◑ DRY RUN</div>}

      <div className="tb-stat">
        <span className={`led ${connected ? "on" : ""}`} />
        {connected ? "link" : "no link"}
      </div>

      <div className="topbar-spacer" />

      {droppedCount > 0 && (
        <div className="dropped-chip">⚠ {droppedCount} events dropped</div>
      )}

      <div className="tb-stat"><span className="num">{runningCount}</span> running</div>
      <div className="tb-stat"><span className="num">{agentCount}</span> agents</div>
      <div className="tb-stat"><span className="num">{eventCount.toLocaleString()}</span> events</div>

      <button className="hud-btn" onClick={onOpenRuns} title="Browse & replay recorded runs">⟲ Runs</button>
      <button className="hud-btn" onClick={onPauseAll} title="Pause every agent in the swarm">Pause all</button>
      <button className="hud-btn danger" onClick={onStopAll} title="Stop the entire swarm">Stop all</button>

      {view === "3d" && (
        <button
          className={`hud-btn fun ${funMode ? "active" : ""}`}
          onClick={onToggleFun}
          aria-pressed={funMode}
          title="HYPERDRIVE — unleash the 3D world (F)"
        >✦ Hyperdrive</button>
      )}

      <div className="view-toggle" role="group" aria-label="Visualization view">
        <button className={view === "3d" ? "active" : ""} aria-pressed={view === "3d"} onClick={() => onSetView("3d")}>3D</button>
        <div className="divider" />
        <button className={view === "2d" ? "active" : ""} aria-pressed={view === "2d"} onClick={() => onSetView("2d")}>2D</button>
        <div className="divider" />
        <button className={view === "flow" ? "active" : ""} aria-pressed={view === "flow"} onClick={() => onSetView("flow")}>FLOW</button>
        <div className="divider" />
        <button className={view === "credit" ? "active" : ""} aria-pressed={view === "credit"} onClick={() => onSetView("credit")}>CREDIT</button>
        <div className="divider" />
        <button className={view === "ops" ? "active" : ""} aria-pressed={view === "ops"} onClick={() => onSetView("ops")}>OPS</button>
      </div>
      <span className="hotkey-hint" title="V — cycle 3D / 2D / FLOW / CREDIT / OPS">[V]</span>
    </div>
  );
}
