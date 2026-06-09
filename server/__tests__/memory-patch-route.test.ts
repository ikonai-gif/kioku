/**
 * Brick 1.1 + M1 fix — PATCH /api/memories/:id (owner edits own memory),
 * with honesty-layer guard: verified=true memories are immutable.
 *
 * Deterministic: no DB. Mounts a bare Express app with a self-contained
 * copy of the route's validation/scoping/guard contract and mocked storage.
 * Verifies: 401 unauth, 400 empty/invalid, 404 not-found/not-owned,
 * 409 verified-immutable, 200 happy path, per-user scope passed to storage.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";

const updateMemory = vi.fn();
const getMemory = vi.fn();
let currentUser: number | null = 10;

// Mirror of the route handler shipped in server/routes.ts (kept in sync).
function mountApp() {
  const app = express();
  app.use(express.json());
  app.patch("/api/memories/:id", async (req, res) => {
    const userId = currentUser;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const body = (req.body ?? {}) as { content?: unknown; importance?: unknown };
    const patch: { content?: string; importance?: number } = {};
    if (typeof body.content === "string" && body.content.trim()) patch.content = body.content.trim();
    if (typeof body.importance === "number" && body.importance >= 0 && body.importance <= 1) patch.importance = body.importance;
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: "Nothing to update (content or importance required)" });
    const existing = await getMemory(Number(req.params.id), userId);
    if (!existing) return res.status(404).json({ error: "Not found" });
    if (existing.verified === true) {
      return res.status(409).json({ error: "Memory is verified and immutable; delete and recreate to change it." });
    }
    const updated = await updateMemory(Number(req.params.id), userId, patch);
    if (!updated) return res.status(404).json({ error: "Not found" });
    res.json(updated);
  });
  return app;
}

describe("PATCH /api/memories/:id", () => {
  beforeEach(() => {
    updateMemory.mockReset(); getMemory.mockReset(); currentUser = 10;
    getMemory.mockResolvedValue({ id: 5, userId: 10, verified: false });
  });

  it("401 when not authenticated", async () => {
    currentUser = null;
    await request(mountApp()).patch("/api/memories/5").send({ content: "x" }).expect(401);
    expect(updateMemory).not.toHaveBeenCalled();
  });

  it("400 when nothing to update", async () => {
    await request(mountApp()).patch("/api/memories/5").send({}).expect(400);
    expect(updateMemory).not.toHaveBeenCalled();
  });

  it("400 when importance out of range and no content", async () => {
    await request(mountApp()).patch("/api/memories/5").send({ importance: 2 }).expect(400);
    expect(updateMemory).not.toHaveBeenCalled();
  });

  it("404 when memory not found / not owned by user", async () => {
    getMemory.mockResolvedValue(undefined);
    await request(mountApp()).patch("/api/memories/5").send({ content: "hello" }).expect(404);
    expect(updateMemory).not.toHaveBeenCalled();
  });

  it("409 when memory is verified (immutable honesty-layer fact)", async () => {
    getMemory.mockResolvedValue({ id: 5, userId: 10, verified: true });
    await request(mountApp()).patch("/api/memories/5").send({ content: "tampered" }).expect(409);
    expect(updateMemory).not.toHaveBeenCalled();
  });

  it("200 updates content (trimmed) and passes per-user scope", async () => {
    updateMemory.mockResolvedValue({ id: 5, content: "hello", userId: 10 });
    const res = await request(mountApp()).patch("/api/memories/5").send({ content: "  hello  " }).expect(200);
    expect(res.body.content).toBe("hello");
    expect(updateMemory).toHaveBeenCalledWith(5, 10, { content: "hello" });
  });

  it("200 updates importance within range", async () => {
    updateMemory.mockResolvedValue({ id: 5, importance: 0.8, userId: 10 });
    await request(mountApp()).patch("/api/memories/5").send({ importance: 0.8 }).expect(200);
    expect(updateMemory).toHaveBeenCalledWith(5, 10, { importance: 0.8 });
  });
});
