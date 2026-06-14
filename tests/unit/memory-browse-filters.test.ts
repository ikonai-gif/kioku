/**
 * P2.1 PR-1 — query-param parsing for GET /api/memories browse filters.
 */
import { describe, it, expect } from "vitest";
import { parseMemoryBrowseFilters, hasAnyFilter } from "../../server/lib/memory-browse-filters.js";

describe("parseMemoryBrowseFilters", () => {
  it("returns empty object for no params", () => {
    const f = parseMemoryBrowseFilters({});
    expect(f).toEqual({});
    expect(hasAnyFilter(f)).toBe(false);
  });

  it("parses a full filter set with correct types", () => {
    const f = parseMemoryBrowseFilters({
      namespace: "_projects",
      type: "semantic",
      agent_id: "16",
      importance_min: "0.85",
      importance_max: "1",
      created_after: "1748000000000",
      created_before: "1749000000000",
    });
    expect(f).toEqual({
      namespace: "_projects",
      type: "semantic",
      agentId: 16,
      importanceMin: 0.85,
      importanceMax: 1,
      createdAfter: 1748000000000,
      createdBefore: 1749000000000,
    });
    expect(hasAnyFilter(f)).toBe(true);
  });

  it("omits non-numeric numbers and blank strings", () => {
    const f = parseMemoryBrowseFilters({
      namespace: "   ",
      type: "",
      agent_id: "abc",
      importance_min: "not-a-number",
      created_after: "",
    });
    expect(f).toEqual({});
  });

  it("truncates agent_id to an integer and keeps fractional importance", () => {
    const f = parseMemoryBrowseFilters({ agent_id: "16.9", importance_min: "0.7" });
    expect(f.agentId).toBe(16);
    expect(f.importanceMin).toBe(0.7);
  });

  it("ignores unknown params", () => {
    const f = parseMemoryBrowseFilters({ foo: "bar", page: "2", limit: "50" });
    expect(f).toEqual({});
  });
});
