/**
 * R465 — Luca audit log.
 *
 * Forensic, append-only record of every `luca_*` tool invocation by Luca.
 * One row per terminal call with: tool name, write-class, status (ok|error
 * |rate_limited|blocked), input hash (sha256, NEVER raw values), latency,
 * error detail (truncated). Fire-and-forget — failures here MUST NEVER
 * break the underlying tool call.
 *
 * Why a separate table from `tool_activity_log` and `tool_runs`:
 *   - tool_activity_log is UI-oriented (running→done streaming for the
 *     activity timeline). Mutates rows in-place; not append-only.
 *   - tool_runs is V1a-specific (run_code/analyze_image/etc.) and uses
 *     SF3 dedup pairs. Doesn't cover Studio luca_* tools (memory_schema,
 *     recall_self, self_config) which route through the main switch.
 *   - This table is the SINGLE place where you can answer "what did Luca
 *     try in the last 24 hours?" — across the entire luca_* surface,
 *     including rate-limited and gate-blocked attempts.
 *
 * Hash semantics:
 *   `input_hash = sha256(stableJsonStringify(input ?? {}))`. Stable means
 *   keys sorted recursively so the same logical input always hashes the
 *   same. We store the hash, not the raw input, because some inputs carry
 *   user-context (search queries, paths, etc.) that we don't want to
 *   accumulate indefinitely. The hash is enough to group repeated calls
 *   and link them to (the rare) raw rows in tool_runs/tool_activity_log
 *   when needed.
 */

import { createHash } from "node:crypto";
import { pool } from "../../storage";
import logger from "../../logger";

export type LucaAuditStatus = "ok" | "error" | "rate_limited" | "blocked";
export type LucaAuditClassification =
  | "READ_ONLY"
  | "LOW_STAKES_WRITE"
  | "HIGH_STAKES_WRITE"
  | "UNKNOWN";

/**
 * Stable JSON stringify — recursively sorts object keys so that
 * { a: 1, b: 2 } and { b: 2, a: 1 } produce the same hash. Arrays
 * preserve their order (semantically meaningful). Non-serialisable
 * values (functions, undefined, BigInt) collapse to a sentinel string
 * so the function never throws on weird inputs.
 */
export function stableJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const visit = (v: unknown): unknown => {
    if (v === null) return null;
    if (typeof v === "undefined") return "__undefined__";
    if (typeof v === "function") return "__function__";
    if (typeof v === "bigint") return `__bigint__:${v.toString()}`;
    if (typeof v !== "object") return v;
    if (seen.has(v as object)) return "__cycle__";
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(visit);
    const obj = v as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) sorted[k] = visit(obj[k]);
    return sorted;
  };
  return JSON.stringify(visit(value));
}

/** SHA-256 hex of a stable JSON serialisation of `input`. */
export function hashLucaInput(input: unknown): string {
  return createHash("sha256").update(stableJsonStringify(input ?? {})).digest("hex");
}

/**
 * Insert a single audit row. Fire-and-forget — caller never awaits the
 * promise's success state, only that the function itself doesn't throw.
 * Best-effort: if the DB is unreachable, we log and move on.
 *
 * Rate-limited and gate-blocked attempts MUST be recorded too — that's
 * the whole point of the table. Pass `status: 'rate_limited'` or
 * `'blocked'` in those cases.
 */
export async function recordLucaAudit(params: {
  userId: number;
  agentId: number | null;
  tool: string;
  classification: LucaAuditClassification;
  status: LucaAuditStatus;
  inputHash: string;
  latencyMs: number;
  errorDetail?: string | null;
}): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO luca_audit_log
         (user_id, agent_id, tool, classification, status, input_hash, latency_ms, error_detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        params.userId,
        params.agentId ?? null,
        params.tool.slice(0, 64),
        params.classification,
        params.status,
        params.inputHash,
        Math.max(0, Math.floor(params.latencyMs)),
        (params.errorDetail ?? null) === null ? null : (params.errorDetail as string).slice(0, 500),
      ],
    );
  } catch (e: any) {
    // Never throw from the audit path. Log + swallow.
    logger.warn(
      { component: "luca-audit", event: "insert_failed", err: e?.message ?? String(e), tool: params.tool },
      "[luca-audit] insert failed (non-fatal)",
    );
  }
}

/**
 * Best-effort detection of rate-limited / blocked outcomes from a tool's
 * stringified result. The luca_* dispatchers return JSON strings — when
 * they hit a rate limit they return `{"error":"rate_limited", ...}`.
 * Used by the dispatcher wrappers to derive `status` without each tool
 * site having to thread it explicitly.
 */
export function inferStatusFromResult(resultStr: string): LucaAuditStatus {
  if (typeof resultStr !== "string" || resultStr.length === 0) return "ok";
  // Cheap substring screen first — avoid JSON.parse on large outputs.
  if (resultStr.length < 4096 && resultStr.includes('"error"')) {
    try {
      const parsed = JSON.parse(resultStr);
      if (parsed && typeof parsed === "object") {
        const err = (parsed as Record<string, unknown>).error;
        if (typeof err === "string") {
          if (err === "rate_limited" || err.startsWith("rate_limited")) return "rate_limited";
          if (err === "blocked" || err === "gate_blocked") return "blocked";
        }
      }
    } catch {
      // Not JSON — fall through. ok.
    }
  }
  return "ok";
}
