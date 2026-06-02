/**
 * [#171 / BRO2-319] Patent-room routing policy — pure decision helpers.
 *
 * Dependency-free so the gate is unit-testable without importing the heavy
 * deliberation engine (same pattern as lib/heterogeneity.ts). Enforces the
 * locked policy: in a patent room ONLY a local provider may answer; every cloud
 * provider ABSTAINS (no ZDR contract configured), and there is never a silent
 * cloud fallback. Inert for normal rooms (patentRoom=false → always allow).
 */

export function isLocalProvider(provider?: string | null): boolean {
  return provider === "local" || provider === "ollama";
}

/**
 * True when a call MUST be blocked (→ ABSTAIN) because it is in a patent room
 * and not routed to a local provider. Returns false for normal rooms, so the
 * gate is a no-op until a room is explicitly flagged patent_room=true.
 *
 * If a signed ZDR + no-training contract ever exists, direct Anthropic/OpenAI
 * could be permitted here — there is none today, so all cloud providers block.
 */
export function patentRoomBlocks(
  patentRoom: boolean,
  provider?: string | null,
): boolean {
  if (!patentRoom) return false;
  return !isLocalProvider(provider);
}
