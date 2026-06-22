import type { ReactNode } from "react";

interface Props {
  connected: boolean;
  sessionName: string;
  runningCount: number;
  agentCount: number;
  eventCount: number;
  droppedCount: number;
  dryRun: boolean;
  onOpenRuns: () => void;
  onPauseAll: () => void;
  onStopAll: () => void;
  children?: ReactNode; // trailing slot (settings menu, etc.)
}

export function TopBar({
  connected, sessionName, runningCount, agentCount, eventCount, droppedCount,
  dryRun, onOpenRuns, onPauseAll, onStopAll, children,
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
      {children}
    </div>
  );
}
