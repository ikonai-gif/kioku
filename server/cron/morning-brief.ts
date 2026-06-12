/**
 * CRON-1 Morning Brief — [BRO2-A15 / LUCA-076] build order #2 PR1.
 *
 * Composes calendar + unread email + active tasks via the EXISTING partner
 * tool dispatcher (executePartnerTool), so classification, the approval
 * gate, audit logging, and auto_mode marking apply to scheduled runs
 * identically to interactive ones (LUCA-076 §4). The whole run executes
 * inside an audit context (source='cron', jobId='CRON-1').
 *
 * Gates (all default OFF — BOSS flips after merge+verify):
 *   LUCA_ROUTINES_ENABLED=true        master switch for scheduled routines
 *   LUCA_CRON_TELEGRAM_APPROVED=true  BOSS standing pre-approval for the
 *                                     Telegram send (LUCA-076 §3 variant A;
 *                                     source of truth: Notion [LUCA-076])
 * Rate cap: max 1 run / LUCA_CRON_RATE_CAP_HOURS (default 6) — see
 * rate-limiter.ts. HARD RULE intact: removing either flag stops the brief;
 * no build/merge/deploy/spend paths exist here.
 */
import logger from "../logger";
import { executePartnerTool } from "../deliberation";
import { sendTelegramMessage } from "../lib/telegram";
import { runWithAuditContext } from "../lib/luca-tools/audit-context";
import { checkAndMarkCronRun } from "./rate-limiter";

export const CRON1_JOB_ID = "CRON-1";

export interface MorningBriefResult {
  status: "sent" | "skipped" | "error";
  reason?: string;
}

export function routinesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.LUCA_ROUTINES_ENABLED ?? "").trim().toLowerCase() === "true";
}

export function cronTelegramApproved(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.LUCA_CRON_TELEGRAM_APPROVED ?? "").trim().toLowerCase() === "true";
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

/** Defensive parse of a tool's stringified JSON result. */
function tryParse(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * Pure formatter — LUCA-076 §2: each block ≤200 chars, total ≤600.
 * Exported for unit tests.
 */
export function formatMorningBrief(params: {
  dateLabel: string;
  calendarSummary: string;
  emailSummary: string;
  tasksSummary: string;
}): string {
  const cal = clip(params.calendarSummary, 200);
  const mail = clip(params.emailSummary, 200);
  const tasks = clip(params.tasksSummary, 200);
  const msg = `☀️ Доброе утро, Котэ — ${params.dateLabel}\n\n📅 СЕГОДНЯ: ${cal}\n\n📬 ПОЧТА: ${mail}\n\n✅ АКТИВНЫЕ ЗАДАЧИ: ${tasks}`;
  return clip(msg, 640); // headroom for emoji/labels over the 600 content budget
}

function summarizeCalendar(raw: string): string {
  const parsed = tryParse(raw) as any;
  const events: any[] = Array.isArray(parsed) ? parsed : parsed?.events ?? parsed?.items ?? [];
  if (!Array.isArray(events) || events.length === 0) return "Ничего запланировано";
  const first = events.slice(0, 2).map((e) => e?.summary ?? e?.title ?? "событие").join("; ");
  return `${events.length} событ. → ${first}`;
}

function summarizeEmail(raw: string): string {
  const parsed = tryParse(raw) as any;
  const msgs: any[] = Array.isArray(parsed) ? parsed : parsed?.messages ?? parsed?.emails ?? [];
  if (!Array.isArray(msgs) || msgs.length === 0) return "0 непрочитанных";
  const urgent = msgs.filter((m) => m?.urgency === "high" || m?.category === "urgent");
  const head = (urgent.length ? urgent : msgs).slice(0, 2).map((m) => m?.subject ?? "(без темы)").join("; ");
  return `${msgs.length} непрочит.${urgent.length ? ` (${urgent.length} срочн.)` : ""} → ${head}`;
}

function summarizeTasks(raw: string): string {
  const parsed = tryParse(raw) as any;
  const tasks: any[] = Array.isArray(parsed) ? parsed : parsed?.tasks ?? parsed?.items ?? [];
  if (!Array.isArray(tasks) || tasks.length === 0) return "0 активных";
  const head = tasks.slice(0, 2).map((t) => t?.title ?? t?.name ?? "задача").join("; ");
  return `${tasks.length} → ${head}`;
}

export async function runMorningBrief(env: NodeJS.ProcessEnv = process.env): Promise<MorningBriefResult> {
  if (!routinesEnabled(env)) {
    logger.info({ component: "cron", job: CRON1_JOB_ID }, "[CRON-1] DISABLED — LUCA_ROUTINES_ENABLED=false");
    return { status: "skipped", reason: "routines_disabled" };
  }
  const allowed = await checkAndMarkCronRun(CRON1_JOB_ID);
  if (!allowed) return { status: "skipped", reason: "rate_capped" };

  const userId = Number(env.LUCA_CRON_USER_ID ?? "10");
  const agentId = Number(env.LUCA_CRON_AGENT_ID ?? "16");
  const chatId = env.TELEGRAM_BOSS_CHAT_ID;

  try {
    return await runWithAuditContext({ source: "cron", jobId: CRON1_JOB_ID }, async () => {
      const now = new Date();
      const tz = "America/Los_Angeles";
      const dateLabel = now.toLocaleDateString("ru-RU", { day: "numeric", month: "long", timeZone: tz });
      const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(now); dayEnd.setHours(23, 59, 59, 0);

      // READ_ONLY composition through the real dispatcher — audit +
      // auto_mode marking happen exactly as in interactive runs.
      const [calRaw, mailRaw, tasksRaw] = await Promise.all([
        executePartnerTool("luca_calendar_list", { maxResults: 5, timeMin: dayStart.toISOString(), timeMax: dayEnd.toISOString() }, userId, agentId).catch((e) => `{"error":"${String(e).slice(0, 80)}"}`),
        executePartnerTool("email_triage", { max_messages: 20, only_unread: true }, userId, agentId).catch((e) => `{"error":"${String(e).slice(0, 80)}"}`),
        executePartnerTool("list_tasks", { status: "active" }, userId, agentId).catch((e) => `{"error":"${String(e).slice(0, 80)}"}`),
      ]);

      const text = formatMorningBrief({
        dateLabel,
        calendarSummary: summarizeCalendar(calRaw),
        emailSummary: summarizeEmail(mailRaw),
        tasksSummary: summarizeTasks(tasksRaw),
      });

      if (!cronTelegramApproved(env)) {
        logger.info(
          { component: "cron", job: CRON1_JOB_ID, preview: text.slice(0, 120) },
          "[CRON-1] composed but NOT sent — LUCA_CRON_TELEGRAM_APPROVED=false (BOSS standing pre-approval absent)",
        );
        return { status: "skipped", reason: "telegram_not_approved" };
      }
      if (!chatId) {
        logger.warn({ component: "cron", job: CRON1_JOB_ID }, "[CRON-1] TELEGRAM_BOSS_CHAT_ID unset — cannot send");
        return { status: "skipped", reason: "no_chat_id" };
      }

      const res = await sendTelegramMessage({
        chatId,
        text,
        urgency: "normal",
        userId,
        reason: "cron:CRON-1 morning brief (standing pre-approval LUCA-076 §3, flag LUCA_CRON_TELEGRAM_APPROVED)",
      });
      if (!res || (res as any).delivered === false) {
        return { status: "error", reason: "telegram_send_failed" };
      }
      logger.info({ component: "cron", job: CRON1_JOB_ID }, "[CRON-1] morning brief sent");
      return { status: "sent" };
    });
  } catch (e) {
    logger.error({ component: "cron", job: CRON1_JOB_ID, err: String(e) }, "[CRON-1] run failed");
    return { status: "error", reason: String(e).slice(0, 200) };
  }
}
