/**
 * KIOKU™ — Partner room auto-assign (W7 P2.10)
 *
 * Invariant: when the UI creates a new Partner room via POST /api/rooms
 * with no agentIds, the server MUST route it to Luca (by name or by
 * canonical id=16), NEVER to userAgents[0] (which picked BOSS/BRO2
 * depending on SELECT order and caused severe persona drift).
 *
 * Source-level contract test; pattern mirrors the other P2.x tests.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const src = readFileSync(
  resolve(__dirname, "../../server/routes.ts"),
  "utf8"
);

describe("Partner room auto-assign — invariants", () => {
  // Extract the POST /api/rooms handler body
  const start = src.indexOf('app.post("/api/rooms"');
  const end = src.indexOf("}));", start) + 4;
  const handler = src.slice(start, end);

  it("Partner branch exists (isPartnerRoom check)", () => {
    expect(handler).toMatch(/isPartnerRoom/);
  });

  it("MUST match Luca by name === 'luca' (exact, case-insensitive)", () => {
    expect(handler).toMatch(
      /a\.name\??\.toLowerCase\(\)\s*===\s*["']luca["']/i
    );
  });

  it("MUST have explicit canonical id === 16 fallback", () => {
    expect(handler).toMatch(/a\.id\s*===\s*16/);
  });

  it("MUST NOT fall back to userAgents[0] (caused routing to BOSS/BRO2)", () => {
    // The bad pattern: `|| userAgents[0]` after the find chain
    expect(handler).not.toMatch(/\|\|\s*userAgents\[0\]/);
  });

  it("MUST error (500) if Luca is missing — never silently pick wrong agent", () => {
    expect(handler).toMatch(/Luca agent not found/);
    expect(handler).toMatch(/500/);
  });

  it("Partner room remains exempt from plan limits (UX: always creatable)", () => {
    expect(handler).toMatch(/Partner room is exempt from plan limits/);
  });
});
