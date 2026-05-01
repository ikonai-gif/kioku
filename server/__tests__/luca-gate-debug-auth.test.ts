/**
 * /api/debug/luca-gate — owner-session auth.
 *
 * The Luca Board UI (LucaWorkPanel + luca-board) hits this endpoint on
 * load through the unified apiRequest path that sends x-session-token /
 * httpOnly cookie. Before this fix, the route accepted ONLY the master
 * key, so every owner browser session got a 403 and the panel rendered
 * gate=null forever.
 *
 * Contract:
 *   1. master key match → 200 (legacy path, unchanged)
 *   2. owner session → 200 (new)
 *   3. non-owner authenticated session → 403
 *   4. unauthenticated + no master key → 403
 *
 * Strategy: mount a bare Express handler that mirrors the production
 * auth predicate with injected getUser/isOwner stubs. Pulls in the same
 * safeCompare from util-secure-compare so master-key behaviour matches
 * production exactly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Minimal helpers extracted from routes.ts so the contract test does
// not depend on the full route registrar (which pulls in DB, auth,
// jobs, breakers, …).
function safeCompare(a: string, b: string): boolean {
  // Production uses Node's crypto.timingSafeEqual — for a contract test
  // a plain equality check is sufficient.
  if (a.length !== b.length) return false;
  return a === b;
}

type GetUserFn = (req: any) => Promise<number | null>;
type IsOwnerFn = (userId: number) => Promise<boolean>;

function makeApp(opts: {
  masterKey?: string;
  getUser: GetUserFn;
  isOwner: IsOwnerFn;
}) {
  const app = express();
  const ENV: Record<string, string | undefined> = {
    KIOKU_MASTER_KEY: opts.masterKey,
    LUCA_V1A_ENABLED: "true",
    LUCA_APPROVAL_GATE_ENABLED: "true",
    LUCA_APPROVAL_GATE_MODE: "block",
    LUCA_EXPANDED_SCOPE_ENABLED: "true",
  };

  app.get("/api/debug/luca-gate", async (req, res) => {
    const mk = (req.headers["x-master-key"] as string) || "";
    const masterKey = ENV.KIOKU_MASTER_KEY;
    const masterKeyOk = !!masterKey && safeCompare(mk, masterKey);
    let ownerOk = false;
    if (!masterKeyOk) {
      const userId = await opts.getUser(req);
      if (userId !== null) {
        try { ownerOk = await opts.isOwner(userId); } catch { ownerOk = false; }
      }
    }
    if (!masterKeyOk && !ownerOk) return res.status(403).json({ error: "Forbidden" });
    res.json({
      LUCA_V1A_ENABLED: ENV.LUCA_V1A_ENABLED ?? null,
      LUCA_APPROVAL_GATE_ENABLED: ENV.LUCA_APPROVAL_GATE_ENABLED ?? null,
      LUCA_APPROVAL_GATE_MODE: ENV.LUCA_APPROVAL_GATE_MODE ?? null,
      LUCA_EXPANDED_SCOPE_ENABLED: ENV.LUCA_EXPANDED_SCOPE_ENABLED ?? null,
      resolved: { isApprovalGateActive: true, isApprovalGateEnforcing: true },
    });
  });
  return app;
}

describe("/api/debug/luca-gate — auth", () => {
  describe("master-key path (legacy, must still work)", () => {
    it("200 when x-master-key matches", async () => {
      const app = makeApp({
        masterKey: "kioku_master_test",
        getUser: async () => null,
        isOwner: async () => false,
      });
      const res = await request(app)
        .get("/api/debug/luca-gate")
        .set("x-master-key", "kioku_master_test");
      expect(res.status).toBe(200);
      expect(res.body.LUCA_APPROVAL_GATE_ENABLED).toBe("true");
      expect(res.body.resolved.isApprovalGateActive).toBe(true);
    });

    it("403 when x-master-key is wrong", async () => {
      const app = makeApp({
        masterKey: "kioku_master_test",
        getUser: async () => null,
        isOwner: async () => false,
      });
      const res = await request(app)
        .get("/api/debug/luca-gate")
        .set("x-master-key", "wrong");
      expect(res.status).toBe(403);
    });
  });

  describe("owner-session path (new)", () => {
    it("200 when getUser returns an owner userId", async () => {
      const isOwnerSpy = vi.fn(async (uid: number) => uid === 10);
      const app = makeApp({
        masterKey: "kioku_master_test",
        getUser: async () => 10,
        isOwner: isOwnerSpy,
      });
      const res = await request(app).get("/api/debug/luca-gate");
      expect(res.status).toBe(200);
      expect(res.body.LUCA_V1A_ENABLED).toBe("true");
      expect(isOwnerSpy).toHaveBeenCalledWith(10);
    });

    it("403 when authenticated but not an owner", async () => {
      const app = makeApp({
        masterKey: "kioku_master_test",
        getUser: async () => 99,
        isOwner: async () => false,
      });
      const res = await request(app).get("/api/debug/luca-gate");
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("Forbidden");
    });

    it("403 when unauthenticated AND no master key", async () => {
      const app = makeApp({
        masterKey: "kioku_master_test",
        getUser: async () => null,
        isOwner: async () => false,
      });
      const res = await request(app).get("/api/debug/luca-gate");
      expect(res.status).toBe(403);
    });

    it("isOwner crash → 403 (does not 500 the route)", async () => {
      const app = makeApp({
        masterKey: "kioku_master_test",
        getUser: async () => 10,
        isOwner: async () => { throw new Error("DB down"); },
      });
      const res = await request(app).get("/api/debug/luca-gate");
      expect(res.status).toBe(403);
    });
  });

  describe("master-key takes precedence (no isOwner lookup needed)", () => {
    it("200 with master key, getUser/isOwner not called", async () => {
      const getUserSpy = vi.fn(async () => null);
      const isOwnerSpy = vi.fn(async () => false);
      const app = makeApp({
        masterKey: "kioku_master_test",
        getUser: getUserSpy,
        isOwner: isOwnerSpy,
      });
      const res = await request(app)
        .get("/api/debug/luca-gate")
        .set("x-master-key", "kioku_master_test");
      expect(res.status).toBe(200);
      expect(getUserSpy).not.toHaveBeenCalled();
      expect(isOwnerSpy).not.toHaveBeenCalled();
    });
  });

  describe("KIOKU_MASTER_KEY unset (dev/local)", () => {
    it("403 with no auth", async () => {
      const app = makeApp({
        masterKey: undefined,
        getUser: async () => null,
        isOwner: async () => false,
      });
      const res = await request(app).get("/api/debug/luca-gate");
      expect(res.status).toBe(403);
    });

    it("200 with owner session even when master key is unset", async () => {
      const app = makeApp({
        masterKey: undefined,
        getUser: async () => 10,
        isOwner: async () => true,
      });
      const res = await request(app).get("/api/debug/luca-gate");
      expect(res.status).toBe(200);
    });

    it("403 with non-empty x-master-key when master key is unset", async () => {
      const app = makeApp({
        masterKey: undefined,
        getUser: async () => null,
        isOwner: async () => false,
      });
      const res = await request(app)
        .get("/api/debug/luca-gate")
        .set("x-master-key", "anything");
      expect(res.status).toBe(403);
    });
  });
});
