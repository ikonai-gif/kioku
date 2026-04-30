/**
 * PR-A.6 — Build multimodal chatHistory for Anthropic deliberation.
 *
 * Pipeline (caveat C2 in R349): when constructing Claude's `messages` array
 * for partner-chat, we want vision content (image bytes) for the most-recent
 * N attachments, and textual stand-ins (summary / transcription / extracted_text)
 * for older or non-image attachments. If a recent attachment's summary is still
 * being computed (queued in attachment-summarizer), we wait briefly so Claude
 * sees something useful instead of `[image]`.
 *
 * Shape of the output preserves Anthropic.Messages.MessageParam — drop-in
 * replacement for the string-based chatHistory in deliberation.ts:6047.
 *
 * Safety:
 *   - getAssetBytes never throws; on failure we emit "[image]" as a text block.
 *   - awaitSummaryIfPending caps total blocking at 5s across the whole history
 *     (one Promise.allSettled gate, not per-attachment), so latency on a slow
 *     OpenAI/Anthropic backend can never stack to 5s × N.
 *   - Models without vision support (only certain Claude SKUs have image
 *     blocks) get the text-fallback path automatically via `supportsVision`.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { AttachmentMeta, RoomMessage } from "@shared/schema";
import logger from "../logger";
import { getAssetBytes, refreshSignedUrlIfNeeded } from "./asset-bytes-cache";
import { storage } from "../storage";

const VISION_MODELS_PREFIXES = [
  "claude-3-5-sonnet",
  "claude-3-5-haiku",
  "claude-3-7-sonnet",
  "claude-sonnet-4",
  "claude-opus-4",
  "claude-haiku-4",
];

/**
 * Best-effort heuristic for whether a Claude model accepts image content blocks.
 * Anthropic doesn't ship a discovery API; we whitelist the families that do
 * (everything 3.5+ basically). New SKUs default to true to avoid silently
 * dropping vision when a future model lands.
 */
export function supportsVision(modelId: string | null | undefined): boolean {
  if (!modelId) return false;
  const m = modelId.toLowerCase();
  if (VISION_MODELS_PREFIXES.some((p) => m.startsWith(p))) return true;
  // Claude 3 (claude-3-opus, claude-3-sonnet, claude-3-haiku) — vision yes.
  if (m.startsWith("claude-3")) return true;
  // Older claude-2 / claude-instant — text only.
  if (m.startsWith("claude-2") || m.startsWith("claude-instant")) return false;
  // Default-allow for unknown future Claude SKUs; Anthropic returns 400 if
  // wrong, which we surface verbatim — better than silently going text.
  if (m.startsWith("claude-")) return true;
  return false;
}

const SUMMARY_WAIT_BUDGET_MS = 5_000;
const SUMMARY_POLL_INTERVAL_MS = 250;

/**
 * If any attachment in `messages` has storage_key but missing summary, wait
 * briefly for the summarizer to fill it in. Returns the (possibly updated)
 * messages — we re-fetch the JSONB so caller sees the patched state.
 *
 * Total budget across all pending summaries is SUMMARY_WAIT_BUDGET_MS — we
 * never block deliberation longer than that even if 10 attachments land at
 * once. Returns original messages if nothing pending.
 */
export async function awaitSummaryIfPending(
  messages: RoomMessage[],
): Promise<RoomMessage[]> {
  // Only attachments newer than ~30s old are worth waiting on; older ones
  // are either already summarized or genuinely failed and re-fetching won't
  // help.
  const RECENT_WINDOW_MS = 30_000;
  const now = Date.now();
  const pendingMessageIds = new Set<number>();
  for (const m of messages) {
    const arr = (m.attachments ?? []) as AttachmentMeta[];
    for (const a of arr) {
      if (!a.storage_key) continue;
      if (a.summary || a.transcription || a.extracted_text) continue;
      if (now - (a.uploaded_at ?? 0) > RECENT_WINDOW_MS) continue;
      pendingMessageIds.add(m.id);
      break;
    }
  }
  if (pendingMessageIds.size === 0) return messages;

  const deadline = now + SUMMARY_WAIT_BUDGET_MS;
  const pendingIds = Array.from(pendingMessageIds);
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, SUMMARY_POLL_INTERVAL_MS));
    let refreshedById = new Map<number, RoomMessage>();
    try {
      const fresh = await storage.getRoomMessagesByIds(pendingIds);
      for (const r of fresh) refreshedById.set(r.id, r);
    } catch (err) {
      logger.warn({ err }, "[multimodal] poll fetch failed");
    }
    const refreshed = messages.map((m) => refreshedById.get(m.id) ?? m);
    let stillPending = false;
    for (const r of refreshed) {
      if (!pendingMessageIds.has(r.id)) continue;
      const arr = (r.attachments ?? []) as AttachmentMeta[];
      // Pending means ANY attachment still has storage_key without summary/transcription/extracted_text.
      const anyStillPending = arr.some(
        (a) =>
          a.storage_key &&
          !a.summary &&
          !a.transcription &&
          !a.extracted_text,
      );
      if (anyStillPending) {
        stillPending = true;
        break;
      }
    }
    messages = refreshed;
    if (!stillPending) break;
  }
  return messages;
}

const RECENT_VISION_LIMIT = 5;

interface BuildOptions {
  modelId: string;
  /** Agent.id so we can flip role to "assistant" for that agent's own turns. */
  agentId: number;
  /** Whether we're in partner-chat — controls the `[name]: ` prefix. */
  isPartnerChat: boolean;
}

/**
 * Build Anthropic-shaped messages from a RoomMessage[] array. Most-recent N
 * image attachments become inline image blocks; older ones (and all non-image
 * attachments) collapse to a textual summary line:
 *
 *   "[image: <summary>]"
 *   "[voice <duration>s: <transcription excerpt>]"
 *   "[file <name>: <extracted_text excerpt>]"
 *
 * The function never throws — on any per-attachment failure (cache miss,
 * Supabase 500) it emits the text fallback for that one slot.
 */
export async function buildMultimodalClaudeMessages(
  messages: RoomMessage[],
  opts: BuildOptions,
): Promise<Anthropic.Messages.MessageParam[]> {
  const useVision = supportsVision(opts.modelId);
  const visionEligible = collectVisionEligible(messages);
  const visionAllowed = new Set(visionEligible.slice(-RECENT_VISION_LIMIT));

  const out: Anthropic.Messages.MessageParam[] = [];

  for (const m of messages) {
    const role: "user" | "assistant" = m.agentId === opts.agentId ? "assistant" : "user";
    const baseText = opts.isPartnerChat ? m.content : `[${m.agentName}]: ${m.content}`;
    const arr = (m.attachments ?? []) as AttachmentMeta[];

    if (arr.length === 0) {
      out.push({ role, content: baseText });
      continue;
    }

    // Build content blocks: text first, then attachment blocks.
    const blocks: Anthropic.Messages.ContentBlockParam[] = [];
    if (baseText.trim().length > 0) {
      blocks.push({ type: "text", text: baseText });
    }

    for (const a of arr) {
      const visionPick = useVision && visionAllowed.has(a.id) && a.type === "image";
      if (visionPick) {
        const resolved = await loadImageBlock(m.id, a);
        if (resolved) {
          blocks.push(resolved);
          continue;
        }
        // Fall through to text fallback if vision load failed.
      }
      blocks.push({ type: "text", text: textFallbackFor(a) });
    }

    if (blocks.length === 0) {
      // Defensive: never emit an empty content block (Anthropic 400s).
      blocks.push({ type: "text", text: "[empty]" });
    }
    out.push({ role, content: blocks });
  }
  return out;
}

/**
 * Compute the ordered list of image attachment ids in `messages`. The last
 * RECENT_VISION_LIMIT entries (in chronological order, since `messages` is
 * already sorted oldest-first) become vision-eligible.
 */
function collectVisionEligible(messages: RoomMessage[]): string[] {
  const ids: string[] = [];
  for (const m of messages) {
    for (const a of (m.attachments ?? []) as AttachmentMeta[]) {
      if (a.type === "image" && a.storage_key) ids.push(a.id);
    }
  }
  return ids;
}

async function loadImageBlock(
  messageId: number,
  a: AttachmentMeta,
): Promise<Anthropic.Messages.ImageBlockParam | null> {
  // Refresh signed URL inline (caveat C1) — cheap if already fresh.
  try {
    await refreshSignedUrlIfNeeded(messageId, a.id, a);
  } catch (err) {
    logger.warn({ err, messageId, attachmentId: a.id }, "[multimodal] refresh URL failed");
  }
  const bytes = await getAssetBytes(a.storage_key);
  if (!bytes) return null;
  const mt = bytes.mime as
    | "image/png"
    | "image/jpeg"
    | "image/gif"
    | "image/webp";
  // Anthropic only allows png/jpeg/gif/webp. Reject anything else cleanly.
  if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mt)) {
    return null;
  }
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: mt,
      data: bytes.data.toString("base64"),
    },
  };
}

/**
 * Plain-string history for non-vision providers (Gemini / OpenAI). Each message
 * keeps the same shape used historically by deliberation.ts:6047 — `{ role,
 * content }` — but content is augmented with text-fallback lines for any
 * attachments so the LLM sees "[image: <summary>]" / "[voice 12s: ...]" /
 * "[file foo.pdf: ...]" inline. Older or non-image attachments collapse the
 * same way as the Claude vision path's text fallback.
 */
export function buildTextHistoryWithAttachments(
  messages: RoomMessage[],
  opts: { agentId: number; isPartnerChat: boolean },
): Array<{ role: "user" | "assistant"; content: string }> {
  return messages.map((m) => {
    const role: "user" | "assistant" = m.agentId === opts.agentId ? "assistant" : "user";
    const baseText = opts.isPartnerChat ? m.content : `[${m.agentName}]: ${m.content}`;
    const arr = (m.attachments ?? []) as AttachmentMeta[];
    if (arr.length === 0) return { role, content: baseText };
    const lines = [baseText.trim(), ...arr.map((a) => textFallbackFor(a))].filter(
      (s) => s.length > 0,
    );
    return { role, content: lines.join("\n") };
  });
}

function textFallbackFor(a: AttachmentMeta): string {
  const summary = (a.summary ?? "").trim();
  if (a.type === "image") {
    return summary ? `[image: ${summary}]` : `[image]`;
  }
  if (a.type === "voice") {
    const dur = typeof a.duration_sec === "number" ? `${a.duration_sec}s` : "?";
    const tr = (a.transcription ?? summary ?? "").trim().slice(0, 800);
    return tr ? `[voice ${dur}: ${tr}]` : `[voice ${dur}]`;
  }
  if (a.type === "file") {
    const head = (a.extracted_text ?? summary ?? "").trim().slice(0, 1200);
    return head ? `[file ${a.original_name}: ${head}]` : `[file ${a.original_name}]`;
  }
  return `[${a.type}]`;
}
