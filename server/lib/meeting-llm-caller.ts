/**
 * Meeting Room LLM caller (W9 Item 3-4).
 *
 * Thin adapter that turns a resolved Anthropic client + TurnInput into the
 * `LlmCaller` signature that `runTurn` expects. Lives here so the route
 * handler stays free of Anthropic-specific wiring and so unit tests can
 * inject a deterministic stub without pulling Anthropic SDK types.
 *
 * Responsibilities:
 *  - Resolve the per-agent or shared Anthropic client (same rule as deliberation).
 *  - Wrap the call in `withAnthropicBreaker` and `LLM_TIMEOUT_MS`.
 *  - Extract the final text from the Anthropic response envelope.
 *  - Default `visibility` to `"all"` (most turns) — LLM can opt into scoped
 *    posts later via a future tool call; for W9 we don't expose that knob.
 *
 * Tool execution is NOT handled here — `meeting-tools.ts` exports
 * `getMeetingTurnTools` for the tool list, but the runner does not execute
 * tools itself. If the Anthropic response requests a tool, we return its
 * accompanying `text` block if any, otherwise a stub "(no response)" string
 * — the runner will still commit that as the turn's content, and Item 5
 * will flesh out artifact tools.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { LlmCaller } from "./meeting-turn-runner";
import { LLM_TIMEOUT_MS } from "./meeting-turn-runner";
import { withAnthropicBreaker } from "./anthropic-client";
import { pool } from "../storage";
import logger from "../logger";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || null;

/** Default Anthropic model for meeting turns — matches deliberation path. */
const DEFAULT_MODEL = process.env.MEETING_LLM_MODEL || "claude-3-5-sonnet-20241022";
const DEFAULT_MAX_TOKENS = Number(process.env.MEETING_LLM_MAX_TOKENS ?? 2048);

interface AgentLlmCreds {
  llmApiKey: string | null;
  llmProvider: string | null;
}

async function loadAgentCreds(agentId: number): Promise<AgentLlmCreds | null> {
  const { rows } = await pool.query(
    `SELECT "llmApiKey" AS "llmApiKey", "llmProvider" AS "llmProvider"
       FROM agents WHERE id = $1`,
    [agentId],
  );
  return rows.length > 0 ? rows[0] : null;
}

function resolveClient(creds: AgentLlmCreds | null): Anthropic | null {
  if (creds?.llmApiKey && creds.llmProvider === "anthropic") {
    return new Anthropic({ apiKey: creds.llmApiKey });
  }
  if (ANTHROPIC_API_KEY) return new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  return null;
}

/**
 * Build an `LlmCaller` bound to a specific agent. Route handler resolves the
 * agent id from the participant and calls this factory once per turn.
 */
export async function makeMeetingLlmCaller(agentId: number): Promise<LlmCaller> {
  const creds = await loadAgentCreds(agentId);
  const client = resolveClient(creds);
  if (!client) {
    throw new Error("no_llm_provider");
  }

  const llm: LlmCaller = async (input, tools) => {
    // Extract first system block text; runner builds a single system string.
    const systemText = (input.systemPrompt || "").slice(0, 100_000);
    // Build a simple user/assistant transcript from visibleContext. Rows
    // authored by THIS agent are replayed as assistant turns; everything
    // else collapses to user turns prefixed with the author so the LLM has
    // attribution. This is the Week-9 floor — richer role shaping arrives
    // with artifact tools in Item 5.
    const messages = input.visibleContext.map((e) => {
      const isSelf = e.authorAgentId === agentId;
      const text = isSelf
        ? e.content
        : `[agent ${e.authorAgentId ?? "system"} / seq ${e.sequenceNumber}] ${e.content}`;
      return { role: (isSelf ? "assistant" : "user") as "user" | "assistant", content: text };
    });
    if (messages.length === 0 || messages[messages.length - 1].role !== "user") {
      // Anthropic requires the first + last non-system message be `user`.
      messages.push({ role: "user", content: "[your turn]" });
    }

    // Hard timeout independent of SDK internal timeouts — ensures the runner's
    // T2 commit budget is not eaten by a hung LLM call.
    const timeoutPromise = new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error("llm_timeout")), LLM_TIMEOUT_MS);
      (t as any).unref?.();
    });

    const callPromise = withAnthropicBreaker(client, (c) =>
      c.messages.create({
        model: DEFAULT_MODEL,
        max_tokens: DEFAULT_MAX_TOKENS,
        system: systemText,
        messages,
        tools: tools.length > 0 ? tools : undefined,
      }),
    );

    const resp = await Promise.race([callPromise, timeoutPromise]);
    // Anthropic response has `content: Array<{type:'text', text}|{type:'tool_use', ...}>`.
    const blocks = (resp as Anthropic.Messages.Message).content ?? [];
    const textBlocks = blocks.filter((b): b is Anthropic.Messages.TextBlock => b.type === "text");
    const text = textBlocks.map((b) => b.text).join("\n").trim();
    if (!text) {
      logger.warn(
        { agentId, stopReason: (resp as any).stop_reason },
        "[meeting-llm] empty text response",
      );
      return { content: "(no response)", visibility: "all" };
    }
    return { content: text, visibility: "all" };
  };

  return llm;
}
