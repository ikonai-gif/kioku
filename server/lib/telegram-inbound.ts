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

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { db, storage } from "../storage";
import logger from "../logger";
import { saveAssetAndSign } from "../workspace-storage";
import { summarizeAttachment } from "./attachment-summarizer";
import type { AttachmentMeta } from "@shared/schema";

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

// PR-A.6 — photo/voice/document inline payloads.
//
// Telegram sends `photo` as an array of PhotoSize (multiple resolutions).
// We pick the largest by file_size after parse. `voice` is a single object;
// `document` is a single object (PDFs, .docx, .txt, etc.). All three carry a
// `file_id` we resolve via getFile → file_path → download.
//
// `file_size` may be missing on some old clients; we treat absence as "unknown
// big" and reject up-front. The caps below match R349 and exist to bound
// blast radius (memory + Anthropic vision token cost) — Telegram itself caps
// uploads at 50 MB so anything above is suspicious.
const telegramPhotoSizeSchema = z.object({
  file_id: z.string(),
  file_unique_id: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  file_size: z.number().optional(),
});

const telegramVoiceSchema = z.object({
  file_id: z.string(),
  file_unique_id: z.string().optional(),
  duration: z.number().optional(),
  mime_type: z.string().optional(),
  file_size: z.number().optional(),
});

const telegramDocumentSchema = z.object({
  file_id: z.string(),
  file_unique_id: z.string().optional(),
  file_name: z.string().optional(),
  mime_type: z.string().optional(),
  file_size: z.number().optional(),
});

const telegramMessageSchema = z.object({
  message_id: z.number().optional(),
  date: z.number().optional(),
  from: telegramUserSchema,
  chat: telegramChatSchema,
  text: z.string().optional(),
  caption: z.string().optional(),
  photo: z.array(telegramPhotoSizeSchema).optional(),
  voice: telegramVoiceSchema.optional(),
  document: telegramDocumentSchema.optional(),
});

export type TelegramPhotoSize = z.infer<typeof telegramPhotoSizeSchema>;
export type TelegramVoice = z.infer<typeof telegramVoiceSchema>;
export type TelegramDocument = z.infer<typeof telegramDocumentSchema>;
export type TelegramMessage = z.infer<typeof telegramMessageSchema>;

// PR-A.6 attachment caps (R349).
//   photo: 5 MB hard cap — Anthropic Haiku vision charges per token, and
//          5 MB ≈ ~6k tokens in base64.
//   voice: 20 MB — ~30 min OGG/Opus, well above what BOSS would ever send.
//   document: 20 MB — Telegram itself caps uploads at 50 MB, but PDFs >20 MB
//             rarely have useful extractable text and would dominate cache.
export const TELEGRAM_PHOTO_MAX_BYTES = 5 * 1024 * 1024;
export const TELEGRAM_VOICE_MAX_BYTES = 20 * 1024 * 1024;
export const TELEGRAM_DOCUMENT_MAX_BYTES = 20 * 1024 * 1024;

// Telegram inbound attachments hold raw user-uploaded media → fall under PII
// retention. R349 sets the deadline at 90 days from upload; the cron in
// server/lib/jobs/asset-cleanup.ts deletes the binary and patches storage_key=null
// after that mark, while preserving summary/transcription for context continuity.
export const TELEGRAM_PII_RETENTION_DAYS = 90;

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

// ── PR-A.6 — Telegram media ingest → Supabase Storage → AttachmentMeta ──────
//
// Pipeline (called from POST /api/telegram/webhook on photo/voice/document):
//   1. enforce per-type size cap (rejects up-front, audit row notes which cap)
//   2. getTelegramFile(file_id)        → file_path on api.telegram.org
//   3. fetchTelegramFile(file_path)    → raw bytes (token NEVER logged)
//   4. saveAssetAndSign(BOSS, AGENT)   → Supabase storage_key + signed_url (1h)
//   5. build AttachmentMeta with expires_at = now + 90d (PII retention)
//   6. summarizeAttachment(messageId, attId) fire-and-forget after addRoomMessage
//
// Why this lives in telegram-inbound.ts and not a separate module: the route
// handler already imports from here, the helpers below are Telegram-specific,
// and keeping them next to telegramMessageSchema makes the contract obvious.

/**
 * F2 — token redaction. Every Telegram file URL contains the bot token verbatim:
 *   https://api.telegram.org/file/bot<TOKEN>/<path>
 * If we ever log the URL as-is, the token leaks into logs forever. This helper
 * returns a path with the bot prefix replaced by `bot<redacted>` so structured
 * logs are safe to ship to Datadog/Sentry without rotating the token.
 */
export function safeFilePath(urlOrPath: string | null | undefined): string {
  if (!urlOrPath) return "";
  return urlOrPath.replace(/bot[\d]+:[A-Za-z0-9_-]+/g, "bot<redacted>");
}

export interface TelegramFileInfo {
  file_id: string;
  file_path: string;
  file_size: number | null;
}

/**
 * Resolve a Telegram file_id to its file_path via getFile.
 *
 * Returns null on any non-2xx or schema mismatch — caller falls back to a
 * "Не удалось загрузить" outbound message. Never throws.
 */
export async function getTelegramFile(fileId: string): Promise<TelegramFileInfo | null> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    logger.warn("[telegram-inbound] getTelegramFile: TELEGRAM_BOT_TOKEN unset");
    return null;
  }
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) {
      logger.warn(
        { status: res.status, fileId },
        "[telegram-inbound] getFile non-2xx",
      );
      return null;
    }
    const j = (await res.json()) as {
      ok?: boolean;
      result?: { file_id?: string; file_path?: string; file_size?: number };
    };
    if (!j.ok || !j.result?.file_path || !j.result.file_id) {
      logger.warn({ fileId }, "[telegram-inbound] getFile missing file_path");
      return null;
    }
    return {
      file_id: j.result.file_id,
      file_path: j.result.file_path,
      file_size: typeof j.result.file_size === "number" ? j.result.file_size : null,
    };
  } catch (err: any) {
    logger.warn({ err: err?.message, fileId }, "[telegram-inbound] getFile threw");
    return null;
  }
}

/**
 * Download the raw bytes of a Telegram file. Token NEVER appears in error
 * payloads (we redact via safeFilePath before logging).
 *
 * Returns null on non-2xx or fetch errors so caller can degrade gracefully.
 */
export async function fetchTelegramFile(
  filePath: string,
  maxBytes: number,
): Promise<{ data: Buffer; mime: string } | null> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    logger.warn("[telegram-inbound] fetchTelegramFile: TELEGRAM_BOT_TOKEN unset");
    return null;
  }
  // The actual URL contains the token; only `safeFilePath(filePath)` ever
  // hits the logger.
  const url = `https://api.telegram.org/file/bot${token}/${filePath}`;
  const safePath = safeFilePath(filePath);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      logger.warn(
        { status: res.status, filePath: safePath },
        "[telegram-inbound] fetchTelegramFile non-2xx",
      );
      return null;
    }
    const ab = await res.arrayBuffer();
    if (ab.byteLength > maxBytes) {
      logger.warn(
        { sizeBytes: ab.byteLength, maxBytes, filePath: safePath },
        "[telegram-inbound] fetchTelegramFile body exceeds cap",
      );
      return null;
    }
    const data = Buffer.from(ab);
    const mime = res.headers.get("content-type") || "application/octet-stream";
    return { data, mime };
  } catch (err: any) {
    logger.warn(
      { err: err?.message, filePath: safePath },
      "[telegram-inbound] fetchTelegramFile threw",
    );
    return null;
  }
}

/**
 * Pick the highest-quality PhotoSize entry that still fits the cap. Telegram
 * sends a sorted-by-size array (smallest first) but we don't rely on order —
 * we explicitly pick by file_size. Entries with missing file_size are skipped
 * to avoid downloading something we can't bound up-front.
 */
export function pickLargestPhoto(
  photos: TelegramPhotoSize[],
  maxBytes: number,
): TelegramPhotoSize | null {
  let best: TelegramPhotoSize | null = null;
  for (const p of photos) {
    const s = p.file_size;
    if (typeof s !== "number" || s <= 0) continue;
    if (s > maxBytes) continue;
    if (!best || (best.file_size ?? 0) < s) best = p;
  }
  // Fallback: nothing had file_size. Use the last entry (Telegram's largest)
  // and let fetchTelegramFile enforce the cap mid-download.
  if (!best && photos.length > 0) best = photos[photos.length - 1];
  return best;
}

/** Lazy `att_<uuid>` so callers don't have to import randomUUID directly. */
export function newAttachmentId(): string {
  return `att_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/**
 * Slug a Telegram-supplied filename so it's safe as a Supabase Storage key
 * fragment. Strip directory separators, control chars, and reduce to ASCII
 * + hyphens. The full filename is preserved on AttachmentMeta.original_name
 * — this is just for the storage path.
 */
function slugifyFilename(name: string): string {
  return name
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "file";
}

export interface BuildAttachmentInput {
  type: AttachmentMeta["type"];
  bytes: { data: Buffer; mime: string };
  originalName: string;
  durationSec?: number | null;
  mimeOverride?: string;
  /** Owner of the storage namespace (BOSS for Telegram inbound). */
  userId: number;
  /** Agent slot under userId (Лука = 16 in production). */
  agentId: number;
  /** PII retention deadline. Defaults to 90d for Telegram source. */
  ttlMs?: number;
}

/**
 * Upload bytes to Supabase Storage and synthesize an AttachmentMeta ready to
 * embed in room_messages.attachments. Pure builder — does NOT touch DB.
 *
 * Storage path layout: `inbox/telegram/<yyyy-mm-dd>/<attId>-<filename>`. The
 * date prefix makes manual S3-style listing humane; the attId prefix makes
 * any future garbage-collect / PII purge trivially scoped.
 */
export async function buildAttachmentFromBytes(
  input: BuildAttachmentInput,
): Promise<AttachmentMeta> {
  const id = newAttachmentId();
  const now = Date.now();
  const date = new Date(now).toISOString().slice(0, 10);
  const slug = slugifyFilename(input.originalName);
  const relPath = `inbox/telegram/${date}/${id}-${slug}`;
  const mime = input.mimeOverride || input.bytes.mime || "application/octet-stream";

  const { key, url } = await saveAssetAndSign(
    input.userId,
    input.agentId,
    relPath,
    input.bytes.data,
    { contentType: mime, expiresSec: 3600 },
  );

  const ttlMs = input.ttlMs ?? TELEGRAM_PII_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  return {
    id,
    type: input.type,
    mime,
    size_bytes: input.bytes.data.length,
    storage_key: key,
    signed_url: url,
    signed_url_expires_at: now + 60 * 60 * 1000,
    summary: null,
    transcription: null,
    extracted_text: null,
    duration_sec: input.durationSec ?? null,
    original_name: input.originalName,
    uploaded_at: now,
    expires_at: now + ttlMs,
  };
}

export interface ProcessAttachmentResult {
  ok: true;
  attachment: AttachmentMeta;
}
export interface ProcessAttachmentFail {
  ok: false;
  reason:
    | "size_cap"
    | "missing_token"
    | "getfile_failed"
    | "download_failed"
    | "storage_failed"
    | "unsupported";
}

/**
 * One-shot helper: take a parsed Telegram message + attachment kind, do the
 * full size-check → getFile → download → Supabase upload → AttachmentMeta
 * synthesis. Returns a discriminated union the route handler can branch on.
 *
 * The route handler is responsible for inserting the room_message row with
 * the returned attachment, then calling summarizeAttachment(messageId, attId)
 * fire-and-forget.
 */
export async function processTelegramAttachment(
  message: TelegramMessage,
  agentId: number,
  userId: number = BOSS_USER_ID,
): Promise<ProcessAttachmentResult | ProcessAttachmentFail> {
  // Photo branch — pick largest, cap 5 MB.
  if (message.photo && message.photo.length > 0) {
    const pick = pickLargestPhoto(message.photo, TELEGRAM_PHOTO_MAX_BYTES);
    if (!pick) return { ok: false, reason: "size_cap" };
    const info = await getTelegramFile(pick.file_id);
    if (!info) return { ok: false, reason: "getfile_failed" };
    if (typeof info.file_size === "number" && info.file_size > TELEGRAM_PHOTO_MAX_BYTES) {
      return { ok: false, reason: "size_cap" };
    }
    const dl = await fetchTelegramFile(info.file_path, TELEGRAM_PHOTO_MAX_BYTES);
    if (!dl) return { ok: false, reason: "download_failed" };
    // Telegram serves photos as JPEG by default; honour content-type returned.
    try {
      const att = await buildAttachmentFromBytes({
        type: "image",
        bytes: dl,
        originalName: `photo-${pick.file_unique_id ?? pick.file_id.slice(0, 8)}.jpg`,
        userId,
        agentId,
      });
      return { ok: true, attachment: att };
    } catch (err: any) {
      logger.warn({ err: err?.message }, "[telegram-inbound] photo storage upload failed");
      return { ok: false, reason: "storage_failed" };
    }
  }

  // Voice branch — single object, cap 20 MB.
  if (message.voice) {
    const v = message.voice;
    if (typeof v.file_size === "number" && v.file_size > TELEGRAM_VOICE_MAX_BYTES) {
      return { ok: false, reason: "size_cap" };
    }
    const info = await getTelegramFile(v.file_id);
    if (!info) return { ok: false, reason: "getfile_failed" };
    if (typeof info.file_size === "number" && info.file_size > TELEGRAM_VOICE_MAX_BYTES) {
      return { ok: false, reason: "size_cap" };
    }
    const dl = await fetchTelegramFile(info.file_path, TELEGRAM_VOICE_MAX_BYTES);
    if (!dl) return { ok: false, reason: "download_failed" };
    const mime = v.mime_type || dl.mime || "audio/ogg";
    const ext = mime.includes("ogg") ? "ogg" : mime.includes("mp4") ? "m4a" : "voice";
    try {
      const att = await buildAttachmentFromBytes({
        type: "voice",
        bytes: { data: dl.data, mime },
        originalName: `voice-${v.file_unique_id ?? v.file_id.slice(0, 8)}.${ext}`,
        durationSec: typeof v.duration === "number" ? v.duration : null,
        mimeOverride: mime,
        userId,
        agentId,
      });
      return { ok: true, attachment: att };
    } catch (err: any) {
      logger.warn({ err: err?.message }, "[telegram-inbound] voice storage upload failed");
      return { ok: false, reason: "storage_failed" };
    }
  }

  // Document branch — single object, cap 20 MB. PDF/Word/text — anything else
  // is stored but only filename will land in the summary (per attachment-summarizer.ts).
  if (message.document) {
    const d = message.document;
    if (typeof d.file_size === "number" && d.file_size > TELEGRAM_DOCUMENT_MAX_BYTES) {
      return { ok: false, reason: "size_cap" };
    }
    const info = await getTelegramFile(d.file_id);
    if (!info) return { ok: false, reason: "getfile_failed" };
    if (typeof info.file_size === "number" && info.file_size > TELEGRAM_DOCUMENT_MAX_BYTES) {
      return { ok: false, reason: "size_cap" };
    }
    const dl = await fetchTelegramFile(info.file_path, TELEGRAM_DOCUMENT_MAX_BYTES);
    if (!dl) return { ok: false, reason: "download_failed" };
    const mime = d.mime_type || dl.mime || "application/octet-stream";
    const name = d.file_name || `file-${d.file_unique_id ?? d.file_id.slice(0, 8)}`;
    try {
      const att = await buildAttachmentFromBytes({
        type: "file",
        bytes: { data: dl.data, mime },
        originalName: name,
        mimeOverride: mime,
        userId,
        agentId,
      });
      return { ok: true, attachment: att };
    } catch (err: any) {
      logger.warn({ err: err?.message }, "[telegram-inbound] document storage upload failed");
      return { ok: false, reason: "storage_failed" };
    }
  }

  return { ok: false, reason: "unsupported" };
}

/** Convenience: kick off summarizer in fire-and-forget mode with logging. */
export function scheduleAttachmentSummary(
  messageId: number,
  attachmentId: string,
  onReady?: (e: { messageId: number; attachmentId: string; summary: string }) => void,
): void {
  summarizeAttachment(messageId, attachmentId, { onReady }).catch((err) => {
    logger.warn(
      { err, messageId, attachmentId },
      "[telegram-inbound] summarizeAttachment threw",
    );
  });
}
