/**
 * KIOKU™ — Admin set-room-agents (W7 P2.8)
 *
 * Pure source-level contract test. The handler mirrors the pattern of
 * delete-memories: master-key auth + (userId, roomId) scoping. The
 * non-negotiable invariant is that the UPDATE MUST filter by BOTH
 * id AND user_id, so we can never accidentally re-route another
 * user's room even if caller passes a mismatched pair.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const routesSource = readFileSync(
  resolve(__dirname, "../../server/routes.ts"),
  "utf8"
);

describe("admin/set-room-agents — invariants", () => {
  it("endpoint is registered as POST /api/admin/set-room-agents", () => {
    expect(routesSource).toMatch(
      /app\.post\(\s*["']\/api\/admin\/set-room-agents["']/
    );
  });

  it("requires x-master-key auth (parity with dump-user)", () => {
    const handlerBlock = extractHandler(routesSource, "/api/admin/set-room-agents");
    expect(handlerBlock).toMatch(/x-master-key/);
    expect(handlerBlock).toMatch(/KIOKU_MASTER_KEY/);
    expect(handlerBlock).toMatch(/safeCompare/);
    expect(handlerBlock).toMatch(/403/);
  });

  it("UPDATE MUST be scoped by BOTH id AND user_id (no cross-user writes)", () => {
    const handlerBlock = extractHandler(routesSource, "/api/admin/set-room-agents");
    expect(handlerBlock).toMatch(
      /UPDATE\s+rooms\s+SET\s+agent_ids\s*=\s*\$1\s+WHERE\s+id\s*=\s*\$2\s+AND\s+user_id\s*=\s*\$3/i
    );
    // Negative: must NOT have an UPDATE scoped only by id
    expect(handlerBlock).not.toMatch(
      /UPDATE\s+rooms\s+SET\s+agent_ids[^;]*WHERE\s+id\s*=\s*\$\d+\s*(?:RETURNING|$)/i
    );
  });

  it("verifies agent ownership before updating (agents must belong to user)", () => {
    const handlerBlock = extractHandler(routesSource, "/api/admin/set-room-agents");
    expect(handlerBlock).toMatch(
      /SELECT\s+id\s+FROM\s+agents\s+WHERE\s+user_id\s*=\s*\$1\s+AND\s+id\s*=\s*ANY/i
    );
    expect(handlerBlock).toMatch(/agentIds not owned by user/);
  });

  it("enforces bounded input (userId + roomId required, non-empty int[], max 20)", () => {
    const handlerBlock = extractHandler(routesSource, "/api/admin/set-room-agents");
    expect(handlerBlock).toMatch(/userId required/);
    expect(handlerBlock).toMatch(/roomId required/);
    expect(handlerBlock).toMatch(/agentIds.*required/);
    expect(handlerBlock).toMatch(/max 20/);
  });

  it("returns previousAgentIds for audit trail / rollback", () => {
    const handlerBlock = extractHandler(routesSource, "/api/admin/set-room-agents");
    expect(handlerBlock).toMatch(/previousAgentIds/);
  });
});

/** Extract the app.post("/.../set-room-agents", ...) block up to its matching `}));` */
function extractHandler(src: string, routePath: string): string {
  const start = src.indexOf(`"${routePath}"`);
  if (start === -1) return "";
  const end = src.indexOf("}));", start);
  if (end === -1) return src.slice(start);
  return src.slice(start, end + 4);
}
