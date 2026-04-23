/**
 * Luca V1a Day 2 — `run_code` tool.
 *
 * Anthropic tool definition + handler for executing Python in the Pyodide
 * sandbox (Day 1 `PyodideRunner`). Every call lands as a `tool_runs` row
 * (pending → terminal), so we can reproduce any turn and compute SF3
 * retry-grouping by `code_sha`.
 *
 * Three-level flag defense:
 *   1. `LUCA_V1A_ENABLED=true` (master)
 *   2. `LUCA_TOOLS_ENABLED=true` (tool-registry master)
 *   3. `LUCA_TOOL_RUN_CODE_ENABLED=true` (per-tool)
 * All three must be on → tool registers. Any one off → `disabled`.
 *
 * Timeout policy (plan N1 fix): default 8s, cap 20s. Leaves ≥40s buffer
 * under LLM_TIMEOUT_MS=60s (was 30s prior). Caller can lower but never
 * raise above 20s. The pyodide-runner itself caps at 60s as a last-resort
 * absolute ceiling — this layer enforces the tighter tool-level cap.
 *
 * SF3 — `code_sha = sha256(code + JSON.stringify(inputs ?? {}))`.
 * V1 `inputs` is always undefined; `undefined ?? {}` coerces to `{}`, so
 * JSON.stringify produces the stable string `"{}"`. Same sha as explicit
 * empty `{}` (V2 callers can pass inputs=undefined or inputs={} interchangeably).
 * V2 file_upload (post-V1a) will pass file metadata so same code + different
 * file → different sha → no retry collision.
 *
 * Forensic log rows:
 *   - "pending" inserted BEFORE runner.run() — captures input + ctxKey
 *     even if runner throws (WASM load fail etc.).
 *   - Terminal ("ok"|"error"|"timeout"|"memory_exceeded"|"disabled")
 *     inserted AFTER runner completes — carries output + elapsedMs.
 *   - They share `code_sha` for SF3 grouping. Correlation by creation
 *     order within the same (turnId, ctxKey) — no shared row id, both
 *     are independent rows in the append-only log.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { createHash } from "crypto";
import { db } from "../../storage";
import { toolRuns } from "../../../shared/schema";
import { isLucaToolEnabled, LucaFeatureDisabledError } from "../luca/env";
import {
  getPyodideRunner,
  toSandboxKey,
  type PyodideRunner,
  type RunCodeResult,
  type SandboxKey,
} from "../luca/pyodide-runner";
import logger from "../../logger";

// ─── Policy constants ────────────────────────────────────────────────────

/** Default per-call timeout when caller doesn't specify. Plan N1. */
export const RUN_CODE_DEFAULT_TIMEOUT_MS = 8_000;

/** Tool-layer ceiling. Caller cannot raise above this. Plan N1. */
export const RUN_CODE_MAX_TIMEOUT_MS = 20_000;

// ─── Anthropic tool definition ───────────────────────────────────────────

/**
 * Anthropic Tool spec for Luca's run_code. DIFFERENT from the partner-chat
 * `run_code` tool (which is Daytona-backed, persistent, supports JS) — this
 * one is Pyodide-only, per-turn sandbox, tool_runs-logged.
 *
 * Named `luca_run_code` (NOT `run_code`) to avoid collision with
 * partner-chat's `run_code` in deliberation.ts. The two tools have
 * different input schemas and different backends — if they ever ended up
 * in the same LLM tool list (bug, refactor), Anthropic SDK would reject
 * duplicate names or silently last-write-wins. Explicit distinct names
 * make the collision impossible. Golden test in
 * `luca/registry-collision.test.ts` enforces this (Bro2 Day 2 M2).
 *
 * Not registered in `partner-chat` flow. Only loaded via Luca's own tool
 * registry (`luca-tools/registry.ts`).
 */
export const runCodeTool: Anthropic.Messages.Tool = {
  name: "luca_run_code",
  description:
    "Run a short Python snippet in a per-turn Pyodide sandbox (Luca V1a). Use for " +
    "arithmetic, data analysis, small simulations, plot generation. " +
    "Globals DO NOT persist across calls by default — call with " +
    "`keep_globals: true` if you need REPL-style state within the same " +
    "turn. Default timeout 8s, max 20s. Network egress is NOT available.",
  input_schema: {
    type: "object" as const,
    properties: {
      code: {
        type: "string",
        description: "Python source. Use print() for stdout. matplotlib/numpy available on Day 1.5.",
      },
      timeout_ms: {
        type: "number",
        description: `Override default timeout in ms. Capped at ${RUN_CODE_MAX_TIMEOUT_MS}.`,
      },
      keep_globals: {
        type: "boolean",
        description: "If true, this call's global state persists for subsequent run_code in the SAME turn (same ctxKey). Default false (stateless).",
      },
    },
    required: ["code"],
  },
};

// ─── Input validation ────────────────────────────────────────────────────

export interface RunCodeToolInput {
  code: string;
  timeout_ms?: number;
  keep_globals?: boolean;
}

/**
 * Parse + validate LLM-provided tool input. Throws user-visible errors
 * (the tool-runner maps these to a tool_result with is_error=true).
 */
export function parseRunCodeInput(raw: unknown): RunCodeToolInput {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("run_code.invalid_input: expected object");
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.code !== "string" || r.code.length === 0) {
    throw new Error("run_code.invalid_input: `code` must be non-empty string");
  }
  if (r.code.length > 100_000) {
    throw new Error("run_code.invalid_input: `code` exceeds 100KB limit");
  }
  if (r.timeout_ms != null) {
    if (typeof r.timeout_ms !== "number" || r.timeout_ms <= 0) {
      throw new Error("run_code.invalid_input: `timeout_ms` must be positive number");
    }
  }
  if (r.keep_globals != null && typeof r.keep_globals !== "boolean") {
    throw new Error("run_code.invalid_input: `keep_globals` must be boolean");
  }
  return {
    code: r.code,
    timeout_ms: r.timeout_ms as number | undefined,
    keep_globals: r.keep_globals as boolean | undefined,
  };
}

// ─── Code sha (SF3) ──────────────────────────────────────────────────────

/**
 * SF3: code_sha = sha256(code + JSON.stringify(inputs ?? {})).
 *
 * V1 `inputs` is always undefined. Nullish coalesce `?? {}` converts it to
 * the empty object, so JSON.stringify returns the JS string `"{}"`. V2
 * `luca_upload_file` will pass real `inputs` (file metadata) and get its
 * own distinct sha. Audit pass-3 D21: collision-resistant because
 * JSON.stringify(object|array) always starts with `{` or `[` — a
 * malicious `code` ending with a valid JSON literal cannot silently
 * merge with a non-empty inputs object because inputs-stringified length
 * is always ≥ 2 and starts with `{`/`[`, preventing boundary ambiguity.
 */
export function computeCodeSha(
  code: string,
  inputs: Record<string, unknown> | undefined = undefined,
): string {
  const inputsStr = JSON.stringify(inputs ?? {});
  return createHash("sha256").update(code + inputsStr).digest("hex");
}

// ─── Tool-run forensic insert ────────────────────────────────────────────

export interface RunCodeContext {
  userId: number;
  agentId?: number | null;
  meetingId?: string | null;
  turnId?: string | null;
  /** Pyodide sandbox key. Per-turn isolation by convention (B1). */
  ctxKey: SandboxKey;
}

/**
 * Insert a "pending" row BEFORE the runner is invoked. Separated so we can
 * unit-test the write path without a live runner.
 */
export async function insertPendingRun(
  ctx: RunCodeContext,
  input: RunCodeToolInput,
  codeSha: string,
): Promise<void> {
  await db.insert(toolRuns).values({
    userId: ctx.userId,
    agentId: ctx.agentId ?? null,
    meetingId: ctx.meetingId ?? null,
    turnId: ctx.turnId ?? null,
    ctxKey: ctx.ctxKey,
    tool: "luca_run_code",
    codeSha,
    status: "pending",
    input: input as unknown as Record<string, unknown>,
    output: null,
    errorDetail: null,
    elapsedMs: null,
    memoryPeakBytes: null,
    networkAttempted: false,
  });
}

/** Insert a terminal row AFTER the runner returns (or throws). */
export async function insertTerminalRun(
  ctx: RunCodeContext,
  input: RunCodeToolInput,
  codeSha: string,
  result: RunCodeResult | { status: "error"; errorDetail: string },
): Promise<void> {
  const isFull = "stdout" in result;
  await db.insert(toolRuns).values({
    userId: ctx.userId,
    agentId: ctx.agentId ?? null,
    meetingId: ctx.meetingId ?? null,
    turnId: ctx.turnId ?? null,
    ctxKey: ctx.ctxKey,
    tool: "luca_run_code",
    codeSha,
    status: result.status,
    input: input as unknown as Record<string, unknown>,
    output: isFull
      ? ({
          stdout: result.stdout,
          stderr: result.stderr,
          plots: result.plots,
          elapsedMs: result.elapsedMs,
        } as unknown as Record<string, unknown>)
      : null,
    errorDetail: result.errorDetail ?? null,
    elapsedMs: isFull ? result.elapsedMs : null,
    memoryPeakBytes: null, // Day 1.5 RealPyodideRunner will populate
    networkAttempted: false, // Pyodide sandbox has no network
  });
}

// ─── Main handler ────────────────────────────────────────────────────────

/**
 * Sanitized tool_result payload Luca's turn-runner will ship back to
 * Anthropic. Drops internal fields (ctxKey, elapsedMs — kept in
 * tool_runs for forensics; Luca doesn't need them to reason).
 */
export interface RunCodeToolResult {
  status: "ok" | "error" | "timeout" | "memory_exceeded" | "disabled";
  stdout: string;
  stderr: string;
  /** Count only; actual plot bytes live in S3 (Day 3). */
  plot_count: number;
  /** Plot filenames if any. */
  plots: string[];
  error?: string;
}

/**
 * Invoke the tool. Returns the user-facing result shape.
 *
 * Failure modes:
 *   - Flag off → `{status: "disabled", error: "luca_feature_disabled"}`
 *     (no tool_runs row; tool wasn't supposed to be in Luca's registry
 *      in the first place — this is belt-and-braces).
 *   - Bad input → throws user-visible Error; turn-runner maps to is_error.
 *   - Runner infra throw (WASM load) → terminal row with status="error",
 *     errorDetail = thrown message. Returned as {status:"error"} to Luca.
 *   - Runner returns non-ok status → terminal row mirrors, result forwards.
 */
export async function runCodeHandler(
  raw: unknown,
  ctx: RunCodeContext,
  runner: PyodideRunner = getPyodideRunner(),
): Promise<RunCodeToolResult> {
  // Flag check FIRST — no tool_runs row if tool shouldn't exist.
  if (!isLucaToolEnabled("LUCA_TOOL_RUN_CODE_ENABLED")) {
    return {
      status: "disabled",
      stdout: "",
      stderr: "",
      plot_count: 0,
      plots: [],
      error: "luca_feature_disabled: run_code tool is not enabled",
    };
  }

  // TODO Day 5 (plan §B2): insert `turnStateStore.isLocked(ctx.turnId)` check
  // here AFTER flag gate, BEFORE parseRunCodeInput. If locked → return
  // {status: "disabled", error: "turn_locked_untrusted_content"} without
  // inserting tool_runs rows. Belt-and-braces — the tool-set filter in
  // getLucaTools() should already strip run_code from Luca's offered tools
  // when the turn is locked, so this handler path shouldn't fire; this is
  // defense-in-depth against forged tool_use blocks / future refactor bugs.
  // TurnStateStore already shipped Day -1 (server/lib/luca/turn-state-store.ts).

  const input = parseRunCodeInput(raw);
  const codeSha = computeCodeSha(input.code);

  // Capped timeout. Caller can lower below default, never raise above cap.
  const effectiveTimeoutMs = Math.min(
    input.timeout_ms ?? RUN_CODE_DEFAULT_TIMEOUT_MS,
    RUN_CODE_MAX_TIMEOUT_MS,
  );

  // Pending row BEFORE runner call.
  try {
    await insertPendingRun(ctx, input, codeSha);
  } catch (e) {
    logger.error(
      { err: e, ctxKey: ctx.ctxKey, codeSha },
      "[luca.runCode] failed to insert pending tool_runs row",
    );
    // Don't block tool execution on forensic-log failure. Terminal row
    // will still be attempted below and carries all necessary info.
  }

  let result: RunCodeResult;
  try {
    result = await runner.run({
      ctxKey: ctx.ctxKey,
      code: input.code,
      timeoutMs: effectiveTimeoutMs,
      keepGlobals: input.keep_globals ?? false,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn(
      { err: e, ctxKey: ctx.ctxKey, codeSha },
      "[luca.runCode] runner threw — emitting error terminal row",
    );
    try {
      await insertTerminalRun(ctx, input, codeSha, {
        status: "error",
        errorDetail: `run_code_infrastructure_error: ${msg}`,
      });
    } catch (logErr) {
      logger.error(
        { err: logErr, ctxKey: ctx.ctxKey, codeSha },
        "[luca.runCode] failed to insert terminal tool_runs row after runner throw",
      );
    }
    return {
      status: "error",
      stdout: "",
      stderr: "",
      plot_count: 0,
      plots: [],
      error: `run_code_infrastructure_error: ${msg}`,
    };
  }

  // Terminal row.
  try {
    await insertTerminalRun(ctx, input, codeSha, result);
  } catch (e) {
    logger.error(
      { err: e, ctxKey: ctx.ctxKey, codeSha, status: result.status },
      "[luca.runCode] failed to insert terminal tool_runs row",
    );
    // Forensic loss — but result is still valid, return it to Luca.
  }

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    plot_count: result.plots.length,
    plots: result.plots.map((p) => p.filename),
    error: result.errorDetail ?? undefined,
  };
}

// ─── Convenience for registry / tool-runner ──────────────────────────────

/** Re-exported for tests and registry. */
export { LucaFeatureDisabledError, toSandboxKey };
