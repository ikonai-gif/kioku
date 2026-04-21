/**
 * Emotion Scorer — Phase 4b
 * Scores each new memory with an 8-dimensional emotion vector via GPT-4o-mini.
 * Dimensions: [joy, acceptance, fear, surprise, sadness, disgust, anger, anticipation]
 * Each value 0.0 to 1.0.
 */

import { withOpenAIBreaker, CircuitOpenError } from './lib/openai-client';
import logger from './logger';

const EMOTION_SCORE_PROMPT = `Rate the emotional content of this text on 8 dimensions (0.0 to 1.0).
Return ONLY a JSON array of 8 floats in this exact order:
[joy, acceptance, fear, surprise, sadness, disgust, anger, anticipation]

Text: "{content}"

JSON array:`;

export async function scoreEmotion(content: string): Promise<number[] | null> {
  try {
    const response = await withOpenAIBreaker((openai) =>
      openai.chat.completions.create({
        model: 'gpt-4.1-mini',
        messages: [{ role: 'user', content: EMOTION_SCORE_PROMPT.replace('{content}', content.slice(0, 500)) }],
        temperature: 0.1,
        max_tokens: 50,
      }),
    );
    const text = response.choices[0]?.message?.content?.trim();
    if (!text) return null;
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed) || parsed.length !== 8) return null;
    return parsed.map((v: number) => Math.max(0, Math.min(1, v)));
  } catch (err) {
    if (err instanceof CircuitOpenError) {
      logger.debug({ component: 'emotion-scorer' }, '[emotion-scorer] circuit open — skipping');
    }
    return null;
  }
}
