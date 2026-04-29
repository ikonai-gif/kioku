/**
 * LEO PR-A — Telegram Bot API wrapper.
 *
 * Fail-silent contract:
 *   - Never throws. Every code path either returns `{ok:true}` or
 *     `{ok:false, error:'<reason>'}`. Callers can `await` without `try`.
 *   - Every send attempt logs a row to `luca_telegram_log`, even when we
 *     refuse to send (missing config, rate-limited, fetch threw). This is
 *     the only way to observe what the tool actually did, since the
 *     dispatcher records the JSON return value but rate-limits / refusals
 *     don't surface separately.
 *
 * No email fallback, no ws-event broadcast — those land in PR-B alongside
 * the cron worker that owns the deferred-send queue.
 *
 * Rate limiter:
 *   - In-process Map<chatId, number[]> of recent send timestamps.
 *   - 30 sends per ROLLING MINUTE (60_000ms). Older entries pruned on every
 *     attempt. Per-process state is fine for PR-A; multi-replica concerns
 *     belong to PR-B (cron + DB-backed deferred queue).
 */

import { db } from "../storage";
import { lucaTelegramLog } from "../../shared/schema";
import logger from "../logger";

const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 30;
const SEND_TIMEOUT_MS = 8000;
const MAX_TEXT_LENGTH = 4000;

const recentSends: Map<string, number[]> = new Map();

export interface SendInput {
  chatId: string;
  text: string;
  /** Tier the caller's classifier (or hard rule) decided. Used for log row. */
  urgency: "high" | "normal" | "low";
  /** User the chat belongs to — drives the audit row. */
  userId: number;
  /** Optional context (e.g. `vip_sender:foo@example.com`). */
  reason?: string;
  parseMode?: "Markdown" | "HTML";
}

export interface SendResult {
  ok: boolean;
  /** Stable error code; only set when ok=false. */
  error?: string;
  /** True iff the input text was longer than MAX_TEXT_LENGTH and was truncated before send. */
  truncated?: boolean;
  /** Telegram API HTTP status when fetch returned (success or non-2xx). */
  status?: number;
}

type LogInsertFn = (row: {
  userId: number;
  message: string;
  urgency: "high" | "normal" | "low";
  delivered: boolean;
  error: string | null;
  reason: string | null;
}) => Promise<void>;

let __logInsertOverride: LogInsertFn | null = null;

/**
 * Test seam — replace the audit-log insert with a mock. Production code
 * never calls this; only `tests/unit/telegram.test.ts` uses it.
 */
export function __setLucaTelegramLogInsertForTests(fn: LogInsertFn | null): void {
  __logInsertOverride = fn;
}

/** Internal — tests use this to clear the rate-limit Map between cases. */
export function __resetTelegramRateLimitForTests(): void {
  recentSends.clear();
}

async function logAttempt(row: {
  userId: number;
  message: string;
  urgency: "high" | "normal" | "low";
  delivered: boolean;
  error: string | null;
  reason: string | null;
}): Promise<void> {
  try {
    if (__logInsertOverride) {
      await __logInsertOverride(row);
      return;
    }
    await db.insert(lucaTelegramLog).values(row);
  } catch (err: any) {
    // Logging the log failure: don't recurse, just emit a warn.
    logger.warn(
      { component: "telegram", event: "log_insert_failed", error: err?.message ?? String(err) },
      "[telegram] failed to insert luca_telegram_log row",
    );
  }
}

function checkRateLimit(chatId: string, now: number): boolean {
  const arr = recentSends.get(chatId) ?? [];
  const fresh = arr.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (fresh.length >= RATE_LIMIT_MAX) {
    recentSends.set(chatId, fresh);
    return false;
  }
  fresh.push(now);
  recentSends.set(chatId, fresh);
  return true;
}

/**
 * Send a Telegram message. NEVER throws. Returns a structured result.
 *
 * Truncation is applied BEFORE the API call (so the rate-limited path also
 * reports `truncated:true` when applicable — caller-visible without dropping
 * the audit info).
 */
export async function sendTelegramMessage(input: SendInput): Promise<SendResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    logger.warn(
      { component: "telegram", event: "not_configured" },
      "[telegram] TELEGRAM_BOT_TOKEN unset — refusing to send",
    );
    await logAttempt({
      userId: input.userId,
      message: input.text.slice(0, MAX_TEXT_LENGTH),
      urgency: input.urgency,
      delivered: false,
      error: "telegram_not_configured",
      reason: input.reason ?? null,
    });
    return { ok: false, error: "telegram_not_configured" };
  }

  // 4000-char hard truncate. Done before rate-limit / fetch so the audit row
  // and the on-the-wire payload are consistent.
  let text = input.text;
  let truncated = false;
  if (text.length > MAX_TEXT_LENGTH) {
    text = text.slice(0, MAX_TEXT_LENGTH);
    truncated = true;
  }

  // In-process rate limit (30/min/chat).
  const now = Date.now();
  if (!checkRateLimit(input.chatId, now)) {
    logger.warn(
      { component: "telegram", event: "rate_limited", chatId: input.chatId },
      "[telegram] rate-limited — 30 sends/min cap hit",
    );
    await logAttempt({
      userId: input.userId,
      message: text,
      urgency: input.urgency,
      delivered: false,
      error: "rate_limited",
      reason: input.reason ?? null,
    });
    return { ok: false, error: "rate_limited", truncated: truncated || undefined };
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), SEND_TIMEOUT_MS);
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body: Record<string, unknown> = { chat_id: input.chatId, text };
  if (input.parseMode) body.parse_mode = input.parseMode;

  let res: Response | null = null;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } catch (err: any) {
    clearTimeout(timer);
    const msg = err?.name === "AbortError"
      ? "timeout"
      : err?.message
        ? String(err.message).slice(0, 200)
        : "unknown";
    logger.error(
      { component: "telegram", event: "fetch_threw", error: msg },
      "[telegram] fetch threw — failing silently",
    );
    await logAttempt({
      userId: input.userId,
      message: text,
      urgency: input.urgency,
      delivered: false,
      error: `fetch_threw:${msg}`,
      reason: input.reason ?? null,
    });
    return { ok: false, error: `fetch_threw:${msg}`, truncated: truncated || undefined };
  }
  clearTimeout(timer);

  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 200);
    } catch { /* ignore */ }
    logger.error(
      { component: "telegram", event: "fetch_non_2xx", status: res.status, detail },
      "[telegram] non-2xx from Telegram API",
    );
    await logAttempt({
      userId: input.userId,
      message: text,
      urgency: input.urgency,
      delivered: false,
      error: `fetch_${res.status}`,
      reason: input.reason ?? null,
    });
    return {
      ok: false,
      error: `fetch_${res.status}`,
      status: res.status,
      truncated: truncated || undefined,
    };
  }

  await logAttempt({
    userId: input.userId,
    message: text,
    urgency: input.urgency,
    delivered: true,
    error: null,
    reason: input.reason ?? null,
  });
  return {
    ok: true,
    status: res.status,
    truncated: truncated || undefined,
  };
}
