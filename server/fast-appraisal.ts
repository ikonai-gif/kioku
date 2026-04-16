/**
 * Fast Appraisal — Phase 4b
 * After each conversation/deliberation, evaluates how the event
 * affects the agent's PAD (Pleasure-Arousal-Dominance) emotional state.
 * Uses GPT-4o-mini for cheap, fast emotional assessment.
 */

import OpenAI from 'openai';
import { getDecayedEmotionalState, clampPAD, padToEmotionLabel, defaultEmotionalState, slowReflection } from './emotional-state';

const APPRAISAL_PROMPT = `You are an emotion analyzer for an AI agent.
Agent's current emotional state: Pleasure={P}, Arousal={A}, Dominance={D} (each -1.0 to 1.0)
Current emotion: {emotion}

Recent event: "{event}"

How does this event shift the agent's emotional state?
Return ONLY JSON: {"delta_P": float, "delta_A": float, "delta_D": float, "poignancy": int}
- Deltas in range [-0.3, 0.3]. Be conservative — small changes.
- Poignancy: 1-10 (how important/memorable this event was).`;

export async function fastAppraisal(
  agentId: number, userId: number, eventDescription: string, storage: any
): Promise<void> {
  try {
    const state = await storage.getAgentEmotionalState(agentId);
    if (!state) {
      // Initialize default state on first interaction
      const defaults = defaultEmotionalState();
      await storage.upsertAgentEmotionalState(agentId, userId, defaults);
      return;
    }

    const decayed = getDecayedEmotionalState(state);

    const openai = new OpenAI();
    const prompt = APPRAISAL_PROMPT
      .replace('{P}', decayed.pleasure.toFixed(2))
      .replace('{A}', decayed.arousal.toFixed(2))
      .replace('{D}', decayed.dominance.toFixed(2))
      .replace('{emotion}', decayed.emotionLabel)
      .replace('{event}', eventDescription.slice(0, 300));

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 80,
    });

    const text = response.choices[0]?.message?.content?.trim();
    if (!text) return;

    const result = JSON.parse(text);
    const newP = clampPAD(decayed.pleasure + (result.delta_P || 0));
    const newA = clampPAD(decayed.arousal + (result.delta_A || 0));
    const newD = clampPAD(decayed.dominance + (result.delta_D || 0));
    const newLabel = padToEmotionLabel(newP, newA, newD);
    const newPoignancy = (state.poignancySum || 0) + (result.poignancy || 0);

    await storage.upsertAgentEmotionalState(agentId, userId, {
      pleasure: newP,
      arousal: newA,
      dominance: newD,
      emotionLabel: newLabel,
      poignancySum: newPoignancy,
      lastUpdatedAt: Date.now(),
    });

    // Trigger slow reflection if poignancy threshold exceeded (Phase 4d)
    if (newPoignancy > 150) {
      slowReflection(agentId, userId, storage).catch(() => {});
    }
  } catch {
    // Silent fail — emotional appraisal is non-critical
  }
}
