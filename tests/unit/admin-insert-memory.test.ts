/**
 * KIOKU™ — Admin insert-memory (W7 P2.9)
 *
 * Source-level contract test. This endpoint bypasses LLM extraction to
 * land hard preferences (e.g., explicit dislikes the agent failed to
 * persist). The non-negotiable invariant is that the INSERT MUST be
 * bounded by an agent-ownership pre-check so we can't poison another
 * user's agent even if caller supplies a mismatched (userId, agentId).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const routesSource = readFileSync(
  resolve(__dirname, "../../server/routes.ts"),
  "utf8"
);

describe("admin/insert-memory — invariants", () => {
  it("endpoint is registered as POST /api/admin/insert-memory", () => {
    expect(routesSource).toMatch(
      /app\.post\(\s*["']\/api\/admin\/insert-memory["']/
    );
  });

  it("requires x-master-key auth", () => {
    const h = extract(routesSource, "/api/admin/insert-memory");
    expect(h).toMatch(/x-master-key/);
    expect(h).toMatch(/KIOKU_MASTER_KEY/);
    expect(h).toMatch(/safeCompare/);
    expect(h).toMatch(/403/);
  });

  it("verifies agent ownership BEFORE INSERT (pre-check by user_id)", () => {
    const h = extract(routesSource, "/api/admin/insert-memory");
    // The SELECT must be scoped by BOTH id AND user_id
    expect(h).toMatch(
      /SELECT[^;]+FROM\s+agents\s+WHERE\s+id\s*=\s*\$1\s+AND\s+user_id\s*=\s*\$2/i
    );
    expect(h).toMatch(/agent not owned by user/);
  });

  it("INSERT writes user_id and agent_id as first two columns (non-orphan row)", () => {
    const h = extract(routesSource, "/api/admin/insert-memory");
    expect(h).toMatch(
      /INSERT\s+INTO\s+memories\s*\(\s*user_id\s*,\s*agent_id/i
    );
  });

  it("enforces bounded input (userId+agentId+content required, length cap, 0..1 importance)", () => {
    const h = extract(routesSource, "/api/admin/insert-memory");
    expect(h).toMatch(/userId required/);
    expect(h).toMatch(/agentId required/);
    expect(h).toMatch(/content required/);
    expect(h).toMatch(/content too long/);
    expect(h).toMatch(/importance must be 0\.\.1/);
  });
});

function extract(src: string, routePath: string): string {
  const start = src.indexOf(`"${routePath}"`);
  if (start === -1) return "";
  const end = src.indexOf("}));", start);
  if (end === -1) return src.slice(start);
  return src.slice(start, end + 4);
}
