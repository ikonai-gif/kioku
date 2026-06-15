import { describe, it, expect } from "vitest";
import { isObservedTool } from "../lib/tool-whitelist";

describe("isObservedTool", () => {
  it("returns true for whitelisted tool web_search", () => {
    expect(isObservedTool("web_search")).toBe(true);
  });

  it("returns false for non-whitelisted tool generate_image", () => {
    expect(isObservedTool("generate_image")).toBe(false);
  });

  it("returns false for non-whitelisted tool luca_write", () => {
    expect(isObservedTool("luca_write")).toBe(false);
  });

  it("returns true for sandbox_shell with observed command ls", () => {
    expect(isObservedTool("sandbox_shell", { command: "ls -la" })).toBe(true);
  });

  it("returns false for sandbox_shell with non-observed command rm", () => {
    expect(isObservedTool("sandbox_shell", { command: "rm -rf x" })).toBe(false);
  });
});
