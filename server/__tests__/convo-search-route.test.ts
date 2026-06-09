/**
 * Brick 1.2 (LUCA-053) — GET /api/conversations/search.
 *
 * Deterministic: no DB. Mounts a bare Express app with a self-contained copy of
 * the route contract (flag gate + auth + validation + per-user storage call) and
 * a mocked storage. Verifies: 503 flag off, 401 unauth, 400 missing q, 200 with
 * results, and that the authed userId is passed to storage (per-user scope).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";

const searchMessages = vi.fn();
let currentUser: number | null = 10;
let flagEnabled = true;

function mountApp() {
  const app = express();
  app.use(express.json());
  app.get("/api/conversations/search", (req, res, next) => {
    if (!flagEnabled) return res.status(503).json({ error: "feature_disabled", feature: "CONVO_SEARCH_ENABLED" });
    next();
  }, async (req, res) => {
    const userId = currentUser;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!q) return res.status(400).json({ error: "Query param q is required" });
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
    const results = await searchMessages(userId, q, limit);
    res.json({ data: results });
  });
  return app;
}

describe("GET /api/conversations/search", () => {
  beforeEach(() => { searchMessages.mockReset(); currentUser = 10; flagEnabled = true; });

  it("503 when feature flag disabled", async () => {
    flagEnabled = false;
    await request(mountApp()).get("/api/conversations/search?q=hi").expect(503);
    expect(searchMessages).not.toHaveBeenCalled();
  });

  it("401 when not authenticated", async () => {
    currentUser = null;
    await request(mountApp()).get("/api/conversations/search?q=hi").expect(401);
    expect(searchMessages).not.toHaveBeenCalled();
  });

  it("400 when q is missing", async () => {
    await request(mountApp()).get("/api/conversations/search").expect(400);
    expect(searchMessages).not.toHaveBeenCalled();
  });

  it("400 when q is blank", async () => {
    await request(mountApp()).get("/api/conversations/search?q=%20%20").expect(400);
    expect(searchMessages).not.toHaveBeenCalled();
  });

  it("200 returns results and passes per-user scope + limit", async () => {
    searchMessages.mockResolvedValue([{ messageId: 7, roomId: 3, snippet: "hello world", createdAt: 123 }]);
    const res = await request(mountApp()).get("/api/conversations/search?q=hello&limit=5").expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].messageId).toBe(7);
    expect(searchMessages).toHaveBeenCalledWith(10, "hello", 5);
  });

  it("200 clamps limit to default when invalid", async () => {
    searchMessages.mockResolvedValue([]);
    await request(mountApp()).get("/api/conversations/search?q=x&limit=abc").expect(200);
    expect(searchMessages).toHaveBeenCalledWith(10, "x", 20);
  });
});
