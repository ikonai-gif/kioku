/**
 * KIOKU™ — Sprint 1 v2 (R373) — schema invariants
 *
 * Source-level contract: provenance + verified + last_verified_at columns
 * exist in shared/schema.ts and the migration 0012_memory_provenance_sprint1v2.sql
 * matches them. Default values must be safe-failure (luca_inferred / false / null)
 * so existing 758 memories don't gain unearned trust.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const schemaSource = readFileSync(
  resolve(__dirname, "../../shared/schema.ts"),
  "utf8"
);
const migrationPath = resolve(
  __dirname,
  "../../migrations/0012_memory_provenance_sprint1v2.sql"
);

describe("Sprint 1 v2 — shared/schema.ts memories table", () => {
  it("declares provenance column with luca_inferred default", () => {
    expect(schemaSource).toMatch(
      /provenance:\s*text\("provenance"\)\.notNull\(\)\.default\("luca_inferred"\)/
    );
  });

  it("declares verified column as NOT NULL DEFAULT false", () => {
    expect(schemaSource).toMatch(
      /verified:\s*boolean\("verified"\)\.notNull\(\)\.default\(false\)/
    );
  });

  it("declares lastVerifiedAt column as nullable bigint", () => {
    expect(schemaSource).toMatch(
      /lastVerifiedAt:\s*bigint\("last_verified_at"\s*,\s*\{\s*mode:\s*"number"\s*\}\)/
    );
    // Must NOT be notNull — null = never verified is the default state.
    // Find just the lastVerifiedAt declaration line and assert no .notNull() on it.
    const lvaLine = schemaSource.match(/lastVerifiedAt:.*$/m)?.[0] ?? "";
    expect(lvaLine).not.toMatch(/\.notNull\(\)/);
  });
});

describe("Sprint 1 v2 — migration 0012", () => {
  it("migration file exists", () => {
    expect(existsSync(migrationPath)).toBe(true);
  });

  it("uses IF NOT EXISTS for idempotency (apply-migration safety)", () => {
    const sql = readFileSync(migrationPath, "utf8");
    // All ALTER TABLE statements must be idempotent
    const alters = sql.match(/ALTER TABLE memories[\s\S]*?;/g) ?? [];
    expect(alters.length).toBeGreaterThanOrEqual(3);
    for (const stmt of alters) {
      expect(stmt).toMatch(/IF NOT EXISTS/);
    }
  });

  it("adds provenance with luca_inferred default", () => {
    const sql = readFileSync(migrationPath, "utf8");
    expect(sql).toMatch(
      /ADD COLUMN IF NOT EXISTS provenance text NOT NULL DEFAULT 'luca_inferred'/
    );
  });

  it("adds verified as NOT NULL DEFAULT false", () => {
    const sql = readFileSync(migrationPath, "utf8");
    expect(sql).toMatch(
      /ADD COLUMN IF NOT EXISTS verified boolean NOT NULL DEFAULT false/
    );
  });

  it("adds last_verified_at as nullable bigint (no NOT NULL)", () => {
    const sql = readFileSync(migrationPath, "utf8");
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS last_verified_at bigint(?!\s+NOT NULL)/);
  });

  it("creates composite index on (user_id, namespace, provenance)", () => {
    const sql = readFileSync(migrationPath, "utf8");
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS\s+\w+\s+ON memories\s*\(\s*user_id\s*,\s*namespace\s*,\s*provenance\s*\)/
    );
  });

  it("does NOT add a CHECK constraint on provenance (forward-compat per BRO1)", () => {
    const sql = readFileSync(migrationPath, "utf8");
    expect(sql).not.toMatch(/CHECK\s*\(\s*provenance\s+IN/i);
  });
});
