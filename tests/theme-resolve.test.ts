import { describe, it, expect } from "vitest";
import { resolveInitialTheme, themeToStored } from "@/lib/theme";

describe("resolveInitialTheme", () => {
  it("returns dark by default (null/unknown)", () => {
    expect(resolveInitialTheme(null)).toBe(true);
    expect(resolveInitialTheme("garbage")).toBe(true);
  });
  it("respects stored light/dark", () => {
    expect(resolveInitialTheme("light")).toBe(false);
    expect(resolveInitialTheme("dark")).toBe(true);
  });
});
describe("themeToStored", () => {
  it("serializes", () => {
    expect(themeToStored(true)).toBe("dark");
    expect(themeToStored(false)).toBe("light");
  });
});
