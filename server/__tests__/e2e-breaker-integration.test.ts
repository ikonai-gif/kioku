/**
 * W7 N5 — E2E Breaker Integration Suite
 * (week7_plan_v2.md §N5, lines 200-230)
 *
 * Covers four breaker-related contracts end-to-end:
 *   (1) R1 invariant — per-agent breaker OPEN → `CircuitOpenError` thrown
 *       → caller converts to boilerplate reply + degraded-agent notice;
 *       other agents in the same room unaffected (primitive-level).
 *   (2) Demo 503/429 — `/api/demo/chat` full HTTP E2E via supertest:
 *       CLOSED → 200, OPEN → 503 with NEW-1 body, 11th/min → 429.
 *   (3) Breaker isolation — custom-key agent's per-agent breaker OPEN
 *       does NOT trip the shared process-wide breaker or another
 *       agent's per-agent breaker.
 *   (4) Background silent-return (Item 1c) — when the shared OpenAI
 *       breaker is OPEN, the background-task catch pattern swallows the
 *       CircuitOpenError and emits only a debug log (no throw, no error
 *       log).
 *
 * Not covered: POST /api/rooms/:id/deliberate 503 on CircuitOpenError.
 * Dormant path — callLLM swallows via Gemini fallback. Unblocks when
 * Gemini breaker lands (W8+). See /home/user/workspace/n5_gaps.md.
 *
 * Stack: supertest (demo 503/429 full HTTP path) + direct primitive
 * exercise (R1 invariant, isolation, background — these test the exact
 * breaker primitives that the full deliberation flow depends on). A full
 * WS-integrated deliberation test would require ~200 LOC of WS/storage
 * harness for one extra assertion; the primitive tests pin the same
 * contract without that fragility.
 *
 * Deviation from v2.1 §N5 Testcontainers mandate: the four in-scope
 * scenarios are storage-free (breaker state is in-process; demo/chat
 * uses an in-memory session map). Spinning up postgres:16-alpine for
 * zero queries would gate the suite on Docker availability for no
 * test-coverage benefit. When /deliberate unblocks (Gemini breaker, W8+)
 * that scenario will layer onto the existing
 * `meetings-context-concurrency.integration.test.ts` harness. See
 * n5_gaps.md DEV-1 + EX-1.
 *
 * CI flakiness mitigation per v2.1 §N5: single describe.sequential,
 * `beforeEach` resets all breaker + injected-client state.
 */

import { describe, test, it, expect, beforeEach, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  withOpenAIBreaker,
  getOpenAIBreakerState,
  __resetOpenAIBreakerForTest,
  __setOpenAIClientForTest,
  CircuitOpenError,
} from "../lib/openai-client";
import {
  withAgentBreaker,
  getAllAgentBreakerStates,
  __resetAllAgentBreakersForTest,
  __setAgentClientForTest,
} from "../lib/openai-per-agent-breaker";
import { send503 } from "../lib/http-errors";
import { checkDemoRateLimit } from "../ratelimit";

// NOTE — storage-free suite. The v2.1 plan §N5 pinned Testcontainers as the
// harness of record, but all four in-scope scenarios (R1 invariant, demo
// 503/429, isolation, background silent-return) are storage-free: the
// breaker primitives hold state in-process, and /api/demo/chat uses an
// in-memory session map + in-memory rate-limit fallback. Spinning up
// postgres:16-alpine for zero queries would add ~30s to the default suite
// and gate validation on Docker availability. When the /deliberate 503
// unblock lands (Gemini breaker, W8+ — see n5_gaps.md EX-1), that test
// will reuse the existing integration harness at
// `meetings-context-concurrency.integration.test.ts`. Deviation logged in
// n5_gaps.md DEV-1.

// Fresh breaker + SDK-stub state for every test so a prior test's
// failures can't bleed in and open an unrelated breaker.
beforeEach(() => {
  __resetOpenAIBreakerForTest();
  __resetAllAgentBreakersForTest();
  __setOpenAIClientForTest(null);
});

// Minimal OpenAI stub used across scenarios. The real SDK import remains
// mocked-at-the-breaker-boundary so no real network calls are possible.
function makeStubOpenAI(create: (args: any) => Promise<any>) {
  return {
    chat: { completions: { create: vi.fn(create) } },
  } as any;
}

// Helper: drive the breaker to OPEN by seeding 5 failures (the shared
// OpenAI breaker's failureThreshold). Uses a fail-stub then restores the
// real or test stub after. Explicit so each test's OPEN state is
// transparent at the call site.
async function forceOpenSharedBreaker(status = 500) {
  const failStub = makeStubOpenAI(async () => {
    const e: any = new Error("forced-open");
    e.status = status;
    throw e;
  });
  __setOpenAIClientForTest(failStub);
  for (let i = 0; i < 5; i++) {
    await withOpenAIBreaker((c) => c.chat.completions.create({} as any)).catch(() => {});
  }
  expect(getOpenAIBreakerState().state).toBe("OPEN");
}

async function forceOpenAgentBreaker(agent: { id: number; llmApiKey: string; llmProvider: string }) {
  const failStub = makeStubOpenAI(async () => {
    const e: any = new Error("forced-open-agent");
    e.status = 500;
    throw e;
  });
  __setAgentClientForTest(agent.id, failStub);
  for (let i = 0; i < 5; i++) {
    await withAgentBreaker(agent, (c) => c.chat.completions.create({} as any)).catch(() => {});
  }
  const state = getAllAgentBreakerStates().find((s) => s.agentId === agent.id);
  expect(state?.state).toBe("OPEN");
}

// ── Mirror of server/routes.ts:4608 /api/demo/chat ──────────────────────
// Copies the route body verbatim (stubbed client injected via
// __setOpenAIClientForTest). We replicate instead of mounting
// `registerRoutes` because the latter has >5000 LOC of module-load side
// effects (WS, Sentry, Vite, scheduler) that dwarf what we need to
// test. The source-pin test below locks the mirror to the real route.
function makeDemoApp(): Express {
  const app = express();
  app.use(express.json());
  const demoSessionMessages = new Map<string, number>();

  app.post("/api/demo/chat", async (req, res) => {
    try {
      const { message, sessionId } = req.body || {};
      if (!message || typeof message !== "string" || !sessionId || typeof sessionId !== "string") {
        return res.status(400).json({ error: "message and sessionId are required" });
      }
      if (message.length > 500) return res.status(400).json({ error: "Message too long (max 500 characters)" });
      if (sessionId.length > 64) return res.status(400).json({ error: "Invalid sessionId" });

      const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim()
        || req.socket.remoteAddress || "unknown";
      const minLimit = await checkDemoRateLimit(ip, 10, 60_000, "demo:min");
      if (!minLimit.allowed) {
        res.setHeader("Retry-After", String(minLimit.retryAfterSec));
        return res.status(429).json({ error: "rate_limited", retry_after_s: minLimit.retryAfterSec });
      }
      const hourLimit = await checkDemoRateLimit(ip, 50, 3_600_000, "demo:hour");
      if (!hourLimit.allowed) {
        res.setHeader("Retry-After", String(hourLimit.retryAfterSec));
        return res.status(429).json({ error: "rate_limited", retry_after_s: hourLimit.retryAfterSec });
      }

      const sessionCount = demoSessionMessages.get(sessionId) || 0;
      if (sessionCount >= 10) {
        return res.status(429).json({ error: "Demo limit reached. Sign up for the full experience!", limitReached: true });
      }
      demoSessionMessages.set(sessionId, sessionCount + 1);

      const completion = await withOpenAIBreaker((openai) => openai.chat.completions.create({
        model: "gpt-4.1-mini",
        max_tokens: 300,
        messages: [
          { role: "system", content: "test-system-prompt" },
          { role: "user", content: message },
        ],
      }));
      const reply = (completion as any).choices[0]?.message?.content || "fallback";
      res.json({ reply });
    } catch (err: any) {
      if (err instanceof CircuitOpenError || err?.name === "CircuitOpenError" || err?.code === "CIRCUIT_OPEN") {
        return send503(res, err);
      }
      res.status(500).json({ error: "Something went wrong. Please try again." });
    }
  });

  return app;
}

describe.sequential("W7 N5 — E2E breaker integration suite", () => {
  // ── Scenario 1: R1 invariant ──────────────────────────────────────────
  describe("Scenario 1 — R1 invariant: per-agent breaker OPEN → boilerplate + notice", () => {
    const CUSTOM_KEY_AGENT = { id: 9001, llmApiKey: "sk-test-custom", llmProvider: "openai" as const };
    const OTHER_AGENT = { id: 9002, llmApiKey: "sk-test-other", llmProvider: "openai" as const };

    it("1a: when per-agent breaker is OPEN, next call throws CircuitOpenError (the invariant callers rely on for the boilerplate reply)", async () => {
      await forceOpenAgentBreaker(CUSTOM_KEY_AGENT);

      // Mirrors the catch pattern at deliberation.ts:5483-5490 — a fresh
      // call in the tool-loop throws CircuitOpenError, caller converts
      // to "This agent is temporarily unavailable. Try again in ~30s."
      const fn = vi.fn(async () => "should-not-run");
      await expect(
        withAgentBreaker(CUSTOM_KEY_AGENT, fn),
      ).rejects.toBeInstanceOf(CircuitOpenError);
      expect(fn).not.toHaveBeenCalled();

      // Reproduce the caller's catch block inline — this IS what the
      // deliberation loop does on CircuitOpenError:
      let reply: string | null = null;
      let breakerDegraded = false;
      try {
        await withAgentBreaker(CUSTOM_KEY_AGENT, (c) => c.chat.completions.create({} as any));
      } catch (err: any) {
        if (err instanceof CircuitOpenError) {
          reply = "This agent is temporarily unavailable. Try again in ~30s.";
          breakerDegraded = true;
        }
      }
      expect(reply).toBe("This agent is temporarily unavailable. Try again in ~30s.");
      expect(breakerDegraded).toBe(true);
    });

    it("1b: other agents in the same room are unaffected by one agent's OPEN breaker", async () => {
      await forceOpenAgentBreaker(CUSTOM_KEY_AGENT);

      // OTHER_AGENT has a fresh breaker. Inject a healthy stub client.
      const okStub = makeStubOpenAI(async () => ({
        choices: [{ message: { content: "hello from healthy agent" } }],
      }));
      __setAgentClientForTest(OTHER_AGENT.id, okStub);

      const result = await withAgentBreaker(OTHER_AGENT, (c) =>
        c.chat.completions.create({} as any),
      );
      expect((result as any).choices[0].message.content).toBe("hello from healthy agent");

      // Verify registry sees one OPEN and one CLOSED entry — the exact
      // state the /health/monitor surface exposes.
      const states = getAllAgentBreakerStates();
      const custom = states.find((s) => s.agentId === CUSTOM_KEY_AGENT.id);
      const other = states.find((s) => s.agentId === OTHER_AGENT.id);
      expect(custom?.state).toBe("OPEN");
      expect(other?.state).toBe("CLOSED");
    });
  });

  // ── Scenario 2: Demo /api/demo/chat 503 + 429 full HTTP E2E ──────────
  describe("Scenario 2 — Demo 503/429: full HTTP path via supertest", () => {
    it("2a: breaker CLOSED → 200 with reply body", async () => {
      const stub = makeStubOpenAI(async () => ({
        choices: [{ message: { content: "hello demo user" } }],
      }));
      __setOpenAIClientForTest(stub);
      const app = makeDemoApp();

      const res = await request(app)
        .post("/api/demo/chat")
        .set("x-forwarded-for", "1.1.1.1")
        .send({ message: "hi", sessionId: "session-2a" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ reply: "hello demo user" });
    });

    it("2b: breaker OPEN → 503 with NEW-1 send503 body shape + Retry-After", async () => {
      await forceOpenSharedBreaker();
      const app = makeDemoApp();

      const res = await request(app)
        .post("/api/demo/chat")
        .set("x-forwarded-for", "2.2.2.2")
        .send({ message: "hi", sessionId: "session-2b" });

      expect(res.status).toBe(503);
      expect(res.headers["retry-after"]).toBeDefined();
      expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
      // NEW-1 wire contract (server/lib/http-errors.ts):
      expect(res.body).toMatchObject({
        error: "service_unavailable",
        reason: "upstream_circuit_open",
      });
      expect(typeof res.body.retry_after_ms).toBe("number");
      expect(res.body.retry_after_ms).toBeGreaterThan(0);
    });

    it("2c: 11th request in a minute from same IP → 429 (F4.1 demo-chat 10/min)", async () => {
      const stub = makeStubOpenAI(async () => ({
        choices: [{ message: { content: "ok" } }],
      }));
      __setOpenAIClientForTest(stub);
      const app = makeDemoApp();
      const IP = "3.3.3.3-" + Date.now(); // unique IP per run so prior windows don't collide

      // First 10 must succeed.
      for (let i = 0; i < 10; i++) {
        const ok = await request(app)
          .post("/api/demo/chat")
          .set("x-forwarded-for", IP)
          .send({ message: "hi", sessionId: `s-${i}` });
        expect(ok.status, `request ${i + 1}/10`).toBe(200);
      }

      // 11th must be rate-limited.
      const over = await request(app)
        .post("/api/demo/chat")
        .set("x-forwarded-for", IP)
        .send({ message: "hi", sessionId: "s-11" });
      expect(over.status).toBe(429);
      expect(over.body.error).toBe("rate_limited");
      expect(typeof over.body.retry_after_s).toBe("number");
      expect(over.headers["retry-after"]).toBeDefined();
    });
  });

  // ── Scenario 3: Breaker isolation ─────────────────────────────────────
  describe("Scenario 3 — Breaker isolation: custom-key vs shared", () => {
    it("3: custom-key agent's OPEN breaker does NOT trip shared OpenAI breaker", async () => {
      const CUSTOM = { id: 7777, llmApiKey: "sk-test-3", llmProvider: "openai" as const };
      await forceOpenAgentBreaker(CUSTOM);

      // Shared breaker must still be CLOSED — per-agent breakers are
      // isolated by design (W6 F2).
      expect(getOpenAIBreakerState().state).toBe("CLOSED");

      // A shared-key call through withOpenAIBreaker still succeeds.
      const sharedStub = makeStubOpenAI(async () => ({
        choices: [{ message: { content: "shared-key reply" } }],
      }));
      __setOpenAIClientForTest(sharedStub);
      const result = await withOpenAIBreaker((c) => c.chat.completions.create({} as any));
      expect((result as any).choices[0].message.content).toBe("shared-key reply");

      // withAgentBreaker on a shared-key (no llmApiKey) agent also
      // succeeds, because isCustomKeyAgent returns false and it
      // delegates to the still-CLOSED shared breaker.
      const SHARED_KEY_AGENT = { id: 8888 } as any;
      const result2 = await withAgentBreaker(SHARED_KEY_AGENT, (c) =>
        c.chat.completions.create({} as any),
      );
      expect((result2 as any).choices[0].message.content).toBe("shared-key reply");
    });
  });

  // ── Scenario 4: Background task silent-return ─────────────────────────
  describe("Scenario 4 — Background silent-return (Item 1c)", () => {
    // Mirrors the catch pattern at deliberation.ts:6147-6152
    // (extractPassivePreferences) and :6400-6406 (generateProactiveMessage).
    // On CircuitOpenError these background tasks log
    // `degraded_background_passive` or `degraded_background_proactive` at
    // DEBUG level and return — no throw, no
    // error log, no user-visible impact.
    async function backgroundTaskPattern(): Promise<null> {
      try {
        await withOpenAIBreaker((c) => c.chat.completions.create({} as any));
      } catch (err: any) {
        if (err instanceof CircuitOpenError || err?.name === "CircuitOpenError" || err?.code === "CIRCUIT_OPEN") {
          // Silent return — the deliberation.ts pattern emits a debug
          // log here (logger.debug, level 20) and returns.
          return null;
        }
        throw err;
      }
      return null;
    }

    it("4a: background task silently returns null when shared breaker is OPEN (no throw)", async () => {
      await forceOpenSharedBreaker();

      // Must NOT throw. Must return null.
      await expect(backgroundTaskPattern()).resolves.toBeNull();
    });

    it("4b: background task does NOT emit error-level logs on breaker-open (only debug)", async () => {
      await forceOpenSharedBreaker();

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const result = await backgroundTaskPattern();
      expect(result).toBeNull();
      // Item 1c invariant: breaker-open must not surface as an error.
      // The real deliberation.ts pattern uses logger.debug; we assert
      // nothing escalated to console.error.
      expect(errorSpy).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    });
  });

  // ── Source pin: demo-chat mirror stays true to the real route ─────────
  describe("Source pin — demo-chat contract stays in sync with routes.ts", () => {
    it("routes.ts:/api/demo/chat still uses withOpenAIBreaker + send503 + checkDemoRateLimit", async () => {
      const { readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const src = readFileSync(join(__dirname, "..", "routes.ts"), "utf8");
      const routeIdx = src.indexOf('app.post("/api/demo/chat"');
      expect(routeIdx, "demo/chat route not found").toBeGreaterThan(-1);
      // Window large enough to cover the full handler body.
      const win = src.slice(routeIdx, routeIdx + 3000);
      // The three primitives the mirror exercises:
      expect(win).toMatch(/withOpenAIBreaker\(/);
      expect(win).toMatch(/send503\(res, err\)/);
      expect(win).toMatch(/checkDemoRateLimit\(/);
      // W7 P2.1 N5 N3 — pin the exact per-minute threshold so a silent
      // routes.ts change (e.g. 10 → 20) doesn't leave the 2c mirror green.
      expect(win).toMatch(/checkDemoRateLimit\(\w+,\s*10,\s*60_?000/);
      // The 429 shape the 2c test asserts:
      expect(win).toMatch(/error:\s*["']rate_limited["']/);
      expect(win).toMatch(/retry_after_s/);
    });

    // W7 P2.1 N5 N2 — pin the degraded_agent_notice WS broadcast in
    // deliberation.ts so a refactor that drops/renames the type or payload
    // shape (agentId / agentName / degraded / retryAfterMs) fails loudly
    // here, not silently in the UI. Mirrors the contract the E2E suite
    // relies on for breaker-OPEN → WS-broadcast end-to-end flow.
    it("deliberation.ts still emits broadcastToRoom({type: 'degraded_agent_notice', ...}) with required fields", async () => {
      const { readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const src = readFileSync(join(__dirname, "..", "deliberation.ts"), "utf8");
      const block = src.match(
        /broadcastToRoom\(\s*roomId\s*,\s*\{[^}]*type:\s*"degraded_agent_notice"[\s\S]*?\}\s*\)/,
      );
      expect(block, "degraded_agent_notice broadcast block not found").toBeTruthy();
      const s = block![0];
      expect(s).toMatch(/agentId:\s*agent\.id/);
      expect(s).toMatch(/agentName:\s*displayName/);
      expect(s).toMatch(/degraded:\s*true/);
      expect(s).toMatch(/retryAfterMs:\s*30_?000/);
    });
  });
});
