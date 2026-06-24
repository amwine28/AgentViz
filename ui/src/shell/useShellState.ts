import type { ViewMode } from "../types";

// Per-tab client UI state (which view is showing) — NOT world data, so it lives
// outside the store. Pure helpers so it's unit-testable without a render harness;
// App holds the map in a single useState.

export interface ShellUi {
  view: ViewMode;
}

export type ShellMap = Record<string, ShellUi>;

export const defaultShellUi = (): ShellUi => ({ view: "3d" });

export function getShell(map: ShellMap, id: string | null): ShellUi {
  return (id && map[id]) || defaultShellUi();
}

export function setShellView(map: ShellMap, id: string, view: ViewMode): ShellMap {
  return { ...map, [id]: { ...getShell(map, id), view } };
}

// V cycles the spatial/temporal views. CREDIT/OPS now live in the Analytics panel.
export function cycleView(v: ViewMode): ViewMode {
  return v === "3d" ? "2d" : v === "2d" ? "flow" : v === "flow" ? "files" : "3d";
}
