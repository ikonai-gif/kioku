/**
 * W6 Item 2b — Sync 503 + Retry-After on CircuitOpenError
 * W7 NEW-1    — `send503(res, err)` helper unification
 *
 * The full `registerRoutes(httpServer, app)` pulls ~40 modules (storage,
 * drizzle, redis, stripe, oauth, ws, deliberation, etc.). Mounting all of
 * that to test a single catch-block mapping is net-negative. Instead:
 *
 *   1. Contract — mount a tiny Express app that exercises the `send503`
 *      helper directly (both when called from an endpoint catch and from
 *      the global error middleware). Fire CircuitOpenError at each, assert
 *      the wire response: 503 + Retry-After + JSON body.
 *
 *   2. Helper unit tests — send503 default body, override options, and
 *      dynamic Retry-After derived from `err.retryAfterMs`.
 *
 *   3. Source — readFileSync on routes.ts to pin:
 *      - CircuitOpenError + send503 are imported
 *      - the /deliberate endpoint catch calls send503
 *      - the demo-chat catch calls send503
 *      - the global middleware calls send503
 */

import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CircuitOpenError } from "../lib/openai-client";
import { send503 } from "../lib/http-errors";

// ── Contract test: minimal app exercising both mappings via send503 ──
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
        return send503(res, e);
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
      return send503(res, err);
    }
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}

describe("W6 2b / W7 NEW-1 — 503 + Retry-After contract shape", () => {
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

// ── W7 NEW-1 — helper unit tests ──
describe("W7 NEW-1 — send503 helper unit", () => {
  function appWith(handler: (res: express.Response) => void) {
    const app = express();
    app.get("/x", (_req, res) => handler(res));
    return app;
  }

  it("default body + Retry-After: 30 when opts omitted and err is plain Error", async () => {
    const app = appWith((res) => {
      send503(res, new Error("upstream sad"));
    });
    const res = await request(app).get("/x");
    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBe("30");
    expect(res.body).toEqual({
      error: "service_unavailable",
      reason: "upstream_circuit_open",
      retry_after_ms: 30_000,
    });
  });

  it("derives Retry-After from CircuitOpenError.retryAfterMs when present", async () => {
    const app = appWith((res) => {
      send503(res, new CircuitOpenError("x", 45_000));
    });
    const res = await request(app).get("/x");
    expect(res.headers["retry-after"]).toBe("45");
    expect(res.body.retry_after_ms).toBe(45_000);
  });

  it("explicit opts.retryAfterSec wins over err.retryAfterMs", async () => {
    const app = appWith((res) => {
      send503(res, new CircuitOpenError("x", 45_000), { retryAfterSec: 10 });
    });
    const res = await request(app).get("/x");
    expect(res.headers["retry-after"]).toBe("10");
    expect(res.body.retry_after_ms).toBe(10_000);
  });

  it("opts.reason overrides default + opts.extra merges into body", async () => {
    const app = appWith((res) => {
      send503(res, null, {
        reason: "upstream_timeout",
        extra: { trace_id: "abc123" },
      });
    });
    const res = await request(app).get("/x");
    expect(res.body).toEqual({
      error: "service_unavailable",
      reason: "upstream_timeout",
      retry_after_ms: 30_000,
      trace_id: "abc123",
    });
  });
});

// ── Source contract: assert routes.ts routes through send503 ──
describe("W7 NEW-1 — source contract: routes.ts calls send503 at each CircuitOpenError catch", () => {
  const src = readFileSync(
    join(__dirname, "..", "routes.ts"),
    "utf8",
  );

  it("imports isCircuitOpenError + send503 from ./lib/http-errors", () => {
    // W7 P2.1 §9: the triple-guard pattern was deduped into the
    // isCircuitOpenError helper alongside send503. Both now import from
    // the same http-errors module.
    expect(src).toMatch(
      /import\s*\{[^}]*\bisCircuitOpenError\b[^}]*\}\s*from\s*["']\.\/lib\/http-errors["']/,
    );
    expect(src).toMatch(
      /import\s*\{[^}]*\bsend503\b[^}]*\}\s*from\s*["']\.\/lib\/http-errors["']/,
    );
  });

  it("hand-rolled res.status(503) near CircuitOpenError is gone", () => {
    // Grep-equivalent: look for any `status(503)` preceded (within ~500 chars)
    // by CircuitOpenError / CIRCUIT_OPEN. Should be empty post-migration —
    // every such site now funnels through send503.
    const matches = [...src.matchAll(/status\(\s*503\s*\)/g)];
    for (const m of matches) {
      const idx = m.index ?? 0;
      const window = src.slice(Math.max(0, idx - 500), idx + 200);
      expect(
        /CircuitOpenError|CIRCUIT_OPEN/.test(window),
        `Stale hand-rolled 503 near CircuitOpenError at offset ${idx}`,
      ).toBe(false);
    }
  });

  it("the /deliberate endpoint catch calls send503", () => {
    const endpointIdx = src.indexOf('app.post("/api/rooms/:id/deliberate"');
    expect(endpointIdx, "/deliberate endpoint not found").toBeGreaterThan(-1);
    const nextEndpoint = src.indexOf("app.post(", endpointIdx + 1);
    const window = src.slice(endpointIdx, nextEndpoint > -1 ? nextEndpoint : endpointIdx + 4000);
    expect(window).toMatch(/isCircuitOpenError\(|instanceof\s+CircuitOpenError|CIRCUIT_OPEN/);
    expect(window).toMatch(/send503\(\s*res\b/);
  });

  it("the /api/demo/chat catch calls send503", () => {
    const endpointIdx = src.indexOf('"/api/demo/chat"');
    expect(endpointIdx, "/api/demo/chat endpoint not found").toBeGreaterThan(-1);
    const nextEndpoint = src.indexOf("app.post(", endpointIdx + 1);
    const window = src.slice(endpointIdx, nextEndpoint > -1 ? nextEndpoint : endpointIdx + 6000);
    expect(window).toMatch(/isCircuitOpenError\(|instanceof\s+CircuitOpenError|CIRCUIT_OPEN/);
    expect(window).toMatch(/send503\(\s*res\b/);
  });

  it("the global error middleware also calls send503", () => {
    const globalIdx = src.search(/app\.use\(\(\s*err:\s*any[\s\S]*?ValidationError/);
    expect(globalIdx, "global error handler not found").toBeGreaterThan(-1);
    const window = src.slice(globalIdx, globalIdx + 1500);
    expect(window).toMatch(/isCircuitOpenError\(|instanceof\s+CircuitOpenError|CIRCUIT_OPEN/);
    expect(window).toMatch(/send503\(\s*res\b/);
  });
});
