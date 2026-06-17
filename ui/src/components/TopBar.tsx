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
  onSetView: (v: ViewMode) => void;
  onOpenRuns: () => void;
  onPauseAll: () => void;
  onStopAll: () => void;
}

export function TopBar({
  connected, sessionName, runningCount, agentCount, eventCount, droppedCount,
  view, dryRun, onSetView, onOpenRuns, onPauseAll, onStopAll,
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
      <button className="hud-btn" onClick={onPauseAll}>Pause all</button>
      <button className="hud-btn danger" onClick={onStopAll}>Stop all</button>

      <div className="view-toggle">
        <button className={view === "3d" ? "active" : ""} onClick={() => onSetView("3d")}>3D</button>
        <div className="divider" />
        <button className={view === "2d" ? "active" : ""} onClick={() => onSetView("2d")}>2D</button>
        <div className="divider" />
        <button className={view === "flow" ? "active" : ""} onClick={() => onSetView("flow")}>FLOW</button>
        <div className="divider" />
        <button className={view === "credit" ? "active" : ""} onClick={() => onSetView("credit")}>CREDIT</button>
      </div>
      <span className="hotkey-hint">[V]</span>
    </div>
  );
}
