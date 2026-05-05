/**
 * R467 — /api/luca/proposals + /api/luca/proposals/:id/decide endpoint tests.
 *
 * Strategy: same pattern as luca-gate-debug-auth.test.ts — mount a minimal
 * Express app that mirrors the production handler logic with injected
 * getUser/isOwner/pool stubs. Avoids pulling in the full route registrar.
 *
 * Contract under test:
 *   GET /api/luca/proposals
 *     - 401 unauthenticated
 *     - 403 non-owner authenticated
 *     - 400 invalid status param
 *     - 200 owner with default status='pending'
 *     - row scoping: WHERE user_id = $userId (verified by stub recv args)
 *   POST /api/luca/proposals/:id/decide
 *     - 401 unauthenticated
 *     - 403 non-owner authenticated
 *     - 400 invalid id / decision / note (too long / non-string / NUL)
 *     - 404 not_found when probe returns []
 *     - 404 not_found when row exists but user_id differs (no leak)
 *     - 409 already_decided when row exists, owned, but status != 'pending'
 *     - 200 happy path: status flips, decided_at set, note saved
 */
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";

type PoolStub = {
  query: ReturnType<typeof vi.fn>;
};

function makeApp(opts: {
  getUser: (req: any) => Promise<number | null>;
  isOwner: (userId: number) => Promise<boolean>;
  pool: PoolStub;
}) {
  const app = express();
  app.use(express.json());

  const asyncHandler = (fn: any) => (req: any, res: any, next: any) =>
    Promise.resolve(fn(req, res, next)).catch(next);

  app.get("/api/luca/proposals", asyncHandler(async (req: any, res: any) => {
    const userId = await opts.getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    if (!(await opts.isOwner(userId))) return res.status(403).json({ error: "Forbidden" });

    const statusParam = typeof req.query.status === "string" ? req.query.status : "pending";
    const VALID_STATUS = new Set(["pending", "approved", "rejected", "applied"]);
    if (!VALID_STATUS.has(statusParam)) {
      return res.status(400).json({ error: "invalid_status", allowed: [...VALID_STATUS] });
    }
    const limitParam = Number(req.query.limit ?? 50);
    const limit = Number.isFinite(limitParam) && limitParam > 0 && limitParam <= 200
      ? Math.floor(limitParam) : 50;

    const r = await opts.pool.query(
      `SELECT ... FROM luca_proposals WHERE user_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT $3`,
      [userId, statusParam, limit],
    );
    res.json({ proposals: r.rows, count: r.rows.length, status: statusParam });
  }));

  app.post("/api/luca/proposals/:id/decide", asyncHandler(async (req: any, res: any) => {
    const userId = await opts.getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    if (!(await opts.isOwner(userId))) return res.status(403).json({ error: "Forbidden" });

    const idParam = Number(req.params.id);
    if (!Number.isFinite(idParam) || idParam <= 0 || !Number.isInteger(idParam)) {
      return res.status(400).json({ error: "invalid_id" });
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const decision = typeof body.decision === "string" ? body.decision : "";
    if (decision !== "approved" && decision !== "rejected") {
      return res.status(400).json({ error: "invalid_decision", allowed: ["approved", "rejected"] });
    }
    let note: string | null = null;
    if (typeof body.note === "string") {
      const trimmed = body.note.trim();
      if (body.note.length > 2000) return res.status(400).json({ error: "note_too_long" });
      if (body.note.includes("\0")) return res.status(400).json({ error: "invalid_chars" });
      note = trimmed.length > 0 ? trimmed : null;
    } else if (body.note !== undefined && body.note !== null) {
      return res.status(400).json({ error: "invalid_note" });
    }

    const upd = await opts.pool.query(
      `UPDATE luca_proposals SET status = $1, decided_at = NOW(), decision_note = $2
        WHERE id = $3 AND user_id = $4 AND status = 'pending' RETURNING ...`,
      [decision, note, idParam, userId],
    );
    if (upd.rows.length === 0) {
      const probe = await opts.pool.query(
        `SELECT id, user_id, status FROM luca_proposals WHERE id = $1 LIMIT 1`,
        [idParam],
      );
      if (probe.rows.length === 0) return res.status(404).json({ error: "not_found" });
      const row = probe.rows[0];
      if (row.user_id !== userId) return res.status(404).json({ error: "not_found" });
      return res.status(409).json({ error: "already_decided", current_status: row.status });
    }
    res.json({ status: "ok", proposal: upd.rows[0] });
  }));

  return app;
}

const ownerId = 10;

describe("GET /api/luca/proposals — auth", () => {
  it("401 when unauthenticated", async () => {
    const pool = { query: vi.fn() };
    const app = makeApp({ getUser: async () => null, isOwner: async () => false, pool });
    const res = await request(app).get("/api/luca/proposals");
    expect(res.status).toBe(401);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("403 when authenticated non-owner", async () => {
    const pool = { query: vi.fn() };
    const app = makeApp({ getUser: async () => 99, isOwner: async () => false, pool });
    const res = await request(app).get("/api/luca/proposals");
    expect(res.status).toBe(403);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe("GET /api/luca/proposals — params", () => {
  it("400 when status is unknown", async () => {
    const pool = { query: vi.fn() };
    const app = makeApp({ getUser: async () => ownerId, isOwner: async () => true, pool });
    const res = await request(app).get("/api/luca/proposals?status=garbage");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_status");
  });

  it("200 with default status=pending and scopes by user_id", async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ id: 1 }] }) };
    const app = makeApp({ getUser: async () => ownerId, isOwner: async () => true, pool });
    const res = await request(app).get("/api/luca/proposals");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("pending");
    expect(res.body.count).toBe(1);
    const args = pool.query.mock.calls[0][1];
    expect(args[0]).toBe(ownerId);
    expect(args[1]).toBe("pending");
  });

  it("200 with explicit status=approved", async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const app = makeApp({ getUser: async () => ownerId, isOwner: async () => true, pool });
    const res = await request(app).get("/api/luca/proposals?status=approved");
    expect(res.status).toBe(200);
    const args = pool.query.mock.calls[0][1];
    expect(args[1]).toBe("approved");
  });

  it("clamps limit to 200 max, defaults to 50 on invalid", async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const app = makeApp({ getUser: async () => ownerId, isOwner: async () => true, pool });
    await request(app).get("/api/luca/proposals?limit=10000");
    // Anything > 200 is treated as invalid → falls back to 50.
    expect(pool.query.mock.calls[0][1][2]).toBe(50);

    pool.query.mockClear();
    await request(app).get("/api/luca/proposals?limit=garbage");
    expect(pool.query.mock.calls[0][1][2]).toBe(50);

    pool.query.mockClear();
    await request(app).get("/api/luca/proposals?limit=25");
    expect(pool.query.mock.calls[0][1][2]).toBe(25);
  });
});

describe("POST /api/luca/proposals/:id/decide — auth", () => {
  it("401 when unauthenticated", async () => {
    const pool = { query: vi.fn() };
    const app = makeApp({ getUser: async () => null, isOwner: async () => false, pool });
    const res = await request(app).post("/api/luca/proposals/1/decide").send({ decision: "approved" });
    expect(res.status).toBe(401);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("403 when non-owner", async () => {
    const pool = { query: vi.fn() };
    const app = makeApp({ getUser: async () => 99, isOwner: async () => false, pool });
    const res = await request(app).post("/api/luca/proposals/1/decide").send({ decision: "approved" });
    expect(res.status).toBe(403);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe("POST /api/luca/proposals/:id/decide — input validation", () => {
  function ownerApp(pool: PoolStub) {
    return makeApp({ getUser: async () => ownerId, isOwner: async () => true, pool });
  }

  it("400 invalid_id when id is not a positive integer", async () => {
    const pool = { query: vi.fn() };
    const app = ownerApp(pool);
    const res = await request(app).post("/api/luca/proposals/abc/decide").send({ decision: "approved" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_id");
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("400 invalid_decision when decision is unknown", async () => {
    const pool = { query: vi.fn() };
    const app = ownerApp(pool);
    const res = await request(app).post("/api/luca/proposals/1/decide").send({ decision: "applied" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_decision");
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("400 invalid_decision when decision missing", async () => {
    const pool = { query: vi.fn() };
    const app = ownerApp(pool);
    const res = await request(app).post("/api/luca/proposals/1/decide").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_decision");
  });

  it("400 note_too_long when note > 2000 chars", async () => {
    const pool = { query: vi.fn() };
    const app = ownerApp(pool);
    const res = await request(app).post("/api/luca/proposals/1/decide")
      .send({ decision: "approved", note: "x".repeat(2001) });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("note_too_long");
  });

  it("400 invalid_chars when note has NUL", async () => {
    const pool = { query: vi.fn() };
    const app = ownerApp(pool);
    const res = await request(app).post("/api/luca/proposals/1/decide")
      .send({ decision: "approved", note: "ok\u0000bad" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_chars");
  });

  it("400 invalid_note when note is non-string non-null", async () => {
    const pool = { query: vi.fn() };
    const app = ownerApp(pool);
    const res = await request(app).post("/api/luca/proposals/1/decide")
      .send({ decision: "approved", note: 42 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_note");
  });
});

describe("POST /api/luca/proposals/:id/decide — db paths", () => {
  function ownerApp(pool: PoolStub) {
    return makeApp({ getUser: async () => ownerId, isOwner: async () => true, pool });
  }

  it("404 not_found when probe returns no row", async () => {
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })  // UPDATE
        .mockResolvedValueOnce({ rows: [] }), // probe SELECT
    };
    const app = ownerApp(pool);
    const res = await request(app).post("/api/luca/proposals/777/decide").send({ decision: "approved" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("404 not_found when row exists but user_id differs (no leak)", async () => {
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 5, user_id: 999, status: "pending" }] }),
    };
    const app = ownerApp(pool);
    const res = await request(app).post("/api/luca/proposals/5/decide").send({ decision: "approved" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
    // Critically: response must NOT reveal the row exists or its actual status.
    expect(res.body).not.toHaveProperty("current_status");
  });

  it("409 already_decided when row exists, owned, but status != pending", async () => {
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 5, user_id: ownerId, status: "approved" }] }),
    };
    const app = ownerApp(pool);
    const res = await request(app).post("/api/luca/proposals/5/decide").send({ decision: "rejected" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("already_decided");
    expect(res.body.current_status).toBe("approved");
  });

  it("200 happy path: returns updated row, conditional UPDATE was scoped", async () => {
    const decidedAt = new Date("2026-05-04T20:00:00Z");
    const pool = {
      query: vi.fn().mockResolvedValueOnce({
        rows: [{ id: 5, status: "approved", decided_at: decidedAt, decision_note: "ok", title: "x", category: "tool" }],
      }),
    };
    const app = ownerApp(pool);
    const res = await request(app).post("/api/luca/proposals/5/decide")
      .send({ decision: "approved", note: "  ok  " });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.proposal.id).toBe(5);

    // Verify the UPDATE was scoped to status='pending' AND user_id=$ownerId.
    const sqlText = pool.query.mock.calls[0][0] as string;
    expect(sqlText).toMatch(/status\s*=\s*'pending'/);
    expect(sqlText).toMatch(/user_id\s*=\s*\$4/);
    const args = pool.query.mock.calls[0][1] as any[];
    expect(args[0]).toBe("approved");
    expect(args[1]).toBe("ok"); // trimmed note
    expect(args[2]).toBe(5);
    expect(args[3]).toBe(ownerId);
  });

  it("happy path with no note: passes null to UPDATE", async () => {
    const pool = {
      query: vi.fn().mockResolvedValueOnce({
        rows: [{ id: 5, status: "rejected", decided_at: new Date(), decision_note: null, title: "x", category: "tool" }],
      }),
    };
    const app = makeApp({ getUser: async () => ownerId, isOwner: async () => true, pool });
    const res = await request(app).post("/api/luca/proposals/5/decide")
      .send({ decision: "rejected" });
    expect(res.status).toBe(200);
    const args = pool.query.mock.calls[0][1] as any[];
    expect(args[1]).toBeNull();
  });
});
