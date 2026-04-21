/**
 * W6 Item 2b — Sync 503 + Retry-After on CircuitOpenError
 *
 * The full `registerRoutes(httpServer, app)` pulls ~40 modules (storage,
 * drizzle, redis, stripe, oauth, ws, deliberation, etc.). Mounting all of
 * that to test a single catch-block mapping is net-negative. Instead:
 *
 *   1. Contract — mount a tiny Express app that mirrors the exact mapping
 *      shape from routes.ts (both the inline endpoint catch and the global
 *      error handler). Fire CircuitOpenError at each, assert the wire
 *      response: 503 + Retry-After: "30" + JSON body.
 *
 *   2. Source — readFileSync on routes.ts to pin:
 *      - CircuitOpenError is imported
 *      - the inline check lives in the /deliberate endpoint catch
 *      - the global middleware also has the check
 *      - both return 503 + Retry-After: "30" + the exact JSON shape
 */

import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CircuitOpenError } from "../lib/openai-client";

// ── Contract test: minimal app exercising both mappings ──
function makeContractApp() {
  const app = express();
  app.use(express.json());

  // Mirror the inline catch from /api/rooms/:id/deliberate
  app.post("/inline", (_req, res) => {
    try {
      throw new CircuitOpenError("test", 30_000);
    } catch (err) {
      const e = err as any;
      if (e instanceof CircuitOpenError || e?.name === "CircuitOpenError" || e?.code === "CIRCUIT_OPEN") {
        res.setHeader("Retry-After", "30");
        return res.status(503).json({
          error: "service_unavailable",
          reason: "upstream_circuit_open",
          retry_after_ms: 30_000,
        });
      }
      const message = (err as Error).message;
      res.status(500).json({ error: message });
    }
  });

  // Mirror the global error middleware
  app.post("/bubble", (_req, _res, next) => {
    next(new CircuitOpenError("bubbled", 30_000));
  });
  app.use((err: any, _req: any, res: any, _next: any) => {
    if (err instanceof CircuitOpenError || err?.name === "CircuitOpenError" || err?.code === "CIRCUIT_OPEN") {
      res.setHeader("Retry-After", "30");
      return res.status(503).json({
        error: "service_unavailable",
        reason: "upstream_circuit_open",
        retry_after_ms: 30_000,
      });
    }
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}

describe("W6 2b — 503 + Retry-After contract shape", () => {
  it("inline catch maps CircuitOpenError → 503 + Retry-After: 30 + body", async () => {
    const app = makeContractApp();
    const res = await request(app).post("/inline").send({});
    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBe("30");
    expect(res.body).toEqual({
      error: "service_unavailable",
      reason: "upstream_circuit_open",
      retry_after_ms: 30_000,
    });
  });

  it("global middleware maps CircuitOpenError → 503 + Retry-After: 30 + body", async () => {
    const app = makeContractApp();
    const res = await request(app).post("/bubble").send({});
    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBe("30");
    expect(res.body).toEqual({
      error: "service_unavailable",
      reason: "upstream_circuit_open",
      retry_after_ms: 30_000,
    });
  });
});

// ── Source contract: assert routes.ts has both mappings ──
describe("W6 2b — source contract: routes.ts wires CircuitOpenError → 503", () => {
  const src = readFileSync(
    join(__dirname, "..", "routes.ts"),
    "utf8",
  );

  it("imports CircuitOpenError from ./lib/openai-client", () => {
    expect(src).toMatch(
      /import\s*\{[^}]*\bCircuitOpenError\b[^}]*\}\s*from\s*["']\.\/lib\/openai-client["']/,
    );
  });

  it("the /deliberate endpoint catch maps CircuitOpenError → 503 + Retry-After: 30", () => {
    // Find the /deliberate endpoint.
    const endpointIdx = src.indexOf('app.post("/api/rooms/:id/deliberate"');
    expect(endpointIdx, "/deliberate endpoint not found").toBeGreaterThan(-1);
    // Window: from endpoint to next app.post (comfortably covers the catch).
    const nextEndpoint = src.indexOf("app.post(", endpointIdx + 1);
    const window = src.slice(endpointIdx, nextEndpoint > -1 ? nextEndpoint : endpointIdx + 4000);
    expect(window).toMatch(/instanceof\s+CircuitOpenError|CIRCUIT_OPEN/);
    expect(window).toMatch(/setHeader\(\s*["']Retry-After["']\s*,\s*["']30["']\s*\)/);
    expect(window).toMatch(/status\(\s*503\s*\)/);
    expect(window).toMatch(/service_unavailable/);
    expect(window).toMatch(/upstream_circuit_open/);
    expect(window).toMatch(/retry_after_ms:\s*30_?000/);
  });

  it("the global error middleware also maps CircuitOpenError → 503 + Retry-After: 30", () => {
    // Find the global error handler (4-arg middleware signature).
    const globalIdx = src.search(/app\.use\(\(\s*err:\s*any[\s\S]*?ValidationError/);
    expect(globalIdx, "global error handler not found").toBeGreaterThan(-1);
    // Window to the closing of the handler (next '});' should be close enough;
    // use a generous slice to be safe.
    const window = src.slice(globalIdx, globalIdx + 1500);
    expect(window).toMatch(/instanceof\s+CircuitOpenError|CIRCUIT_OPEN/);
    expect(window).toMatch(/setHeader\(\s*["']Retry-After["']\s*,\s*["']30["']\s*\)/);
    expect(window).toMatch(/status\(\s*503\s*\)/);
    expect(window).toMatch(/service_unavailable/);
    expect(window).toMatch(/upstream_circuit_open/);
    expect(window).toMatch(/retry_after_ms:\s*30_?000/);
  });
});
