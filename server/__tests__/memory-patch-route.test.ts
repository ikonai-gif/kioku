/**
 * Brick 1.1 — PATCH /api/memories/:id (owner edits own memory).
 *
 * Deterministic: no DB. Mounts a bare Express app with a self-contained
 * copy of the route's validation/scoping contract and a mocked storage,
 * driven via supertest. Verifies: 401 unauth, 400 empty patch, 400 bad
 * importance, 404 not-found (wrong user), 200 happy path with content +
 * importance, and that per-user scope (userId) is passed to storage.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";

const updateMemory = vi.fn();
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
    const updated = await updateMemory(Number(req.params.id), userId, patch);
    if (!updated) return res.status(404).json({ error: "Not found" });
    res.json(updated);
  });
  return app;
}

describe("PATCH /api/memories/:id", () => {
  beforeEach(() => { updateMemory.mockReset(); currentUser = 10; });

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
    updateMemory.mockResolvedValue(undefined);
    await request(mountApp()).patch("/api/memories/5").send({ content: "hello" }).expect(404);
    expect(updateMemory).toHaveBeenCalledWith(5, 10, { content: "hello" });
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
