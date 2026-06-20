import { describe, it, expect } from "vitest";
import {
  getAnalytics,
  setDock,
  toggleSection,
  defaultAnalyticsUi,
  SECTION_ORDER,
  type SectionId,
} from "../src/components/analytics/analyticsState";

describe("analyticsState helpers", () => {
  it("getAnalytics returns the default for an unknown/null id", () => {
    expect(getAnalytics({}, null)).toEqual(defaultAnalyticsUi());
    expect(getAnalytics({}, "x")).toEqual(defaultAnalyticsUi());
  });

  it("defaults to a minimized dock with only the graph section open", () => {
    const ui = defaultAnalyticsUi();
    expect(ui.dock).toBe("minimized");
    expect(ui.sections).toEqual({ graph: true, credit: false, ops: false });
  });

  it("setDock sets per-id without touching other tabs", () => {
    const m = setDock({}, "A", "expanded");
    expect(getAnalytics(m, "A").dock).toBe("expanded");
    expect(getAnalytics(m, "B").dock).toBe("minimized");
    const m2 = setDock(m, "A", "minimized");
    expect(getAnalytics(m2, "A").dock).toBe("minimized");
  });

  it("setDock preserves the tab's open sections", () => {
    const m = toggleSection({}, "A", "ops");
    const m2 = setDock(m, "A", "expanded");
    expect(getAnalytics(m2, "A").sections.ops).toBe(true);
    expect(getAnalytics(m2, "A").dock).toBe("expanded");
  });

  it("toggleSection flips one section, preserving dock and the others", () => {
    const m = toggleSection({}, "A", "credit");
    expect(getAnalytics(m, "A").sections.credit).toBe(true);
    expect(getAnalytics(m, "A").sections.graph).toBe(true); // default-open, untouched
    expect(getAnalytics(m, "A").dock).toBe("minimized"); // unchanged
    const m2 = toggleSection(m, "A", "credit");
    expect(getAnalytics(m2, "A").sections.credit).toBe(false);
  });

  it("toggleSection is independent per tab", () => {
    const m = toggleSection(toggleSection({}, "A", "ops"), "B", "credit");
    expect(getAnalytics(m, "A").sections.ops).toBe(true);
    expect(getAnalytics(m, "A").sections.credit).toBe(false);
    expect(getAnalytics(m, "B").sections.credit).toBe(true);
    expect(getAnalytics(m, "B").sections.ops).toBe(false);
  });

  it("SECTION_ORDER lists every section exactly once", () => {
    const all: SectionId[] = ["graph", "credit", "ops"];
    expect([...SECTION_ORDER].sort()).toEqual([...all].sort());
    expect(SECTION_ORDER.length).toBe(new Set(SECTION_ORDER).size);
  });
});
