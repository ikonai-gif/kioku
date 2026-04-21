import { withOpenAIBreaker, CircuitOpenError } from "./lib/openai-client";
import logger from "./logger";

const MODEL = "text-embedding-3-small"; // 1536 dims, $0.02/1M tokens

/**
 * Generate embedding for a text string.
 * Returns null if OpenAI is not configured or the circuit is open.
 */
export async function embedText(text: string): Promise<number[] | null> {
  if (!process.env.OPENAI_API_KEY) return null;
  try {
    const res = await withOpenAIBreaker((client) =>
      client.embeddings.create({
        model: MODEL,
        input: text.slice(0, 8000), // max safe input
      }),
    );
    return res.data[0]?.embedding ?? null;
  } catch (err) {
    if (err instanceof CircuitOpenError) {
      logger.debug({ component: "embeddings" }, "[embeddings] circuit open — skipping");
      return null;
    }
    logger.error({ component: "embeddings", err }, "[embeddings] error");
    return null;
  }
}

/**
 * Compute cosine similarity between two vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export const embeddingsEnabled = !!process.env.OPENAI_API_KEY;
