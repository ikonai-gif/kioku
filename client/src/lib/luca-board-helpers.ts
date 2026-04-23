/**
 * Luca Day 7 — Pure helpers for the Approval Board.
 *
 * Extracted from `pages/luca-board.tsx` so they can be unit-tested
 * without a DOM/React runtime (no React Testing Library in the stack).
 *
 * All functions are pure and deterministic given a `now` injection;
 * production code in the page passes Date.now() and these tests pass
 * fixed timestamps.
 */

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "edited"
  | "rejected"
  | "timeout"
  | "error";

export interface ApprovalRowLite {
  status: ApprovalStatus;
  expiresAt: string;
}

export type GateMode = "block" | "log_only" | null;

/**
 * Whether Send / Edit actions should be enabled on a row.
 *
 * Rules:
 *   - Only `pending` rows are decidable.
 *   - Expired rows are not decidable (expire worker will flip them).
 *   - `log_only` mode means rows are shadow observability — the tool
 *     already ran; Send/Edit would double-execute. So disabled.
 *   - `block` mode is the only mode where Send/Edit actually help.
 */
export function canExecuteApproval(
  row: ApprovalRowLite,
  mode: GateMode,
  now: number = Date.now(),
): boolean {
  if (row.status !== "pending") return false;
  if (new Date(row.expiresAt).getTime() <= now) return false;
  return mode === "block";
}

/**
 * Whether Reject should be enabled on a row. Reject is safe in any mode
 * (no side effects), as long as the row is still decidable.
 */
export function canRejectApproval(
  row: ApprovalRowLite,
  now: number = Date.now(),
): boolean {
  if (row.status !== "pending") return false;
  if (new Date(row.expiresAt).getTime() <= now) return false;
  return true;
}

/**
 * Count pending rows for the nav badge / header summary.
 */
export function countPending(rows: ApprovalRowLite[]): number {
  return rows.filter((r) => r.status === "pending").length;
}

/**
 * Classify a JSON parse attempt on an edit payload.
 * Returns either the parsed object, or a human-readable error string.
 * Payload must be a plain object (not array, not primitive).
 */
export function parseEditPayload(
  raw: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {
      ok: false,
      error: "Invalid JSON: " + (e instanceof Error ? e.message : String(e)),
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      error: "Payload must be a JSON object (not an array or primitive).",
    };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

/**
 * Format a "x ago" human relative string, stable under test clocks.
 */
export function formatRelative(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const s = Math.floor((now - t) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/**
 * Format a future-delta "expires in 5m" string, or "expired" if past.
 */
export function formatExpiresIn(iso: string, now: number = Date.now()): string {
  const diff = new Date(iso).getTime() - now;
  if (diff <= 0) return "expired";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/**
 * Safe JSON.stringify with 2-space indent. Falls back to String(v)
 * on circular refs.
 */
export function prettyJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
