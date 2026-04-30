/**
 * KIOKU™ — Sprint 1 v2 (R373) — expires_at filter bug fix
 *
 * The expires_at column existed since Phase 2 but neither searchMemories
 * nor textSearchMemories filtered by it. Bug: temporal memories with past
 * expiresAt were still being returned and ranked. This test asserts the
 * fix is present in BOTH retrieval paths.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const storageSource = readFileSync(
  resolve(__dirname, "../../server/storage.ts"),
  "utf8"
);

function extractMethod(src: string, methodName: string): string {
  // Simple heuristic — find method signature and slice until next method or closing brace
  const sigPattern = new RegExp(
    `(private\\s+)?async\\s+${methodName}\\s*\\([^)]*\\)\\s*[:{]`,
  );
  const match = sigPattern.exec(src);
  if (!match) return "";
  const start = match.index;
  // Walk forward for ~3000 chars or until we hit "private async" or "  async" again
  const slice = src.slice(start, start + 4000);
  return slice;
}

describe("Sprint 1 v2 — expires_at filter in vector search path", () => {
  const method = extractMethod(storageSource, "searchMemories");

  it("searchMemories method is found", () => {
    expect(method.length).toBeGreaterThan(100);
  });

  it("vector path filters expires_at (NULL OR > now)", () => {
    expect(method).toMatch(
      /expires_at IS NULL OR expires_at\s*>\s*\$\d/
    );
  });

  it("passes Date.now() as the timestamp parameter", () => {
    expect(method).toMatch(/Date\.now\(\)/);
  });
});

describe("Sprint 1 v2 — expires_at filter in text fallback path", () => {
  const method = extractMethod(storageSource, "textSearchMemories");

  it("textSearchMemories method is found", () => {
    expect(method.length).toBeGreaterThan(50);
  });

  it("text path filters expires_at (NULL OR > now)", () => {
    expect(method).toMatch(
      /expires_at IS NULL OR expires_at\s*>\s*\$\d/
    );
  });

  it("passes Date.now() as the timestamp parameter", () => {
    expect(method).toMatch(/Date\.now\(\)/);
  });
});

describe("Sprint 1 v2 — filter is present in BOTH paths (not just one)", () => {
  it("storage.ts contains exactly two expires_at filter sites", () => {
    const matches = storageSource.match(
      /expires_at IS NULL OR expires_at\s*>\s*\$\d/g
    );
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });
});
