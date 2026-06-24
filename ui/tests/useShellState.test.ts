import { describe, it, expect } from "vitest";
import { getShell, setShellView, cycleView, defaultShellUi } from "../src/shell/useShellState";
import type { ViewMode } from "../src/types";

describe("useShellState helpers", () => {
  it("getShell returns the default for an unknown/null id", () => {
    expect(getShell({}, null)).toEqual({ view: "3d" });
    expect(getShell({}, "x")).toEqual(defaultShellUi());
  });

  it("setShellView sets per-id without touching other tabs", () => {
    const m = setShellView({}, "A", "2d");
    expect(getShell(m, "A").view).toBe("2d");
    expect(getShell(m, "B").view).toBe("3d");
    const m2 = setShellView(m, "B", "flow");
    expect(getShell(m2, "A").view).toBe("2d");
    expect(getShell(m2, "B").view).toBe("flow");
  });

  it("cycleView walks 3d -> 2d -> flow -> files -> 3d (credit/ops live in the analytics panel)", () => {
    const seq: ViewMode[] = ["3d", "2d", "flow", "files"];
    expect(seq.map(cycleView)).toEqual(["2d", "flow", "files", "3d"]);
  });
});
