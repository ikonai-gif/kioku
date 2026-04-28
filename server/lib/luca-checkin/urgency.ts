/**
 * LEO PR-A — Urgency classifier.
 *
 * Returns one of three tiers — `high | normal | low` — for a candidate
 * outreach event. Every classification flows through deterministic hard
 * rules first; only when nothing matches do we ask Claude Haiku.
 *
 * Default-low is the safe answer. Per BRO1 cron spec, a `low` finding is
 * skipped entirely; a misclassified `high` would either bypass the gate
 * (urgency='high' → LOW_STAKES_WRITE downgrade) or wake BOSS during quiet
 * hours, both undesirable. So when the LLM errors, times out, or returns
 * unparseable text, we fall back to `low` and the cron skips the event.
 *
 * The hard rules CANNOT be overridden by the LLM. The LLM never sees a
 * pre-classified event — we return before calling it.
 */

import Anthropic from "@anthropic-ai/sdk";
import { readLucaEnv } from "../luca/env";
import logger from "../../logger";

export type Urgency = "high" | "normal" | "low";

export interface ClassifyContext {
  source: "cron" | "gmail" | "gcal" | "manual";
  senderEmail?: string;
  subject?: string;
  bodyExcerpt?: string;
  /** Hours until the next calendar conflict (smaller = more urgent). */
  calendarConflictWithinHours?: number;
  /** Free-text describing what cron observed (e.g. "build_failed:CI"). */
  cronFinding?: string;
}

export interface ClassifyResult {
  urgency: Urgency;
  reason: string;
}

const EMERGENCY_KEYWORDS = [
  "emergency",
  "asap",
  "immediately",
  "срочно",
  "срочн",
  "крит",
  "critical",
  "outage",
  "down",
  "production",
];

/**
 * Test seam: when set, replaces the live Anthropic call with the supplied
 * resolver. Production code path never sets this. The classifier still
 * applies its sanitization to whatever the resolver returns.
 */
type LlmFn = (
  prompt: string,
  systemPrompt: string,
  model: string,
  signal: AbortSignal,
) => Promise<string>;

let __llmOverride: LlmFn | null = null;

/** Internal — for unit tests only. */
export function __setUrgencyLlmForTests(fn: LlmFn | null): void {
  __llmOverride = fn;
}

/** Default LLM caller — pure, takes already-built prompt/system. */
async function callAnthropic(
  prompt: string,
  systemPrompt: string,
  model: string,
  signal: AbortSignal,
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("anthropic_api_key_missing");
  }
  // Anthropic SDK accepts an AbortSignal via the second arg `requestOptions`
  // — pass it through so AbortController.abort() truly cancels the request.
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create(
    {
      model,
      max_tokens: 16,
      system: systemPrompt,
      messages: [{ role: "user", content: prompt }],
    },
    { signal },
  );
  const block = response.content?.[0];
  if (block && block.type === "text") return block.text ?? "";
  return "";
}

function buildPrompt(ctx: ClassifyContext): string {
  const parts: string[] = [];
  parts.push(`source: ${ctx.source}`);
  if (ctx.senderEmail) parts.push(`from: ${ctx.senderEmail}`);
  if (ctx.subject) parts.push(`subject: ${ctx.subject}`);
  if (ctx.bodyExcerpt) parts.push(`body: ${ctx.bodyExcerpt.slice(0, 600)}`);
  if (typeof ctx.calendarConflictWithinHours === "number") {
    parts.push(`calendar_conflict_in_hours: ${ctx.calendarConflictWithinHours}`);
  }
  if (ctx.cronFinding) parts.push(`cron_finding: ${ctx.cronFinding}`);
  return parts.join("\n");
}

const SYSTEM_PROMPT =
  "You are an urgency triage classifier for an executive assistant.\n" +
  "Read the input event and respond with EXACTLY one of the three tokens: high | normal | low.\n" +
  "high — VIP correspondents, time-critical events (within hours), or production emergencies.\n" +
  "normal — routine requests that benefit from a check-in but are not blocking.\n" +
  "low — informational, can wait, or unclear.\n" +
  "Default to low if unsure. Never invent reasons not in the input. " +
  "Output a single line: just the token, lowercase, no punctuation.";

function sanitizeLlmOutput(raw: string): Urgency | null {
  // Take the first non-empty line and lowercase it. Reject anything that
  // doesn't match the closed set — the LLM may wrap the answer in
  // explanation despite the instructions, and we'd rather be wrong-toward-
  // safe (low) than execute on parsed garbage.
  if (!raw) return null;
  const firstLine = raw.split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 0);
  if (!firstLine) return null;
  const lower = firstLine.toLowerCase().replace(/[^a-z]/g, "");
  if (lower === "high" || lower === "normal" || lower === "low") {
    return lower as Urgency;
  }
  return null;
}

/**
 * Classify the urgency of a single outreach event.
 *
 * Order of operations:
 *   1. VIP sender match (LUCA_VIP_SENDERS) → `high`
 *   2. Calendar conflict ≤ 2h          → `high`
 *   3. Emergency keyword in subj/body   → `high`
 *   4. Otherwise call Claude Haiku (2s timeout) and sanitize
 *   5. On any LLM error/timeout/unparseable → `low`
 */
export async function classifyUrgency(ctx: ClassifyContext): Promise<ClassifyResult> {
  const env = readLucaEnv();

  // 1. VIP sender match — case-insensitive substring match on the local
  //    part is too loose; we compare full email equality. VIP list is
  //    pre-lowercased by readLucaEnv.
  if (ctx.senderEmail) {
    const sender = ctx.senderEmail.trim().toLowerCase();
    for (const vip of env.LUCA_VIP_SENDERS) {
      if (sender === vip || sender.includes(vip)) {
        return { urgency: "high", reason: `vip_sender:${ctx.senderEmail}` };
      }
    }
  }

  // 2. Calendar conflict within 2 hours.
  if (
    typeof ctx.calendarConflictWithinHours === "number" &&
    ctx.calendarConflictWithinHours <= 2
  ) {
    return { urgency: "high", reason: "calendar_conflict_2h" };
  }

  // 3. Emergency keyword in subject or body.
  const haystack = `${ctx.subject ?? ""} ${ctx.bodyExcerpt ?? ""}`.toLowerCase();
  for (const kw of EMERGENCY_KEYWORDS) {
    if (haystack.includes(kw)) {
      return { urgency: "high", reason: `emergency_keyword:${kw}` };
    }
  }

  // 4. LLM classification with 2-second budget.
  const model = env.LUCA_URGENCY_MODEL || "claude-haiku-4-5";
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 2000);
  let llmRaw = "";
  try {
    const fn = __llmOverride ?? callAnthropic;
    llmRaw = await fn(buildPrompt(ctx), SYSTEM_PROMPT, model, ac.signal);
  } catch (err: any) {
    clearTimeout(timer);
    const msg = err?.name === "AbortError"
      ? "timeout"
      : err?.message
        ? String(err.message).slice(0, 80)
        : "unknown";
    logger.warn(
      { component: "luca-checkin", event: "urgency_llm_error", error: msg },
      "[luca-checkin] urgency LLM failed; defaulting low",
    );
    return { urgency: "low", reason: `llm_error:${msg}` };
  }
  clearTimeout(timer);

  const parsed = sanitizeLlmOutput(llmRaw);
  if (!parsed) {
    return { urgency: "low", reason: "llm_unparseable" };
  }
  return { urgency: parsed, reason: `llm:${parsed}` };
}
