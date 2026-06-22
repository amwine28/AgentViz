import { describe, it, expect } from "vitest";
import { normalizeTheme, otherTheme, THEMES, DEFAULT_THEME } from "../src/theme/theme";

describe("theme helpers", () => {
  it("defaults to light", () => {
    expect(DEFAULT_THEME).toBe("light");
    expect(THEMES).toEqual(["light", "dark"]);
  });

  it("normalizeTheme passes through valid themes", () => {
    expect(normalizeTheme("light")).toBe("light");
    expect(normalizeTheme("dark")).toBe("dark");
  });

  it("normalizeTheme falls back to default for anything invalid", () => {
    expect(normalizeTheme(null)).toBe("light");
    expect(normalizeTheme(undefined)).toBe("light");
    expect(normalizeTheme("")).toBe("light");
    expect(normalizeTheme("LIGHT")).toBe("light"); // case-sensitive → invalid → default
    expect(normalizeTheme("solarized")).toBe("light");
  });

  it("otherTheme toggles between the two", () => {
    expect(otherTheme("light")).toBe("dark");
    expect(otherTheme("dark")).toBe("light");
    expect(otherTheme(otherTheme("light"))).toBe("light");
  });
});
