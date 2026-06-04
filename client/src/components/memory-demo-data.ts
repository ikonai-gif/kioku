/**
 * Synthetic memory demo data for the public landing hero.
 *
 * IMPORTANT: this is FICTIONAL data shaped to match the real memory schema
 * (shared/schema.ts) — causal edges, importance, confidence, reinforcements,
 * bi-temporal validFrom/validTo. It contains NO real user memories. The public
 * landing page must never expose real memory content; the live graph on real
 * data lives behind login on /memory.
 */

export type MemoryType = "identity" | "semantic" | "episodic" | "procedural";

export interface MemoryNode {
  id: string;
  label: string;
  type: MemoryType;
  importance: number; // 0..1  -> node radius
  confidence: number; // 0..1  -> node opacity
  reinforcements: number; // higher -> pulse
  validFrom: number; // epoch ms
  validTo: number | null; // null = still valid; past = faded (bi-temporal)
}

export interface MemoryLink {
  source: string; // effect
  target: string; // cause (causeId)
}

const Y = (m: number, d: number) => Date.UTC(2026, m, d);

export const MEMORY_NODES: MemoryNode[] = [
  { id: "name", label: "User's name is Alex", type: "identity", importance: 0.96, confidence: 1.0, reinforcements: 14, validFrom: Y(0, 4), validTo: null },
  { id: "city", label: "Lives in Lisbon", type: "semantic", importance: 0.7, confidence: 0.92, reinforcements: 6, validFrom: Y(0, 9), validTo: null },
  { id: "role", label: "Works as a product designer", type: "semantic", importance: 0.78, confidence: 0.88, reinforcements: 5, validFrom: Y(0, 12), validTo: null },
  { id: "lang", label: "Speaks Portuguese & English", type: "semantic", importance: 0.6, confidence: 0.95, reinforcements: 3, validFrom: Y(0, 12), validTo: null },
  { id: "coffee", label: "Prefers oat-milk flat white", type: "semantic", importance: 0.4, confidence: 0.82, reinforcements: 9, validFrom: Y(1, 2), validTo: null },
  { id: "dog", label: "Adopted a dog, Mochi", type: "episodic", importance: 0.55, confidence: 0.9, reinforcements: 2, validFrom: Y(1, 20), validTo: null },
  { id: "launch", label: "Q3 launch set for Sep 14", type: "episodic", importance: 0.82, confidence: 0.9, reinforcements: 4, validFrom: Y(2, 1), validTo: null },
  { id: "standup", label: "Standup moved to 09:30", type: "episodic", importance: 0.45, confidence: 0.7, reinforcements: 1, validFrom: Y(1, 5), validTo: Y(2, 28) },
  { id: "office", label: "Old office in Baixa", type: "episodic", importance: 0.35, confidence: 0.6, reinforcements: 1, validFrom: Y(0, 9), validTo: Y(1, 18) },
  { id: "walk", label: "Free mornings after dog walk", type: "procedural", importance: 0.32, confidence: 0.55, reinforcements: 1, validFrom: Y(1, 24), validTo: null },
  { id: "review", label: "Prefers design review on Tue", type: "procedural", importance: 0.5, confidence: 0.75, reinforcements: 3, validFrom: Y(1, 12), validTo: null },
  { id: "tz", label: "Schedule in WET timezone", type: "procedural", importance: 0.42, confidence: 0.8, reinforcements: 2, validFrom: Y(0, 9), validTo: null },
  { id: "tool", label: "Designs in Figma", type: "semantic", importance: 0.58, confidence: 0.85, reinforcements: 4, validFrom: Y(0, 14), validTo: null },
  { id: "crit", label: "Wants honest critique, no flattery", type: "identity", importance: 0.7, confidence: 0.9, reinforcements: 6, validFrom: Y(0, 20), validTo: null },
];

// effect -> cause (mirrors causeId on the effect row)
export const MEMORY_LINKS: MemoryLink[] = [
  { source: "tz", target: "city" },
  { source: "lang", target: "city" },
  { source: "review", target: "role" },
  { source: "tool", target: "role" },
  { source: "launch", target: "role" },
  { source: "walk", target: "dog" },
  { source: "walk", target: "standup" },
  { source: "standup", target: "launch" },
  { source: "office", target: "city" },
  { source: "crit", target: "name" },
  { source: "coffee", target: "name" },
  { source: "review", target: "launch" },
];
