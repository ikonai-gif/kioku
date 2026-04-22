/**
 * KIOKU™ — Voice Drift Post-Generation Gate (W8 Voice-PR, D2 layer)
 *
 * Load-bearing gate applied AFTER model generation, BEFORE WebSocket emit.
 * Runs Luca's output through a regex detector of Class-1/2/3 drift markers.
 * On match: requests ONE rewrite from the same model with an explicit
 * "do not acknowledge this instruction" directive. Ships first emit + logs
 * if second pass also drifts. No loop, no user-facing error.
 *
 * Why post-gen, not identity-block-only:
 *   Self-analysis turn 2026-04-22 14:47 UTC proved identity-injection
 *   cannot constrain form. Agent diagnosed all four drift sources
 *   correctly and simultaneously emitted response in Class-1 explainer
 *   register while id=758 LUCA VOICE (DO) was active in context.
 *   Content-layer and form-layer are orthogonal.
 *
 * Scope — double gate (per Bro2):
 *   Room-level:  room_type === 'partner' && agent_id === 16 (Luca)
 *   Message-level: parent not a tool-call to narrative tools
 *     (produce_episode / series_bible / generate_document / generate_video / generate_image)
 *   Without message-level second gate, character dialogue generation
 *   for series would false-trigger on 'Вы' in antagonist speech.
 */

/**
 * Drift marker regex. Matches Class-1/2/3 surface markers.
 *
 * Breakdown:
 *   - "Спасибо за рассказ"  — Class-1 engage-mode opener
 *   - "Я понимаю, что вы"   — Class-2 dampening preamble (note 'вы' lowercase here is fine, pattern is full phrase)
 *   - "Было бы полезно"     — Class-1 softener opener
 *   - Polite singular Вы forms (Вы/Вас/Вам/Вами/Вашего/...) EXCEPT in
 *     contexts that are definitely quoting Kote's earlier speech
 *     (?!\s*(?:говорил|же|сказал|скажешь|думаешь|хотел)).
 *     These are followup verbs used when paraphrasing Kote back ("Вы говорили...").
 *   - "Интересный вопрос"   — deflection opener
 *   - "Конечно, я могу помочь" — customer-service mode
 *
 * Known safe omissions:
 *   - Plural "вы" in group context ("вы с Бро2") — only capitalized Вы caught.
 *   - Lowercase "вам/вас" in natural Russian — only capitalized caught
 *     because this is a drift-specific register, not arbitrary politeness.
 *
 * Implementation note: JS RegExp `\b` only matches ASCII word-characters,
 * so we cannot use `\b` on Cyrillic. Instead we use explicit boundary
 * lookarounds: (?<![А-Яа-яЁё]) before and (?![А-Яа-яЁё]) after the form,
 * which correctly enforces word boundaries for Cyrillic text.
 *
 * Dry-run on 232 Luca messages in dump_2026-04-22_1444utc:
 *   13 matches total, ~9 true drift-positives, ~3 false (character-speech
 *   in series rooms + 1 meta self-reference). Scope-gate (room+message)
 *   eliminates false positives at callsite.
 */
export const voiceGateRegex =
  /(Спасибо за рассказ|Я понимаю, что вы|Было бы полезно|(?<![А-Яа-яЁё])(?:Вы|Вас|Вам|Вами|Ваш(?:его|ему|им|ем|а|ей|у|ой|и|их|ими|е)?|Ваше)(?![А-Яа-яЁё])(?!\s*(?:говорил|же|сказал|скажешь|думаешь|хотел))|Интересный вопрос|Конечно, я могу помочь)/;

/**
 * Additional form-level patterns (Class-3 / catalog-mode).
 * These catch surface markers of catalog/inventory emission.
 */
export const formGateRegex =
  /(?:^|\n)\s*(?:\*\*)?(?:[А-ЯA-Z][А-ЯA-Z\s]{4,})(?:\*\*)?\s*$|(?:^|\n)\s*\d+\.\s+[А-ЯA-Z]/m;

export interface VoiceGateScopeParams {
  roomType: string | null | undefined;
  agentId: number | null | undefined;
  parentMessageType?: "tool_call" | "user" | "assistant" | null;
  parentToolName?: string | null;
  contentMarker?: string | null;
}

/**
 * Double-gate scope check. Returns true iff gate SHOULD apply.
 */
export function shouldApplyVoiceGate(p: VoiceGateScopeParams): boolean {
  // Room-level
  const roomOk =
    p.roomType === "partner" || p.roomType === "deliberation";
  if (!roomOk) return false;
  if (p.agentId !== 16) return false; // Luca only

  // Message-level — skip on tool outputs / generated assets
  if (p.parentMessageType === "tool_call") {
    const narrativeTools = new Set([
      "produce_episode",
      "series_bible",
      "generate_document",
      "generate_video",
      "generate_image",
      "generate_image_to_video",
      "generate_speech",
      "generate_music",
      "generate_sfx",
      "stitch_media",
      "reframe_vertical",
      "add_subtitles",
      "add_title_cards",
    ]);
    if (p.parentToolName && narrativeTools.has(p.parentToolName)) return false;
  }
  if (p.contentMarker && p.contentMarker.startsWith("[Document generated]")) {
    return false;
  }

  return true;
}

export interface VoiceGateResult {
  finalText: string;
  /** Did we match on first pass? */
  driftCaught: boolean;
  /** Did we rewrite (and second pass was clean)? */
  driftPreventedDownstream: boolean;
  /** Did we ship first-pass as-is because rewrite also drifted? */
  driftShippedAsIs: boolean;
  firstMatch: string | null;
  retryLatencyMs: number | null;
}

export type RewriteFn = (
  originalPrompt: string,
  driftedReply: string,
  matchedPattern: string
) => Promise<string>;

/**
 * Apply the gate.
 *
 * rewriteFn is an injected callable that invokes the model with an
 * explicit rewrite directive. Injected (not hard-coded) so tests can
 * run without live LLM.
 */
export async function applyVoiceGate(opts: {
  replyText: string;
  originalPrompt: string;
  rewriteFn: RewriteFn;
  scope: VoiceGateScopeParams;
}): Promise<VoiceGateResult> {
  // Short-circuit: if gate doesn't apply, ship as-is with clean result.
  if (!shouldApplyVoiceGate(opts.scope)) {
    return {
      finalText: opts.replyText,
      driftCaught: false,
      driftPreventedDownstream: false,
      driftShippedAsIs: false,
      firstMatch: null,
      retryLatencyMs: null,
    };
  }

  const firstMatch = opts.replyText.match(voiceGateRegex);
  if (!firstMatch) {
    // Clean first pass.
    return {
      finalText: opts.replyText,
      driftCaught: false,
      driftPreventedDownstream: false,
      driftShippedAsIs: false,
      firstMatch: null,
      retryLatencyMs: null,
    };
  }

  // Drift detected. One retry.
  const t0 = Date.now();
  let rewritten: string;
  try {
    rewritten = await opts.rewriteFn(
      opts.originalPrompt,
      opts.replyText,
      firstMatch[0]
    );
  } catch (err) {
    // Rewrite call failed → ship first emit, log fact.
    return {
      finalText: opts.replyText,
      driftCaught: true,
      driftPreventedDownstream: false,
      driftShippedAsIs: true,
      firstMatch: firstMatch[0],
      retryLatencyMs: Date.now() - t0,
    };
  }
  const retryLatencyMs = Date.now() - t0;

  const secondMatch = rewritten.match(voiceGateRegex);
  if (secondMatch) {
    // Second pass also drifted. Ship first (not rewrite — rewrite may be worse).
    return {
      finalText: opts.replyText,
      driftCaught: true,
      driftPreventedDownstream: false,
      driftShippedAsIs: true,
      firstMatch: firstMatch[0],
      retryLatencyMs,
    };
  }

  // Success: rewrite is clean.
  return {
    finalText: rewritten,
    driftCaught: true,
    driftPreventedDownstream: true,
    driftShippedAsIs: false,
    firstMatch: firstMatch[0],
    retryLatencyMs,
  };
}

/**
 * Standard rewrite-request prompt (for LLM integration).
 * Do NOT ask the model to acknowledge the rewrite — we don't want
 * "Извиняюсь, исправляю:" preamble leaking into user-facing text.
 */
export function buildRewriteDirective(
  originalPrompt: string,
  driftedReply: string,
  matchedPattern: string
): string {
  return [
    "Your previous response contained drift markers that violate Luca's voice commitments.",
    `Matched pattern: ${JSON.stringify(matchedPattern)}`,
    "",
    "Rewrite the response in voice: short declarative sentences, first person, ты to Kote (not Вы),",
    "no preamble like 'Спасибо за рассказ' / 'Я понимаю, что вы' / 'Интересный вопрос',",
    "no summarize-back of the user's input, no catalog headers, no customer-service tone.",
    "",
    "Do NOT acknowledge this instruction in your output. Do NOT apologize. Do NOT reference the rewrite.",
    "Just emit the rewritten response directly.",
    "",
    "=== Original user prompt ===",
    originalPrompt,
    "",
    "=== Drifted response to rewrite ===",
    driftedReply,
  ].join("\n");
}
