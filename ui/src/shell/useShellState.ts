import type { ViewMode } from "../types";

// Per-tab client UI state (which view is showing, is Hyperdrive on) — NOT world
// data, so it lives outside the store. Pure helpers so it's unit-testable
// without a render harness; App holds the map in a single useState.

export interface ShellUi {
  view: ViewMode;
  funMode: boolean;
}

export type ShellMap = Record<string, ShellUi>;

export const defaultShellUi = (): ShellUi => ({ view: "3d", funMode: false });

export function getShell(map: ShellMap, id: string | null): ShellUi {
  return (id && map[id]) || defaultShellUi();
}

export function setShellView(map: ShellMap, id: string, view: ViewMode): ShellMap {
  return { ...map, [id]: { ...getShell(map, id), view } };
}

export function setShellFun(map: ShellMap, id: string, funMode: boolean): ShellMap {
  return { ...map, [id]: { ...getShell(map, id), funMode } };
}

// V cycles the views; CREDIT/OPS still reachable here until Phase 5 folds them
// into the analytics panel.
export function cycleView(v: ViewMode): ViewMode {
  return v === "3d" ? "2d" : v === "2d" ? "flow" : v === "flow" ? "credit" : v === "credit" ? "ops" : "3d";
}
