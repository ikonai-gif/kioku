/**
 * Token Budget Manager — KIOKU™
 * Manages token budgets per LLM call so prompts stay within model context limits.
 *
 * Token estimation: 1 token ≈ 4 characters (English approximation).
 */

// ── Model Context Windows (tokens) ──────────────────────────────────

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // OpenAI
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "gpt-3.5-turbo": 16_000,
  "gpt-4.1": 128_000,
  "gpt-4.1-mini": 128_000,
  "gpt-5.4": 128_000,
  "gpt-5.4-mini": 128_000,
  "gpt-5.4-nano": 128_000,
  // Gemini
  "gemini-1.5-flash": 1_000_000,
  "gemini-1.5-pro": 2_000_000,
  "gemini-2.0-flash": 1_000_000,
  "gemini-2.5-flash": 1_000_000,
  "gemini-2.5-pro": 2_000_000,
  "gemini-3.1-pro": 2_000_000,
};

const DEFAULT_CONTEXT_WINDOW = 8_000;

// ── Budget Allocation Constants ─────────────────────────────────────

const RESPONSE_RESERVE = 2_000;
const MAX_SYSTEM_PROMPT_TOKENS = 500;
const MAX_MEMORY_TOKENS = 2_000;

// ── Token Counting ──────────────────────────────────────────────────

/** Approximate token count: 1 token ≈ 4 characters for English text. */
export function countTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/** Get the context window size for a model. */
export function getContextWindow(model: string): number {
  return MODEL_CONTEXT_WINDOWS[model] ?? DEFAULT_CONTEXT_WINDOW;
}

// ── Truncation ──────────────────────────────────────────────────────

/** Truncate text to fit within a token budget, preserving whole words. */
export function truncateToFit(content: string, maxTokens: number): string {
  if (!content) return "";
  if (countTokens(content) <= maxTokens) return content;

  const maxChars = maxTokens * 4;
  // Truncate at the last space before the limit to avoid splitting words
  const truncated = content.slice(0, maxChars);
  const lastSpace = truncated.lastIndexOf(" ");
  const cutPoint = lastSpace > maxChars * 0.8 ? lastSpace : maxChars;
  return truncated.slice(0, cutPoint) + " [truncated]";
}

// ── Budget Sections ─────────────────────────────────────────────────

export interface BudgetSections {
  systemPrompt: string;
  memoryContext: string;
  topic: string;
  otherPositions: string;
}

export interface AllocatedBudget {
  systemPrompt: string;
  memoryContext: string;
  topic: string;
  otherPositions: string;
  totalTokens: number;
  wasOverBudget: boolean;
}

/**
 * Allocate token budget for a single LLM call.
 *
 * Priority:
 *   1. Topic — never truncated (essential context)
 *   2. System prompt — up to MAX_SYSTEM_PROMPT_TOKENS
 *   3. Memory context — up to MAX_MEMORY_TOKENS, truncated least-relevant-first
 *   4. Other positions — gets remaining budget after above sections
 *
 * If total exceeds the model context window minus response reserve,
 * older positions are summarized/truncated and memories are reduced.
 */
export function allocateBudget(model: string, sections: BudgetSections): AllocatedBudget {
  const contextWindow = getContextWindow(model);
  const availableBudget = contextWindow - RESPONSE_RESERVE;

  // Topic is always kept (it's short)
  const topicTokens = countTokens(sections.topic);

  // System prompt: cap at MAX_SYSTEM_PROMPT_TOKENS
  let systemPrompt = sections.systemPrompt;
  const systemTokens = countTokens(systemPrompt);
  if (systemTokens > MAX_SYSTEM_PROMPT_TOKENS) {
    systemPrompt = truncateToFit(systemPrompt, MAX_SYSTEM_PROMPT_TOKENS);
  }
  const finalSystemTokens = countTokens(systemPrompt);

  // Memory context: cap at MAX_MEMORY_TOKENS
  let memoryContext = sections.memoryContext;
  const memoryTokens = countTokens(memoryContext);
  if (memoryTokens > MAX_MEMORY_TOKENS) {
    memoryContext = truncateMemories(memoryContext, MAX_MEMORY_TOKENS);
  }
  let finalMemoryTokens = countTokens(memoryContext);

  // Remaining budget for other positions
  const usedSoFar = topicTokens + finalSystemTokens + finalMemoryTokens;
  let remainingBudget = availableBudget - usedSoFar;

  let otherPositions = sections.otherPositions;
  let wasOverBudget = false;

  if (remainingBudget <= 0) {
    // Extreme case: even base sections exceed budget. Aggressively truncate memories.
    wasOverBudget = true;
    const memBudget = Math.max(200, availableBudget - topicTokens - finalSystemTokens - 500);
    memoryContext = truncateMemories(memoryContext, memBudget);
    finalMemoryTokens = countTokens(memoryContext);
    remainingBudget = availableBudget - topicTokens - finalSystemTokens - finalMemoryTokens;
  }

  const positionTokens = countTokens(otherPositions);
  if (positionTokens > remainingBudget) {
    wasOverBudget = true;
    otherPositions = truncateOlderPositions(otherPositions, remainingBudget);
  }

  const totalTokens =
    countTokens(systemPrompt) +
    countTokens(memoryContext) +
    topicTokens +
    countTokens(otherPositions);

  return {
    systemPrompt,
    memoryContext,
    topic: sections.topic,
    otherPositions,
    totalTokens,
    wasOverBudget,
  };
}

// ── Internal Helpers ────────────────────────────────────────────────

/**
 * Truncate memory context by removing entries from the end (least relevant).
 * Memories are formatted as lines starting with "- ".
 */
function truncateMemories(memoryContext: string, maxTokens: number): string {
  if (countTokens(memoryContext) <= maxTokens) return memoryContext;

  const lines = memoryContext.split("\n");
  const result: string[] = [];
  let tokens = 0;

  for (const line of lines) {
    const lineTokens = countTokens(line) + 1; // +1 for newline
    if (tokens + lineTokens > maxTokens) break;
    result.push(line);
    tokens += lineTokens;
  }

  if (result.length < lines.length) {
    result.push("[...additional memories truncated to fit budget]");
  }

  return result.join("\n");
}

/**
 * Truncate older positions when they exceed budget.
 * Positions are formatted as lines starting with "- AgentName:".
 * Keeps the most recent positions (end of list) and summarizes older ones.
 */
function truncateOlderPositions(positions: string, maxTokens: number): string {
  if (countTokens(positions) <= maxTokens) return positions;

  const lines = positions.split("\n").filter((l) => l.trim());
  if (lines.length === 0) return "";

  // Keep positions from the end (most recent) until budget is reached
  const kept: string[] = [];
  let tokens = 0;
  const summaryLine = "[earlier positions omitted to fit context window]";
  const summaryTokens = countTokens(summaryLine) + 1;

  for (let i = lines.length - 1; i >= 0; i--) {
    const lineTokens = countTokens(lines[i]) + 1;
    if (tokens + lineTokens + summaryTokens > maxTokens && kept.length > 0) {
      break;
    }
    kept.unshift(lines[i]);
    tokens += lineTokens;
  }

  if (kept.length < lines.length) {
    return summaryLine + "\n" + kept.join("\n");
  }
  return kept.join("\n");
}
