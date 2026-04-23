/**
 * KIOKU™ — Luca self-write memory tool (W7 P2.12)
 *
 * Source-level contract test for the `remember` partner tool. Luca uses
 * this to persist durable memories (dislikes, commitments, reflections,
 * relational facts, etc.) bypassing LLM extraction. Non-negotiable
 * invariants:
 *   - Registered in LUCA_STUDIO_TOOL_NAMES so the schema exposed to the
 *     model matches what Luca can actually execute.
 *   - Tool schema lives in `partnerTools` with the approved 10-type enum.
 *   - Handler is scoped to (userId, agentId) — we cannot poison another
 *     agent's memory.
 *   - Handler validates type enum, content (non-empty, length-capped) and
 *     importance (0..1).
 *   - INSERT writes user_id and agent_id as first two columns (no orphan
 *     rows possible).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const deliberationSource = readFileSync(
  resolve(__dirname, "../../server/deliberation.ts"),
  "utf8"
);

describe("remember tool — registration & schema", () => {
  it("is listed in LUCA_STUDIO_TOOL_NAMES (via the base-set array)", () => {
    // Day 6 part 3: LUCA_STUDIO_TOOL_NAMES is now derived from
    // LUCA_STUDIO_TOOL_NAMES_BASE (an array literal). We match against
    // the base array — any refactor that moves `remember` out of the
    // always-on base set will (rightly) break this.
    const block = extractBetween(
      deliberationSource,
      "LUCA_STUDIO_TOOL_NAMES_BASE",
      "];"
    );
    expect(block).toMatch(/["']remember["']/);
  });

  it("has a tool schema entry in partnerTools", () => {
    expect(deliberationSource).toMatch(/name:\s*["']remember["']/);
  });

  it("enum includes the 10 approved memory types", () => {
    const schema = extractToolSchema(deliberationSource, "remember");
    for (const t of [
      "aesthetic",
      "procedural",
      "meta_cognitive",
      "reflection",
      "commitment",
      "relational",
      "autobiographical",
      "episodic",
      "semantic",
      "emotional_state",
    ]) {
      expect(schema).toMatch(new RegExp(`["']${t}["']`));
    }
  });

  it("type and content are required fields", () => {
    const schema = extractToolSchema(deliberationSource, "remember");
    expect(schema).toMatch(/required:\s*\[\s*["']type["']\s*,\s*["']content["']\s*\]/);
  });

  it("schema exposes the 8 approved emotion fields (no frustration/regret)", () => {
    const schema = extractToolSchema(deliberationSource, "remember");
    for (const e of [
      "engagement",
      "confidence",
      "trust",
      "curiosity",
      "pride",
      "concern",
      "attachment",
      "doubt",
    ]) {
      expect(schema).toMatch(new RegExp(`${e}\\s*:`));
    }
    expect(schema).not.toMatch(/frustration\s*:/);
    expect(schema).not.toMatch(/regret\s*:/);
  });

  it("schema exposes related_ids for non-linear memory links", () => {
    const schema = extractToolSchema(deliberationSource, "remember");
    expect(schema).toMatch(/related_ids\s*:/);
  });
});

describe("remember tool — handler invariants", () => {
  const handler = extractCaseBlock(deliberationSource, "remember");

  it("handler case exists in executePartnerTool switch", () => {
    expect(handler.length).toBeGreaterThan(200);
  });

  it("validates the type against the allowed enum", () => {
    expect(handler).toMatch(/ALLOWED_TYPES/);
    expect(handler).toMatch(/invalid type/);
  });

  it("rejects empty content", () => {
    expect(handler).toMatch(/['"]content['"] is required/);
  });

  it("caps content length (bounded input)", () => {
    expect(handler).toMatch(/content too long/);
    expect(handler).toMatch(/4000/);
  });

  it("validates importance is in [0..1]", () => {
    expect(handler).toMatch(/importance must be between 0 and 1/);
  });

  it("INSERT is scoped by (user_id, agent_id) as first two columns", () => {
    expect(handler).toMatch(
      /INSERT\s+INTO\s+memories\s*\(\s*user_id\s*,\s*agent_id/i
    );
  });

  it("INSERT uses the callsite userId and agentId bindings", () => {
    // $1, $2 must come from userId, agentId — not from toolInput
    expect(handler).toMatch(
      /VALUES\s*\(\s*\$1\s*,\s*\$2\s*,\s*\$3\s*,\s*\$4\s*,\s*\$5\s*,\s*\$6\s*,\s*\$7\s*,\s*\$8\s*,\s*\$9\s*\)/
    );
    // The parameter array must START with userId, agentId — never let the
    // tool input override who owns the memory.
    expect(handler).toMatch(/\[\s*userId\s*,\s*agentId\s*,/);
  });

  it("does not trust toolInput.userId or toolInput.agentId (ownership non-overridable)", () => {
    expect(handler).not.toMatch(/toolInput\.userId/);
    expect(handler).not.toMatch(/toolInput\.agentId/);
  });

  it("clamps emotional_valence into [-1..+1]", () => {
    expect(handler).toMatch(/Math\.max\(\s*-1/);
    expect(handler).toMatch(/Math\.min\(\s*1/);
  });

  it("derives a namespace by type when none supplied", () => {
    expect(handler).toMatch(/_aesthetics/);
    expect(handler).toMatch(/_commitment/);
    expect(handler).toMatch(/_relational/);
    expect(handler).toMatch(/_meta_cognitive/);
  });
});

// ---------- helpers ----------

function extractBetween(src: string, startMarker: string, endMarker: string): string {
  const s = src.indexOf(startMarker);
  if (s === -1) return "";
  const e = src.indexOf(endMarker, s);
  if (e === -1) return src.slice(s);
  return src.slice(s, e + endMarker.length);
}

/** Slice the `{ name: "<toolName>", ... }` object literal from partnerTools. */
function extractToolSchema(src: string, toolName: string): string {
  const marker = `name: "${toolName}"`;
  const idx = src.indexOf(marker);
  if (idx === -1) return "";
  // Walk back to the opening `{` of this literal
  let start = idx;
  while (start > 0 && src[start] !== "{") start--;
  // Walk forward matching braces
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return src.slice(start);
}

/** Slice the body of a `case "<toolName>": { ... }` block from the switch.
 *  Picks the LAST occurrence — the one with a real `{ ... }` body — so we
 *  don't match the one-line timeline case in describeToolCall. */
function extractCaseBlock(src: string, toolName: string): string {
  const marker = `case "${toolName}":`;
  let lastBlock = "";
  let from = 0;
  while (true) {
    const idx = src.indexOf(marker, from);
    if (idx === -1) break;
    from = idx + marker.length;
    // Skip to next non-whitespace char after the marker
    let j = idx + marker.length;
    while (j < src.length && /\s/.test(src[j])) j++;
    if (src[j] !== "{") continue; // one-liner form like `case "x": return ...`
    let depth = 0;
    for (let i = j; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
        depth--;
        if (depth === 0) {
          lastBlock = src.slice(j, i + 1);
          break;
        }
      }
    }
  }
  return lastBlock;
}
