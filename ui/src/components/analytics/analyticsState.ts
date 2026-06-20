// Per-tab Analytics panel UI state (NOT world data). Pure + testable; App holds
// the map in one useState, keyed by session id — each tab keeps its own dock.

export type DockState = "expanded" | "minimized";
export type SectionId = "graph" | "credit" | "ops";

export interface AnalyticsUi {
  dock: DockState;
  sections: Record<SectionId, boolean>; // which sections are open
}

export type AnalyticsMap = Record<string, AnalyticsUi>;

export const SECTION_ORDER: SectionId[] = ["graph", "credit", "ops"];
export const SECTION_LABEL: Record<SectionId, string> = {
  graph: "Graph & Audit",
  credit: "Credit",
  ops: "Operations",
};

export const defaultAnalyticsUi = (): AnalyticsUi => ({
  dock: "minimized",
  sections: { graph: true, credit: false, ops: false },
});

export function getAnalytics(map: AnalyticsMap, id: string | null): AnalyticsUi {
  return (id && map[id]) || defaultAnalyticsUi();
}

export function setDock(map: AnalyticsMap, id: string, dock: DockState): AnalyticsMap {
  return { ...map, [id]: { ...getAnalytics(map, id), dock } };
}

export function toggleSection(map: AnalyticsMap, id: string, section: SectionId): AnalyticsMap {
  const cur = getAnalytics(map, id);
  return { ...map, [id]: { ...cur, sections: { ...cur.sections, [section]: !cur.sections[section] } } };
}
