/**
 * Luca V1a `agent_browser` tool — Stagehand-driven multi-step browser
 * automation in Browserbase managed Chromium.
 *
 * Why this tool exists (vs. the existing E2B + Puppeteer `browse_website`):
 *
 *   `browse_website` is fast and cheap but limited to ONE step:
 *     - extract_text (DOM after JS render) ✅
 *     - screenshot ✅
 *     - interact ❌ (closed by R366 — destructive-action blast radius)
 *   It cannot log in (E2B sandbox is ephemeral, no cookie persistence),
 *   chain steps, or react to what it sees.
 *
 *   `agent_browser` solves the "multi-step on a logged-in site" gap:
 *     - persistent per-(user, domain) Browserbase context retains cookies
 *       between turns
 *     - Stagehand `agent({ instructions }).execute(...)` plans + runs N
 *       actions to satisfy a natural-language task
 *     - per-domain allowlist (NOT global) — only sites Boss has approved
 *     - every session has video replay in Browserbase audit dashboard
 *
 * Layered defenses (any one of which disables the tool):
 *   1. Three-level Luca flag stack (master / tools-master / per-tool)
 *   2. `LUCA_BROWSER_DISABLED` global kill-switch (kills both this AND
 *      legacy browse_website at once — for "shut everything down NOW")
 *   3. Empty allowlist short-circuit (defense-in-depth — flag flip alone
 *      can't open a hole)
 *   4. Per-(userId,agentId) sliding-window rate limit (5/hour — separate
 *      counter from browse-website-guard, see agent-browser-guard.ts)
 *   5. Hard `maxSteps` cap of 20 — proxy for $-cap until we have real
 *      cost telemetry (BRO1 R395-Q5: real cost cap is R-future)
 *   6. Domain-scoped session — cookies do not bleed across domains
 *   7. Destructive-action guard in agent system prompt (BRO1 R395 P5):
 *      Delete / Cancel / Pay / Purchase / Confirm-payment require an
 *      EXPLICIT keyword in the user task; otherwise the agent must abort
 *      and return early with a question
 *
 * Ship-dark by default: `LUCA_TOOL_AGENT_BROWSER_ENABLED=false` at boot.
 * Boss flips manually after BRO3 mock smoke (BRO2 R356.5 commitment).
 *
 * Cost retrospective (BRO1 R395 P3): on every successful call we emit a
 * structured `logger.info` with userId, domain, actions_taken, sessionId,
 * duration_ms — grep-able for daily cost reconciliation against the
 * Browserbase dashboard during the 24h watch window.
 *
 * Note on Stagehand model choice (deviation from R392 prompt):
 *   R392 specified `claude-3-5-sonnet-20241022` per BRO1 R395 P2 — written
 *   before Stagehand v3 was published. v3's AgentProvider map (see
 *   node_modules/@browserbasehq/stagehand/.../agent/AgentProvider.js) does
 *   NOT include 3-5-sonnet, AND the codebase comment in analyze-image.ts
 *   (line 86) confirms "old claude-3-5-sonnet-20241022 alias returns
 *   not_found_error on current Anthropic API". Default is therefore
 *   `claude-sonnet-4-6` (matches analyze-image precedent, present in v3
 *   AgentProvider map, currently released). Same INTENT as P2 — released
 *   model, not aspirational. Override via LUCA_AGENT_BROWSER_MODEL.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { Stagehand } from "@browserbasehq/stagehand";
import {
  isLucaToolEnabled,
  LucaFeatureDisabledError,
} from "../luca/env";
import {
  isHostAllowed,
  getAllowedDomainPatterns,
  isAllowlistEmpty,
} from "./agent-browser-allowlist";
import {
  checkAgentBrowserRateLimit,
  AGENT_BROWSER_RATE_LIMIT,
} from "./agent-browser-guard";
import { BrowserbaseSessionManager } from "../luca-browser/session";
import logger from "../../logger";

// ─── Policy constants ────────────────────────────────────────────────────

/** Hard cap on agent steps per call — proxy for $-cap. */
export const AGENT_BROWSER_MAX_STEPS_CAP = 20;

/** Default steps when caller doesn't specify. */
export const AGENT_BROWSER_DEFAULT_MAX_STEPS = 20;

/** Min/max instruction length — prevents trivial empty prompts and runaway. */
export const AGENT_BROWSER_INSTRUCTION_MIN = 10;
export const AGENT_BROWSER_INSTRUCTION_MAX = 2_000;

/** Default Stagehand agent model — see module doc for deviation rationale. */
export const AGENT_BROWSER_DEFAULT_MODEL = "claude-sonnet-4-6";

/**
 * Destructive-action guard string injected into the agent's system prompt
 * (BRO1 R395 P5). Keyword list intentionally narrow — buttons commonly
 * mis-clicked by autonomous agents. The "EXPLICIT" check forces Boss to
 * actually intend the action; otherwise the agent must stop.
 */
export const DESTRUCTIVE_ACTION_GUARD =
  "CRITICAL SAFETY GUARDRAIL: You MUST NOT click buttons, links, or " +
  "controls labelled with destructive actions — Delete, Remove, Cancel, " +
  "Pay, Purchase, Buy, Confirm payment, Subscribe, Submit order — " +
  "UNLESS the user task EXPLICITLY uses that keyword. If the task is " +
  "ambiguous or the only path forward is a destructive button, stop " +
  "immediately and return a short summary explaining what you would " +
  "have done and why you stopped. Never optimise for task completion " +
  "over Boss's safety.";

// ─── Anthropic tool definition ───────────────────────────────────────────

/**
 * Builds the Anthropic tool spec. Embeds the live allowlist into the
 * `domain` description so the LLM sees exactly which domains are allowed
 * right now (rebuilt every call — env may change between turns).
 */
export function buildAgentBrowserTool(): Anthropic.Messages.Tool {
  const patterns = getAllowedDomainPatterns();
  const allowText = patterns.length
    ? `Allowed domains: ${patterns.join(", ")}.`
    : "Allowed domains: (none configured — tool will refuse all calls).";

  return {
    name: "luca_agent_browser",
    description:
      "Multi-step agentic browser running in Browserbase managed Chromium " +
      "with Stagehand. Use ONLY when (a) the site requires login (your " +
      "session is persisted per-domain across turns), (b) the task needs " +
      "multiple steps (click → fill → submit → read result), or (c) " +
      "luca_browse_website / luca_read_url cannot satisfy the task. " +
      "Each call costs ~$0.05–0.30 and 10–60 seconds. Hard cap " +
      `${AGENT_BROWSER_MAX_STEPS_CAP} actions per call. Domain must be in ` +
      "the allowlist. Refuses to click destructive actions (Delete, " +
      "Cancel, Pay, etc.) without explicit instruction.",
    input_schema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "Natural-language description of what to do. Be specific. " +
            "Example: 'Open vercel.com/dashboard, find project " +
            "ikonai-landing, return latest deployment status and commit SHA.'",
        },
        domain: {
          type: "string",
          description:
            `Single primary domain for this session (cookie scope). ${allowText} ` +
            "Must match exactly or via leading wildcard (e.g. *.up.railway.app " +
            "matches a strict subdomain).",
        },
        max_actions: {
          type: "number",
          description:
            `Max agent steps. Default ${AGENT_BROWSER_DEFAULT_MAX_STEPS}, ` +
            `hard cap ${AGENT_BROWSER_MAX_STEPS_CAP}.`,
        },
        capture_screenshot: {
          type: "boolean",
          description:
            "Return final page screenshot as base64 jpeg. Default false " +
            "(saves bandwidth and tokens).",
        },
      },
      required: ["task", "domain"],
    },
  };
}

/**
 * Spec snapshot used by the registry when dispatching. Re-built once per
 * registry call so the embedded allowlist stays fresh.
 */
export const agentBrowserTool: Anthropic.Messages.Tool = buildAgentBrowserTool();

// ─── Input schema ────────────────────────────────────────────────────────

const agentBrowserInputSchema = z.object({
  task: z
    .string()
    .min(AGENT_BROWSER_INSTRUCTION_MIN, `task must be ≥${AGENT_BROWSER_INSTRUCTION_MIN} chars`)
    .max(AGENT_BROWSER_INSTRUCTION_MAX, `task must be ≤${AGENT_BROWSER_INSTRUCTION_MAX} chars`),
  domain: z.string().min(3).max(255),
  max_actions: z
    .number()
    .int()
    .positive()
    .max(AGENT_BROWSER_MAX_STEPS_CAP)
    .optional(),
  capture_screenshot: z.boolean().optional(),
});

export type AgentBrowserValidatedInput = z.infer<typeof agentBrowserInputSchema>;

// ─── Session manager singleton ───────────────────────────────────────────

let _sessionMgr: BrowserbaseSessionManager | null = null;

/**
 * Lazy-init singleton. Constructed on first `agentBrowserHandler` call so
 * boot doesn't fail in dev where BROWSERBASE_API_KEY is unset.
 */
export function getSessionManager(): BrowserbaseSessionManager {
  if (_sessionMgr) return _sessionMgr;
  const apiKey = process.env.BROWSERBASE_API_KEY;
  const projectId = process.env.BROWSERBASE_PROJECT_ID;
  if (!apiKey || !projectId) {
    throw new LucaFeatureDisabledError(
      "agent_browser: BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID must be set",
    );
  }
  _sessionMgr = new BrowserbaseSessionManager({ apiKey, projectId });
  return _sessionMgr;
}

/** Test-only escape hatch — replaces the singleton with a stub. */
export function __setSessionManagerForTests(mgr: BrowserbaseSessionManager | null): void {
  _sessionMgr = mgr;
}

// ─── Stagehand factory (overridable for tests) ───────────────────────────

/**
 * Stagehand constructor wrapper — separated so tests can swap a stub
 * without touching the real Browserbase / Anthropic network paths.
 */
export interface StagehandLike {
  init(): Promise<void>;
  close(): Promise<void>;
  agent(opts: {
    model?: string;
    systemPrompt?: string;
  }): {
    execute: (
      instructionOrOptions:
        | string
        | { instruction: string; maxSteps?: number },
    ) => Promise<{
      success: boolean;
      message: string;
      actions: Array<Record<string, unknown>>;
      completed: boolean;
      metadata?: Record<string, unknown>;
    }>;
  };
  /** Optional — used only for screenshot capture. */
  page?: { url(): string; screenshot(opts?: unknown): Promise<Buffer> };
}

export type StagehandFactory = (opts: {
  apiKey: string;
  projectId: string;
  browserbaseSessionID: string;
}) => StagehandLike;

let _stagehandFactory: StagehandFactory = (opts) =>
  new Stagehand({
    env: "BROWSERBASE",
    apiKey: opts.apiKey,
    projectId: opts.projectId,
    browserbaseSessionID: opts.browserbaseSessionID,
  }) as unknown as StagehandLike;

export function __setStagehandFactoryForTests(factory: StagehandFactory | null): void {
  _stagehandFactory = factory ??
    ((opts) =>
      new Stagehand({
        env: "BROWSERBASE",
        apiKey: opts.apiKey,
        projectId: opts.projectId,
        browserbaseSessionID: opts.browserbaseSessionID,
      }) as unknown as StagehandLike);
}

// ─── Handler ─────────────────────────────────────────────────────────────

export interface AgentBrowserContext {
  userId: number;
  agentId: number;
  /**
   * Optional explicit override — when set, the handler uses this instead
   * of the lazy-init singleton. Tests pass a stub. Production handlers
   * leave this undefined.
   */
  agentBrowserSessionMgr?: BrowserbaseSessionManager;
}

export type AgentBrowserStatus =
  | "ok"
  | "disabled"
  | "domain_blocked"
  | "rate_limited"
  | "input_invalid"
  | "error";

export interface AgentBrowserResult {
  status: AgentBrowserStatus;
  result?: {
    summary: string;
    actions_taken: number;
    final_url?: string;
    screenshot_b64?: string;
    /** Browserbase dashboard URL for video replay — Boss audit hook. */
    session_replay_url: string;
  };
  error?: string;
}

/**
 * Reads the global kill-switch. Both this AND the per-tool flag must be
 * green for the tool to run.
 */
function isGlobalBrowserKillSwitchOn(): boolean {
  return process.env.LUCA_BROWSER_DISABLED === "true";
}

/** Lower-case + strip leading `www.` — same rule as the allowlist matcher. */
function normalizeDomain(domain: string): string {
  return domain.toLowerCase().replace(/^www\./, "");
}

export async function agentBrowserHandler(
  input: unknown,
  ctx: AgentBrowserContext,
): Promise<AgentBrowserResult> {
  const startedAt = Date.now();

  // 1. Three-level flag stack.
  if (!isLucaToolEnabled("LUCA_TOOL_AGENT_BROWSER_ENABLED")) {
    return { status: "disabled", error: "agent_browser flag is off" };
  }
  // 2. Global kill-switch.
  if (isGlobalBrowserKillSwitchOn()) {
    return {
      status: "disabled",
      error: "LUCA_BROWSER_DISABLED=true — global kill-switch engaged",
    };
  }
  // 3. Allowlist must be non-empty (defense-in-depth).
  if (isAllowlistEmpty()) {
    return {
      status: "disabled",
      error: "LUCA_AGENT_BROWSER_ALLOWED_DOMAINS is empty — tool refuses all calls",
    };
  }

  // 4. Input validation.
  const parsed = agentBrowserInputSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path?.length ? first.path.join(".") : "input";
    return {
      status: "input_invalid",
      error: `agent_browser.input: ${path}: ${first?.message ?? "invalid"}`,
    };
  }
  const { task, domain, max_actions, capture_screenshot } = parsed.data;
  const cleanDomain = normalizeDomain(domain);

  // 5. Allowlist match.
  if (!isHostAllowed(cleanDomain)) {
    return {
      status: "domain_blocked",
      error: `domain ${cleanDomain} is not in LUCA_AGENT_BROWSER_ALLOWED_DOMAINS`,
    };
  }

  // 6. Rate limit (5/hour per (userId,agentId) — separate counter).
  const rlKey = `${ctx.userId}:${ctx.agentId}:agent_browser`;
  if (!checkAgentBrowserRateLimit(rlKey)) {
    return {
      status: "rate_limited",
      error:
        `agent_browser rate limited at ${AGENT_BROWSER_RATE_LIMIT.max}/hour ` +
        `for agent ${ctx.agentId}`,
    };
  }

  const maxSteps = Math.min(
    max_actions ?? AGENT_BROWSER_DEFAULT_MAX_STEPS,
    AGENT_BROWSER_MAX_STEPS_CAP,
  );
  // R401: trim env value before handing it to Stagehand. Railway's variable
  // editor occasionally leaves a trailing newline/whitespace (we hit this
  // in production with LUCA_TOOLS_ENABLED and LUCA_AGENT_BROWSER_MODEL).
  // Anthropic 400s with the literal value echoed back ("model: <name>\n"),
  // which costs hours of misdiagnosis since a direct curl with the same
  // key+endpoint succeeds. Defensive trim here, plus log when we drop
  // whitespace so future regressions surface immediately.
  const rawModel = process.env.LUCA_AGENT_BROWSER_MODEL;
  const trimmedModel = rawModel != null ? rawModel.trim() : "";
  if (rawModel != null && rawModel !== trimmedModel) {
    logger.warn(
      {
        source: "luca_agent_browser",
        op: "env_whitespace_stripped",
        env: "LUCA_AGENT_BROWSER_MODEL",
        rawLength: rawModel.length,
        trimmedLength: trimmedModel.length,
      },
      "agent_browser: stripped whitespace/newline from LUCA_AGENT_BROWSER_MODEL env",
    );
  }
  const model = trimmedModel || AGENT_BROWSER_DEFAULT_MODEL;

  // 7. Acquire session via manager.
  const sessionMgr = ctx.agentBrowserSessionMgr ?? getSessionManager();
  let sessionId = "";
  try {
    const handle = await sessionMgr.getOrCreate({
      userId: ctx.userId,
      domain: cleanDomain,
    });
    sessionId = handle.sessionId;
  } catch (e) {
    logger.warn(
      { source: "luca_agent_browser", op: "session_create_failed", err: String(e) },
      "agent_browser: failed to create Browserbase session",
    );
    return {
      status: "error",
      error: `failed to acquire Browserbase session: ${String(e).slice(0, 200)}`,
    };
  }

  const apiKey = process.env.BROWSERBASE_API_KEY;
  const projectId = process.env.BROWSERBASE_PROJECT_ID;
  if (!apiKey || !projectId) {
    return {
      status: "disabled",
      error: "BROWSERBASE_API_KEY/PROJECT_ID unset — should have been caught earlier",
    };
  }

  const stagehand = _stagehandFactory({
    apiKey,
    projectId,
    browserbaseSessionID: sessionId,
  });

  let actionsTaken = 0;
  try {
    await stagehand.init();

    const agent = stagehand.agent({
      model,
      systemPrompt: DESTRUCTIVE_ACTION_GUARD,
    });

    const result = await agent.execute({ instruction: task, maxSteps });
    actionsTaken = Array.isArray(result.actions) ? result.actions.length : 0;

    let screenshot_b64: string | undefined;
    if (capture_screenshot && stagehand.page) {
      try {
        const buf = await stagehand.page.screenshot({
          fullPage: false,
          type: "jpeg",
          quality: 70,
        });
        screenshot_b64 = Buffer.from(buf).toString("base64");
      } catch (e) {
        logger.warn(
          { source: "luca_agent_browser", op: "screenshot_failed", err: String(e) },
          "agent_browser: screenshot capture failed (non-fatal)",
        );
      }
    }

    const finalUrl = stagehand.page ? safeUrl(stagehand.page) : undefined;
    const session_replay_url = `https://browserbase.com/sessions/${sessionId}`;

    // BRO1 R395 P3: cost retrospective evidence — emit on every success.
    logger.info(
      {
        source: "luca_agent_browser",
        op: "execute_ok",
        userId: ctx.userId,
        agentId: ctx.agentId,
        domain: cleanDomain,
        sessionId,
        actions_taken: actionsTaken,
        max_steps: maxSteps,
        model,
        duration_ms: Date.now() - startedAt,
      },
      "agent_browser execute ok",
    );

    return {
      status: "ok",
      result: {
        summary: result.message || (result.success ? "Task completed" : "Task incomplete"),
        actions_taken: actionsTaken,
        final_url: finalUrl,
        screenshot_b64,
        session_replay_url,
      },
    };
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    logger.warn(
      {
        source: "luca_agent_browser",
        op: "execute_failed",
        userId: ctx.userId,
        agentId: ctx.agentId,
        domain: cleanDomain,
        sessionId,
        actions_taken: actionsTaken,
        duration_ms: Date.now() - startedAt,
        err: errMsg,
      },
      "agent_browser execute failed",
    );
    return {
      status: "error",
      error: `agent_browser failed: ${errMsg.slice(0, 500)}`,
    };
  } finally {
    try {
      await stagehand.close();
    } catch {
      // best effort
    }
    try {
      await sessionMgr.releaseSession({
        userId: ctx.userId,
        domain: cleanDomain,
      });
    } catch {
      // best effort
    }
  }
}

/** Defensive — page.url() can throw if the page is closed. */
function safeUrl(page: { url(): string }): string | undefined {
  try {
    return page.url();
  } catch {
    return undefined;
  }
}
