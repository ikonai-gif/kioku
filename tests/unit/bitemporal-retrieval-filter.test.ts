// tests/unit/bitemporal-retrieval-filter.test.ts
// [BRO2-325] 2.1c — superseded facts (valid_to NOT NULL) must NEVER be returned
// by any retrieval / injection path. Source-pins the filter across the vector
// query, graph walk, keyword fallback, getInjectionCandidates, and searchMemories
// so a future refactor cannot silently resurface a closed fact.
import { readFileSync } from "fs";
import { resolve } from "path";

const mi = readFileSync(resolve(__dirname, "../../server/memory-injection.ts"), "utf8");
const st = readFileSync(resolve(__dirname, "../../server/storage.ts"), "utf8");

describe("2.1c bi-temporal retrieval filter", () => {
  it("memory-injection vector + graph queries exclude superseded facts", () => {
    // vector query (1) + both graph-walk branches (2) => >= 3 SQL occurrences
    const n = (mi.match(/m\.valid_to IS NULL/g) || []).length;
    expect(n).toBeGreaterThanOrEqual(3);
  });

  it("keyword fallback excludes superseded facts in JS", () => {
    expect(mi.replace(/\s+/g, " ")).toMatch(/m\.validTo == null/);
  });

  it("storage getInjectionCandidates excludes superseded facts", () => {
    expect(st).toMatch(/\$\{memories\.validTo\} IS NULL/);
  });

  it("storage searchMemories (vector + text) excludes superseded facts", () => {
    const n = (st.match(/valid_to IS NULL/g) || []).length;
    expect(n).toBeGreaterThanOrEqual(2);
  });
});
