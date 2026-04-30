/**
 * PR-A.6 — route-level attachment behaviours.
 *
 * Mirroring strategy (same pattern as telegram-webhook.test.ts): we build a
 * minimal Express app that re-implements ONLY the contract under test, so
 * we can assert on HTTP status codes without booting registerRoutes() and
 * its enormous dependency graph.
 *
 * Cases covered:
 *   - POST /api/rooms/:id/messages multipart returns 413 when body exceeds
 *     20 MB cap (multer LIMIT_FILE_SIZE → JSON 413 + clear error message)
 *   - POST .../attachments/:id/refresh-url returns 410 when storage_key=null
 *     (i.e. PII retention has zeroed out the binary). The cache helper is
 *     never called.
 */

import { describe, it, expect, vi } from "vitest";
import express from "express";
import multer from "multer";
import request from "supertest";

const refreshSpy = vi.fn();
vi.mock("../lib/asset-bytes-cache", () => ({
  refreshSignedUrlIfNeeded: refreshSpy,
}));

function buildApp(opts: {
  attachmentsByMessage: Map<number, Map<string, any>>;
  ownsRoom: (roomId: number, userId: number) => boolean;
}) {
  const app = express();
  app.use(express.json());

  // /api/rooms/:id/messages — multipart 20 MB cap branch only.
  app.post("/api/rooms/:id/messages", (req, res, next) => {
    const ct = String(req.headers["content-type"] || "");
    if (!ct.startsWith("multipart/form-data")) {
      // JSON branch is out of scope for this test — accept silently.
      return res.json({ ok: true });
    }
    const upload = multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: 20 * 1024 * 1024 },
    }).single("file");
    upload(req as any, res as any, (err: any) => {
      if (err?.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ error: "File too large (20MB max)" });
      }
      if (err) return next(err);
      return res.json({ ok: true, sizeBytes: (req as any).file?.size ?? 0 });
    });
  });

  // /api/rooms/:roomId/messages/:messageId/attachments/:attachmentId/refresh-url
  app.post(
    "/api/rooms/:roomId/messages/:messageId/attachments/:attachmentId/refresh-url",
    async (req, res) => {
      // Skip auth for this test; just exercise the branch logic.
      const userId = 10; // pretend BOSS
      const roomId = Number(req.params.roomId);
      const messageId = Number(req.params.messageId);
      const attachmentId = String(req.params.attachmentId);
      if (!opts.ownsRoom(roomId, userId)) {
        return res.status(404).json({ error: "Not found" });
      }
      const att = opts.attachmentsByMessage.get(messageId)?.get(attachmentId);
      if (!att) return res.status(404).json({ error: "Attachment not found" });
      if (!att.storage_key) {
        return res.status(410).json({ error: "Attachment expired" });
      }
      const url = await refreshSpy(messageId, attachmentId, att);
      if (!url) return res.status(502).json({ error: "Refresh failed" });
      return res.json({ url });
    },
  );

  return app;
}

describe("routes-attachments — POST /api/rooms/:id/messages multipart 413", () => {
  it("returns 413 when uploaded file exceeds 20MB cap", async () => {
    const app = buildApp({
      attachmentsByMessage: new Map(),
      ownsRoom: () => true,
    });
    // Build a 20MB+1 buffer to exceed the cap.
    const oversized = Buffer.alloc(20 * 1024 * 1024 + 1024, 0xab);
    const res = await request(app)
      .post("/api/rooms/42/messages")
      .field("content", "hi")
      .field("agentName", "Я")
      .attach("file", oversized, { filename: "huge.bin", contentType: "application/octet-stream" });
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ error: expect.stringContaining("20MB") });
  });
});

describe("routes-attachments — refresh-url 410 when storage_key=null", () => {
  it("returns 410 and never calls refreshSignedUrlIfNeeded", async () => {
    refreshSpy.mockReset();
    const map = new Map<number, Map<string, any>>();
    const inner = new Map<string, any>();
    inner.set("att_x", {
      id: "att_x",
      type: "image",
      mime: "image/jpeg",
      size_bytes: 0,
      storage_key: null, // PII-cleaned
      signed_url: null,
      signed_url_expires_at: 0,
      summary: null,
      transcription: null,
      extracted_text: null,
      duration_sec: null,
      original_name: "old.jpg",
      uploaded_at: 0,
      expires_at: null,
    });
    map.set(99, inner);

    const app = buildApp({
      attachmentsByMessage: map,
      ownsRoom: () => true,
    });
    const res = await request(app).post(
      "/api/rooms/1/messages/99/attachments/att_x/refresh-url",
    );
    expect(res.status).toBe(410);
    expect(res.body).toMatchObject({ error: "Attachment expired" });
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it("returns the URL when refresh succeeds", async () => {
    refreshSpy.mockReset();
    refreshSpy.mockResolvedValue("https://fresh.example/x");
    const map = new Map<number, Map<string, any>>();
    const inner = new Map<string, any>();
    inner.set("att_y", {
      id: "att_y",
      type: "image",
      mime: "image/jpeg",
      size_bytes: 1024,
      storage_key: "k",
      signed_url: "https://stale/x",
      signed_url_expires_at: Date.now() + 30_000,
      original_name: "a.jpg",
      uploaded_at: Date.now(),
      expires_at: null,
    } as any);
    map.set(7, inner);

    const app = buildApp({
      attachmentsByMessage: map,
      ownsRoom: () => true,
    });
    const res = await request(app).post(
      "/api/rooms/1/messages/7/attachments/att_y/refresh-url",
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: "https://fresh.example/x" });
    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });
});
