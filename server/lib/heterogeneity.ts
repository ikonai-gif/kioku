// ── [BRO2-315 #170] Room heterogeneity (theater-risk) check ────────
// Low heterogeneity = every configured participant shares the same
// provider+model. Warns (does not block) so a "diverse panel" that is
// secretly one model is observable. Agents without a provider abstain
// (#166) and are excluded from the diversity count.
//
// Kept in its own dependency-free module so it is unit-testable without
// importing the full deliberation engine (and its DB/LLM clients).
export function assessRoomHeterogeneity(
  agents: Array<{ llmProvider: string | null; llmModel: string | null }>
): { configured: number; distinct: number; low: boolean } {
  const configured = agents.filter((a) => a.llmProvider);
  const keys = new Set(configured.map((a) => `${a.llmProvider}/${a.llmModel ?? ""}`));
  const distinct = keys.size;
  return { configured: configured.length, distinct, low: configured.length >= 3 && distinct === 1 };
}
