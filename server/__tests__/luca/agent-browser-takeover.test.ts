/**
 * Phase 5 PR-B (R-luca-computer-ui) — agent-browser yields to active takeover.
 *
 * BRO1 R438 Q4 verification: Stagehand SDK has no public pause()/resume(),
 * so the agent loop polls `isTakeoverActive(stepId)` BEFORE invoking
 * `agent.execute`. This test:
 *   1. Acquires a takeover BEFORE handler is called → handler sleeps in
 *      1s ticks until release.
 *   2. After ~2 ticks we release → handler proceeds and execute() is called.
 *   3. clearTakeover is invoked in the finally block (lock cleanup).
 *
 * Mocks: storage + ws so the handler runs without DB / real WS.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("agentBrowserHandler — Phase 5 PR-B takeover yield", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("../../storage", () => ({
      setToolActivityMedia: vi.fn(async () => {}),
      removeToolActivityMediaByKind: vi.fn(async () => {}),
    }));
    vi.doMock("../../ws", () => ({
      broadcastToolActivity: vi.fn(),
    }));
    vi.doMock("../../logger", () => ({
      default: {
        info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
        child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
      },
    }));
    process.env.LUCA_V1A_ENABLED = "true";
    process.env.LUCA_TOOLS_ENABLED = "true";
    process.env.LUCA_TOOL_AGENT_BROWSER_ENABLED = "true";
    process.env.LUCA_AGENT_BROWSER_ALLOWED_DOMAINS = "vercel.com";
    process.env.BROWSERBASE_API_KEY = "bb_test";
    process.env.BROWSERBASE_PROJECT_ID = "proj_test";
    delete process.env.LUCA_BROWSER_DISABLED;
  });

  afterEach(() => {
    delete process.env.LUCA_V1A_ENABLED;
    delete process.env.LUCA_TOOLS_ENABLED;
    delete process.env.LUCA_TOOL_AGENT_BROWSER_ENABLED;
    delete process.env.LUCA_AGENT_BROWSER_ALLOWED_DOMAINS;
    delete process.env.BROWSERBASE_API_KEY;
    delete process.env.BROWSERBASE_PROJECT_ID;
    vi.doUnmock("../../storage");
    vi.doUnmock("../../ws");
    vi.doUnmock("../../logger");
    vi.resetModules();
  });

  function fakeMgr() {
    return {
      async getOrCreate() {
        return {
          sessionId: "sess-yield",
          connectUrl: "wss://bb/sess-yield",
          debuggerFullscreenUrl: "https://browserbase.com/iframe",
        };
      },
      async releaseSession() {},
      forgetContext() {},
      __snapshot() { return new Map(); },
    } as any;
  }

  it("waits while takeover is active, then proceeds once released", async () => {
    const {
      acquireTakeover,
      releaseTakeover,
      isTakeoverActive,
      clearTakeover,
      __clearTakeoverStateForTests,
    } = await import("../../lib/luca-takeover");
    const {
      agentBrowserHandler,
      __setStagehandFactoryForTests,
      __setSessionManagerForTests,
    } = await import("../../lib/luca-tools/agent-browser");
    const { __resetAgentBrowserRateLimitForTests } = await import(
      "../../lib/luca-tools/agent-browser-guard"
    );
    __resetAgentBrowserRateLimitForTests();
    __clearTakeoverStateForTests();

    let executeCalled = false;
    let executeAt = 0;
    let counter = 0;
    const factory = (() => ({
      async init() {},
      async close() {},
      agent: () => ({
        execute: async () => {
          executeCalled = true;
          executeAt = ++counter;
          return {
            success: true, completed: true, message: "done", actions: [], metadata: {},
          };
        },
      }),
      context: { pages: () => [] },
    })) as any;
    __setStagehandFactoryForTests(factory);
    __setSessionManagerForTests(fakeMgr());

    // Pre-acquire — handler should sleep until we release.
    const stepId = "step-yield";
    acquireTakeover({
      stepId,
      roomId: 42,
      userId: 7,
      mode: "interactive",
      connectionId: "boss-conn",
    });
    expect(isTakeoverActive(stepId)).toBe(true);

    // Release after a short delay so the handler's poll loop unblocks.
    setTimeout(() => {
      releaseTakeover(stepId, "boss-conn");
    }, 1500);

    const t0 = Date.now();
    const r = await agentBrowserHandler(
      { task: "Open vercel dashboard please.", domain: "vercel.com" },
      {
        userId: 7,
        agentId: 11,
        liveFramePublisher: {
          roomId: 42,
          stepId,
          description: "yield test",
          startedAt: t0,
        },
      },
    );

    expect(r.status).toBe("ok");
    expect(executeCalled).toBe(true);
    // Should have waited at least one tick (1s).
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(900);
    // Lock cleared in finally regardless.
    expect(isTakeoverActive(stepId)).toBe(false);

    // Cleanup.
    clearTakeover(stepId);
  }, 15_000);

  it("does not wait when no takeover is active (fast path)", async () => {
    const { isTakeoverActive, __clearTakeoverStateForTests } = await import(
      "../../lib/luca-takeover"
    );
    const {
      agentBrowserHandler,
      __setStagehandFactoryForTests,
      __setSessionManagerForTests,
    } = await import("../../lib/luca-tools/agent-browser");
    const { __resetAgentBrowserRateLimitForTests } = await import(
      "../../lib/luca-tools/agent-browser-guard"
    );
    __resetAgentBrowserRateLimitForTests();
    __clearTakeoverStateForTests();

    const factory = (() => ({
      async init() {},
      async close() {},
      agent: () => ({
        execute: async () => ({
          success: true, completed: true, message: "done", actions: [], metadata: {},
        }),
      }),
      context: { pages: () => [] },
    })) as any;
    __setStagehandFactoryForTests(factory);
    __setSessionManagerForTests(fakeMgr());

    const t0 = Date.now();
    const r = await agentBrowserHandler(
      { task: "Open vercel dashboard please.", domain: "vercel.com" },
      {
        userId: 7,
        agentId: 11,
        liveFramePublisher: {
          roomId: 42,
          stepId: "step-fast",
          description: "fast path",
          startedAt: t0,
        },
      },
    );
    const elapsed = Date.now() - t0;
    expect(r.status).toBe("ok");
    // No takeover → no 1s tick wait.
    expect(elapsed).toBeLessThan(1000);
    expect(isTakeoverActive("step-fast")).toBe(false);
  });
});
