/**
 * PR-A.6 — Attachment summarizer (async, fire-and-forget).
 *
 * After a room_message is persisted with attachment metadata, the route
 * handler / telegram inbound calls summarizeAttachment(messageId, attId) in a
 * non-blocking way. This module:
 *
 *   1. Limits concurrent summary calls to MAX_PARALLEL=3 (in-process FIFO
 *      queue — we deliberately avoid p-limit / npm install per R349 DON'T).
 *   2. Routes by attachment type:
 *        - image / video_frame  → Anthropic Claude vision (caption + OCR hint)
 *        - voice                → OpenAI Whisper transcription (full text +
 *                                 100-char head as summary)
 *        - file (pdf/word/text) → pdf-parse / utf8 best-effort text extraction
 *        - everything else      → "[type] original_name" placeholder
 *   3. Patches the attachment JSONB slot with summary / transcription /
 *      extracted_text fields.
 *   4. Re-derives room_messages.search_text so FTS picks up the new content.
 *   5. (Optional) broadcasts a `attachment_summary_ready` WS event so the
 *      web client can refresh tooltips. Broadcast is best-effort: any error
 *      is logged and swallowed; the DB is the source of truth.
 */

import { setTimeout as delay } from "node:timers/promises";

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

import logger from "../logger";
import { storage } from "../storage";
import { getAssetBytes } from "./asset-bytes-cache";
import type { AttachmentMeta } from "@shared/schema";

// ── concurrency limiter ──────────────────────────────────────────────────────

const MAX_PARALLEL = 3;
let active = 0;
const queue: Array<() => void> = [];

/** Visible to tests: current concurrency / queue depth. */
export function __getQueueStateForTests(): { active: number; queued: number } {
  return { active, queued: queue.length };
}

/** Visible to tests: drain everything (for after-each cleanup). */
export async function __waitForIdleForTests(timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (active > 0 || queue.length > 0) {
    if (Date.now() > deadline) {
      throw new Error(
        `summarizer: queue did not drain in ${timeoutMs}ms (active=${active}, queued=${queue.length})`,
      );
    }
    await delay(20);
  }
}

async function withSummaryLimit<T>(fn: () => Promise<T>): Promise<T> {
  while (active >= MAX_PARALLEL) {
    await new Promise<void>((resolve) => queue.push(resolve));
  }
  active++;
  try {
    return await fn();
  } finally {
    active--;
    queue.shift()?.();
  }
}

// ── client lookups (lazy — keeps cold start cheap) ───────────────────────────

let anthropicClient: Anthropic | null = null;
function getAnthropic(): Anthropic | null {
  if (anthropicClient) return anthropicClient;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  anthropicClient = new Anthropic({ apiKey: key });
  return anthropicClient;
}

let openaiClient: OpenAI | null = null;
function getOpenAI(): OpenAI | null {
  if (openaiClient) return openaiClient;
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  openaiClient = new OpenAI({ apiKey: key });
  return openaiClient;
}

// ── type-specific summarizers ────────────────────────────────────────────────

const IMAGE_SUMMARY_PROMPT =
  "В одном предложении (по-русски): что изображено. " +
  "Если на картинке есть text — процитируй главный текст в кавычках. " +
  "Не более 200 символов.";

async function summarizeImage(att: AttachmentMeta): Promise<string> {
  const bytes = await getAssetBytes(att.storage_key);
  if (!bytes) return att.original_name || "[image]";

  const client = getAnthropic();
  if (!client) {
    // No Anthropic key in env — graceful fallback. We still mark the row.
    return att.original_name || "[image]";
  }

  try {
    const res = await client.messages.create({
      model: "claude-3-5-haiku-latest",
      max_tokens: 200,
      system: IMAGE_SUMMARY_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: bytes.mime as
                  | "image/png"
                  | "image/jpeg"
                  | "image/gif"
                  | "image/webp",
                data: bytes.data.toString("base64"),
              },
            },
          ],
        },
      ],
    });
    const block = res.content.find((b) => b.type === "text");
    const text = block && block.type === "text" ? block.text.trim() : "";
    return text || att.original_name || "[image]";
  } catch (err) {
    logger.warn(
      { err, attachmentId: att.id, mime: att.mime },
      "[summarizer] image summary failed",
    );
    return att.original_name || "[image]";
  }
}

interface VoiceResult {
  summary: string;
  transcription: string | null;
}

async function summarizeVoice(att: AttachmentMeta): Promise<VoiceResult> {
  const bytes = await getAssetBytes(att.storage_key);
  if (!bytes) {
    return {
      summary: `Voice [${att.duration_sec ?? "?"}s]`,
      transcription: null,
    };
  }

  const oai = getOpenAI();
  if (!oai) {
    return {
      summary: `Voice [${att.duration_sec ?? "?"}s]`,
      transcription: null,
    };
  }

  try {
    // OpenAI SDK accepts a Web File. We make one from the raw bytes.
    const ext = (att.mime.split("/")[1] || "ogg").replace(/[^a-z0-9]/gi, "");
    const filename = `voice.${ext || "ogg"}`;
    const file = new File([bytes.data], filename, { type: bytes.mime });
    const res = await oai.audio.transcriptions.create({
      file,
      model: "whisper-1",
      response_format: "json",
    });
    const text = ((res as unknown as { text?: string }).text ?? "").trim();
    if (!text) {
      return { summary: `Voice [${att.duration_sec ?? "?"}s]`, transcription: null };
    }
    const summary = text.length > 100 ? text.slice(0, 100) + "…" : text;
    return { summary, transcription: text };
  } catch (err) {
    logger.warn(
      { err, attachmentId: att.id, mime: att.mime },
      "[summarizer] voice transcription failed",
    );
    return { summary: `Voice [${att.duration_sec ?? "?"}s]`, transcription: null };
  }
}

interface FileResult {
  summary: string;
  extractedText: string | null;
}

async function summarizeFile(att: AttachmentMeta): Promise<FileResult> {
  const bytes = await getAssetBytes(att.storage_key);
  if (!bytes) {
    return { summary: att.original_name || "[file]", extractedText: null };
  }

  // PDF: dynamic-import pdf-parse so fixture-loading doesn't run at module
  // import time (the package eagerly reads a sample PDF on require()).
  const looksLikePdf = att.mime === "application/pdf" || /\.pdf$/i.test(att.original_name);
  const looksLikeText =
    att.mime.startsWith("text/") ||
    /\.(txt|md|csv|json|log)$/i.test(att.original_name);

  let text = "";
  try {
    if (looksLikePdf) {
      // pdf-parse has no types; cast the dynamic import explicitly.
      const mod = (await import("pdf-parse" as string)) as {
        default: (b: Buffer) => Promise<{ text: string }>;
      };
      const out = await mod.default(bytes.data);
      text = (out.text || "").trim();
    } else if (looksLikeText) {
      text = bytes.data.toString("utf-8", 0, Math.min(bytes.data.length, 200_000));
    } else {
      // Word docs, Excel etc. — out of scope for PR-A.6. Leave empty.
      return {
        summary: `[${att.type}] ${att.original_name}`,
        extractedText: null,
      };
    }
  } catch (err) {
    logger.warn(
      { err, attachmentId: att.id, mime: att.mime },
      "[summarizer] file extraction failed",
    );
    return { summary: `[${att.type}] ${att.original_name}`, extractedText: null };
  }

  const summary = text ? text.slice(0, 200) + (text.length > 200 ? "…" : "") : att.original_name;
  return { summary, extractedText: text || null };
}

// ── public entry point ───────────────────────────────────────────────────────

export interface SummarizeOptions {
  /** Optional callback invoked after the JSONB has been patched. */
  onReady?: (event: {
    messageId: number;
    attachmentId: string;
    summary: string;
  }) => void;
}

/**
 * Summarize a single attachment.
 *
 * - Re-reads the attachment from storage (don't trust caller-passed copy —
 *   another writer may have updated signed_url).
 * - Performs type-specific summarization.
 * - Patches summary / transcription / extracted_text into the JSONB slot.
 * - Re-derives search_text on the parent row.
 * - Calls onReady (used by the route handler to broadcast WS).
 *
 * Errors are logged and swallowed: this is fire-and-forget. The summary
 * may end up as the original filename or `"[image]"` if everything failed,
 * and the attachment will simply not have rich text to feed deliberation.
 */
export async function summarizeAttachment(
  messageId: number,
  attachmentId: string,
  opts: SummarizeOptions = {},
): Promise<void> {
  return withSummaryLimit(async () => {
    let att: AttachmentMeta | null;
    try {
      att = await storage.getAttachment(messageId, attachmentId);
    } catch (err) {
      logger.warn(
        { err, messageId, attachmentId },
        "[summarizer] getAttachment threw",
      );
      return;
    }
    if (!att) {
      logger.info(
        { messageId, attachmentId },
        "[summarizer] attachment not found (likely deleted before summary ran)",
      );
      return;
    }

    let summary = "";
    let transcription: string | null = null;
    let extractedText: string | null = null;

    if (att.type === "image" || att.type === "video_frame") {
      summary = await summarizeImage(att);
    } else if (att.type === "voice") {
      const r = await summarizeVoice(att);
      summary = r.summary;
      transcription = r.transcription;
    } else if (att.type === "file") {
      const r = await summarizeFile(att);
      summary = r.summary;
      extractedText = r.extractedText;
    } else {
      summary = `[${att.type as string}] ${att.original_name}`;
    }

    try {
      await storage.patchAttachment(messageId, attachmentId, {
        summary,
        transcription,
        extracted_text: extractedText,
      });
      await storage.updateMessageSearchText(messageId);
    } catch (err) {
      logger.warn(
        { err, messageId, attachmentId },
        "[summarizer] patchAttachment failed",
      );
      return;
    }

    try {
      opts.onReady?.({ messageId, attachmentId, summary });
    } catch (err) {
      logger.warn(
        { err, messageId, attachmentId },
        "[summarizer] onReady callback threw",
      );
    }
  });
}
