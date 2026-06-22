import { useState, useRef, useEffect } from "react";
import { THEMES, type Theme } from "../theme/theme";

const THEME_LABEL: Record<Theme, string> = { light: "Light", dark: "Dark" };

// A small gear button in the TopBar that opens a popover of client settings.
// Today it holds the theme switch; it's the home for future per-client prefs.
export function SettingsMenu({
  theme,
  onSetTheme,
}: {
  theme: Theme;
  onSetTheme: (t: Theme) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside-click and on Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="settings-menu" ref={ref}>
      <button
        className={`hud-btn ${open ? "active" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="true"
        aria-expanded={open}
        title="Settings"
      >⚙ Settings</button>

      {open && (
        <div className="settings-popover panel" role="menu">
          <div className="settings-row">
            <span className="settings-label">Theme</span>
            <div className="seg" role="group" aria-label="Theme">
              {THEMES.map((t) => (
                <button
                  key={t}
                  className={theme === t ? "active" : ""}
                  aria-pressed={theme === t}
                  onClick={() => onSetTheme(t)}
                >{THEME_LABEL[t]}</button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
