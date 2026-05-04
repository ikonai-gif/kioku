/**
 * KIOKU™ — R462 Luca autonomy
 *
 * Three features in one PR. Source-level invariants only (no DB / no LLM):
 *   1) memory-injection: alwaysInject Boss-profile slice
 *   2) deliberation: post-response _self_monitoring auto-write
 *   3) deliberation: luca_recall_self tool registration + dispatch
 *
 * Why source-level: the heavy paths (embed, LLM tool call, storage.createMemory)
 * are all imported from this module, so spinning them up requires DB + Anthropic.
 * Existing R-tests in this repo use the same pattern (see core-identity-injection,
 * luca-memory-schema-dispatch-routing).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const memInj = readFileSync(
  resolve(__dirname, "../../server/memory-injection.ts"),
  "utf8",
);
const delib = readFileSync(
  resolve(__dirname, "../../server/deliberation.ts"),
  "utf8",
);

describe("R462 — alwaysInject Boss profile (memory-injection)", () => {
  it("declares BOSS_PROFILE_CHAR_CAP, BOSS_NAME_RE, BOSS_PROFILE_TYPES", () => {
    expect(memInj).toMatch(/const\s+BOSS_PROFILE_CHAR_CAP\s*=\s*4000\b/);
    expect(memInj).toMatch(/const\s+BOSS_NAME_RE\s*=/);
    // Regex must match: котэ, кот[аеуыя]?, kote, boss, босс — case-insensitive
    expect(memInj).toMatch(/\/\\b\(котэ\|кот\[аеуыя\]\?\\b\|kote\|boss\|босс\)\/i/);
    expect(memInj).toMatch(
      /const\s+BOSS_PROFILE_TYPES\s*=\s*new Set\(\[[^\]]*"relational"[^\]]*"aesthetic"[^\]]*"procedural"[^\]]*\]\)/s,
    );
  });

  it("filters: dedupe vs identity ids + restrict to BOSS_PROFILE_TYPES + Boss-name regex", () => {
    expect(memInj).toMatch(
      /alwaysInjectIds\.has\(m\.id\)[\s\S]{0,80}return false/,
    );
    expect(memInj).toMatch(/BOSS_PROFILE_TYPES\.has\(m\.type\)[\s\S]{0,40}return false/);
    expect(memInj).toMatch(/BOSS_NAME_RE\.test\(c\)/);
  });

  it("sorts importance DESC, then recency DESC", () => {
    // both tiebreakers present in the bossProfileCandidates.sort body
    const start = memInj.indexOf("bossProfileCandidates");
    expect(start).toBeGreaterThan(-1);
    const window = memInj.slice(start, start + 1500);
    expect(window).toMatch(/impB\s*-\s*impA/);
    expect(window).toMatch(/tsB\s*-\s*tsA/);
  });

  it("respects BOSS_PROFILE_CHAR_CAP and dedupes by adding to alwaysInjectIds", () => {
    expect(memInj).toMatch(/bossCharUsed\s*\+\s*content\.length\s*>\s*BOSS_PROFILE_CHAR_CAP/);
    expect(memInj).toMatch(/alwaysInjectIds\.add\(m\.id\)/);
  });

  it("appends to the same alwaysInject array used by identity loop (single context bundle)", () => {
    // The Boss block must push into alwaysInject (not a separate variable)
    const start = memInj.indexOf("R462 — Always-inject Boss profile");
    expect(start).toBeGreaterThan(-1);
    const window = memInj.slice(start, start + 2500);
    expect(window).toMatch(/alwaysInject\.push\(/);
  });
});

describe("R462 — post-response _self_monitoring auto-write (deliberation)", () => {
  it("fire-and-forget hook only fires for partner-chat with both sides present", () => {
    const start = delib.indexOf("R462 — Fire-and-forget self-monitoring write");
    expect(start).toBeGreaterThan(-1);
    const window = delib.slice(start, start + 2000);
    expect(window).toMatch(/if\s*\(\s*isPartnerChat\s*&&\s*triggerContent\s*&&\s*reply\s*\)/);
    expect(window).toMatch(/void\s*\(\s*async\s*\(\)\s*=>/);
  });

  it("writes meta_cognitive into _self_monitoring with luca_inferred + verified=false", () => {
    const start = delib.indexOf("R462 — Fire-and-forget self-monitoring write");
    const window = delib.slice(start, start + 2500);
    expect(window).toMatch(/type:\s*"meta_cognitive"/);
    expect(window).toMatch(/namespace:\s*"_self_monitoring"/);
    expect(window).toMatch(/provenance:\s*"luca_inferred"/);
    expect(window).toMatch(/verified:\s*false/);
    // Importance low (≤0.5) so it doesn't dominate retrieval
    expect(window).toMatch(/importance:\s*0\.[0-4]\d?/);
  });

  it("uses storage.createMemory (not the LLM-tool path)", () => {
    const start = delib.indexOf("R462 — Fire-and-forget self-monitoring write");
    const window = delib.slice(start, start + 2500);
    expect(window).toMatch(/storage\.createMemory\(/);
  });

  it("write failure is non-fatal (caught + logged at debug)", () => {
    const start = delib.indexOf("R462 — Fire-and-forget self-monitoring write");
    const window = delib.slice(start, start + 2500);
    expect(window).toMatch(/catch\s*\(\s*e[^)]*\)\s*\{[\s\S]*?logger\.debug/);
  });
});

describe("R462 — luca_recall_self tool (deliberation)", () => {
  it("is registered in LUCA_STUDIO_TOOL_NAMES_BASE (Luca scope guard)", () => {
    const scopeStart = delib.search(/LUCA_STUDIO_TOOL_NAMES_BASE\s*:\s*readonly\s+string\[\]\s*=\s*\[/);
    expect(scopeStart).toBeGreaterThan(-1);
    const scopeEnd = delib.indexOf("];", scopeStart);
    const window = delib.slice(scopeStart, scopeEnd);
    expect(window).toMatch(/"luca_recall_self"/);
  });

  it("has a tool definition with required query and optional limit/type_filter", () => {
    const defStart = delib.indexOf('name: "luca_recall_self"');
    expect(defStart).toBeGreaterThan(-1);
    const window = delib.slice(defStart, defStart + 3000);
    expect(window).toMatch(/required:\s*\[\s*"query"\s*\]/);
    expect(window).toMatch(/properties:\s*\{[\s\S]*?query:\s*\{[\s\S]*?type:\s*"string"/);
    expect(window).toMatch(/limit:\s*\{[\s\S]*?type:\s*"number"/);
    expect(window).toMatch(/type_filter:\s*\{[\s\S]*?type:\s*"string"/);
    expect(window).toMatch(/additionalProperties:\s*false/);
  });

  it("routes through the main switch (not the standalone preview branch)", () => {
    expect(delib).toMatch(
      /ROUTES_THROUGH_MAIN_SWITCH\s*=\s*new Set<string>\(\[[^\]]*"luca_recall_self"[^\]]*\]\)/,
    );
  });

  it("dispatch handler: rate-limited, scoped to {userId, agentId}, vector with ILIKE fallback, hard cap 10", () => {
    // Two case statements share the prefix: pretty-print at ~1489 and main
    // dispatch at ~5777. Find the SECOND occurrence (the dispatch body).
    const firstCase = delib.indexOf('case "luca_recall_self":');
    const caseStart = delib.indexOf('case "luca_recall_self":', firstCase + 1);
    expect(caseStart).toBeGreaterThan(-1);
    const window = delib.slice(caseStart, caseStart + 4000);
    // Closure-scoped, not from toolInput
    expect(window).toMatch(/checkAuthRateLimit\(`luca_recall_self:burst:\$\{agentId\}`/);
    expect(window).toMatch(/user_id\s*=\s*\$2\s+AND\s+agent_id\s*=\s*\$3/);
    // vector path
    expect(window).toMatch(/embedding_vec\s*<=>\s*\$1::vector/);
    // ILIKE fallback
    expect(window).toMatch(/ILIKE/);
    // limit clamp
    expect(window).toMatch(/Math\.min\(\s*10\s*,/);
  });

  it("read-only — no createMemory / updateMemory calls inside the case", () => {
    const firstCase = delib.indexOf('case "luca_recall_self":');
    const caseStart = delib.indexOf('case "luca_recall_self":', firstCase + 1);
    const caseEnd = delib.indexOf("case \"", caseStart + 30);
    const window = delib.slice(caseStart, caseEnd > 0 ? caseEnd : caseStart + 4000);
    expect(window).not.toMatch(/createMemory\(/);
    expect(window).not.toMatch(/updateMemory\(/);
    expect(window).not.toMatch(/deleteMemory\(/);
  });

  it("anti-fabrication aliases route hallucinated names → luca_recall_self", () => {
    // System-prompt block listing forbidden tool names with hint
    expect(delib).toMatch(/search_my_memory \(use luca_recall_self\)/);
    expect(delib).toMatch(/recall \(use luca_recall_self\)/);
    expect(delib).toMatch(/find_memory \(use luca_recall_self\)/);
    expect(delib).toMatch(/query_memory \(use luca_recall_self\)/);
    expect(delib).toMatch(/my_memory_search \(use luca_recall_self\)/);
  });

  it("pretty-print case present for activity timeline", () => {
    expect(delib).toMatch(
      /case\s+"luca_recall_self":\s*return\s+`Ищу в своей памяти:/,
    );
  });
});
