import type { ViewMode } from "../types";
import type { Theme } from "../theme/theme";

const VIEWS: { id: ViewMode; label: string }[] = [
  { id: "3d", label: "3D" },
  { id: "2d", label: "2D" },
  { id: "flow", label: "FLOW" },
];

// The view switcher — lives in the top bar (chrome), so it never covers the
// agents on the canvas. Still upper-right, just out of the field.
export function ViewSwitch({
  view,
  onSetView,
  funMode,
  onToggleFun,
  theme,
  onToggleTheme,
}: {
  view: ViewMode;
  onSetView: (v: ViewMode) => void;
  funMode: boolean;
  onToggleFun: () => void;
  theme: Theme;
  onToggleTheme: () => void;
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
          className={`hud-btn ${theme === "dark" ? "active" : ""}`}
          onClick={onToggleTheme}
          aria-pressed={theme === "dark"}
          title="Night sky — dark 3D field with a live starfield"
        >{theme === "dark" ? "☾ Night" : "☼ Day"}</button>
      )}
      {view === "3d" && (
        <button
          className={`hud-btn fun ${funMode ? "active" : ""}`}
          onClick={onToggleFun}
          aria-pressed={funMode}
          title="HYPERDRIVE — unleash the 3D world (F)"
        >✦ Hyperdrive</button>
      )}
      <span className="hotkey-hint" title="V — cycle 3D / 2D / FLOW">[V]</span>
    </div>
  );
}
