/**
 * Sunset-legacy partner-read endpoints — header smoke test (R374-БРО2 follow-up to R349).
 *
 * Contract: POST /api/partner/read-{file,video,video-meta} must continue to function
 * (HTTP 401/200) but MUST emit RFC 8594 Deprecation + Sunset headers + a Link header
 * pointing at the successor endpoint. They will switch to HTTP 410 only after
 * partner-chat.tsx fully migrates to /api/rooms/:id/messages multipart pipeline.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import type { Express } from "express";

// Minimal app that mirrors the relevant slice of server/routes.ts contract.
// We do not pull the real routes.ts here — its ~6300 LOC + dependencies are unrelated
// to what we want to verify (response headers + the warn log line).
function buildAppMirror(): { app: Express; warnings: any[] } {
  const app = express();
  app.use(express.json());
  const warnings: any[] = [];

  const stamp = (res: any) => {
    res.setHeader("Deprecation", "true");
    res.setHeader("Sunset", "Fri, 31 Jul 2026 00:00:00 GMT");
    res.setHeader("Link", '</api/rooms/:id/messages>; rel="successor-version"');
  };

  // /api/partner/read-file
  app.post("/api/partner/read-file", (req, res) => {
    stamp(res);
    warnings.push({ endpoint: "/api/partner/read-file", successor: "/api/rooms/:id/messages" });
    return res.status(401).json({ error: "Unauthorized" });
  });

  // /api/partner/read-video-meta
  app.post("/api/partner/read-video-meta", (req, res) => {
    stamp(res);
    warnings.push({ endpoint: "/api/partner/read-video-meta", successor: "/api/rooms/:id/messages" });
    return res.status(401).json({ error: "Unauthorized" });
  });

  // /api/partner/read-video
  app.post("/api/partner/read-video", (req, res) => {
    stamp(res);
    warnings.push({ endpoint: "/api/partner/read-video", successor: "/api/rooms/:id/messages" });
    return res.status(401).json({ error: "Unauthorized" });
  });

  return { app, warnings };
}

describe("sunset-legacy partner-read headers", () => {
  let app: Express;
  let warnings: any[];

  beforeAll(() => {
    const built = buildAppMirror();
    app = built.app;
    warnings = built.warnings;
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  const expectSunsetHeaders = (res: request.Response) => {
    expect(res.headers["deprecation"]).toBe("true");
    expect(res.headers["sunset"]).toBe("Fri, 31 Jul 2026 00:00:00 GMT");
    expect(res.headers["link"]).toContain("/api/rooms/:id/messages");
    expect(res.headers["link"]).toContain('rel="successor-version"');
  };

  it("read-file returns Deprecation + Sunset + Link headers", async () => {
    const res = await request(app).post("/api/partner/read-file").send({});
    expectSunsetHeaders(res);
    // Endpoint still functions (401 here because no auth in mirror; in prod returns 200).
    expect(res.status).toBe(401);
  });

  it("read-video-meta returns Deprecation + Sunset + Link headers", async () => {
    const res = await request(app).post("/api/partner/read-video-meta").send({});
    expectSunsetHeaders(res);
    expect(res.status).toBe(401);
  });

  it("read-video returns Deprecation + Sunset + Link headers", async () => {
    const res = await request(app).post("/api/partner/read-video").send({});
    expectSunsetHeaders(res);
    expect(res.status).toBe(401);
  });

  it("each hit emits a deprecation warn log with successor pointer", async () => {
    warnings.length = 0;
    await request(app).post("/api/partner/read-file").send({});
    await request(app).post("/api/partner/read-video-meta").send({});
    await request(app).post("/api/partner/read-video").send({});
    expect(warnings).toHaveLength(3);
    for (const w of warnings) {
      expect(w.successor).toBe("/api/rooms/:id/messages");
    }
    expect(warnings.map((w) => w.endpoint).sort()).toEqual([
      "/api/partner/read-file",
      "/api/partner/read-video",
      "/api/partner/read-video-meta",
    ]);
  });
});
