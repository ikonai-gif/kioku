/**
 * [BRO2-A8 / LUCA-072] Audit export PR1 — unit tests for the pure helpers
 * and the route-contract invariants that the acceptance criteria grep for.
 * DB-touching buildRoomExport is exercised by BOSS verification on prod
 * (curl against a known room) per LUCA-072 Q4; these tests cover the
 * privacy-critical pure logic.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import {
  excludedNamespaces,
  redactPatentContent,
  scrubSecrets,
  excerpt,
  exportFilename,
  EXPORT_DEFAULT_EXCLUDED_NAMESPACES,
} from "../../server/room-export";

describe("room-export — exclusion list (LUCA-072 Q3)", () => {
  it("always excludes _self_monitoring and _emotional_state", () => {
    const ns = excludedNamespaces({} as NodeJS.ProcessEnv);
    for (const d of EXPORT_DEFAULT_EXCLUDED_NAMESPACES) expect(ns.has(d)).toBe(true);
  });

  it("extends via EXPORT_EXCLUDE_NAMESPACES but never drops defaults", () => {
    const ns = excludedNamespaces({ EXPORT_EXCLUDE_NAMESPACES: "_secret_ns, foo" } as NodeJS.ProcessEnv);
    expect(ns.has("_secret_ns")).toBe(true);
    expect(ns.has("foo")).toBe(true);
    expect(ns.has("_self_monitoring")).toBe(true);
    expect(ns.has("_emotional_state")).toBe(true);
  });
});

describe("room-export — patent redaction (LUCA-072 Q3 / K12–K20)", () => {
  it("replaces [patent]-tagged content entirely", () => {
    expect(redactPatentContent("[patent] claim 7 wording …")).toBe("[REDACTED: patent-sensitive]");
    expect(redactPatentContent("notes [PATENT] inline")).toBe("[REDACTED: patent-sensitive]");
  });
  it("leaves untagged content unchanged", () => {
    const s = "plain engineering note";
    expect(redactPatentContent(s)).toBe(s);
  });
});

describe("room-export — secret scrub (LUCA-072 Q4 acceptance)", () => {
  it("scrubs sk- and sb_secret_ shaped tokens", () => {
    const dirty = JSON.stringify({ a: "sk-ABCDEF1234567890abcdef", b: "sb_secret_default_2026_05_08x" });
    const clean = scrubSecrets(dirty);
    expect(clean).not.toMatch(/sk-[A-Za-z0-9_-]{16,}/);
    expect(clean).not.toContain("sb_secret_default");
    expect(clean).toContain("[REDACTED]");
  });
  it("scrubs ENVNAME=value shapes for known providers", () => {
    const dirty = 'log line OPENROUTER_API_KEY=abcdefghijklmnop1234 end';
    expect(scrubSecrets(dirty)).not.toContain("abcdefghijklmnop1234");
  });
  it("does not mangle ordinary content", () => {
    const s = "Kimi routed via OpenRouter; decision approved.";
    expect(scrubSecrets(s)).toBe(s);
  });
});

describe("room-export — excerpt + filename", () => {
  it("caps excerpts at 200 chars with ellipsis", () => {
    const long = "x".repeat(300);
    const e = excerpt(long);
    expect(e.length).toBe(201);
    expect(e.endsWith("…")).toBe(true);
  });
  it("filename is room-{id}-export-{timestamp}.json", () => {
    const f = exportFilename(273, new Date("2026-06-11T15:00:00.000Z"));
    expect(f).toMatch(/^room-273-export-2026-06-11T15-00-00-000Z\.json$/);
  });
});

describe("room-export — route contract (static)", () => {
  const routes = readFileSync(path.join(__dirname, "../../server/routes.ts"), "utf8");
  it("GET /api/rooms/:id/export is registered with auth + Content-Disposition", () => {
    expect(routes).toContain('app.get("/api/rooms/:id/export"');
    const idx = routes.indexOf('app.get("/api/rooms/:id/export"');
    const block = routes.slice(idx, idx + 1600);
    expect(block).toContain("getUser(req)");
    expect(block).toContain("Content-Disposition");
    expect(block).toContain("buildRoomExport");
  });
});
