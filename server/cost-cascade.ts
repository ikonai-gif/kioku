/**
 * [LUCA-097 / SPEC-2 / BRO2] Cost cascade — complexity classifier.
 *
 * Conservative v1: classify a user message into 'simple' | 'medium' | 'complex'.
 * Only 'simple' (explicit smalltalk) is routed to a cheaper model; everything
 * else stays on the current default (sonnet-class). Pure + dependency-free so
 * it is unit-testable without the deliberation engine.
 *
 * Gated by CASCADE_ENABLED at the call site — when off, this is never invoked
 * and the hot path is byte-for-byte the pre-cascade behaviour.
 */

export type ComplexityTier = "simple" | "medium" | "complex";

export function cascadeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.CASCADE_ENABLED ?? "").trim().toLowerCase() === "true";
}

/** The cheap model used for the 'simple' tier. Overridable via env. */
export function cascadeSimpleModel(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.CASCADE_SIMPLE_MODEL ?? "").trim();
  return raw || "claude-haiku-4-5-20251001";
}

/**
 * Conservative smalltalk detector. Returns 'simple' ONLY for short messages
 * that are clearly greetings / acks / pleasantries with no task content.
 * Anything with a question mark, code, numbers-heavy content, multiple
 * sentences, or length over the threshold falls through to 'medium'.
 * 'complex' is reserved for explicit multi-part / conflict signals.
 */
export function classifyComplexity(msg: string): ComplexityTier {
  const text = (msg ?? "").trim();
  if (text.length === 0) return "medium";

  const lower = text.toLowerCase();
  const wordCount = text.split(/\s+/).length;

  // Hard complex signals: long, multi-question, explicit "compare/analyze/why".
  const questionMarks = (text.match(/\?/g) || []).length;
  const hasComplexVerb = /(compare|analy[sz]e|design|architect|debug|prove|evaluate|сравни|проанализир|анализир|спроектир|докажи|оцени)/i.test(text);
  const hasCode = /```|\bfunction\b|\bconst\b|\bclass\b|=>|SELECT |\bimport\b/.test(text);
  if (text.length > 600 || questionMarks >= 2 || hasComplexVerb || hasCode) {
    return "complex";
  }

  // Simple smalltalk: short, no question, matches a greeting/ack pattern.
  const smalltalkRe = /^(привет|здаров|здарова|хай|хелло|hello|hi|hey|йо|yo|ок|окей|ok|okay|спасибо|спс|thanks|thank you|пока|bye|good ?(morning|night|day)|доброе утро|добрый (день|вечер)|споки|ничего|как дела|how are you|sup|здаро|ауф|👍|🙏|❤️|😊)[\s.!,?]*$/i;
  const isShort = wordCount <= 5 && text.length <= 40;
  if (isShort && questionMarks === 0 && smalltalkRe.test(lower)) {
    return "simple";
  }

  return "medium";
}
