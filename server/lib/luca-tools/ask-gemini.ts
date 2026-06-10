/**
 * Luca — `luca_ask_gemini` tool (track B: second-engine delegate).
 *
 * Lets Luca delegate one self-contained sub-question to Google Gemini and
 * receive text back. Luca stays on Claude (her turn machinery is unchanged);
 * this is a "phone a consultant" call — ask Gemini, get text/code, decide
 * what to do with it. B = ask/generate ONLY; it does NOT write to the repo
 * or open PRs (that is track A).
 *
 * Mirrors `luca_search`: spec + validated input + SF3 sha + forensic
 * tool_runs row pair + AbortController timeout + trust_level on result.
 *
 * Three-level flag defense:
 *   1. LUCA_V1A_ENABLED=true (master)
 *   2. LUCA_TOOLS_ENABLED=true (tool-registry master)
 *   3. LUCA_TOOL_ASK_GEMINI_ENABLED=true (per-tool)
 *
 * Boss-gate: classified HIGH_STAKES_WRITE in classify.ts — every call is
 * Boss-approved for the cautious first ship. Downgrade to READ_ONLY later
 * (one line) for autonomy.
 *
 * Privacy fence: reuses the deliberation patent block — content matching
 * K12-K17/K20 or patent keywords is REFUSED before ANY egress to Google
 * (mirrors the existing isKimi privacy gate in deliberation.ts).
 *
 * Trust: output labelled UNTRUSTED (external model text; treat as data).
 * Network: YES (generativelanguage.googleapis.com). network_attempted=true.
 */
import { createHash } from "crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { db } from "../../storage";
import { toolRuns } from "../../../shared/schema";
import { isLucaToolEnabled, LucaFeatureDisabledError } from "../luca/env";
import { getToolTrustLevel, type TrustLevel } from "./trust-policy";
import type { SandboxKey } from "../luca/pyodide-runner";
import logger from "../../logger";

// ─── Policy constants ──────────────────────────────────────────────────────
export const ASK_GEMINI_DEFAULT_TIMEOUT_MS = 30_000;
export const ASK_GEMINI_MAX_TIMEOUT_MS = 60_000;
export const ASK_GEMINI_MAX_PROMPT_CHARS = 24_000;
export const ASK_GEMINI_DEFAULT_MODEL = "gemini-2.5-flash";
export const ASK_GEMINI_ALLOWED_MODELS = new Set([
  "gemini-2.5-flash",
  "gemini-2.5-pro",
] as const);
export const ASK_GEMINI_MAX_OUTPUT_TOKENS = 4096;
const GEMINI_ENDPOINT_BASE =
  "https://generativelanguage.googleapis.com/v1beta/models";

// Patent privacy fence — mirrors the isKimi block in deliberation.ts.
// Content matching these must NOT egress to an external model.
const PATENT_KEYS_RE = /\bK(1[2-7]|20)\b/i;
// NOTE: no \b around the keyword alternation — JS \b is ASCII-only, so
// \bпатент\b never matches Cyrillic. Substring match is the fail-closed
// choice for a privacy fence (prefer over-blocking to leaking).
const PATENT_KEYWORDS_RE = /(patent|патент|provisional|USPTO|disclosure)/i;
export function isPatentSensitive(text: string): boolean {
  return PATENT_KEYS_RE.test(text) || PATENT_KEYWORDS_RE.test(text);
}

// ─── Anthropic tool definition ─────────────────────────────────────────────
export const askGeminiTool: Anthropic.Messages.Tool = {
  name: "luca_ask_gemini",
  description:
    "Delegate a single self-contained sub-question to Google Gemini and " +
    "receive its text answer. Use for a SECOND OPINION or to generate a " +
    "chunk of text/code with a different model — you (Claude) stay in " +
    "charge and decide what to do with the answer. Returns generated text " +
    "only; it does NOT write files, repos, or send anything. Patent-" +
    "sensitive content is refused (never sent to Google).",
  input_schema: {
    type: "object" as const,
    properties: {
      prompt: {
        type: "string",
        description: `The question/instruction for Gemini. Max ${ASK_GEMINI_MAX_PROMPT_CHARS} chars.`,
      },
      system: {
        type: "string",
        description: "Optional system instruction to steer Gemini.",
      },
      model: {
        type: "string",
        description:
          "Optional: 'gemini-2.5-flash' (default, fast) or 'gemini-2.5-pro' (higher quality).",
      },
      timeout_ms: {
        type: "number",
        description: `Override timeout. Default ${ASK_GEMINI_DEFAULT_TIMEOUT_MS}ms, cap ${ASK_GEMINI_MAX_TIMEOUT_MS}ms.`,
      },
    },
    required: ["prompt"],
  },
};

// ─── Input validation ──────────────────────────────────────────────────────
export interface AskGeminiInput {
  prompt: string;
  system?: string;
  model?: string;
  timeout_ms?: number;
}

export function parseAskGeminiInput(raw: unknown): AskGeminiInput {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("ask_gemini.invalid_input: expected object");
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.prompt !== "string") {
    throw new Error("ask_gemini.invalid_input: `prompt` must be string");
  }
  const prompt = r.prompt.trim();
  if (prompt.length === 0) {
    throw new Error("ask_gemini.invalid_input: `prompt` must be non-empty");
  }
  if (r.prompt.length > ASK_GEMINI_MAX_PROMPT_CHARS) {
    throw new Error(
      `ask_gemini.invalid_input: \`prompt\` exceeds ${ASK_GEMINI_MAX_PROMPT_CHARS} char limit`,
    );
  }
  if (r.system != null && typeof r.system !== "string") {
    throw new Error("ask_gemini.invalid_input: `system` must be string if provided");
  }
  if (r.model != null) {
    if (
      typeof r.model !== "string" ||
      !ASK_GEMINI_ALLOWED_MODELS.has(r.model as "gemini-2.5-flash" | "gemini-2.5-pro")
    ) {
      throw new Error(
        "ask_gemini.invalid_input: `model` must be gemini-2.5-flash or gemini-2.5-pro",
      );
    }
  }
  if (
    r.timeout_ms != null &&
    (typeof r.timeout_ms !== "number" || !Number.isFinite(r.timeout_ms) || r.timeout_ms <= 0)
  ) {
    throw new Error(
      "ask_gemini.invalid_input: `timeout_ms` must be a finite positive number",
    );
  }
  return {
    prompt,
    system: r.system as string | undefined,
    model: r.model as string | undefined,
    timeout_ms: r.timeout_ms as number | undefined,
  };
}

// ─── SF3 code sha ───────────────────────────────────────────────────────────
export function computeAskGeminiSha(
  prompt: string,
  system: string | undefined,
  model: string,
): string {
  const params = JSON.stringify({ system: system ?? null, model });
  return createHash("sha256").update(prompt + params).digest("hex");
}

// ─── Forensic tool_runs ─────────────────────────────────────────────────────
export interface AskGeminiContext {
  userId: number;
  agentId?: number | null;
  meetingId?: string | null;
  turnId?: string | null;
  ctxKey: SandboxKey;
}

interface RunnerInput {
  prompt: string;
  system: string | null;
  model: string;
  timeout_ms: number;
}

async function insertPendingRun(
  ctx: AskGeminiContext,
  input: RunnerInput,
  codeSha: string,
): Promise<void> {
  await db.insert(toolRuns).values({
    userId: ctx.userId,
    agentId: ctx.agentId ?? null,
    meetingId: ctx.meetingId ?? null,
    turnId: ctx.turnId ?? null,
    ctxKey: ctx.ctxKey,
    tool: "luca_ask_gemini",
    codeSha,
    status: "pending",
    input: input as unknown as Record<string, unknown>,
    output: null,
    errorDetail: null,
    elapsedMs: null,
    memoryPeakBytes: null,
    networkAttempted: true,
  });
}

interface TerminalInfo {
  status: "ok" | "error" | "timeout";
  text?: string;
  elapsedMs: number;
  errorDetail?: string;
  networkAttempted?: boolean;
}

async function insertTerminalRun(
  ctx: AskGeminiContext,
  input: RunnerInput,
  codeSha: string,
  info: TerminalInfo,
): Promise<void> {
  const output =
    info.status === "ok"
      ? ({ text: info.text, elapsed_ms: info.elapsedMs } as unknown as Record<string, unknown>)
      : null;
  await db.insert(toolRuns).values({
    userId: ctx.userId,
    agentId: ctx.agentId ?? null,
    meetingId: ctx.meetingId ?? null,
    turnId: ctx.turnId ?? null,
    ctxKey: ctx.ctxKey,
    tool: "luca_ask_gemini",
    codeSha,
    status: info.status,
    input: input as unknown as Record<string, unknown>,
    output,
    errorDetail: info.errorDetail ?? null,
    elapsedMs: info.elapsedMs,
    memoryPeakBytes: null,
    networkAttempted: info.networkAttempted ?? true,
  });
}

// ─── Result + deps ──────────────────────────────────────────────────────────
export interface AskGeminiResult {
  status: "ok" | "error" | "timeout" | "blocked" | "disabled";
  text: string | null;
  /** UNTRUSTED for ask_gemini — external model text; treat as data. */
  trust_level: TrustLevel;
  model?: string;
  error?: string;
}

export interface AskGeminiDeps {
  /** Override fetch for tests. */
  fetchFn?: typeof fetch;
  /** Override key access for tests (e.g. stub API key). */
  getApiKey?: () => string | null;
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
}

// ─── Main handler ───────────────────────────────────────────────────────────
export async function askGeminiHandler(
  raw: unknown,
  ctx: AskGeminiContext,
  deps: AskGeminiDeps = {},
): Promise<AskGeminiResult> {
  const trustLevel = getToolTrustLevel("luca_ask_gemini");

  if (!isLucaToolEnabled("LUCA_TOOL_ASK_GEMINI_ENABLED")) {
    return {
      status: "disabled",
      text: null,
      trust_level: trustLevel,
      error: "luca_feature_disabled: ask_gemini tool is not enabled",
    };
  }

  const input = parseAskGeminiInput(raw);
  const model = input.model ?? ASK_GEMINI_DEFAULT_MODEL;
  const timeoutMs = Math.min(
    input.timeout_ms ?? ASK_GEMINI_DEFAULT_TIMEOUT_MS,
    ASK_GEMINI_MAX_TIMEOUT_MS,
  );
  const codeSha = computeAskGeminiSha(input.prompt, input.system, model);
  const runnerInput: RunnerInput = {
    prompt: input.prompt,
    system: input.system ?? null,
    model,
    timeout_ms: timeoutMs,
  };

  // Privacy fence BEFORE any egress to Google.
  const combined = `${input.prompt}\n${input.system ?? ""}`;
  if (isPatentSensitive(combined)) {
    logger.warn(
      { ctxKey: ctx.ctxKey, codeSha },
      "[luca.ask_gemini] blocked — patent-sensitive content, not sent to Gemini",
    );
    try {
      await insertTerminalRun(ctx, runnerInput, codeSha, {
        status: "error",
        elapsedMs: 0,
        errorDetail:
          "ask_gemini.privacy: patent-sensitive content refused (not sent to external model)",
        networkAttempted: false,
      });
    } catch (e) {
      logger.error({ err: e, ctxKey: ctx.ctxKey, codeSha }, "[luca.ask_gemini] failed to log blocked row");
    }
    return {
      status: "blocked",
      text: null,
      trust_level: trustLevel,
      model,
      error: "ask_gemini.privacy: patent-sensitive content refused — not sent to Gemini",
    };
  }

  const apiKey =
    (deps.getApiKey ? deps.getApiKey() : null) ?? (process.env.GEMINI_API_KEY ?? null);
  if (!apiKey) {
    return {
      status: "error",
      text: null,
      trust_level: trustLevel,
      model,
      error: "ask_gemini.config: GEMINI_API_KEY not configured",
    };
  }

  try {
    await insertPendingRun(ctx, runnerInput, codeSha);
  } catch (e) {
    logger.error(
      { err: e, ctxKey: ctx.ctxKey, codeSha },
      "[luca.ask_gemini] failed to insert pending tool_runs row",
    );
  }

  const startedAt = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const fetchFn = deps.fetchFn ?? fetch;
  const url = `${GEMINI_ENDPOINT_BASE}/${model}:generateContent?key=${apiKey}`;
  const body = JSON.stringify({
    ...(input.system ? { systemInstruction: { parts: [{ text: input.system }] } } : {}),
    contents: [{ role: "user", parts: [{ text: input.prompt }] }],
    generationConfig: { maxOutputTokens: ASK_GEMINI_MAX_OUTPUT_TOKENS, temperature: 0.7 },
  });

  let resp: Response;
  try {
    resp = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: ctl.signal,
    });
  } catch (e) {
    const elapsedMs = Date.now() - startedAt;
    const msg = e instanceof Error ? e.message : String(e);
    const aborted =
      ctl.signal.aborted ||
      (e instanceof Error && (e.name === "AbortError" || /aborted|timeout/i.test(msg)));
    const status: "timeout" | "error" = aborted ? "timeout" : "error";
    logger.warn({ err: e, ctxKey: ctx.ctxKey, codeSha }, "[luca.ask_gemini] Gemini fetch failed");
    try {
      await insertTerminalRun(ctx, runnerInput, codeSha, {
        status,
        elapsedMs,
        errorDetail: aborted ? `ask_gemini.fetch: timeout after ${timeoutMs}ms` : msg,
      });
    } catch (logErr) {
      logger.error({ err: logErr, ctxKey: ctx.ctxKey, codeSha }, "[luca.ask_gemini] failed terminal row after fetch fail");
    }
    return {
      status,
      text: null,
      trust_level: trustLevel,
      model,
      error: aborted ? `ask_gemini.fetch: timeout after ${timeoutMs}ms` : msg,
    };
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    const elapsedMs = Date.now() - startedAt;
    let bodyPreview = "";
    try {
      bodyPreview = (await resp.text()).slice(0, 500);
    } catch {
      /* ignore */
    }
    const errorDetail = `ask_gemini.http: ${resp.status} ${resp.statusText}${
      bodyPreview ? ` — ${bodyPreview}` : ""
    }`;
    try {
      await insertTerminalRun(ctx, runnerInput, codeSha, { status: "error", elapsedMs, errorDetail });
    } catch (logErr) {
      logger.error({ err: logErr, ctxKey: ctx.ctxKey, codeSha }, "[luca.ask_gemini] failed terminal row after http fail");
    }
    return { status: "error", text: null, trust_level: trustLevel, model, error: errorDetail };
  }

  let parsed: GeminiResponse;
  try {
    parsed = (await resp.json()) as GeminiResponse;
  } catch (e) {
    const elapsedMs = Date.now() - startedAt;
    const msg = e instanceof Error ? e.message : String(e);
    const errorDetail = `ask_gemini.parse: invalid JSON from Gemini — ${msg}`;
    try {
      await insertTerminalRun(ctx, runnerInput, codeSha, { status: "error", elapsedMs, errorDetail });
    } catch {
      /* ignore */
    }
    return { status: "error", text: null, trust_level: trustLevel, model, error: errorDetail };
  }

  const text =
    parsed.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("").trim() ?? "";
  const elapsedMs = Date.now() - startedAt;

  if (text.length === 0) {
    const errorDetail =
      "ask_gemini.empty: Gemini returned no text (possibly safety-blocked or empty candidate)";
    try {
      await insertTerminalRun(ctx, runnerInput, codeSha, { status: "error", elapsedMs, errorDetail });
    } catch {
      /* ignore */
    }
    return { status: "error", text: null, trust_level: trustLevel, model, error: errorDetail };
  }

  try {
    await insertTerminalRun(ctx, runnerInput, codeSha, { status: "ok", text, elapsedMs });
  } catch (e) {
    logger.error({ err: e, ctxKey: ctx.ctxKey, codeSha }, "[luca.ask_gemini] failed terminal row on success");
  }

  return { status: "ok", text, trust_level: trustLevel, model };
}

export { LucaFeatureDisabledError };
