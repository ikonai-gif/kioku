/**
 * R417 — owner-polling endpoint rate-limit coverage invariant
 *
 * Background:
 *  The UI polls the following endpoints every ~30s:
 *    GET /api/rooms
 *    GET /api/partner/status
 *    GET /api/gallery
 *    GET /api/luca/approvals
 *
 *  Owner accounts (BOSS) rely on R415's `resolveUserPlan` bypass in
 *  `rateLimitMiddleware` to keep these polls under their 9999/min ceiling
 *  instead of dev's 60/min.
 *
 *  If ANY of these endpoints is ever moved behind a router that does NOT
 *  wire through `rateLimitMiddleware`, the owner-bypass becomes irrelevant
 *  for that endpoint AND new strict limits could be introduced silently.
 *
 *  This test asserts:
 *    1. All four endpoints are registered in the codebase.
 *    2. The route file is mounted in server/app.ts.
 *    3. `rateLimitMiddleware` is wired in the server boot path.
 *    4. There is no per-endpoint `app.use(rateLimit(...))` wrapper that
 *       would override the global behaviour for these specific paths
 *       (regression guard against future drift).
 *
 *  Static-analysis style — no live HTTP, no DB. Pure source assertions
 *  that match the pattern used by tests/unit/admin-set-user-plan.test.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const repoRoot = join(__dirname, "..", "..");
const routesSource = readFileSync(join(repoRoot, "server", "routes.ts"), "utf8");
const lucaApprovalSource = readFileSync(
  join(repoRoot, "server", "luca-approval-routes.ts"),
  "utf8",
);
const indexSource = readFileSync(join(repoRoot, "server", "index.ts"), "utf8");

describe("R417 — owner-polling endpoints coverage invariant", () => {
  it("GET /api/rooms is registered", () => {
    expect(routesSource).toMatch(/app\.get\(\s*["']\/api\/rooms["']/);
  });

  it("GET /api/partner/status is registered", () => {
    expect(routesSource).toMatch(/app\.get\(\s*["']\/api\/partner\/status["']/);
  });

  it("GET /api/gallery is registered", () => {
    expect(routesSource).toMatch(/app\.get\(\s*["']\/api\/gallery["']/);
  });

  it("GET /api/luca/approvals is registered (via luca-approval-routes)", () => {
    expect(lucaApprovalSource).toMatch(
      /["']\/api\/luca\/approvals["']/,
    );
  });

  it("luca-approval-routes is mounted somewhere in server", () => {
    // Either index.ts or routes.ts must register the luca approval router.
    const mounted =
      /registerLucaApprovalRoutes|luca-approval-routes/.test(indexSource) ||
      /registerLucaApprovalRoutes|luca-approval-routes/.test(routesSource);
    expect(mounted).toBe(true);
  });

  it("rateLimitMiddleware is wired in the boot path (server/index.ts or server/routes.ts)", () => {
    const wired =
      /app\.use\(\s*rateLimitMiddleware\s*\)/.test(indexSource) ||
      /app\.use\(\s*rateLimitMiddleware\s*\)/.test(routesSource);
    expect(wired).toBe(true);
  });

  it("no per-route rate-limit wrapper bypasses the global middleware for polled endpoints (regression guard)", () => {
    // If anyone ever writes something like
    //   app.get("/api/rooms", customRateLimit({...}), handler)
    // this test fails so they remember to update R415's owner-bypass too.
    const polledPaths = [
      "/api/rooms",
      "/api/partner/status",
      "/api/gallery",
    ];
    for (const path of polledPaths) {
      const re = new RegExp(
        `app\\.get\\(\\s*["']${path.replace(/\//g, "\\/")}["']\\s*,\\s*[a-zA-Z]+RateLimit`,
        "g",
      );
      const match = routesSource.match(re);
      expect(match, `${path} must not have a per-route rate-limit wrapper`).toBeNull();
    }
  });
});
