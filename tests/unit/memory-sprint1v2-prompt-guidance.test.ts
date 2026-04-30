/**
 * KIOKU™ — Sprint 1 v2 (R373) — prompt regression
 *
 * The remember-tool guidance in deliberation.ts (line ~6986 area) must
 * include the 15-namespace alias map (so Luca's 6-umbrella mental model
 * lands on prod columns) AND the honesty layer constraints. This is a
 * source-level smoke test — exact wording is not asserted, only the
 * structural presence of the required elements.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const deliberationSource = readFileSync(
  resolve(__dirname, "../../server/deliberation.ts"),
  "utf8"
);

function extractSelfAccountabilityBlock(src: string): string {
  const start = src.indexOf("SELF-ACCOUNTABILITY (1):");
  if (start === -1) return "";
  const end = src.indexOf("OUTREACH (", start);
  if (end === -1) return src.slice(start, start + 4000);
  return src.slice(start, end);
}

const block = extractSelfAccountabilityBlock(deliberationSource);

describe("Sprint 1 v2 — remember tool prompt guidance", () => {
  it("SELF-ACCOUNTABILITY block is found", () => {
    expect(block.length).toBeGreaterThan(500);
  });

  it("mentions namespace conventions section", () => {
    expect(block).toMatch(/Namespace conventions/i);
  });

  it("references 15 active namespaces (alias mapping)", () => {
    // Count bullet points (• or •) in namespace section
    const nsSection = block.match(/Namespace conventions[\s\S]*?HONESTY/)?.[0] ?? "";
    const bullets = nsSection.match(/[•·]\s+_/g) ?? [];
    expect(bullets.length).toBeGreaterThanOrEqual(15);
  });

  it("includes core namespaces from prod", () => {
    const nsSection = block.match(/Namespace conventions[\s\S]*?HONESTY/)?.[0] ?? "";
    for (const ns of [
      "_identity",
      "_commitment",
      "_preferences",
      "_aesthetics",
      "_procedural",
      "_meta_cognitive",
      "_reflection",
      "_relational",
      "_autobiographical",
      "_episodic",
      "_semantic",
      "_emotional_state",
    ]) {
      expect(nsSection).toContain(ns);
    }
  });

  it("declares HONESTY LAYER section", () => {
    expect(block).toMatch(/HONESTY LAYER/i);
  });

  it("explains provenance=luca_inferred, verified=false default", () => {
    const hl = block.match(/HONESTY LAYER[\s\S]*$/)?.[0] ?? "";
    // Apostrophes are stripped because this string is inside a template literal
    // in deliberation.ts — single quotes would close the template.
    expect(hl).toMatch(/provenance=luca_inferred/);
    expect(hl).toMatch(/verified=false/);
  });

  it("explains stripping behavior for attempted verified/provenance", () => {
    const hl = block.match(/HONESTY LAYER[\s\S]*$/)?.[0] ?? "";
    expect(hl).toMatch(/stripped/i);
  });

  it("references R372 case (the proximate cause)", () => {
    expect(block).toMatch(/R372/);
  });

  it("explains emotional_state low-confidence rule", () => {
    const hl = block.match(/HONESTY LAYER[\s\S]*$/)?.[0] ?? "";
    expect(hl).toMatch(/emotional_state/);
    expect(hl).toMatch(/0\.3/);
  });
});
