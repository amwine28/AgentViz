import type { ViewMode } from "../types";
import type { Theme } from "../theme/theme";

const VIEWS: { id: ViewMode; label: string }[] = [
  { id: "3d", label: "3D" },
  { id: "2d", label: "2D" },
  { id: "flow", label: "FLOW" },
  { id: "files", label: "FILES" },
];

// The view switcher — lives in the top bar (chrome), so it never covers the
// agents on the canvas. Still upper-right, just out of the field.
export function ViewSwitch({
  view,
  onSetView,
  theme,
  onToggleTheme,
}: {
  view: ViewMode;
  onSetView: (v: ViewMode) => void;
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
      <span className="hotkey-hint" title="V — cycle 3D / 2D / FLOW / FILES">[V]</span>
    </div>
  );
}
