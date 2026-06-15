import { describe, it, expect } from "vitest";
import { isObservedTool } from "../lib/tool-whitelist";

describe("isObservedTool", () => {
  it("returns true for whitelisted tool luca_search", () => {
    expect(isObservedTool("luca_search")).toBe(true);
  });

  it("returns false for non-whitelisted tool generate_image", () => {
    expect(isObservedTool("generate_image")).toBe(false);
  });

  it("returns true for luca_read_url (the real runtime name, not read_url)", () => {
    expect(isObservedTool("luca_read_url")).toBe(true);
  });

  it("returns false for bare read_url (runtime uses luca_ prefix)", () => {
    expect(isObservedTool("read_url")).toBe(false);
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
