// Theme state: light (default) | dark, switched by a `data-theme` attribute on
// <html>. The pure parts (normalize/toggle) are unit-tested; the DOM/storage
// side effects are a thin shell around them. Persisted client-side so each
// browser remembers the operator's choice.

export type Theme = "light" | "dark";

export const THEMES: Theme[] = ["light", "dark"];
export const DEFAULT_THEME: Theme = "light";

const STORAGE_KEY = "agentviz.theme";

// Coerce any stored/incoming value to a valid theme, falling back to default.
export function normalizeTheme(value: string | null | undefined): Theme {
  return value === "dark" || value === "light" ? value : DEFAULT_THEME;
}

export function otherTheme(theme: Theme): Theme {
  return theme === "dark" ? "light" : "dark";
}

// Read the persisted choice (guarded — localStorage can throw in private mode).
export function loadTheme(): Theme {
  try {
    return normalizeTheme(localStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_THEME;
  }
}

// Apply to the document and persist. Idempotent; safe to call on every change.
export function applyTheme(theme: Theme): void {
  const t = normalizeTheme(theme);
  try {
    document.documentElement.setAttribute("data-theme", t);
  } catch {
    /* no document (tests) — pure callers use normalizeTheme directly */
  }
  try {
    localStorage.setItem(STORAGE_KEY, t);
  } catch {
    /* storage unavailable — non-fatal */
  }
}
