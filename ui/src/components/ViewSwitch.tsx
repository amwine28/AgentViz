import type { ViewMode } from "../types";

const VIEWS: { id: ViewMode; label: string }[] = [
  { id: "3d", label: "3D" },
  { id: "2d", label: "2D" },
  { id: "flow", label: "FLOW" },
  // CREDIT/OPS stay here until Phase 5 moves them into the Analytics panel.
  { id: "credit", label: "CREDIT" },
  { id: "ops", label: "OPS" },
];

// The view switcher, relocated to the upper-right corner of the stage.
export function ViewSwitch({
  view,
  onSetView,
  funMode,
  onToggleFun,
}: {
  view: ViewMode;
  onSetView: (v: ViewMode) => void;
  funMode: boolean;
  onToggleFun: () => void;
}) {
  return (
    <div className="view-switch">
      <div className="view-toggle" role="group" aria-label="Visualization view">
        {VIEWS.map((v, i) => (
          <span key={v.id} style={{ display: "contents" }}>
            {i > 0 && <div className="divider" />}
            <button
              className={view === v.id ? "active" : ""}
              aria-pressed={view === v.id}
              onClick={() => onSetView(v.id)}
            >{v.label}</button>
          </span>
        ))}
      </div>
      {view === "3d" && (
        <button
          className={`hud-btn fun ${funMode ? "active" : ""}`}
          onClick={onToggleFun}
          aria-pressed={funMode}
          title="HYPERDRIVE — unleash the 3D world (F)"
        >✦ Hyperdrive</button>
      )}
      <span className="hotkey-hint" title="V — cycle 3D / 2D / FLOW / CREDIT / OPS">[V]</span>
    </div>
  );
}
