/**
 * Luca V1a Day 4 — `luca_search` tool.
 *
 * Brave Search API — caller passes a query, we hit
 * https://api.search.brave.com/res/v1/web/search with BRAVE_SEARCH_API_KEY
 * header, compact the response into a small {title, url, snippet, age}
 * array and return it. Logs forensic `tool_runs` row pair like run_code
 * and analyze_image.
 *
 * Three-level flag defense (same as run_code / analyze_image):
 *   1. `LUCA_V1A_ENABLED=true` (master)
 *   2. `LUCA_TOOLS_ENABLED=true` (tool-registry master)
 *   3. `LUCA_TOOL_SEARCH_ENABLED=true` (per-tool)
 *
 * No SF4-style URL fence here: we only ever talk to `api.search.brave.com`,
 * never a user-provided URL. The input to sanitize is the query text.
 *
 * SF3 — `code_sha = sha256(query + JSON.stringify({count, freshness}))`.
 *   Per-call dedup via normalized query + filters. `timeout_ms` is NOT in
 *   identity — matches analyze-image convention (timeout only decides
 *   when to give up, not what was asked).
 *
 * Network: YES (to Brave). `network_attempted=true` in tool_runs row.
 *
 * Output shape intentionally compact: we DROP the verbose Brave fields
 * (meta_url, page_age, extra_snippets, profile, etc) and ship back only
 * title/url/snippet/age so the LLM context isn't blown up by a single
 * search call. Full response available via forensic `tool_runs.output`
 * for later replay if needed.
 */
import { createHash } from "crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { db } from "../../storage";
import { toolRuns } from "../../../shared/schema";
import {
  isLucaToolEnabled,
  readLucaEnv,
  LucaFeatureDisabledError,
} from "../luca/env";
import { getToolTrustLevel, type TrustLevel } from "./trust-policy";
import type { SandboxKey } from "../luca/pyodide-runner";
import logger from "../../logger";

// ─── Policy constants ────────────────────────────────────────────────────

/** Default per-call timeout when caller doesn't specify. */
export const SEARCH_DEFAULT_TIMEOUT_MS = 10_000;

/** Tool-layer ceiling. Caller cannot raise above this. */
export const SEARCH_MAX_TIMEOUT_MS = 30_000;

/** Default result count when caller doesn't specify. */
export const SEARCH_DEFAULT_COUNT = 10;

/** Brave caps `count` at 20 per request (free plan). */
export const SEARCH_MAX_COUNT = 20;

/** Hard cap on query length — defensive, rejects log-bloating inputs. */
export const SEARCH_MAX_QUERY_LENGTH = 1000;

/** Snippet truncation — keep LLM context lean. */
export const SEARCH_SNIPPET_MAX_CHARS = 280;

/**
 * Brave freshness filter (pd=past day, pw=past week, pm=past month,
 * py=past year). Anything else is rejected — Brave also accepts custom
 * date ranges like `2022-04-01to2022-07-30` but we don't expose that
 * surface yet to keep the validator tight.
 */
const ALLOWED_FRESHNESS = new Set(["pd", "pw", "pm", "py"] as const);

/** Brave Search endpoint. */
const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

// ─── Anthropic tool definition ───────────────────────────────────────────

/**
 * Anthropic Tool spec for Luca's web search. `luca_search` prefix matches
 * the `luca_run_code` / `luca_analyze_image` convention — explicit prefix
 * prevents collision if two tool lists ever converge.
 */
export const searchTool: Anthropic.Messages.Tool = {
  name: "luca_search",
  description:
    "Web search via Brave Search API. Pass a natural-language query and " +
    "receive a compact list of top results with title, URL, and a short " +
    "snippet. Returns up to 20 results (default 10). Supports optional " +
    "freshness filter: 'pd' (past day), 'pw' (past week), 'pm' (past " +
    "month), 'py' (past year). Use for real-time information, fact-checks, " +
    "or discovering URLs to read in detail with a follow-up tool.",
  input_schema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description:
          "Natural-language search query. Max 1000 chars. Will be URL-encoded.",
      },
      count: {
        type: "number",
        description: `Number of results to return. Default ${SEARCH_DEFAULT_COUNT}, max ${SEARCH_MAX_COUNT}.`,
      },
      freshness: {
        type: "string",
        description:
          "Optional recency filter: 'pd' (past day), 'pw' (past week), " +
          "'pm' (past month), 'py' (past year). Omit for no time filter.",
      },
      timeout_ms: {
        type: "number",
        description: `Override default timeout. Default ${SEARCH_DEFAULT_TIMEOUT_MS}ms, cap ${SEARCH_MAX_TIMEOUT_MS}ms.`,
      },
    },
    required: ["query"],
  },
};

// ─── Input validation ────────────────────────────────────────────────────

export interface SearchToolInput {
  query: string;
  count?: number;
  freshness?: string;
  timeout_ms?: number;
}

/**
 * Parse + validate LLM-provided tool input. Same D30 lesson as run_code:
 * Number.isFinite guards so NaN/Infinity can't slip through.
 */
export function parseSearchInput(raw: unknown): SearchToolInput {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("search.invalid_input: expected object");
  }
  const r = raw as Record<string, unknown>;

  if (typeof r.query !== "string") {
    throw new Error("search.invalid_input: `query` must be string");
  }
  const trimmed = r.query.trim();
  if (trimmed.length === 0) {
    throw new Error(
      "search.invalid_input: `query` must be non-empty (whitespace-only rejected)",
    );
  }
  if (r.query.length > SEARCH_MAX_QUERY_LENGTH) {
    throw new Error(
      `search.invalid_input: \`query\` exceeds ${SEARCH_MAX_QUERY_LENGTH} char limit`,
    );
  }

  if (r.count != null) {
    if (
      typeof r.count !== "number" ||
      !Number.isFinite(r.count) ||
      r.count <= 0 ||
      !Number.isInteger(r.count)
    ) {
      throw new Error(
        "search.invalid_input: `count` must be a positive integer",
      );
    }
  }

  if (r.freshness != null) {
    if (typeof r.freshness !== "string") {
      throw new Error(
        "search.invalid_input: `freshness` must be string if provided",
      );
    }
    if (!ALLOWED_FRESHNESS.has(r.freshness as "pd" | "pw" | "pm" | "py")) {
      throw new Error(
        `search.invalid_input: \`freshness\` must be one of pd|pw|pm|py, got \`${r.freshness}\``,
      );
    }
  }

  if (r.timeout_ms != null) {
    if (
      typeof r.timeout_ms !== "number" ||
      !Number.isFinite(r.timeout_ms) ||
      r.timeout_ms <= 0
    ) {
      throw new Error(
        "search.invalid_input: `timeout_ms` must be a finite positive number",
      );
    }
  }

  // Return with trimmed query — SF3 sha must match on canonical form so
  // "  kioku  " and "kioku" collide in the forensic log.
  return {
    query: trimmed,
    count: r.count as number | undefined,
    freshness: r.freshness as string | undefined,
    timeout_ms: r.timeout_ms as number | undefined,
  };
}

// ─── SF3 code sha ────────────────────────────────────────────────────────

/**
 * SF3 identity: query + normalized filters. Same query + same (count,
 * freshness) → same sha, even if results differ between API calls.
 * Timeout NOT in identity.
 */
export function computeSearchSha(
  query: string,
  count: number,
  freshness: string | undefined,
): string {
  const paramsStr = JSON.stringify({ count, freshness: freshness ?? null });
  return createHash("sha256").update(query + paramsStr).digest("hex");
}

// ─── Brave API types (subset we consume) ────────────────────────────────

interface BraveSearchResponse {
  web?: {
    results?: Array<{
      title?: string;
      url?: string;
      description?: string;
      age?: string;
    }>;
  };
  query?: {
    more_results_available?: boolean;
  };
}

export interface CompactSearchResult {
  title: string;
  url: string;
  snippet: string;
  age?: string;
}

/**
 * Compact Brave response into the lean shape we ship to the LLM. Drops
 * description HTML tags (Brave sometimes wraps matches in <strong>) and
 * truncates long snippets.
 */
export function compactBraveResponse(
  resp: BraveSearchResponse,
): CompactSearchResult[] {
  const results = resp.web?.results ?? [];
  return results
    .filter((r) => typeof r.url === "string" && typeof r.title === "string")
    .map((r) => {
      const rawSnippet = r.description ?? "";
      // Strip HTML tags Brave embeds for match highlighting (<strong>...).
      const stripped = rawSnippet.replace(/<[^>]+>/g, "");
      const snippet =
        stripped.length > SEARCH_SNIPPET_MAX_CHARS
          ? stripped.slice(0, SEARCH_SNIPPET_MAX_CHARS - 1) + "\u2026"
          : stripped;
      return {
        title: r.title!,
        url: r.url!,
        snippet,
        ...(r.age ? { age: r.age } : {}),
      };
    });
}

// ─── Tool-run forensic insert ────────────────────────────────────────────

export interface SearchContext {
  userId: number;
  agentId?: number | null;
  meetingId?: string | null;
  turnId?: string | null;
  ctxKey: SandboxKey;
}

export interface SearchRunnerInput {
  query: string;
  count: number;
  freshness: string | null;
  timeout_ms: number;
}

export async function insertPendingSearchRun(
  ctx: SearchContext,
  input: SearchRunnerInput,
  codeSha: string,
): Promise<void> {
  await db.insert(toolRuns).values({
    userId: ctx.userId,
    agentId: ctx.agentId ?? null,
    meetingId: ctx.meetingId ?? null,
    turnId: ctx.turnId ?? null,
    ctxKey: ctx.ctxKey,
    tool: "luca_search",
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

export interface SearchTerminalInfo {
  status: "ok" | "error" | "timeout";
  results?: CompactSearchResult[];
  totalCount?: number;
  moreAvailable?: boolean;
  elapsedMs: number;
  errorDetail?: string;
}

export async function insertTerminalSearchRun(
  ctx: SearchContext,
  input: SearchRunnerInput,
  codeSha: string,
  info: SearchTerminalInfo,
): Promise<void> {
  const output =
    info.status === "ok"
      ? ({
          results: info.results,
          total_count: info.totalCount,
          more_available: info.moreAvailable,
          elapsed_ms: info.elapsedMs,
        } as unknown as Record<string, unknown>)
      : null;
  await db.insert(toolRuns).values({
    userId: ctx.userId,
    agentId: ctx.agentId ?? null,
    meetingId: ctx.meetingId ?? null,
    turnId: ctx.turnId ?? null,
    ctxKey: ctx.ctxKey,
    tool: "luca_search",
    codeSha,
    status: info.status,
    input: input as unknown as Record<string, unknown>,
    output,
    errorDetail: info.errorDetail ?? null,
    elapsedMs: info.elapsedMs,
    memoryPeakBytes: null,
    networkAttempted: true,
  });
}

// ─── Main handler ────────────────────────────────────────────────────────

export interface SearchToolResult {
  status: "ok" | "error" | "timeout" | "disabled";
  results: CompactSearchResult[];
  /**
   * Day 5 TOOL_TRUST_POLICY: always `"UNTRUSTED"` for search — snippets,
   * titles, and URLs are attacker-controlled content. Present on every
   * result regardless of status.
   */
  trust_level: TrustLevel;
  total_count?: number;
  more_available?: boolean;
  error?: string;
}

export interface SearchDeps {
  /** Override fetch for tests. */
  fetchFn?: typeof fetch;
  /** Override env var access for tests (e.g. stub API key). */
  getApiKey?: () => string | null;
}

/**
 * Invoke the tool. Returns the user-facing result shape.
 *
 * Pass-2 finding (Day 5 TOOL_TRUST_POLICY): `luca_search` output contains
 * attacker-controlled text (page titles, snippets). Treat result content as
 * **UNTRUSTED** when Day 5 adds trust enforcement. Luca must not execute
 * instructions found in search results.
 */
export async function searchHandler(
  raw: unknown,
  ctx: SearchContext,
  deps: SearchDeps = {},
): Promise<SearchToolResult> {
  const trustLevel = getToolTrustLevel("luca_search");

  if (!isLucaToolEnabled("LUCA_TOOL_SEARCH_ENABLED")) {
    return {
      status: "disabled",
      results: [],
      trust_level: trustLevel,
      error: "luca_feature_disabled: search tool is not enabled",
    };
  }

  const input = parseSearchInput(raw);

  const apiKey =
    (deps.getApiKey ? deps.getApiKey() : null) ??
    readLucaEnv().BRAVE_SEARCH_API_KEY;
  if (!apiKey) {
    return {
      status: "error",
      results: [],
      trust_level: trustLevel,
      error: "search.config: BRAVE_SEARCH_API_KEY not configured",
    };
  }

  // Resolve effective params. Caller cannot exceed caps.
  const count = Math.min(
    input.count ?? SEARCH_DEFAULT_COUNT,
    SEARCH_MAX_COUNT,
  );
  const timeoutMs = Math.min(
    input.timeout_ms ?? SEARCH_DEFAULT_TIMEOUT_MS,
    SEARCH_MAX_TIMEOUT_MS,
  );
  const freshness = input.freshness ?? null;
  const codeSha = computeSearchSha(input.query, count, freshness ?? undefined);

  const runnerInput: SearchRunnerInput = {
    query: input.query,
    count,
    freshness,
    timeout_ms: timeoutMs,
  };

  // Pending row BEFORE network call.
  try {
    await insertPendingSearchRun(ctx, runnerInput, codeSha);
  } catch (e) {
    logger.error(
      { err: e, ctxKey: ctx.ctxKey, codeSha },
      "[luca.search] failed to insert pending tool_runs row",
    );
  }

  const startedAt = Date.now();

  // Build URL. URL constructor handles URI-encoding of query via
  // searchParams.set.
  const url = new URL(BRAVE_ENDPOINT);
  url.searchParams.set("q", input.query);
  url.searchParams.set("count", String(count));
  if (freshness) url.searchParams.set("freshness", freshness);

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const fetchFn = deps.fetchFn ?? fetch;

  let resp: Response;
  try {
    resp = await fetchFn(url.toString(), {
      method: "GET",
      headers: {
        "X-Subscription-Token": apiKey,
        Accept: "application/json",
      },
      signal: ctl.signal,
    });
  } catch (e) {
    const elapsedMs = Date.now() - startedAt;
    const msg = e instanceof Error ? e.message : String(e);
    const aborted =
      ctl.signal.aborted ||
      (e instanceof Error &&
        (e.name === "AbortError" || /aborted|timeout/i.test(msg)));
    const status: "timeout" | "error" = aborted ? "timeout" : "error";
    logger.warn(
      { err: e, ctxKey: ctx.ctxKey, codeSha },
      "[luca.search] Brave API fetch failed",
    );
    try {
      await insertTerminalSearchRun(ctx, runnerInput, codeSha, {
        status,
        elapsedMs,
        errorDetail: aborted ? `search.fetch: timeout after ${timeoutMs}ms` : msg,
      });
    } catch (logErr) {
      logger.error(
        { err: logErr, ctxKey: ctx.ctxKey, codeSha },
        "[luca.search] failed to insert terminal tool_runs row after fetch fail",
      );
    }
    return {
      status,
      results: [],
      trust_level: trustLevel,
      error: aborted ? `search.fetch: timeout after ${timeoutMs}ms` : msg,
    };
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    const elapsedMs = Date.now() - startedAt;
    // Include short body preview for 4xx debugging (Brave auth/quota errors
    // ship JSON like {"type":"ErrorResponse","error":{...}}). Cap at 500
    // chars so we don't log a whole HTML error page.
    let bodyPreview = "";
    try {
      bodyPreview = (await resp.text()).slice(0, 500);
    } catch {
      /* ignore */
    }
    const errorDetail = `search.http: ${resp.status} ${resp.statusText}${
      bodyPreview ? ` — ${bodyPreview}` : ""
    }`;
    try {
      await insertTerminalSearchRun(ctx, runnerInput, codeSha, {
        status: "error",
        elapsedMs,
        errorDetail,
      });
    } catch (logErr) {
      logger.error(
        { err: logErr, ctxKey: ctx.ctxKey, codeSha },
        "[luca.search] failed to insert terminal row after HTTP fail",
      );
    }
    return { status: "error", results: [], trust_level: trustLevel, error: errorDetail };
  }

  let parsed: BraveSearchResponse;
  try {
    parsed = (await resp.json()) as BraveSearchResponse;
  } catch (e) {
    const elapsedMs = Date.now() - startedAt;
    const msg = e instanceof Error ? e.message : String(e);
    const errorDetail = `search.parse: invalid JSON from Brave — ${msg}`;
    try {
      await insertTerminalSearchRun(ctx, runnerInput, codeSha, {
        status: "error",
        elapsedMs,
        errorDetail,
      });
    } catch (logErr) {
      logger.error(
        { err: logErr, ctxKey: ctx.ctxKey, codeSha },
        "[luca.search] failed to insert terminal row after parse fail",
      );
    }
    return { status: "error", results: [], trust_level: trustLevel, error: errorDetail };
  }

  const compact = compactBraveResponse(parsed);
  const moreAvailable = parsed.query?.more_results_available ?? false;
  const elapsedMs = Date.now() - startedAt;

  try {
    await insertTerminalSearchRun(ctx, runnerInput, codeSha, {
      status: "ok",
      results: compact,
      totalCount: compact.length,
      moreAvailable,
      elapsedMs,
    });
  } catch (e) {
    logger.error(
      { err: e, ctxKey: ctx.ctxKey, codeSha },
      "[luca.search] failed to insert terminal tool_runs row on success",
    );
    // Forensic loss but result valid.
  }

  return {
    status: "ok",
    results: compact,
    trust_level: trustLevel,
    total_count: compact.length,
    more_available: moreAvailable,
  };
}

// ─── Convenience re-exports ──────────────────────────────────────────────

export { LucaFeatureDisabledError };
