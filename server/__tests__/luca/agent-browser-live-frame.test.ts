/**
 * Phase 4 (R-luca-computer-ui) — agent_browser live Browserbase iframe.
 *
 * Covers BRO1 R436 must-fixes + the moving parts unique to Phase 4:
 *
 *   Helpers (agent-browser-live-frame.ts):
 *     1. buildLiveFrameMedia → expected shape (storageKey="", kind="live_frame",
 *        contentType="text/html", TTL = 1h, sourceUrl = replay)
 *     2. toLiveFrameRow → snake_case JSONB shape symmetric with parseMediaCol
 *     3. toToolActivityMedia round-trip
 *
 *   Session manager (luca-browser/session.ts):
 *     4. getOrCreate calls bb.sessions.debug AFTER session create and surfaces
 *        debuggerFullscreenUrl on the handle (fresh-context branch)
 *     5. bb.sessions.debug throwing must NOT break session create —
 *        handle is returned with debuggerFullscreenUrl=undefined (best-effort)
 *     6. bb.sessions.debug returning empty/missing URL → undefined (no leak)
 *
 *   Storage (storage.ts) — Phase 4 deltas:
 *     7. parseMediaCol allows storage_key="" ONLY when kind="live_frame";
 *        rejects empty key for screenshot/file/video
 *     8. setToolActivityMedia is APPEND, not REPLACE — pre-existing screenshot
 *        media stays intact when a live_frame is added later (R431 must-fix #4)
 *     9. setToolActivityMedia dedupes by kind:storageKey:signedUrl so a retry
 *        does not double-write the same row
 *    10. removeToolActivityMediaByKind drops only the matching kind
 *
 *   agent_browser handler wiring (agent-browser.ts):
 *    11. With liveFramePublisher set, the handler publishes a live_frame
 *        BEFORE Stagehand.init (so Boss sees the iframe ASAP) and broadcasts
 *        status:'running' with mediaUrls containing the live_frame row.
 *    12. In `finally` the handler removes the live_frame row from the DB AND
 *        broadcasts closeLiveFrame:true so the UI tears the iframe down
 *        without waiting for the next /tool-activity poll.
 *
 * No real Browserbase / Stagehand / Anthropic / Postgres traffic — everything
 * stubbed via vi.mock + the existing __setSessionManagerForTests /
 * __setStagehandFactoryForTests escape hatches.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── pg + drizzle mock (mirrors storage-attachments.test.ts) ─────────────
vi.mock("pg", () => {
  function MockPool(this: any) {
    this.query = vi.fn();
    this.on = vi.fn();
    this.end = vi.fn().mockResolvedValue(undefined);
    this.connect = vi.fn();
  }
  return { Pool: MockPool };
});
vi.mock("drizzle-orm/node-postgres", () => ({ drizzle: vi.fn(() => ({})) }));
vi.mock("drizzle-orm", async (orig) => {
  const real = await (orig() as Promise<any>);
  return { ...real, eq: (a: any, b: any) => ({ a, b }) };
});
vi.mock("./logger", () => ({
  default: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import {
  buildLiveFrameMedia,
  toLiveFrameRow,
  toToolActivityMedia,
  LIVE_FRAME_TTL_SEC,
} from "../../lib/luca-tools/agent-browser-live-frame";

// ─── Helpers ─────────────────────────────────────────────────────────────

describe("agent-browser-live-frame helpers", () => {
  it("buildLiveFrameMedia emits the documented shape", () => {
    const before = Date.now();
    const m = buildLiveFrameMedia({
      debuggerFullscreenUrl: "https://www.browserbase.com/devtools-fullscreen/inspector.html?token=abc",
      sessionReplayUrl: "https://browserbase.com/sessions/sess_42",
    });
    expect(m.storageKey).toBe("");
    expect(m.kind).toBe("live_frame");
    expect(m.contentType).toBe("text/html");
    expect(m.signedUrl).toMatch(/devtools-fullscreen/);
    expect(m.sourceUrl).toBe("https://browserbase.com/sessions/sess_42");
    // TTL window should be ~1h from now (allow a small skew for the call cost).
    expect(m.signedExpiresAt).toBeGreaterThanOrEqual(before + LIVE_FRAME_TTL_SEC * 1000 - 50);
    expect(m.signedExpiresAt).toBeLessThanOrEqual(Date.now() + LIVE_FRAME_TTL_SEC * 1000 + 50);
  });

  it("toLiveFrameRow → snake_case JSONB shape symmetric with parseMediaCol", () => {
    const m = buildLiveFrameMedia({
      debuggerFullscreenUrl: "https://x.browserbase.com/iframe?t=tok",
      sessionReplayUrl: "https://browserbase.com/sessions/abc",
    });
    const row = toLiveFrameRow(m);
    expect(row).toMatchObject({
      storage_key: "",
      signed_url: m.signedUrl,
      signed_expires_at: m.signedExpiresAt,
      content_type: "text/html",
      kind: "live_frame",
      source_url: m.sourceUrl,
    });
  });

  it("toToolActivityMedia round-trips fields", () => {
    const m = buildLiveFrameMedia({
      debuggerFullscreenUrl: "https://www.browserbase.com/x",
      sessionReplayUrl: "https://browserbase.com/sessions/y",
    });
    const tam = toToolActivityMedia(m);
    expect(tam).toEqual({
      storageKey: "",
      signedUrl: m.signedUrl,
      signedExpiresAt: m.signedExpiresAt,
      contentType: "text/html",
      kind: "live_frame",
      sourceUrl: m.sourceUrl,
    });
  });
});

// ─── BrowserbaseSessionManager.fetchLiveUrl ──────────────────────────────

describe("BrowserbaseSessionManager — fetchLiveUrl best-effort", () => {
  let BBSDKMock: any;

  beforeEach(() => {
    vi.resetModules();
    BBSDKMock = vi.fn();
    vi.doMock("@browserbasehq/sdk", () => ({
      default: BBSDKMock,
    }));
  });

  afterEach(() => {
    vi.doUnmock("@browserbasehq/sdk");
    vi.resetModules();
  });

  async function importMgr() {
    const mod = await import("../../lib/luca-browser/session");
    return mod;
  }

  function makeBB(opts: {
    debugReturns?: { debuggerFullscreenUrl?: string } | null;
    debugThrows?: boolean;
  }) {
    const ctxCreate = vi.fn().mockResolvedValue({ id: "ctx-1" });
    const sessCreate = vi
      .fn()
      .mockResolvedValue({ id: "sess-99", connectUrl: "wss://bb/sess-99" });
    const sessDebug = vi.fn(async () => {
      if (opts.debugThrows) throw new Error("bb_debug_503");
      return opts.debugReturns ?? { debuggerFullscreenUrl: undefined };
    });
    BBSDKMock.mockImplementation(function (this: any) {
      this.contexts = { create: ctxCreate };
      this.sessions = { create: sessCreate, debug: sessDebug, update: vi.fn() };
    });
    return { ctxCreate, sessCreate, sessDebug };
  }

  it("surfaces debuggerFullscreenUrl on the handle (fresh context path)", async () => {
    const { sessDebug } = makeBB({
      debugReturns: { debuggerFullscreenUrl: "https://www.browserbase.com/iframe?token=abc" },
    });
    const { BrowserbaseSessionManager } = await importMgr();
    const mgr = new BrowserbaseSessionManager({ apiKey: "k", projectId: "p" });
    const h = await mgr.getOrCreate({ userId: 1, domain: "vercel.com" });
    expect(h.sessionId).toBe("sess-99");
    expect(h.connectUrl).toBe("wss://bb/sess-99");
    expect(h.debuggerFullscreenUrl).toBe("https://www.browserbase.com/iframe?token=abc");
    expect(sessDebug).toHaveBeenCalledWith("sess-99");
  });

  it("returns handle with debuggerFullscreenUrl=undefined when bb.sessions.debug throws (best-effort)", async () => {
    makeBB({ debugThrows: true });
    const { BrowserbaseSessionManager } = await importMgr();
    const mgr = new BrowserbaseSessionManager({ apiKey: "k", projectId: "p" });
    const h = await mgr.getOrCreate({ userId: 1, domain: "vercel.com" });
    // Stagehand still has connectUrl — the live preview is purely cosmetic.
    expect(h.sessionId).toBe("sess-99");
    expect(h.connectUrl).toBe("wss://bb/sess-99");
    expect(h.debuggerFullscreenUrl).toBeUndefined();
  });

  it("treats empty/missing debuggerFullscreenUrl as undefined", async () => {
    makeBB({ debugReturns: { debuggerFullscreenUrl: "" } });
    const { BrowserbaseSessionManager } = await importMgr();
    const mgr = new BrowserbaseSessionManager({ apiKey: "k", projectId: "p" });
    const h = await mgr.getOrCreate({ userId: 1, domain: "vercel.com" });
    expect(h.debuggerFullscreenUrl).toBeUndefined();
  });
});

// ─── storage.ts — parseMediaCol live_frame gate + append/remove ──────────

describe("storage.ts — Phase 4 media helpers", () => {
  let pool: any;
  let setToolActivityMedia: any;
  let removeToolActivityMediaByKind: any;
  let getToolActivityForRoom: any;

  beforeEach(async () => {
    vi.resetModules();
    const storage = await import("../../storage");
    pool = storage.pool;
    setToolActivityMedia = storage.setToolActivityMedia;
    removeToolActivityMediaByKind = storage.removeToolActivityMediaByKind;
    getToolActivityForRoom = storage.getToolActivityForRoom;
    (pool as any).query = vi.fn();
  });

  it("parseMediaCol (via getToolActivityForRoom) rejects empty storage_key for non-live kinds", async () => {
    (pool as any).query.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          step_id: "s",
          room_id: 1,
          message_id: null,
          user_id: 1,
          agent_id: 1,
          tool: "luca_agent_browser",
          status: "done",
          description: null,
          preview: null,
          started_at: 1,
          finished_at: 2,
          elapsed_ms: 1,
          created_at: 1,
          // Two rows: one screenshot with empty key (should be filtered out)
          // and one valid file row (kept).
          media_urls: [
            {
              storage_key: "",
              signed_url: "https://x.example/bogus",
              signed_expires_at: 9999,
              content_type: "image/jpeg",
              kind: "screenshot",
            },
            {
              storage_key: "sb/path/file.pdf",
              signed_url: "https://x.example/pdf",
              signed_expires_at: 9999,
              content_type: "application/pdf",
              kind: "file",
            },
          ],
        },
      ],
    });
    const out = await getToolActivityForRoom(1);
    expect(out).toHaveLength(1);
    expect(out[0].mediaUrls).toHaveLength(1);
    expect(out[0].mediaUrls?.[0].kind).toBe("file");
    expect(out[0].mediaUrls?.[0].storageKey).toBe("sb/path/file.pdf");
  });

  it("parseMediaCol allows empty storage_key ONLY for live_frame kind", async () => {
    (pool as any).query.mockResolvedValueOnce({
      rows: [
        {
          id: 2,
          step_id: "s2",
          room_id: 1,
          message_id: null,
          user_id: 1,
          agent_id: 1,
          tool: "luca_agent_browser",
          status: "running",
          description: null,
          preview: null,
          started_at: 1,
          finished_at: null,
          elapsed_ms: null,
          created_at: 1,
          media_urls: [
            {
              storage_key: "",
              signed_url: "https://www.browserbase.com/iframe?t=abc",
              signed_expires_at: 9999,
              content_type: "text/html",
              kind: "live_frame",
              source_url: "https://browserbase.com/sessions/abc",
            },
          ],
        },
      ],
    });
    const out = await getToolActivityForRoom(1);
    expect(out[0].mediaUrls).toHaveLength(1);
    expect(out[0].mediaUrls?.[0].kind).toBe("live_frame");
    expect(out[0].mediaUrls?.[0].storageKey).toBe("");
    expect(out[0].mediaUrls?.[0].sourceUrl).toBe("https://browserbase.com/sessions/abc");
  });

  it("setToolActivityMedia APPENDS instead of replacing (R431 must-fix #4)", async () => {
    // First query: SELECT existing media — return one screenshot already there.
    (pool as any).query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT")) {
        return {
          rows: [
            {
              media_urls: [
                {
                  storage_key: "sb/screenshot.jpg",
                  signed_url: "https://x.example/shot",
                  signed_expires_at: 9999,
                  content_type: "image/jpeg",
                  kind: "screenshot",
                },
              ],
            },
          ],
        };
      }
      return { rows: [] };
    });
    await setToolActivityMedia("step-A", [
      {
        storageKey: "",
        signedUrl: "https://www.browserbase.com/iframe?t=abc",
        signedExpiresAt: Date.now() + 3600_000,
        contentType: "text/html",
        kind: "live_frame",
      } as any,
    ]);
    // The UPDATE call should have a merged array containing BOTH rows.
    const updateCall = (pool as any).query.mock.calls.find((c: any[]) =>
      String(c[0]).includes("UPDATE tool_activity_log"),
    );
    expect(updateCall).toBeTruthy();
    const merged = JSON.parse(updateCall[1][0]);
    expect(Array.isArray(merged)).toBe(true);
    expect(merged).toHaveLength(2);
    const kinds = merged.map((r: any) => r.kind).sort();
    expect(kinds).toEqual(["live_frame", "screenshot"]);
  });

  it("setToolActivityMedia dedupes by kind:storageKey:signedUrl on retry", async () => {
    const exp = Date.now() + 3600_000;
    const liveRow = {
      storage_key: "",
      signed_url: "https://www.browserbase.com/iframe?t=tok",
      signed_expires_at: exp,
      content_type: "text/html",
      kind: "live_frame",
    };
    (pool as any).query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT")) return { rows: [{ media_urls: [liveRow] }] };
      return { rows: [] };
    });
    await setToolActivityMedia("step-A", [
      {
        storageKey: "",
        signedUrl: liveRow.signed_url,
        signedExpiresAt: exp,
        contentType: "text/html",
        kind: "live_frame",
      } as any,
    ]);
    const updateCall = (pool as any).query.mock.calls.find((c: any[]) =>
      String(c[0]).includes("UPDATE tool_activity_log"),
    );
    expect(updateCall).toBeTruthy();
    const merged = JSON.parse(updateCall[1][0]);
    expect(merged).toHaveLength(1);
    expect(merged[0].kind).toBe("live_frame");
  });

  it("removeToolActivityMediaByKind drops only the matching kind", async () => {
    (pool as any).query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT")) {
        return {
          rows: [
            {
              media_urls: [
                {
                  storage_key: "",
                  signed_url: "https://www.browserbase.com/iframe?t=t",
                  signed_expires_at: 9999,
                  content_type: "text/html",
                  kind: "live_frame",
                },
                {
                  storage_key: "sb/screenshot.jpg",
                  signed_url: "https://x.example/shot",
                  signed_expires_at: 9999,
                  content_type: "image/jpeg",
                  kind: "screenshot",
                },
              ],
            },
          ],
        };
      }
      return { rows: [] };
    });
    await removeToolActivityMediaByKind("step-A", "live_frame");
    const updateCall = (pool as any).query.mock.calls.find((c: any[]) =>
      String(c[0]).includes("UPDATE tool_activity_log"),
    );
    expect(updateCall).toBeTruthy();
    const next = JSON.parse(updateCall[1][0]);
    expect(next).toHaveLength(1);
    expect(next[0].kind).toBe("screenshot");
  });

  it("removeToolActivityMediaByKind is a no-op when nothing matches (no UPDATE issued)", async () => {
    (pool as any).query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT")) {
        return {
          rows: [
            {
              media_urls: [
                {
                  storage_key: "sb/screenshot.jpg",
                  signed_url: "https://x.example/shot",
                  signed_expires_at: 9999,
                  content_type: "image/jpeg",
                  kind: "screenshot",
                },
              ],
            },
          ],
        };
      }
      return { rows: [] };
    });
    await removeToolActivityMediaByKind("step-A", "live_frame");
    const updateCall = (pool as any).query.mock.calls.find((c: any[]) =>
      String(c[0]).includes("UPDATE tool_activity_log"),
    );
    expect(updateCall).toBeFalsy();
  });
});

// ─── agent-browser handler — liveFramePublisher wiring ───────────────────

describe("agentBrowserHandler — Phase 4 live frame publisher", () => {
  // Module-scoped mocks: storage + ws are what the handler imports for
  // Phase 4. We replace them entirely so we don't need a real DB.
  const setToolActivityMediaMock = vi.fn(async () => {});
  const removeToolActivityMediaByKindMock = vi.fn(async () => {});
  const broadcastMock = vi.fn();

  beforeEach(() => {
    setToolActivityMediaMock.mockClear();
    removeToolActivityMediaByKindMock.mockClear();
    broadcastMock.mockClear();
    vi.resetModules();
    vi.doMock("../../storage", () => ({
      setToolActivityMedia: (...a: unknown[]) => setToolActivityMediaMock(...(a as [])),
      removeToolActivityMediaByKind: (...a: unknown[]) =>
        removeToolActivityMediaByKindMock(...(a as [])),
    }));
    vi.doMock("../../ws", () => ({
      broadcastToolActivity: (...a: unknown[]) => broadcastMock(...(a as [])),
    }));
    // Logger is fine real, but tests run quieter when stubbed.
    vi.doMock("../../logger", () => ({
      default: {
        info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
        child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
      },
    }));
    // Flag stack on for happy path.
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

  function makeFakeMgr(debuggerUrl: string | undefined) {
    return {
      async getOrCreate() {
        return {
          sessionId: "sess-77",
          connectUrl: "wss://bb/sess-77",
          debuggerFullscreenUrl: debuggerUrl,
        };
      },
      async releaseSession() {},
      forgetContext() {},
      __snapshot() { return new Map(); },
    } as any;
  }

  function makeFakeStagehand(opts: { shouldThrow?: boolean } = {}) {
    return (() => ({
      async init() {},
      async close() {},
      agent() {
        return {
          async execute() {
            if (opts.shouldThrow) throw new Error("stagehand_boom");
            return {
              success: true,
              completed: true,
              message: "ok",
              actions: [],
              metadata: {},
            };
          },
        };
      },
      context: { pages: () => [] },
    })) as any;
  }

  it("publishes live_frame BEFORE Stagehand init and broadcasts running with mediaUrls", async () => {
    const {
      agentBrowserHandler,
      __setStagehandFactoryForTests,
      __setSessionManagerForTests,
    } = await import("../../lib/luca-tools/agent-browser");
    const { __resetAgentBrowserRateLimitForTests } = await import(
      "../../lib/luca-tools/agent-browser-guard"
    );
    __resetAgentBrowserRateLimitForTests();
    const mgr = makeFakeMgr("https://www.browserbase.com/iframe?token=abc");

    // Order tracking: assert setToolActivityMedia was called before stagehand.init.
    let setMediaTime = 0;
    let stagehandInitTime = 0;
    setToolActivityMediaMock.mockImplementation(async () => {
      setMediaTime = ++callOrder;
    });
    let callOrder = 0;
    const factory = (() => ({
      async init() { stagehandInitTime = ++callOrder; },
      async close() {},
      agent: () => ({
        execute: async () => ({
          success: true, completed: true, message: "done", actions: [], metadata: {},
        }),
      }),
      context: { pages: () => [] },
    })) as any;
    __setStagehandFactoryForTests(factory);
    __setSessionManagerForTests(mgr);

    const r = await agentBrowserHandler(
      { task: "Open vercel dashboard please.", domain: "vercel.com" },
      {
        userId: 7,
        agentId: 11,
        liveFramePublisher: {
          roomId: 42,
          stepId: "step-LF",
          description: "Открытие vercel.com",
          startedAt: 1_700_000_000_000,
        },
      },
    );

    expect(r.status).toBe("ok");
    // Order: live frame published BEFORE stagehand init.
    expect(setMediaTime).toBeGreaterThan(0);
    expect(stagehandInitTime).toBeGreaterThan(0);
    expect(setMediaTime).toBeLessThan(stagehandInitTime);

    // setToolActivityMedia called with stepId + a single live_frame row.
    expect(setToolActivityMediaMock).toHaveBeenCalled();
    const [firstStepId, firstMedia] = setToolActivityMediaMock.mock.calls[0];
    expect(firstStepId).toBe("step-LF");
    expect(Array.isArray(firstMedia)).toBe(true);
    expect((firstMedia as any[])[0].kind).toBe("live_frame");
    expect((firstMedia as any[])[0].storageKey).toBe("");
    expect((firstMedia as any[])[0].signedUrl).toMatch(/browserbase\.com/);

    // First broadcast: status:running + mediaUrls with snake_case live_frame.
    expect(broadcastMock).toHaveBeenCalled();
    const [roomId, payload] = broadcastMock.mock.calls[0];
    expect(roomId).toBe(42);
    expect(payload.tool).toBe("luca_agent_browser");
    expect(payload.status).toBe("running");
    expect(payload.stepId).toBe("step-LF");
    expect(payload.description).toBe("Открытие vercel.com");
    expect(Array.isArray(payload.mediaUrls)).toBe(true);
    expect(payload.mediaUrls[0].kind).toBe("live_frame");
    expect(payload.mediaUrls[0].storage_key).toBe("");
    expect(payload.mediaUrls[0].signed_url).toMatch(/browserbase\.com/);
    expect(payload.mediaUrls[0].source_url).toMatch(/\/sessions\/sess-77/);
  });

  it("does NOT publish live_frame when debuggerFullscreenUrl is undefined", async () => {
    const {
      agentBrowserHandler,
      __setStagehandFactoryForTests,
      __setSessionManagerForTests,
    } = await import("../../lib/luca-tools/agent-browser");
    const { __resetAgentBrowserRateLimitForTests } = await import(
      "../../lib/luca-tools/agent-browser-guard"
    );
    __resetAgentBrowserRateLimitForTests();
    __setSessionManagerForTests(makeFakeMgr(undefined));
    __setStagehandFactoryForTests(makeFakeStagehand());

    const r = await agentBrowserHandler(
      { task: "Open vercel dashboard please.", domain: "vercel.com" },
      {
        userId: 7,
        agentId: 11,
        liveFramePublisher: {
          roomId: 42,
          stepId: "step-LF",
          description: null,
          startedAt: Date.now(),
        },
      },
    );
    expect(r.status).toBe("ok");
    // No DB write for live_frame and no live_frame broadcast — but the
    // tear-down broadcast in finally still fires (closeLiveFrame:true) so
    // the UI doesn't get stuck on a stale row from a previous run.
    expect(setToolActivityMediaMock).not.toHaveBeenCalled();
    // Tear-down: broadcast with closeLiveFrame:true was issued.
    const closeBroadcasts = broadcastMock.mock.calls.filter(
      ([, p]: any[]) => p.closeLiveFrame === true,
    );
    expect(closeBroadcasts.length).toBe(1);
  });

  it("in finally: removes live_frame row + broadcasts closeLiveFrame:true (happy path)", async () => {
    const {
      agentBrowserHandler,
      __setStagehandFactoryForTests,
      __setSessionManagerForTests,
    } = await import("../../lib/luca-tools/agent-browser");
    const { __resetAgentBrowserRateLimitForTests } = await import(
      "../../lib/luca-tools/agent-browser-guard"
    );
    __resetAgentBrowserRateLimitForTests();
    __setSessionManagerForTests(makeFakeMgr("https://www.browserbase.com/x"));
    __setStagehandFactoryForTests(makeFakeStagehand());

    const r = await agentBrowserHandler(
      { task: "Open vercel dashboard please.", domain: "vercel.com" },
      {
        userId: 7,
        agentId: 11,
        liveFramePublisher: {
          roomId: 42,
          stepId: "step-LF",
          description: null,
          startedAt: Date.now(),
        },
      },
    );
    expect(r.status).toBe("ok");

    // Removal called once with the matching kind.
    expect(removeToolActivityMediaByKindMock).toHaveBeenCalledTimes(1);
    expect(removeToolActivityMediaByKindMock.mock.calls[0]).toEqual(["step-LF", "live_frame"]);

    // Final broadcast carries closeLiveFrame:true and an empty mediaUrls
    // array so the UI doesn't latch onto a stale row.
    const closeCalls = broadcastMock.mock.calls.filter(
      ([, p]: any[]) => p.closeLiveFrame === true,
    );
    expect(closeCalls.length).toBe(1);
    expect(closeCalls[0][0]).toBe(42);
    expect(closeCalls[0][1].stepId).toBe("step-LF");
    expect(closeCalls[0][1].mediaUrls).toEqual([]);
  });

  it("in finally: tear-down still happens when Stagehand throws (error path)", async () => {
    const {
      agentBrowserHandler,
      __setStagehandFactoryForTests,
      __setSessionManagerForTests,
    } = await import("../../lib/luca-tools/agent-browser");
    const { __resetAgentBrowserRateLimitForTests } = await import(
      "../../lib/luca-tools/agent-browser-guard"
    );
    __resetAgentBrowserRateLimitForTests();
    __setSessionManagerForTests(makeFakeMgr("https://www.browserbase.com/x"));
    __setStagehandFactoryForTests(makeFakeStagehand({ shouldThrow: true }));

    const r = await agentBrowserHandler(
      { task: "Open vercel dashboard please.", domain: "vercel.com" },
      {
        userId: 7,
        agentId: 11,
        liveFramePublisher: {
          roomId: 42,
          stepId: "step-LF-err",
          description: null,
          startedAt: Date.now(),
        },
      },
    );
    expect(r.status).toBe("error");
    expect(removeToolActivityMediaByKindMock).toHaveBeenCalledWith("step-LF-err", "live_frame");
    const closeCalls = broadcastMock.mock.calls.filter(
      ([, p]: any[]) => p.closeLiveFrame === true,
    );
    expect(closeCalls.length).toBe(1);
  });

  it("does not call live-frame helpers when liveFramePublisher is absent (other luca_* tools / background turns)", async () => {
    const {
      agentBrowserHandler,
      __setStagehandFactoryForTests,
      __setSessionManagerForTests,
    } = await import("../../lib/luca-tools/agent-browser");
    const { __resetAgentBrowserRateLimitForTests } = await import(
      "../../lib/luca-tools/agent-browser-guard"
    );
    __resetAgentBrowserRateLimitForTests();
    __setSessionManagerForTests(makeFakeMgr("https://www.browserbase.com/x"));
    __setStagehandFactoryForTests(makeFakeStagehand());

    const r = await agentBrowserHandler(
      { task: "Open vercel dashboard please.", domain: "vercel.com" },
      { userId: 7, agentId: 11 },
    );
    expect(r.status).toBe("ok");
    expect(setToolActivityMediaMock).not.toHaveBeenCalled();
    expect(removeToolActivityMediaByKindMock).not.toHaveBeenCalled();
    expect(broadcastMock).not.toHaveBeenCalled();
  });
});
