/**
 * Luca V1a `luca_agent_browser` tool — unit tests (R343).
 *
 * Covers the full defense-in-depth stack and the happy path:
 *   1. Three-level flag stack (master / tools-master / per-tool) — off ⇒ disabled
 *   2. LUCA_BROWSER_DISABLED global kill-switch
 *   3. Empty allowlist short-circuit (defense-in-depth — flag flip alone
 *      cannot open a hole)
 *   4. Domain not in allowlist ⇒ domain_blocked, NO network call
 *   5. Wildcard suffix-only allowlist match (BRO1 R395 P1)
 *   6. Input validation (missing/short/long task, missing domain)
 *   7. Successful task with mocked Stagehand factory ⇒ status:ok with
 *      summary, actions_taken, session_replay_url
 *   8. Stagehand throws ⇒ status:error, no throw out of the handler, close
 *      + releaseSession still invoked (best-effort cleanup)
 *   9. max_actions clamped to AGENT_BROWSER_MAX_STEPS_CAP (20)
 *  10. capture_screenshot=true ⇒ b64 included in result
 *  11. Per-(userId,domain) session reuse — two calls = one context, two
 *      sessions (BrowserbaseSessionManager.getOrCreate behaviour)
 *  12. Rate-limit (5/hour) — 6th call ⇒ status:rate_limited
 *  13. Registry: tool listed when 3 flags on, omitted when per-tool off,
 *      dispatch routes by name, allowlist embedded in description
 *
 * No real Browserbase / Stagehand / Anthropic traffic — both the session
 * manager and the Stagehand factory are stubbed via the
 * `__setSessionManagerForTests` / `__setStagehandFactoryForTests` hooks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  agentBrowserHandler,
  agentBrowserTool,
  buildAgentBrowserTool,
  AGENT_BROWSER_DEFAULT_MAX_STEPS,
  AGENT_BROWSER_MAX_STEPS_CAP,
  AGENT_BROWSER_INSTRUCTION_MIN,
  AGENT_BROWSER_INSTRUCTION_MAX,
  DESTRUCTIVE_ACTION_GUARD,
  __setSessionManagerForTests,
  __setStagehandFactoryForTests,
  type AgentBrowserContext,
  type StagehandLike,
  type StagehandFactory,
} from "../../lib/luca-tools/agent-browser";
import {
  __resetAgentBrowserRateLimitForTests,
  AGENT_BROWSER_RATE_LIMIT,
} from "../../lib/luca-tools/agent-browser-guard";
import {
  domainMatches,
  isHostAllowed,
} from "../../lib/luca-tools/agent-browser-allowlist";
import {
  __getAllLucaToolSpecsForTests,
  dispatchLucaTool,
  getLucaTools,
} from "../../lib/luca-tools/registry";
import type { BrowserbaseSessionManager } from "../../lib/luca-browser/session";

// ─── Flag helpers (shape mirrors read-url.test.ts) ───────────────────────

const LUCA_FLAG_KEYS = [
  "LUCA_V1A_ENABLED",
  "LUCA_TOOLS_ENABLED",
  "LUCA_TOOL_AGENT_BROWSER_ENABLED",
  "LUCA_TOOL_RUN_CODE_ENABLED",
  "LUCA_TOOL_ANALYZE_IMAGE_ENABLED",
  "LUCA_TOOL_SEARCH_ENABLED",
  "LUCA_TOOL_READ_URL_ENABLED",
  "LUCA_TOOL_EMAIL_READ_ENABLED",
  "LUCA_EMAIL_SCOPE_ENABLED",
  "LUCA_BROWSER_DISABLED",
  "LUCA_AGENT_BROWSER_ALLOWED_DOMAINS",
  "LUCA_AGENT_BROWSER_MODEL",
  "BROWSERBASE_API_KEY",
  "BROWSERBASE_PROJECT_ID",
];

function setFlags(overrides: Record<string, string | undefined>) {
  for (const k of LUCA_FLAG_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function allOn(extra: Record<string, string | undefined> = {}) {
  setFlags({
    LUCA_V1A_ENABLED: "true",
    LUCA_TOOLS_ENABLED: "true",
    LUCA_TOOL_AGENT_BROWSER_ENABLED: "true",
    LUCA_AGENT_BROWSER_ALLOWED_DOMAINS:
      "vercel.com,github.com,*.up.railway.app",
    BROWSERBASE_API_KEY: "bb_test_key",
    BROWSERBASE_PROJECT_ID: "test_project",
    ...extra,
  });
}

function makeCtx(): AgentBrowserContext {
  return { userId: 7, agentId: 11 };
}

// ─── Fake session manager + Stagehand ────────────────────────────────────

interface ManagerCallLog {
  getOrCreate: Array<{ userId: number; domain: string }>;
  release: Array<{ userId: number; domain: string }>;
}

function makeFakeManager(): {
  mgr: BrowserbaseSessionManager;
  log: ManagerCallLog;
  /** Returned sessionId per call — increments to detect reuse-vs-fresh. */
  nextSessionId: () => string;
} {
  let counter = 0;
  const log: ManagerCallLog = { getOrCreate: [], release: [] };
  const sessions = new Map<string, string>();
  const mgr = {
    async getOrCreate(key: { userId: number; domain: string }) {
      log.getOrCreate.push({ ...key });
      const mk = `${key.userId}:${key.domain}`;
      // Always issue a fresh sessionId per call; same context implied if
      // the key was seen before. Tests verify session reuse via getOrCreate
      // call count + same key.
      counter += 1;
      const sid = `sess_${counter}`;
      sessions.set(mk, sid);
      return { sessionId: sid, connectUrl: `wss://fake/${sid}` };
    },
    async releaseSession(key: { userId: number; domain: string }) {
      log.release.push({ ...key });
    },
    forgetContext() {},
    __snapshot() {
      return new Map();
    },
  } as unknown as BrowserbaseSessionManager;
  return { mgr, log, nextSessionId: () => `sess_${counter + 1}` };
}

interface StagehandCallLog {
  init: number;
  close: number;
  agent: Array<{ model?: string; systemPrompt?: string }>;
  execute: Array<{ instruction: string; maxSteps?: number }>;
}

function makeFakeStagehand(opts: {
  message?: string;
  actions?: number;
  pageUrl?: string;
  shouldThrow?: boolean;
  screenshotBytes?: Buffer;
}): { factory: StagehandFactory; log: StagehandCallLog } {
  const log: StagehandCallLog = {
    init: 0,
    close: 0,
    agent: [],
    execute: [],
  };
  const factory: StagehandFactory = (_factoryOpts) => {
    const sh: StagehandLike = {
      async init() {
        log.init += 1;
      },
      async close() {
        log.close += 1;
      },
      agent({ model, systemPrompt }) {
        log.agent.push({ model, systemPrompt });
        return {
          async execute(arg) {
            const { instruction, maxSteps } =
              typeof arg === "string" ? { instruction: arg, maxSteps: undefined } : arg;
            log.execute.push({ instruction, maxSteps });
            if (opts.shouldThrow) {
              throw new Error("stagehand_boom");
            }
            const n = opts.actions ?? 3;
            return {
              success: true,
              completed: true,
              message: opts.message ?? "Task completed.",
              actions: Array.from({ length: n }, (_, i) => ({ step: i + 1 })),
              metadata: {},
            };
          },
        };
      },
      page: opts.pageUrl
        ? {
            url: () => opts.pageUrl!,
            async screenshot() {
              return opts.screenshotBytes ?? Buffer.from("fakejpegbytes");
            },
          }
        : undefined,
    };
    return sh;
  };
  return { factory, log };
}

// ─── Lifecycle ───────────────────────────────────────────────────────────

beforeEach(() => {
  __resetAgentBrowserRateLimitForTests();
  __setSessionManagerForTests(null);
  __setStagehandFactoryForTests(null);
  allOn();
});

afterEach(() => {
  setFlags({});
  __resetAgentBrowserRateLimitForTests();
  __setSessionManagerForTests(null);
  __setStagehandFactoryForTests(null);
});

// ─── Allowlist matcher ───────────────────────────────────────────────────

describe("agent-browser-allowlist.domainMatches", () => {
  it("exact host (case + www-strip)", () => {
    expect(domainMatches("vercel.com", "vercel.com")).toBe(true);
    expect(domainMatches("WWW.Vercel.Com", "vercel.com")).toBe(true);
    expect(domainMatches("vercel.com", "github.com")).toBe(false);
  });

  it("suffix wildcard matches strict subdomain only (BRO1 R395 P1)", () => {
    expect(
      domainMatches("kioku-prod.up.railway.app", "*.up.railway.app"),
    ).toBe(true);
    // Bare base must NOT match the wildcard — that's the P1 requirement.
    expect(domainMatches("up.railway.app", "*.up.railway.app")).toBe(false);
  });

  it("rejects suffix-mismatch trick (up.railway.app.evil.com)", () => {
    expect(
      domainMatches("up.railway.app.evil.com", "*.up.railway.app"),
    ).toBe(false);
  });

  it("isHostAllowed returns false on empty allowlist", () => {
    setFlags({ LUCA_AGENT_BROWSER_ALLOWED_DOMAINS: "" });
    expect(isHostAllowed("vercel.com")).toBe(false);
  });
});

// ─── Flag stack ──────────────────────────────────────────────────────────

describe("agentBrowserHandler — flag stack", () => {
  it("status:disabled when LUCA_V1A_ENABLED is off", async () => {
    setFlags({
      LUCA_TOOLS_ENABLED: "true",
      LUCA_TOOL_AGENT_BROWSER_ENABLED: "true",
      LUCA_AGENT_BROWSER_ALLOWED_DOMAINS: "vercel.com",
    });
    const r = await agentBrowserHandler(
      { task: "Open the dashboard please.", domain: "vercel.com" },
      makeCtx(),
    );
    expect(r.status).toBe("disabled");
  });

  it("status:disabled when per-tool flag is off", async () => {
    setFlags({
      LUCA_V1A_ENABLED: "true",
      LUCA_TOOLS_ENABLED: "true",
      LUCA_AGENT_BROWSER_ALLOWED_DOMAINS: "vercel.com",
    });
    const r = await agentBrowserHandler(
      { task: "Open the dashboard please.", domain: "vercel.com" },
      makeCtx(),
    );
    expect(r.status).toBe("disabled");
  });

  it("status:disabled when LUCA_BROWSER_DISABLED kill-switch is on", async () => {
    allOn({ LUCA_BROWSER_DISABLED: "true" });
    const r = await agentBrowserHandler(
      { task: "Open the dashboard please.", domain: "vercel.com" },
      makeCtx(),
    );
    expect(r.status).toBe("disabled");
    expect(r.error ?? "").toMatch(/LUCA_BROWSER_DISABLED/);
  });

  it("status:disabled when allowlist is empty (defense-in-depth)", async () => {
    setFlags({
      LUCA_V1A_ENABLED: "true",
      LUCA_TOOLS_ENABLED: "true",
      LUCA_TOOL_AGENT_BROWSER_ENABLED: "true",
      LUCA_AGENT_BROWSER_ALLOWED_DOMAINS: "",
      BROWSERBASE_API_KEY: "k",
      BROWSERBASE_PROJECT_ID: "p",
    });
    const r = await agentBrowserHandler(
      { task: "Open the dashboard please.", domain: "vercel.com" },
      makeCtx(),
    );
    expect(r.status).toBe("disabled");
    expect(r.error ?? "").toMatch(/empty/);
  });
});

// ─── Domain block ────────────────────────────────────────────────────────

describe("agentBrowserHandler — domain allowlist", () => {
  it("returns domain_blocked and never touches session manager", async () => {
    const { mgr, log } = makeFakeManager();
    const { factory, log: shLog } = makeFakeStagehand({});
    __setStagehandFactoryForTests(factory);

    const r = await agentBrowserHandler(
      { task: "Do something on evil.com please.", domain: "evil.com" },
      { ...makeCtx(), agentBrowserSessionMgr: mgr },
    );
    expect(r.status).toBe("domain_blocked");
    expect(log.getOrCreate).toHaveLength(0);
    expect(shLog.init).toBe(0);
  });

  it("allows wildcard match against *.up.railway.app", async () => {
    const { mgr } = makeFakeManager();
    const { factory } = makeFakeStagehand({ message: "Found commit." });
    __setStagehandFactoryForTests(factory);

    const r = await agentBrowserHandler(
      {
        task: "Check Railway deployment status please.",
        domain: "kioku-prod.up.railway.app",
      },
      { ...makeCtx(), agentBrowserSessionMgr: mgr },
    );
    expect(r.status).toBe("ok");
  });
});

// ─── Input validation ────────────────────────────────────────────────────

describe("agentBrowserHandler — input validation", () => {
  it("rejects missing task", async () => {
    const r = await agentBrowserHandler(
      { domain: "vercel.com" },
      makeCtx(),
    );
    expect(r.status).toBe("input_invalid");
  });

  it("rejects task shorter than minimum", async () => {
    const tooShort = "x".repeat(AGENT_BROWSER_INSTRUCTION_MIN - 1);
    const r = await agentBrowserHandler(
      { task: tooShort, domain: "vercel.com" },
      makeCtx(),
    );
    expect(r.status).toBe("input_invalid");
  });

  it("rejects task longer than maximum", async () => {
    const tooLong = "y".repeat(AGENT_BROWSER_INSTRUCTION_MAX + 1);
    const r = await agentBrowserHandler(
      { task: tooLong, domain: "vercel.com" },
      makeCtx(),
    );
    expect(r.status).toBe("input_invalid");
  });

  it("rejects missing domain", async () => {
    const r = await agentBrowserHandler(
      { task: "Open the dashboard please." },
      makeCtx(),
    );
    expect(r.status).toBe("input_invalid");
  });

  it("rejects max_actions > hard cap as input_invalid (zod)", async () => {
    const r = await agentBrowserHandler(
      {
        task: "Open the dashboard please.",
        domain: "vercel.com",
        max_actions: AGENT_BROWSER_MAX_STEPS_CAP + 5,
      },
      makeCtx(),
    );
    // zod schema enforces max_actions ≤ AGENT_BROWSER_MAX_STEPS_CAP — anything
    // higher is rejected at input_invalid, not silently clamped. That keeps
    // the LLM honest about what it requested.
    expect(r.status).toBe("input_invalid");
  });
});

// ─── Happy path + Stagehand interaction ──────────────────────────────────

describe("agentBrowserHandler — happy path", () => {
  it("returns ok with summary, actions_taken, session_replay_url", async () => {
    const { mgr, log: mgrLog } = makeFakeManager();
    const { factory, log: shLog } = makeFakeStagehand({
      message: "Latest deploy: 4a6e843",
      actions: 4,
      pageUrl: "https://vercel.com/dashboard",
    });
    __setStagehandFactoryForTests(factory);

    const r = await agentBrowserHandler(
      {
        task: "Open vercel.com dashboard, find latest deploy.",
        domain: "vercel.com",
      },
      { ...makeCtx(), agentBrowserSessionMgr: mgr },
    );

    expect(r.status).toBe("ok");
    expect(r.result?.summary).toBe("Latest deploy: 4a6e843");
    expect(r.result?.actions_taken).toBe(4);
    expect(r.result?.final_url).toBe("https://vercel.com/dashboard");
    expect(r.result?.session_replay_url).toMatch(/browserbase\.com\/sessions\//);
    expect(mgrLog.getOrCreate).toEqual([{ userId: 7, domain: "vercel.com" }]);
    expect(mgrLog.release).toEqual([{ userId: 7, domain: "vercel.com" }]);
    expect(shLog.init).toBe(1);
    expect(shLog.close).toBe(1);
    expect(shLog.execute[0]?.maxSteps).toBe(AGENT_BROWSER_DEFAULT_MAX_STEPS);
    expect(shLog.agent[0]?.systemPrompt).toBe(DESTRUCTIVE_ACTION_GUARD);
  });

  it("includes screenshot_b64 when capture_screenshot=true", async () => {
    const { mgr } = makeFakeManager();
    const png = Buffer.from("FAKEJPEGBYTES");
    const { factory } = makeFakeStagehand({
      pageUrl: "https://github.com/x/y",
      screenshotBytes: png,
    });
    __setStagehandFactoryForTests(factory);

    const r = await agentBrowserHandler(
      {
        task: "Open the GitHub repo home please.",
        domain: "github.com",
        capture_screenshot: true,
      },
      { ...makeCtx(), agentBrowserSessionMgr: mgr },
    );
    expect(r.status).toBe("ok");
    expect(r.result?.screenshot_b64).toBe(png.toString("base64"));
  });

  it("R401: trims trailing newline from LUCA_AGENT_BROWSER_MODEL env", async () => {
    // Railway's variable editor leaves a trailing \n on some saves. Anthropic
    // 400s with the literal value echoed back ("model: <name>\n"), so we
    // strip whitespace before passing the value to Stagehand. Regression
    // for the 4-iteration prod debug session captured in this PR's body.
    const { mgr } = makeFakeManager();
    const { factory, log: shLog } = makeFakeStagehand({});
    __setStagehandFactoryForTests(factory);
    process.env.LUCA_AGENT_BROWSER_MODEL =
      "anthropic/claude-sonnet-4-5-20250929\n";

    await agentBrowserHandler(
      { task: "Browse the page please.", domain: "vercel.com" },
      { ...makeCtx(), agentBrowserSessionMgr: mgr },
    );
    expect(shLog.agent[0]?.model).toBe("anthropic/claude-sonnet-4-5-20250929");
  });

  it("R401: trims surrounding whitespace from LUCA_AGENT_BROWSER_MODEL env", async () => {
    const { mgr } = makeFakeManager();
    const { factory, log: shLog } = makeFakeStagehand({});
    __setStagehandFactoryForTests(factory);
    process.env.LUCA_AGENT_BROWSER_MODEL = "  anthropic/claude-sonnet-4-6  ";

    await agentBrowserHandler(
      { task: "Browse the page please.", domain: "vercel.com" },
      { ...makeCtx(), agentBrowserSessionMgr: mgr },
    );
    expect(shLog.agent[0]?.model).toBe("anthropic/claude-sonnet-4-6");
  });

  it("R401: falls back to AGENT_BROWSER_DEFAULT_MODEL when env is whitespace-only", async () => {
    const { AGENT_BROWSER_DEFAULT_MODEL } = await import(
      "../../lib/luca-tools/agent-browser"
    );
    const { mgr } = makeFakeManager();
    const { factory, log: shLog } = makeFakeStagehand({});
    __setStagehandFactoryForTests(factory);
    process.env.LUCA_AGENT_BROWSER_MODEL = "   \n  ";

    await agentBrowserHandler(
      { task: "Browse the page please.", domain: "vercel.com" },
      { ...makeCtx(), agentBrowserSessionMgr: mgr },
    );
    expect(shLog.agent[0]?.model).toBe(AGENT_BROWSER_DEFAULT_MODEL);
  });

  it("clamps max_actions to AGENT_BROWSER_MAX_STEPS_CAP at the boundary", async () => {
    // BRO1 R395 P5/Q5: hard cap = 20. Caller asking for exactly the cap
    // should pass through unchanged (this is the boundary test — the
    // input-validation block above covers cap+1).
    const { mgr } = makeFakeManager();
    const { factory, log: shLog } = makeFakeStagehand({});
    __setStagehandFactoryForTests(factory);

    await agentBrowserHandler(
      {
        task: "Browse the page please.",
        domain: "vercel.com",
        max_actions: AGENT_BROWSER_MAX_STEPS_CAP,
      },
      { ...makeCtx(), agentBrowserSessionMgr: mgr },
    );
    expect(shLog.execute[0]?.maxSteps).toBe(AGENT_BROWSER_MAX_STEPS_CAP);
  });
});

// ─── Error path ──────────────────────────────────────────────────────────

describe("agentBrowserHandler — Stagehand error", () => {
  it("returns status:error without throwing; cleanup still runs", async () => {
    const { mgr, log: mgrLog } = makeFakeManager();
    const { factory, log: shLog } = makeFakeStagehand({ shouldThrow: true });
    __setStagehandFactoryForTests(factory);

    const r = await agentBrowserHandler(
      {
        task: "Trigger the failure please.",
        domain: "vercel.com",
      },
      { ...makeCtx(), agentBrowserSessionMgr: mgr },
    );
    expect(r.status).toBe("error");
    expect(r.error ?? "").toMatch(/stagehand_boom/);
    // Cleanup invariants — close + release still called on the error path.
    expect(shLog.close).toBe(1);
    expect(mgrLog.release).toHaveLength(1);
  });

  it("returns status:error when session manager throws", async () => {
    const failingMgr = {
      async getOrCreate() {
        throw new Error("browserbase_503");
      },
      async releaseSession() {},
      forgetContext() {},
      __snapshot() {
        return new Map();
      },
    } as unknown as BrowserbaseSessionManager;
    const { factory, log: shLog } = makeFakeStagehand({});
    __setStagehandFactoryForTests(factory);

    const r = await agentBrowserHandler(
      {
        task: "Trigger the failure please.",
        domain: "vercel.com",
      },
      { ...makeCtx(), agentBrowserSessionMgr: failingMgr },
    );
    expect(r.status).toBe("error");
    expect(r.error ?? "").toMatch(/browserbase_503|session/);
    // Stagehand was never constructed because session acquisition failed.
    expect(shLog.init).toBe(0);
  });
});

// ─── Session reuse ───────────────────────────────────────────────────────

describe("agentBrowserHandler — per-(userId,domain) session reuse", () => {
  it("two sequential calls share the same manager key", async () => {
    const { mgr, log: mgrLog } = makeFakeManager();
    const { factory } = makeFakeStagehand({});
    __setStagehandFactoryForTests(factory);

    const ctx = { ...makeCtx(), agentBrowserSessionMgr: mgr };
    await agentBrowserHandler(
      { task: "First call please.", domain: "vercel.com" },
      ctx,
    );
    await agentBrowserHandler(
      { task: "Second call please.", domain: "vercel.com" },
      ctx,
    );
    // Two getOrCreate calls with the same key — manager handles reuse logic
    // internally; this proves the handler does NOT bypass the manager (which
    // would defeat per-domain cookie persistence).
    expect(mgrLog.getOrCreate).toEqual([
      { userId: 7, domain: "vercel.com" },
      { userId: 7, domain: "vercel.com" },
    ]);
    expect(mgrLog.release).toHaveLength(2);
  });
});

// ─── Rate limit ──────────────────────────────────────────────────────────

describe("agentBrowserHandler — rate limit", () => {
  it("returns rate_limited after AGENT_BROWSER_RATE_LIMIT.max calls", async () => {
    const { mgr } = makeFakeManager();
    const { factory } = makeFakeStagehand({});
    __setStagehandFactoryForTests(factory);

    const ctx = { ...makeCtx(), agentBrowserSessionMgr: mgr };
    for (let i = 0; i < AGENT_BROWSER_RATE_LIMIT.max; i += 1) {
      const r = await agentBrowserHandler(
        { task: `Iteration ${i} please.`, domain: "vercel.com" },
        ctx,
      );
      expect(r.status).toBe("ok");
    }
    const blocked = await agentBrowserHandler(
      { task: "Over the cap please.", domain: "vercel.com" },
      ctx,
    );
    expect(blocked.status).toBe("rate_limited");
    expect(blocked.error ?? "").toMatch(/rate limited/);
  });
});

// ─── Registry / dispatch integration ─────────────────────────────────────

describe("registry integration", () => {
  it("luca_agent_browser is listed in full tool specs", () => {
    const all = __getAllLucaToolSpecsForTests();
    expect(all.some((t) => t.name === "luca_agent_browser")).toBe(true);
  });

  it("getLucaTools() includes luca_agent_browser when all 3 flags on", () => {
    const tools = getLucaTools();
    expect(tools.some((t) => t.name === "luca_agent_browser")).toBe(true);
  });

  it("getLucaTools() omits luca_agent_browser when per-tool flag off", () => {
    setFlags({
      LUCA_V1A_ENABLED: "true",
      LUCA_TOOLS_ENABLED: "true",
      LUCA_AGENT_BROWSER_ALLOWED_DOMAINS: "vercel.com",
    });
    const tools = getLucaTools();
    expect(tools.some((t) => t.name === "luca_agent_browser")).toBe(false);
  });

  it("getLucaTools() embeds the live allowlist in the description", () => {
    setFlags({
      LUCA_V1A_ENABLED: "true",
      LUCA_TOOLS_ENABLED: "true",
      LUCA_TOOL_AGENT_BROWSER_ENABLED: "true",
      LUCA_AGENT_BROWSER_ALLOWED_DOMAINS: "github.com,docs.google.com",
    });
    const spec = getLucaTools().find((t) => t.name === "luca_agent_browser");
    expect(spec).toBeDefined();
    const domainProp =
      (spec!.input_schema.properties as Record<string, { description?: string }>)
        ?.domain?.description ?? "";
    expect(domainProp).toMatch(/github\.com/);
    expect(domainProp).toMatch(/docs\.google\.com/);
  });

  it("buildAgentBrowserTool() shows '(none configured)' when allowlist empty", () => {
    setFlags({
      LUCA_V1A_ENABLED: "true",
      LUCA_TOOLS_ENABLED: "true",
      LUCA_TOOL_AGENT_BROWSER_ENABLED: "true",
      LUCA_AGENT_BROWSER_ALLOWED_DOMAINS: "",
    });
    const built = buildAgentBrowserTool();
    const domainDesc =
      (built.input_schema.properties as Record<string, { description?: string }>)
        ?.domain?.description ?? "";
    expect(domainDesc).toMatch(/none configured/);
  });

  it("dispatchLucaTool routes luca_agent_browser to its handler", async () => {
    // Empty allowlist short-circuits to status:disabled — confirms routing
    // without any network egress.
    setFlags({
      LUCA_V1A_ENABLED: "true",
      LUCA_TOOLS_ENABLED: "true",
      LUCA_TOOL_AGENT_BROWSER_ENABLED: "true",
      LUCA_AGENT_BROWSER_ALLOWED_DOMAINS: "",
      BROWSERBASE_API_KEY: "k",
      BROWSERBASE_PROJECT_ID: "p",
    });
    const r = await dispatchLucaTool(
      "luca_agent_browser",
      { task: "Some specific task.", domain: "vercel.com" },
      // The dispatch ctx is a superset; agentId is the field this handler
      // reads. userId comes from the read-url-style ctx mock below.
      { userId: 7, agentId: 11 } as unknown as Parameters<typeof dispatchLucaTool>[2],
    );
    expect((r as { status: string }).status).toBe("disabled");
  });
});

// ─── Tool spec sanity ────────────────────────────────────────────────────

describe("agentBrowserTool spec", () => {
  it("has expected shape", () => {
    expect(agentBrowserTool.name).toBe("luca_agent_browser");
    expect(agentBrowserTool.description).toMatch(/Browserbase|Stagehand/);
    expect(agentBrowserTool.input_schema.type).toBe("object");
    expect(agentBrowserTool.input_schema.required).toEqual(["task", "domain"]);
    const props = agentBrowserTool.input_schema.properties as Record<
      string,
      unknown
    >;
    expect(props.task).toBeDefined();
    expect(props.domain).toBeDefined();
    expect(props.max_actions).toBeDefined();
    expect(props.capture_screenshot).toBeDefined();
  });
});
