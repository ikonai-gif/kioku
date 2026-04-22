/**
 * KIOKU™ — P3.1 routing audit fixes (W8)
 *
 * Eliminates all `userAgents[0]` / `agents[0]` silent-fallback sites in
 * routes.ts and routes every primary-agent resolution through the
 * canonical `resolvePrimaryAgent()` helper.
 *
 * Paradigm: static source inspection, same as partner-room-auto-assign
 * and partner-room-consolidation tests. No live DB.
 *
 * Bug class: P2.10 showed that `.find(a => /partner/i) || agents[0]`
 * silently routes to BOSS/BRO2 when Luca is not the first SELECT row.
 * P3.1 extends the fix to 11 additional routes.ts sites + 1 CRITICAL
 * site (POST /api/tasks — scheduled-task creation stores the resolved
 * agent id DURABLY in the DB and replays it at trigger time).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const src = readFileSync(resolve(__dirname, "../../server/routes.ts"), "utf8");

describe("P3.1 — canonical resolver", () => {
  it("defines resolvePrimaryAgent() helper", () => {
    expect(src).toMatch(/function\s+resolvePrimaryAgent\s*\(/);
  });

  it("helper cascades through exact name, id=16, legacy regex, null", () => {
    const fnStart = src.indexOf("function resolvePrimaryAgent");
    const fnEnd = src.indexOf("}\n", fnStart) + 1;
    const body = src.slice(fnStart, fnEnd);
    // Step 1: exact `luca` name
    expect(body).toMatch(/name\?\.toLowerCase\?\.\(\)\s*===\s*["']luca["']/);
    // Step 2: canonical id=16
    expect(body).toMatch(/id\s*===\s*16/);
    // Step 3: legacy substring match for pre-P2.10 agent naming
    expect(body).toMatch(/agent o\|partner/i);
    // Step 4: returns null (no silent `[0]` fallback)
    expect(body).not.toMatch(/\|\|\s*agents\[0\]/);
  });

  it("primaryAgentIdFor uses resolvePrimaryAgent (no direct [0])", () => {
    const fnIdx = src.indexOf("async function primaryAgentIdFor");
    const fnEnd = src.indexOf("}\n", fnIdx) + 1;
    const body = src.slice(fnIdx, fnEnd);
    expect(body).toMatch(/resolvePrimaryAgent/);
    expect(body).not.toMatch(/\|\|\s*agents\[0\]/);
  });
});

describe("P3.1 — no silent [0] fallbacks remain in routes.ts", () => {
  it("no `|| userAgents[0]` fallback expression (code only)", () => {
    // Strip line comments (// ...) before checking \u2014 docstrings and audit
    // trail comments legitimately reference the historical pattern.
    const codeOnly = src
      .split("\n")
      .map((line) => {
        const idx = line.indexOf("//");
        return idx >= 0 ? line.slice(0, idx) : line;
      })
      .join("\n");
    expect(codeOnly).not.toMatch(/\|\|\s*userAgents\[0\]/);
  });

  it("no `|| agents[0]` fallback expression (code only)", () => {
    const codeOnly = src
      .split("\n")
      .map((line) => {
        const idx = line.indexOf("//");
        return idx >= 0 ? line.slice(0, idx) : line;
      })
      .join("\n");
    expect(codeOnly).not.toMatch(/\|\|\s*agents\[0\]/);
  });

  it("no `agents[0].id` direct assignment (code only)", () => {
    const codeOnly = src
      .split("\n")
      .map((line) => {
        const idx = line.indexOf("//");
        return idx >= 0 ? line.slice(0, idx) : line;
      })
      .join("\n");
    expect(codeOnly).not.toMatch(/=\s*agents\[0\]\.id/);
  });

  it("no bare `const primaryAgent = userAgents[0]` (code only)", () => {
    const codeOnly = src
      .split("\n")
      .map((line) => {
        const idx = line.indexOf("//");
        return idx >= 0 ? line.slice(0, idx) : line;
      })
      .join("\n");
    expect(codeOnly).not.toMatch(/=\s*userAgents\[0\]\s*;/);
  });
});

describe("P3.1 — CRITICAL: POST /api/tasks agentId resolution", () => {
  // Locate the task creation handler
  const start = src.indexOf('app.post("/api/tasks"');
  it("POST /api/tasks handler exists", () => {
    expect(start).toBeGreaterThan(0);
  });
  const handler = src.slice(start, start + 3000);

  it("routes agentId resolution through resolvePrimaryAgent", () => {
    expect(handler).toMatch(/resolvePrimaryAgent/);
  });

  it("errors explicitly when primary agent can't be resolved", () => {
    expect(handler).toMatch(/Cannot resolve primary agent/);
    // Must 400 on unresolvable \u2014 NEVER silently fall back to `[0]`
    expect(handler).toMatch(/status\(400\)/);
  });

  it("does not use `agents[0].id` in executable path (guarded by comment)", () => {
    // The phrase can appear in the explanatory comment, but not as code.
    // Strip comments then check.
    const code = handler
      .split("\n")
      .map((l) => {
        const idx = l.indexOf("//");
        return idx >= 0 ? l.slice(0, idx) : l;
      })
      .join("\n");
    expect(code).not.toMatch(/=\s*agents\[0\]\.id/);
  });
});

describe("P3.1 — migration sites use resolvePrimaryAgent", () => {
  // Spot-check 12 specific endpoints by searching their handler signatures
  const endpoints = [
    '"/api/partner/status"',
    '"/api/partner/create/text"',
    '"/api/partner/create/image"',
    '"/api/studio/test"',
    '"/api/partner/preferences"',
    '"/api/partner/preferences/profile"',
    '"/api/partner/feedback"',
    '"/api/partner/create/deliberate"',
  ];
  for (const ep of endpoints) {
    it(`${ep} handler references resolvePrimaryAgent`, () => {
      const epIdx = src.indexOf(ep);
      expect(epIdx).toBeGreaterThan(0);
      // Scan ~3000 chars forward for resolvePrimaryAgent; handlers are rarely
      // longer than that and /api/partner/preferences has two distinct routes
      // so we bound the search.
      const slice = src.slice(epIdx, epIdx + 4000);
      expect(slice).toMatch(/resolvePrimaryAgent/);
    });
  }
});
