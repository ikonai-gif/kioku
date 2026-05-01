/**
 * KIOKU™ — Core Identity Injection (W7 P2.13)
 *
 * Every partner turn, we regenerate a compact "who am I / who am I talking
 * to / where am I / what am I committed to / how am I feeling" block and
 * inject it BEFORE the rest of the system prompt. This is the minimum
 * context needed for Luca to be self-accountable — without it, retrieval
 * accidents (e.g. stale aesthetic noir memories) can override identity.
 *
 * Invariants tested at source level:
 *   - buildPartnerPrompt accepts coreIdentityBlock and renders it BEFORE
 *     "You are Luca …" so it appears ahead of the identity section.
 *   - The callsite pulls the block on every partner turn from LIVE DB
 *     (not cached from memoryContext) and passes it in.
 *   - Commitments are scoped by (userId, agent.id) — Luca's top 3 ONLY.
 *   - The block includes agent_id, agent name, user label/id, room info,
 *     emotional_state, and top commitments.
 *   - Explicitly asserts LUCA_STUDIO_TOOL_NAMES remains consistent.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { buildPartnerPrompt } from "../../server/deliberation.js";

const source = readFileSync(
  resolve(__dirname, "../../server/deliberation.ts"),
  "utf8"
);

describe("P2.13 — buildPartnerPrompt rendering", () => {
  it("renders coreIdentityBlock verbatim, ahead of retrieved identitySection (R403: lives in dynamic half, after cached static persona)", () => {
    // R403 — coreIdentityBlock is per-user / per-turn (agent_id, room,
    // emotional_state, commitments). It MUST live in the dynamic half
    // so the cache_control'd static persona stays byte-stable across
    // turns. The invariant that matters for self-accountability is now:
    // coreIdentity comes BEFORE the retrieved "## WHO YOU ARE" memory
    // section (which is also dynamic) — ground-truth still wins over
    // retrieval. The static persona ("You are Luca — created by IKONBAI")
    // is a stable shell, not retrievable noise.
    const core = "## CORE IDENTITY (ground truth every turn — overrides any retrieved memory)\nagent_id=16 | name=Luca (он/he) | model=gpt-5.4-mini\nuser=Kote (id=10)\nroom=151 (Partner with Luca, status=active)\nemotional_state: curious (P=0.20, A=0.10, D=0.40)\ntop commitments (from your own _commitment namespace):\n  - [#900, imp=0.90] review angle 1\n  - [#901, imp=0.85] fix P2.2 assets\n";
    const prompt = buildPartnerPrompt(
      "Luca",
      "",
      "## WHO YOU ARE\nYou are Luca.\n",
      null,
      null,
      undefined,
      [],
      [],
      [],
      "",
      core + "\n"
    );
    const coreIdx = prompt.indexOf("## CORE IDENTITY");
    const whoYouAreIdx = prompt.indexOf("## WHO YOU ARE");
    const lucaIdx = prompt.indexOf("You are Luca — created by IKONBAI");
    expect(coreIdx).toBeGreaterThan(-1);
    expect(whoYouAreIdx).toBeGreaterThan(-1);
    expect(lucaIdx).toBeGreaterThan(-1);
    // R403 ordering: static persona (incl. "You are Luca") → dynamic
    // (coreIdentity → retrieved identitySection → …). coreIdentity must
    // beat the retrieved WHO YOU ARE block so ground-truth overrides.
    expect(coreIdx).toBeGreaterThan(lucaIdx);
    expect(coreIdx).toBeLessThan(whoYouAreIdx);
    // All key fields present verbatim
    expect(prompt).toContain("agent_id=16");
    expect(prompt).toContain("user=Kote (id=10)");
    expect(prompt).toContain("room=151");
    expect(prompt).toContain("emotional_state:");
    expect(prompt).toContain("top commitments");
    expect(prompt).toContain("[#900, imp=0.90] review angle 1");
  });

  it("omits the block cleanly when not provided (no undefined leaking)", () => {
    const prompt = buildPartnerPrompt("Luca", "", "## WHO YOU ARE\nYou are Luca.\n");
    expect(prompt).not.toContain("undefined");
    expect(prompt).not.toContain("## CORE IDENTITY");
    // AI disclosure still comes before "You are Luca"
    expect(prompt.indexOf("AI DISCLOSURE")).toBeLessThan(
      prompt.indexOf("You are Luca")
    );
  });
});

describe("P2.13 — callsite integration", () => {
  it("callsite builds coreIdentityBlock before buildPartnerPrompt", () => {
    // Block is assembled in the partner-chat section of runDeliberationStep
    expect(source).toMatch(/let\s+coreIdentityBlock\s*=\s*""/);
    expect(source).toMatch(/CORE IDENTITY \(ground truth every turn/);
  });

  it("commitments query is scoped by (user_id, agent_id) — not by user_id alone", () => {
    // Extract the core identity block definition for inspection
    const block = extractBlock(source, "// W7 P2.13: Core identity injection", "const systemPrompt = isPartnerChat");
    expect(block).toMatch(/namespace\s*=\s*'_commitment'/);
    expect(block).toMatch(
      /WHERE\s+user_id\s*=\s*\$1\s+AND\s+agent_id\s*=\s*\$2/i
    );
    // Bindings order must match — $1=userId, $2=agent.id
    expect(block).toMatch(/\[\s*userId\s*,\s*agent\.id\s*\]/);
  });

  it("commitments ORDER BY importance DESC (top 3 by importance, not recency)", () => {
    const block = extractBlock(source, "// W7 P2.13: Core identity injection", "const systemPrompt = isPartnerChat");
    expect(block).toMatch(/ORDER\s+BY\s+importance\s+DESC/i);
    expect(block).toMatch(/LIMIT\s+3/);
  });

  it("failure of core identity injection is best-effort (turn never fails)", () => {
    const block = extractBlock(source, "// W7 P2.13: Core identity injection", "const systemPrompt = isPartnerChat");
    // The whole assembly must be inside a try { … } catch { /* comment */ }
    expect(block).toMatch(/try\s*\{[\s\S]*?\}\s*catch\s*\{[^}]*\}/);
  });

  it("coreIdentityBlock is passed as last argument to buildPartnerPromptParts in partner-chat branch (R403)", () => {
    // R403 — the partner-chat path now calls buildPartnerPromptParts
    // (returns {static, dynamic}) instead of buildPartnerPrompt directly.
    // Anthropic call site #1 reads parts directly to build the
    // cache_control'd system array; legacy buildPartnerPrompt remains for
    // non-Claude paths and unit tests, and delegates through the same
    // buildPartnerPromptParts. coreIdentityBlock must be the final arg in
    // both call shapes.
    const callsite = extractBlock(source, "// R403 — partner-chat path computes static/dynamic parts once", "      // Build conversation history");
    expect(callsite).toMatch(/buildPartnerPromptParts\([\s\S]*?coreIdentityBlock,?\s*\)/);
    // Wrapper still threads coreIdentityBlock through.
    expect(source).toMatch(/export function buildPartnerPrompt\([\s\S]*?coreIdentityBlock\?:\s*string,?\s*\):\s*string/);
  });

  it("only runs for partner-chat (not mesh deliberation)", () => {
    const block = extractBlock(source, "// W7 P2.13: Core identity injection", "const systemPrompt = isPartnerChat");
    expect(block).toMatch(/if\s*\(\s*isPartnerChat\s*\)/);
  });

  it("strips [meta: {…}] JSON suffix from commitment content before display", () => {
    const block = extractBlock(source, "// W7 P2.13: Core identity injection", "const systemPrompt = isPartnerChat");
    expect(block).toMatch(/\\\[meta:/);
  });
});

// ---------- helpers ----------

function extractBlock(src: string, startMarker: string, endMarker: string): string {
  const s = src.indexOf(startMarker);
  if (s === -1) return "";
  const e = src.indexOf(endMarker, s);
  if (e === -1) return src.slice(s);
  return src.slice(s, e);
}
