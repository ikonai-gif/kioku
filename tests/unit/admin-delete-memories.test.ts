/**
 * KIOKU™ — Admin bulk delete-memories (W7 P2.7)
 *
 * This is a pure source-level contract test. The handler is <30 LOC and
 * mirrors /api/admin/dump-user. Our only non-negotiable invariant is that
 * the DELETE query MUST be scoped by BOTH user_id AND id (never just id).
 * If someone refactors and drops the user_id guard, this test fails loudly.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const routesSource = readFileSync(
  resolve(__dirname, "../../server/routes.ts"),
  "utf8"
);

describe("admin/delete-memories — invariants", () => {
  it("endpoint is registered as POST /api/admin/delete-memories", () => {
    expect(routesSource).toMatch(
      /app\.post\(\s*["']\/api\/admin\/delete-memories["']/
    );
  });

  it("requires x-master-key auth (parity with dump-user)", () => {
    // The handler MUST check x-master-key header against KIOKU_MASTER_KEY
    const handlerBlock = extractHandler(routesSource, "/api/admin/delete-memories");
    expect(handlerBlock).toMatch(/x-master-key/);
    expect(handlerBlock).toMatch(/KIOKU_MASTER_KEY/);
    expect(handlerBlock).toMatch(/safeCompare/);
    expect(handlerBlock).toMatch(/403/);
  });

  it("DELETE query MUST be scoped by BOTH user_id AND id (no orphan deletes)", () => {
    const handlerBlock = extractHandler(routesSource, "/api/admin/delete-memories");
    // The exact line we care about: DELETE FROM memories WHERE user_id = $1 AND id = ANY(...)
    expect(handlerBlock).toMatch(
      /DELETE\s+FROM\s+memories\s+WHERE\s+user_id\s*=\s*\$1\s+AND\s+id\s*=\s*ANY/i
    );
    // Negative: must NOT have a stray `DELETE FROM memories WHERE id = ANY` without user_id guard
    expect(handlerBlock).not.toMatch(
      /DELETE\s+FROM\s+memories\s+WHERE\s+id\s*=\s*ANY/i
    );
  });

  it("enforces bounded input (userId required, non-empty int[], max 500)", () => {
    const handlerBlock = extractHandler(routesSource, "/api/admin/delete-memories");
    expect(handlerBlock).toMatch(/userId required/);
    expect(handlerBlock).toMatch(/memoryIds.*required/);
    expect(handlerBlock).toMatch(/max 500/);
  });
});

/** Extract the app.post("/.../delete-memories", ...) block up to its matching `}));` */
function extractHandler(src: string, routePath: string): string {
  const start = src.indexOf(`"${routePath}"`);
  if (start === -1) return "";
  const end = src.indexOf("}));", start);
  if (end === -1) return src.slice(start);
  return src.slice(start, end + 4);
}
