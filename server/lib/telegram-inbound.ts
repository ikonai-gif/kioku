/**
 * PR-A.5 — Telegram Inbound Webhook helpers.
 *
 * Pure helpers (no Express coupling) used by POST /api/telegram/webhook in
 * server/routes.ts. Kept in their own module so server/__tests__ can import
 * and exercise them without booting the full registerRoutes() graph.
 *
 * Pipeline (route handler order):
 *   1. verifyTelegramSecret(headerValue)            ← 401 on mismatch
 *   2. telegramUpdateSchema.safeParse(body)         ← 200 + drop on malformed
 *   3. allowlist chat_id === TELEGRAM_BOSS_CHAT_ID  ← 200 + drop on mismatch
 *   4. db.insert(telegramInboundLog).onConflictDoNothing.returning  ← idempotency
 *   5. checkInboundRateLimit(chatId)                ← 200 + drop on overflow
 *   6. dispatch (parseCommand or message-into-partner-room)
 *
 * Why every reject is HTTP 200 instead of 4xx (except 401):
 *   Telegram retries non-2xx responses indefinitely with exponential backoff.
 *   For "intentional drops" (rate-limit, allowlist, malformed) we don't want
 *   retries — those would replay the same bad payload forever. 200 = "we got
 *   it, don't retry". The audit row in telegram_inbound_log captures *why*
 *   we dropped it so it's still observable.
 *
 * The single 401 (secret mismatch) is intentional — it tells an attacker the
 * endpoint exists but their secret is wrong, and we DO want Telegram to
 * retry if it ever sends with a stale secret token (post rotation race).
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { db, storage } from "../storage";
import logger from "../logger";

// ── In-memory rate-limit ──────────────────────────────────────────────────────
//
// Sliding 60-second window, 10 messages/min per chat_id. Map<chatId, ts[]>.
// PR-A.5 only allow-lists ONE chat (BOSS), so this Map peaks at one entry.
// Multi-replica concerns are deferred to PR-B (cron + DB-backed queue).
//
// Why 10/min instead of TCRrate-limit's lower numbers: BOSS regularly fires
// bursts of 5–8 quick clarifications during a Лука session; 10/min is the
// "human typing fast" ceiling, well under what Telegram itself would flag.
// Beyond 10/min in a 60s window almost always means a runaway client (or a
// keysmash) — drop with audit.
const RL_WINDOW_MS = 60_000;
const RL_MAX = 10;
const recentInbound: Map<number, number[]> = new Map();

/**
 * @returns true when the chat is under the limit (caller should proceed),
 *          false when the limit is hit (caller should drop with audit).
 */
export function checkInboundRateLimit(chatId: number): boolean {
  const now = Date.now();
  const cutoff = now - RL_WINDOW_MS;
  const arr = recentInbound.get(chatId) ?? [];
  // Prune in place; cheap (window holds <=10 entries).
  const fresh = arr.filter((t) => t > cutoff);
  if (fresh.length >= RL_MAX) {
    recentInbound.set(chatId, fresh);
    return false;
  }
  fresh.push(now);
  recentInbound.set(chatId, fresh);
  return true;
}

/** Test-only escape hatch — clears the in-memory window so tests don't bleed. */
export function __resetInboundRateLimitForTests(): void {
  recentInbound.clear();
}

// ── Telegram payload schema ───────────────────────────────────────────────────
//
// We validate only the fields we actually use. Telegram's full Update schema
// is enormous (channel posts, callback queries, edited messages, polls, …)
// and validating the full thing would mean rejecting payloads on every API
// addition. zod here is a "shape gate" not a contract.
//
// Required: update_id + (message OR something we'll later route). For PR-A.5
// the route handler explicitly drops payloads where `message` is missing.
// Photos/voice/files come in with `message` present but `text` absent — that
// case is handled inline in the route (sendTelegramMessage fallback).
const telegramUserSchema = z.object({
  id: z.number(),
});

const telegramChatSchema = z.object({
  id: z.number(),
});

const telegramMessageSchema = z.object({
  message_id: z.number().optional(),
  date: z.number().optional(),
  from: telegramUserSchema,
  chat: telegramChatSchema,
  text: z.string().optional(),
});

export const telegramUpdateSchema = z.object({
  update_id: z.number(),
  // `message` is the only payload type PR-A.5 acts on; everything else is a
  // 200-and-drop. Marked optional so safeParse succeeds for non-message
  // updates and the route can branch.
  message: telegramMessageSchema.optional(),
}).passthrough();

export type TelegramUpdate = z.infer<typeof telegramUpdateSchema>;

// ── Secret verification ───────────────────────────────────────────────────────
/**
 * Constant-time compare of the X-Telegram-Bot-Api-Secret-Token header
 * against the configured TELEGRAM_WEBHOOK_SECRET. timingSafeEqual requires
 * equal-length buffers, so we hash both sides into fixed-size SHA-256
 * digests before comparing. This avoids leaking secret length and works
 * even when the header value is malformed or extremely long.
 *
 * Returns false (not throw) on missing env or missing header. Caller maps
 * that to 401.
 */
export function verifyTelegramSecret(headerValue: string | string[] | undefined): boolean {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected) {
    // Misconfiguration: warn loudly so prod ops notice. Treat as auth fail
    // rather than silently allowing all requests through.
    logger.warn("telegram-inbound: TELEGRAM_WEBHOOK_SECRET not set; rejecting all webhook calls");
    return false;
  }
  const got = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (typeof got !== "string" || got.length === 0) return false;

  const a = createHash("sha256").update(expected, "utf8").digest();
  const b = createHash("sha256").update(got, "utf8").digest();
  // Both digests are 32 bytes by construction.
  return timingSafeEqual(a, b);
}

// ── Command parsing ───────────────────────────────────────────────────────────
//
// Telegram convention: a command starts with "/" and may be followed by a
// "@botname" (in group chats) plus space-separated args. We only allow
// private chat with BOSS, so @botname is rare but we strip it defensively.
// Only the leading slash-token is the command; everything after the first
// space is treated as one args string the caller can split.
const COMMAND_RE = /^\/([A-Za-z][A-Za-z0-9_]*)(?:@\S+)?(?:\s+([\s\S]+))?$/;

export interface ParsedCommand {
  command: string;
  args: string[];
  /** Raw args text (un-split). Useful for /cancel where a single token id is expected. */
  rawArgs: string;
}

export function parseCommand(text: string): ParsedCommand | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  const m = trimmed.match(COMMAND_RE);
  if (!m) return null;
  const command = m[1].toLowerCase();
  const rawArgs = (m[2] ?? "").trim();
  const args = rawArgs.length > 0 ? rawArgs.split(/\s+/) : [];
  return { command, args, rawArgs };
}

// ── Partner-room discovery ────────────────────────────────────────────────────
//
// BOSS interactions land in the dedicated "Partner" room (purpose="user"),
// which is the same room the dashboard's chat panel renders. Finding the
// room by name+purpose is fragile — BRO1 (M-5) flagged that we should add a
// `partner_flag` column to rooms in a future PR. For PR-A.5 we ship the
// fragile lookup with a clear error path: if no Partner room exists, the
// route surfaces the failure to BOSS via outbound Telegram message instead
// of silently dropping. Future work tracked in code TODO below.
//
// TODO(post-PR-A.5): replace name+purpose match with `rooms.partner_flag` once
// BRO1's M-5 column lands. Affected sites: this function and
// server/lib/self-monitoring/collect.ts:65 (same fragile match exists there).
export interface PartnerRoom {
  roomId: number;
  agentIds: number[];
  /** Source-room name kept for downstream isPartnerChat detection (must be "Partner"). */
  name: string;
}

/** BOSS userId — see TELEGRAM_BOSS_CHAT_ID env. PR-A.5 hardcodes the BOSS user (10). */
export const BOSS_USER_ID = 10;

/**
 * @throws Error("partner_room_not_found") when BOSS hasn't created the room yet.
 *         Route handler maps that to 503 + outbound "Лука не настроен..." message.
 */
export async function findBossPartnerRoom(
  storage: { getRooms: (userId: number) => Promise<Array<{ id: number; name: string; purpose: string; agentIds: string | null }>> },
): Promise<PartnerRoom> {
  const rooms = await storage.getRooms(BOSS_USER_ID);
  const room = rooms.find((r) => r.name === "Partner" && r.purpose === "user");
  if (!room) {
    throw new Error("partner_room_not_found");
  }
  let agentIds: number[] = [];
  try {
    agentIds = JSON.parse(room.agentIds || "[]");
    if (!Array.isArray(agentIds)) agentIds = [];
  } catch {
    // schema.ts:141 says agentIds is JSON-text; corrupted rows fall back to
    // empty (deliberation skips agents). Better than a thrown SyntaxError
    // crashing the webhook.
    agentIds = [];
  }
  return { roomId: room.id, agentIds, name: room.name };
}

// ── DB helper re-export ───────────────────────────────────────────────────────
// Re-exported so the route handler imports from a single seam; tests can
// mock this module instead of "../storage".
export { db };

// ── Command dispatch ──────────────────────────────────────────────────────────
//
// PR-A.5 supports the following slash-commands. Every command MUST return a
// short string reply; the route handler sends it to BOSS as outbound
// Telegram message with urgency:"high". Unknown commands return a friendly
// hint (we do NOT silently drop — BOSS would think Luка is broken).
//
//   /status           — system health (DB, uptime, version, last health-check)
//   /queue            — list of active+pending scheduled tasks (max 10)
//   /cancel <task_id> — mark a scheduled task cancelled
//   /help             — list of commands
//
// Replies are kept under 200 chars where possible (sendTelegramMessage
// truncates at 200). Multi-line bodies use \n separators.
//
// All command helpers are exported so the test suite can exercise them in
// isolation (no Express boot, no live Telegram fetch).

/** /help — hardcoded multi-line. Kept short on purpose (200-char outbound cap). */
export function buildHelpReply(): string {
  return [
    "Команды Лука:",
    "/status — здоровье системы",
    "/queue — активные задачи",
    "/cancel <id> — отменить задачу",
    "/help — это сообщение",
  ].join("\n");
}

/**
 * /status — formatted system health line.
 *
 * Self-call to GET /api/status using PUBLIC_URL + INTERNAL_HEALTH_SECRET
 * (added by PR #78). The internal-health header bypasses rate-limit so a
 * burst of /status from BOSS can never lock us out of our own status
 * endpoint. RAILWAY_GIT_COMMIT_SHA is the deploy SHA Railway injects.
 *
 * Why fetch instead of calling the route's handler in-process: the handler
 * is defined inside registerRoutes() and is not exported. Refactoring it
 * out is a separate cleanup. The fetch hits localhost in prod (PUBLIC_URL
 * resolves through the same Railway pod) so latency is sub-ms.
 */
export async function buildStatusReply(): Promise<string> {
  const baseUrl = process.env.PUBLIC_URL || process.env.APP_URL || "http://localhost:5000";
  const internalSecret = process.env.INTERNAL_HEALTH_SECRET || "";
  const commit = (process.env.RAILWAY_GIT_COMMIT_SHA || "").slice(0, 7) || "unknown";
  try {
    const res = await fetch(`${baseUrl}/api/status`, {
      headers: internalSecret ? { "X-Internal-Health": internalSecret } : {},
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return `Статус: ошибка ${res.status}\nКоммит: ${commit}`;
    }
    const j = await res.json() as {
      status?: string; db?: string; uptime_sec?: number; version?: string;
      last_check?: { ok?: boolean; blocking_drift_count?: number } | null;
    };
    const upMin = Math.floor((j.uptime_sec ?? 0) / 60);
    const lastOk = j.last_check?.ok === false ? "⚠" : "✓";
    const drift = j.last_check?.blocking_drift_count ?? 0;
    return [
      `Статус: ${j.status ?? "unknown"}`,
      `БД: ${j.db ?? "unknown"}, аптайм: ${upMin}m`,
      `Health: ${lastOk}${drift > 0 ? ` (drift: ${drift})` : ""}`,
      `Коммит: ${commit}`,
    ].join("\n");
  } catch (err: any) {
    logger.warn({ err: err?.message }, "telegram-inbound: /status self-call failed");
    return `Статус: недоступен (${err?.message || "timeout"})\nКоммит: ${commit}`;
  }
}

/**
 * /queue — first 10 active or pending scheduled tasks for BOSS.
 *
 * Empty queue returns a friendly message rather than "". The line format
 * stays under ~80 chars per task so the full reply fits Telegram's 4096
 * cap (we'll typically return < 1KB).
 */
export async function buildQueueReply(): Promise<string> {
  try {
    const all = await storage.getScheduledTasks(BOSS_USER_ID);
    const active = all
      .filter((t: any) => t.status === "active" || t.status === "pending")
      .slice(0, 10);
    if (active.length === 0) {
      return "Очередь пуста.";
    }
    const lines = active.map((t: any) => {
      const title = (t.title || "").slice(0, 60);
      return `#${t.id} [${t.status}] ${title}`;
    });
    return ["Активные задачи:", ...lines].join("\n");
  } catch (err: any) {
    logger.warn({ err: err?.message }, "telegram-inbound: /queue lookup failed");
    return "Не удалось получить очередь.";
  }
}

/**
 * /cancel <id> — flip status to "cancelled". Per BOSS scope rule we never
 * delete: cancelled rows stay in scheduled_tasks for audit. Re-cancelling
 * an already-cancelled / completed task returns the same confirmation
 * (idempotent from BOSS's perspective).
 */
export async function handleCancelCommand(rawArgs: string): Promise<string> {
  const trimmed = rawArgs.trim();
  if (!trimmed) {
    return "Использование: /cancel <id>";
  }
  const taskId = Number(trimmed.split(/\s+/)[0]);
  if (!Number.isFinite(taskId) || taskId <= 0) {
    return "id должен быть числом.";
  }
  try {
    const updated = await storage.updateScheduledTask(taskId, BOSS_USER_ID, { status: "cancelled" });
    if (!updated) {
      return `Задача #${taskId} не найдена.`;
    }
    return `Задача #${taskId} отменена.`;
  } catch (err: any) {
    logger.warn({ err: err?.message, taskId }, "telegram-inbound: /cancel failed");
    return `Ошибка отмены #${taskId}.`;
  }
}

/**
 * Top-level command router. Switch on cmd.command (already lower-cased by
 * parseCommand). Unknown commands fall through to a friendly hint instead
 * of silent drop.
 */
export async function handleTelegramCommand(cmd: ParsedCommand): Promise<string> {
  switch (cmd.command) {
    case "status":
      return buildStatusReply();
    case "queue":
      return buildQueueReply();
    case "cancel":
      return handleCancelCommand(cmd.rawArgs);
    case "help":
      return buildHelpReply();
    default:
      return `Неизвестная команда /${cmd.command}. /help — список.`;
  }
}
