import OpenAI from "openai";

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const MODEL = "text-embedding-3-small"; // 1536 dims, $0.02/1M tokens

/**
 * Generate embedding for a text string.
 * Returns null if OpenAI is not configured.
 */
export async function embedText(text: string): Promise<number[] | null> {
  if (!openai) return null;
  try {
    const res = await openai.embeddings.create({
      model: MODEL,
      input: text.slice(0, 8000), // max safe input
    });
    return res.data[0]?.embedding ?? null;
  } catch (err) {
    console.error("[embeddings] error:", err);
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

export const embeddingsEnabled = !!openai;
