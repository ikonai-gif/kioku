/**
 * R475 — luca_recall_self _self_monitoring suppression.
 *
 * Behavior under test (BOSS spec, 3 named cases):
 *   1) no suppress_namespaces arg → defaults to ['_self_monitoring'] →
 *      0 self_monitoring rows in result
 *   2) suppress_namespaces=[] → all namespaces returned (escape hatch)
 *   3) suppress_namespaces=['_self_monitoring','_debug'] → both suppressed
 *
 * The recall handler is a closure inside the partner-tool dispatcher, which
 * is not callable in isolation. We split coverage:
 *   - parseSuppressNamespaces() helper: directly exercised for the 3 input
 *     scenarios + defensive parsing.
 *   - Handler integration: source-grep on the recall case in deliberation.ts
 *     to assert the SQL paths both contain the namespace-exclusion clause
 *     and that parseSuppressNamespaces is wired to toolInput.
 *
 * Together these two layers cover the contract: "given input X, the SQL
 * built will exclude namespaces Y".
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { parseSuppressNamespaces } from "../../server/deliberation.js";

const source = readFileSync(
  resolve(__dirname, "../../server/deliberation.ts"),
  "utf8",
);

describe("R475 — parseSuppressNamespaces (3 BOSS cases + defensive parsing)", () => {
  it("Case 1: undefined arg → defaults to ['_self_monitoring']", () => {
    expect(parseSuppressNamespaces(undefined)).toEqual(["_self_monitoring"]);
  });

  it("Case 2: [] arg → returns [] (escape hatch disables suppression)", () => {
    expect(parseSuppressNamespaces([])).toEqual([]);
  });

  it("Case 3: ['_self_monitoring','_debug'] → returned verbatim (multi-suppress)", () => {
    expect(parseSuppressNamespaces(["_self_monitoring", "_debug"]))
      .toEqual(["_self_monitoring", "_debug"]);
  });

  it("filters non-string entries from arrays defensively", () => {
    expect(parseSuppressNamespaces(["ok", 42, null, "_x", undefined, {}]))
      .toEqual(["ok", "_x"]);
  });

  it("falls back to default for non-array inputs (null / string / number)", () => {
    expect(parseSuppressNamespaces(null)).toEqual(["_self_monitoring"]);
    expect(parseSuppressNamespaces("string")).toEqual(["_self_monitoring"]);
    expect(parseSuppressNamespaces(123)).toEqual(["_self_monitoring"]);
  });
});

describe("R475 — luca_recall_self handler wires suppression into both SQL paths", () => {
  // Two case statements share the prefix: pretty-print at ~1637 and main
  // dispatch at ~5963. We want the dispatch body — find the SECOND occurrence.
  function dispatchWindow(): string {
    const firstCase = source.indexOf('case "luca_recall_self":');
    expect(firstCase).toBeGreaterThan(-1);
    const caseStart = source.indexOf('case "luca_recall_self":', firstCase + 1);
    expect(caseStart).toBeGreaterThan(-1);
    // [BRO2-280] CCP Phase 1.0 added a third recall branch (cube proximity)
    // before vector/FTS. [BRO2-282] added expiry clause to all 3 paths.
    // Widened from 5000 → 9000 → 12000 to include all branches.
    return source.slice(caseStart, caseStart + 12000);
  }

  it("handler parses suppress_namespaces via parseSuppressNamespaces(toolInput.suppress_namespaces)", () => {
    expect(dispatchWindow()).toMatch(
      /parseSuppressNamespaces\(toolInput\.suppress_namespaces\)/,
    );
  });

  it("vector path appends the NULL-safe namespace exclusion clause", () => {
    const w = dispatchWindow();
    // Confirm the vector branch (embedding_vec <=>) is in our window.
    expect(w).toMatch(/embedding_vec\s*<=>\s*\$1::vector/);
    // The exclusion clause should appear at least once in the window.
    expect(w).toMatch(
      /AND \(namespace IS NULL OR namespace <> ALL\(\$\$\{params\.length\}::text\[\]\)\)/,
    );
  });

  it("FTS fallback path appends the same NULL-safe namespace exclusion clause", () => {
    const w = dispatchWindow();
    // [BRO2-278] keyword fallback was migrated from ILIKE to Postgres FTS.
    // Confirm the FTS branch is in our window (content_tsv @@ plainto_tsquery).
    expect(w).toMatch(/content_tsv @@ plainto_tsquery/);
    // The clause should appear TWICE total (once per SQL path).
    const matches = w.match(
      /AND \(namespace IS NULL OR namespace <> ALL\(\$\$\{params\.length\}::text\[\]\)\)/g,
    );
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });

  it("clause is NULL-safe: every `namespace <> ALL(` is preceded by `IS NULL OR `", () => {
    // Bare `namespace <> ALL(...)` would silently drop NULL-namespace rows
    // because NULL <> ALL(arr) is NULL in Postgres (treated as false in WHERE).
    // Verify every occurrence of the comparison is paired with the NULL guard.
    const w = dispatchWindow();
    const totalNeq = (w.match(/namespace <> ALL\(/g) || []).length;
    const safeNeq = (w.match(/IS NULL OR namespace <> ALL\(/g) || []).length;
    expect(totalNeq).toBeGreaterThanOrEqual(2);
    expect(safeNeq).toBe(totalNeq);
  });

  it("tool schema advertises suppress_namespaces as an optional string array", () => {
    const defStart = source.indexOf('name: "luca_recall_self"');
    const defEnd = source.indexOf("},\n  {", defStart);
    const window = source.slice(defStart, defEnd > 0 ? defEnd : defStart + 4000);
    expect(window).toMatch(/suppress_namespaces:\s*\{[\s\S]*?type:\s*"array"/);
    expect(window).toMatch(/suppress_namespaces:\s*\{[\s\S]*?items:\s*\{\s*type:\s*"string"\s*\}/);
    // Must NOT be added to required[]
    expect(window).toMatch(/required:\s*\[\s*"query"\s*\]/);
    expect(window).not.toMatch(/required:\s*\[[^\]]*"suppress_namespaces"/);
  });

  it("system-prompt tool doc mentions suppress_namespaces so Luca knows the param exists", () => {
    // The static system-prompt block lists luca_recall_self fields. Without
    // this mention, Luca cannot intentionally pass [] when she WANTS to
    // query self_monitoring rows.
    const docLineIdx = source.indexOf(
      "- luca_recall_self → read-only ad-hoc search",
    );
    expect(docLineIdx).toBeGreaterThan(-1);
    const docLine = source.slice(docLineIdx, source.indexOf("\n", docLineIdx));
    expect(docLine).toMatch(/suppress_namespaces\?/);
    expect(docLine).toMatch(/_self_monitoring/);
  });
});
