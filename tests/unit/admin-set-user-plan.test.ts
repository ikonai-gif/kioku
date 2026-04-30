/**
 * KIOKU™ — Admin set-user-plan (rate-limit recovery path)
 *
 * Source-level contract test. Mirrors the pattern of admin-set-room-agents.
 * Non-negotiable invariants:
 *   1. POST /api/admin/set-user-plan exists.
 *   2. Master-key auth (no session — that's the whole point of this endpoint;
 *      regular /api/billing/plan requires session and is unreachable when
 *      the user is rate-limited).
 *   3. Plan enum is restricted to PLANS keys via adminSetPlanSchema.
 *   4. Updates plan via storage.updateUserPlan (which scopes by id).
 *   5. NOT mounted as PATCH /api/billing/plan duplicate.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const routesSource = readFileSync(
  resolve(__dirname, "../../server/routes.ts"),
  "utf8"
);
const validationSource = readFileSync(
  resolve(__dirname, "../../server/validation.ts"),
  "utf8"
);
const ratelimitSource = readFileSync(
  resolve(__dirname, "../../server/ratelimit.ts"),
  "utf8"
);

describe("admin/set-user-plan — invariants", () => {
  it("endpoint is registered as POST /api/admin/set-user-plan", () => {
    expect(routesSource).toMatch(
      /app\.post\(\s*["']\/api\/admin\/set-user-plan["']/
    );
  });

  it("requires x-master-key auth via safeCompare (parity with dump-user)", () => {
    const handler = extractHandler(routesSource, "/api/admin/set-user-plan");
    expect(handler).toMatch(/x-master-key/);
    expect(handler).toMatch(/KIOKU_MASTER_KEY/);
    expect(handler).toMatch(/safeCompare/);
    expect(handler).toMatch(/403/);
  });

  it("does NOT call getUser(req) — recovery path must work without session", () => {
    const handler = extractHandler(routesSource, "/api/admin/set-user-plan");
    expect(handler).not.toMatch(/getUser\s*\(\s*req\s*\)/);
  });

  it("validates body via adminSetPlanSchema (not updatePlanSchema)", () => {
    const handler = extractHandler(routesSource, "/api/admin/set-user-plan");
    expect(handler).toMatch(/validateBody\(\s*adminSetPlanSchema/);
    expect(handler).not.toMatch(/validateBody\(\s*updatePlanSchema/);
  });

  it("calls storage.updateUserPlan with userId + plan + billingCycle", () => {
    const handler = extractHandler(routesSource, "/api/admin/set-user-plan");
    expect(handler).toMatch(
      /storage\.updateUserPlan\(\s*userId\s*,\s*plan\s*,\s*billingCycle\b/
    );
  });

  it("returns 404 on missing user (updateUserPlan returns falsy)", () => {
    const handler = extractHandler(routesSource, "/api/admin/set-user-plan");
    expect(handler).toMatch(/404/);
  });

  it("logs the admin action for audit trail", () => {
    const handler = extractHandler(routesSource, "/api/admin/set-user-plan");
    expect(handler).toMatch(/logger\.info/);
    expect(handler).toMatch(/admin-set-user-plan/);
  });
});

describe("adminSetPlanSchema — plan enum matches PLANS map", () => {
  it("schema is exported", () => {
    expect(validationSource).toMatch(/export const adminSetPlanSchema\s*=/);
  });

  it("requires positive integer userId", () => {
    expect(validationSource).toMatch(
      /adminSetPlanSchema[\s\S]*?userId:\s*z\.number\(\)\.int\(\)\.positive\(\)/
    );
  });

  it("plan enum covers every key in PLANS (server/ratelimit.ts)", () => {
    // Extract PLANS keys from ratelimit.ts
    const plansBlock = ratelimitSource.match(
      /const\s+PLANS[\s\S]*?\{([\s\S]*?)\};/
    );
    expect(plansBlock).not.toBeNull();
    const planKeys = Array.from(
      plansBlock![1].matchAll(/^\s*([a-z_]+):\s*\{/gm)
    ).map((m) => m[1]);
    expect(planKeys.length).toBeGreaterThanOrEqual(8);

    // Extract the enum from adminSetPlanSchema
    const enumMatch = validationSource.match(
      /adminSetPlanSchema[\s\S]*?plan:\s*z\.enum\(\[([^\]]+)\]\)/
    );
    expect(enumMatch).not.toBeNull();
    const enumKeys = Array.from(enumMatch![1].matchAll(/"([^"]+)"/g)).map(
      (m) => m[1]
    );

    for (const k of planKeys) {
      expect(enumKeys).toContain(k);
    }
  });

  it("billingCycle is optional and limited to monthly|yearly", () => {
    expect(validationSource).toMatch(
      /adminSetPlanSchema[\s\S]*?billingCycle:\s*z\.enum\(\[\s*"monthly"\s*,\s*"yearly"\s*\]\)\.optional\(\)/
    );
  });
});

/** Extract the app.post("/.../set-user-plan", ...) block up to its matching `}));` */
function extractHandler(src: string, routePath: string): string {
  const start = src.indexOf(`"${routePath}"`);
  if (start === -1) return "";
  const end = src.indexOf("}));", start);
  if (end === -1) return src.slice(start);
  return src.slice(start, end + 4);
}
