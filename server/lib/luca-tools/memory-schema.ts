// R455 / luca_memory_schema — read-only introspection of Luca's own memory
// architecture. Implements BRO3 spec v0.4 (luca_memory_schema_spec_draft.md).
//
// Honesty-sensitive: this module is the source of truth for types/namespaces
// metadata that the system prompt references. Fields and SQL pattern are
// frozen by spec — only handler shape is open to BRO2 impl decisions
// (R454-BRO3 disposition).
//
// Scope:
//   - read-only, no writes
//   - per (user_id, agent_id) — closure args, NEVER from tool input
//   - table is `memories` (NOT `kioku_memories` as some draft SQL suggested;
//     verified storage.ts:154 + 10+ usages in deliberation.ts; spec drift
//     caught by BRO1, ack'd by BRO3 in R455 handoff)
//   - legacy types (fact, causal, …) are filtered out at SQL level (NIT-4
//     defensive default) — only the 11 known types are aggregated. legacy
//     surfacing left to v2.

import type { Pool } from "pg";

// ── Type metadata (Q7-C1 enum-exact, R451-N1 category, R451-N2 always_inject)
// Order: identity (1.5), commitment (1.4), then by weight DESC, then by name.
// Used both at runtime AND as a literal list embedded in the system prompt
// (Honesty rule fallback "recite namespace list verbatim").
export interface TypeMetadata {
  type: string;
  label: string;
  category: "core" | "episodic" | "semantic" | "meta";
  weight: number;
  decay_default_per_day: number;
  always_inject: boolean;
  writable_by_luca: boolean;
  writable_by_system: boolean;
  retrieval_note: string;
}

export const TYPE_METADATA: readonly TypeMetadata[] = [
  {
    type: "identity",
    label: "Identity",
    category: "core",
    weight: 1.5,
    decay_default_per_day: 0,
    always_inject: true,
    writable_by_luca: false,
    writable_by_system: true,
    retrieval_note:
      "always injected via alwaysInject (memory-injection.ts), independent of query semantic match — system-written only via self-correction paths. Hard cap IDENTITY_TOKEN_CAP=2500 tokens, excess dropped by importance-then-recency.",
  },
  {
    type: "commitment",
    label: "Commitment",
    category: "core",
    weight: 1.4,
    decay_default_per_day: 0.005,
    always_inject: false,
    writable_by_luca: true,
    writable_by_system: true,
    retrieval_note:
      "retrieved by query semantic match. Namespace _commitment OR _commitments (alias).",
  },
  {
    type: "meta_cognitive",
    label: "Meta-Cognitive",
    category: "meta",
    weight: 1.3,
    decay_default_per_day: 0.01,
    always_inject: false,
    writable_by_luca: true,
    writable_by_system: true,
    retrieval_note: "self-observation patterns; retrieved by semantic match.",
  },
  {
    type: "reflection",
    label: "Reflection",
    category: "meta",
    weight: 1.2,
    decay_default_per_day: 0.01,
    always_inject: false,
    writable_by_luca: true,
    writable_by_system: true,
    retrieval_note: "lessons from outcomes; retrieved by semantic match.",
  },
  {
    type: "relational",
    label: "Relational",
    category: "episodic",
    weight: 1.1,
    decay_default_per_day: 0.01,
    always_inject: false,
    writable_by_luca: true,
    writable_by_system: true,
    retrieval_note: "person-specific dynamics; retrieved by semantic match.",
  },
  {
    type: "procedural",
    label: "Procedural",
    category: "semantic",
    weight: 1.1,
    decay_default_per_day: 0.01,
    always_inject: false,
    writable_by_luca: true,
    writable_by_system: true,
    retrieval_note: "if-X-then-Y rules; retrieved by semantic match.",
  },
  {
    type: "autobiographical",
    label: "Autobiographical",
    category: "episodic",
    weight: 1.1,
    decay_default_per_day: 0.01,
    always_inject: false,
    writable_by_luca: true,
    writable_by_system: true,
    retrieval_note: "my own history; retrieved by semantic match.",
  },
  {
    type: "aesthetic",
    label: "Aesthetic",
    category: "semantic",
    weight: 1.0,
    decay_default_per_day: 0.01,
    always_inject: false,
    writable_by_luca: true,
    writable_by_system: true,
    retrieval_note: "style/format likes-dislikes; retrieved by semantic match.",
  },
  {
    type: "semantic",
    label: "Semantic",
    category: "semantic",
    weight: 1.0,
    decay_default_per_day: 0.01,
    always_inject: false,
    writable_by_luca: true,
    writable_by_system: true,
    retrieval_note:
      "general world/project facts; retrieved by semantic match.",
  },
  {
    type: "episodic",
    label: "Episodic",
    category: "episodic",
    weight: 0.9,
    decay_default_per_day: 0.02,
    always_inject: false,
    writable_by_luca: true,
    writable_by_system: true,
    retrieval_note: "specific events; retrieved by semantic match.",
  },
  {
    type: "emotional_state",
    label: "Emotional State",
    category: "meta",
    weight: 1.0,
    decay_default_per_day: 0.05,
    always_inject: false,
    writable_by_luca: true,
    writable_by_system: true,
    retrieval_note:
      "current emotion snapshots; confidence forced to 0.3, decays fast.",
  },
];

// Quick lookup set used by SQL filter (NIT-4 defensive default).
const KNOWN_TYPES = new Set(TYPE_METADATA.map((t) => t.type));

// ── Namespace metadata (15 active in prod; verified deliberation.ts:7330-7345)
export interface NamespaceMetadata {
  name: string;
  alias_of: string | null;
  description: string;
}

export const NAMESPACE_METADATA: readonly NamespaceMetadata[] = [
  { name: "_identity",        alias_of: "_people:luca",         description: "who I am, durable self-facts" },
  { name: "_commitment",      alias_of: "_commitments",         description: "open obligations (plural alias _commitments)" },
  { name: "_preferences",     alias_of: "_people:kote umbrella", description: "Boss preferences I learned" },
  { name: "_aesthetics",      alias_of: null,                   description: "style/format likes-dislikes" },
  { name: "_procedural",      alias_of: null,                   description: "if-X-then-Y rules" },
  { name: "_meta_cognitive",  alias_of: null,                   description: "self-observation patterns" },
  { name: "_reflection",      alias_of: null,                   description: "lessons from outcomes" },
  { name: "_relational",      alias_of: "_people:*",            description: "dynamics with specific person/agent" },
  { name: "_autobiographical", alias_of: null,                  description: "my own history" },
  { name: "_episodic",        alias_of: null,                   description: "specific events" },
  { name: "_semantic",        alias_of: "_knowledge",           description: "general world/project facts" },
  { name: "_emotional_state", alias_of: null,                   description: "current emotion snapshots (confidence 0.3)" },
  { name: "_projects",        alias_of: null,                   description: "active projects" },
  { name: "_self",            alias_of: null,                   description: "auto-written introspection" },
  { name: "_self_monitoring", alias_of: null,                   description: "self-audit findings" },
];

// ── Output shape (frozen by spec lines 41-72) ────────────────────────────
export interface MemorySchemaTypeRow extends TypeMetadata {
  count: number;
  example_excerpt: string | null;
}

export interface MemorySchemaNamespaceRow extends NamespaceMetadata {
  count: number;
}

export interface MemorySchemaResult {
  types: MemorySchemaTypeRow[];
  namespaces: MemorySchemaNamespaceRow[];
  special_rules: {
    identity: string;
    commitment: string;
    writable_vs_weighted_asymmetry: string;
    emotional_state: string;
    verified: string;
  };
  totals: {
    total_memories: number;
    last_memory_at: string | null;
    oldest_memory_at: string | null;
  };
  spec_version: "v1.0.0";
}

const SPECIAL_RULES = {
  identity:
    "decayRate=0, always_inject=true, only system-written via self-correction. Attempted remember will return 'invalid type identity'.",
  commitment:
    "weight=1.4, writable via remember (in ALLOWED_TYPES), namespace _commitment OR _commitments (alias).",
  writable_vs_weighted_asymmetry:
    "identity и commitment — top weights (1.5, 1.4), но identity special: только система пишет, Луча НЕ может. Это асимметрия writability vs retrieval-weight — НЕ путать.",
  emotional_state:
    "confidence=0.3 forced, decays fast.",
  verified:
    "provenance='luca_inferred', verified=false для всех luca-self-writes.",
};

// ── Truncate excerpt at 80 chars + ellipsis (spec line ~140) ─────────────
function truncateExcerpt(content: string | null): string | null {
  if (!content) return null;
  // Strip the "[meta: {...}]" suffix that remember tool appends, if present.
  const cleaned = content.replace(/\n\n\[meta: \{[\s\S]*?\}\]\s*$/, "").trim();
  if (cleaned.length <= 80) return cleaned;
  return cleaned.slice(0, 80) + "…";
}

// ── Main entry: live SQL snapshot ────────────────────────────────────────
// Pool is injected for testability. userId / agentId are closure args (NOT
// from tool input — Q7-C2 fix prevents cross-account data leak).
//
// Three queries, executed in parallel for latency:
//   1) types aggregate (filtered to 11 known types — NIT-4 defensive default)
//   2) namespaces aggregate (LEFT JOIN keeps count=0 entries — Q7-C3)
//   3) per-type example excerpt (LATERAL preferred; COALESCE(importance,0)
//      so NULL importance rows still rank — R451-N3)
export async function getMemorySchemaSnapshot(
  pool: Pool,
  userId: number,
  agentId: number,
): Promise<MemorySchemaResult> {
  const knownTypeArr = Array.from(KNOWN_TYPES);

  const [typesRes, namespacesRes, excerptsRes, totalsRes] = await Promise.all([
    // (1) types aggregate — only 11 known types
    pool.query<{ type: string; count: string }>(
      `SELECT type, COUNT(*)::text AS count
       FROM memories
       WHERE user_id = $1 AND agent_id = $2 AND type = ANY($3::text[])
       GROUP BY type`,
      [userId, agentId, knownTypeArr],
    ),
    // (2) namespaces aggregate — LEFT JOIN against fixed list, count=0 kept
    pool.query<{ name: string; count: string }>(
      `WITH active_ns(name) AS (
         SELECT unnest($3::text[])
       )
       SELECT n.name, COALESCE(COUNT(m.id), 0)::text AS count
       FROM active_ns n
       LEFT JOIN memories m
         ON m.namespace = n.name AND m.user_id = $1 AND m.agent_id = $2
       GROUP BY n.name`,
      [userId, agentId, NAMESPACE_METADATA.map((n) => n.name)],
    ),
    // (3) per-type example excerpts (LATERAL keeps rows where no row exists
    //     gone by INNER semantics — that's fine; types with count=0 simply
    //     get null excerpt). COALESCE(importance,0) handles legacy NULLs.
    pool.query<{ type: string; content: string }>(
      `SELECT t.type, ex.content
       FROM (
         SELECT DISTINCT type
         FROM memories
         WHERE user_id = $1 AND agent_id = $2 AND type = ANY($3::text[])
       ) t
       LEFT JOIN LATERAL (
         SELECT content
         FROM memories
         WHERE user_id = $1 AND agent_id = $2 AND type = t.type
         ORDER BY COALESCE(importance, 0) DESC, created_at DESC
         LIMIT 1
       ) ex ON true`,
      [userId, agentId, knownTypeArr],
    ),
    // (4) totals — total_memories filtered to known types so legacy noise
    //     doesn't inflate Luca's introspection. last/oldest unfiltered (any
    //     write, including legacy/system).
    pool.query<{
      total_memories: string;
      last_memory_at: string | null;
      oldest_memory_at: string | null;
    }>(
      `SELECT
         (SELECT COUNT(*)::text FROM memories
          WHERE user_id = $1 AND agent_id = $2 AND type = ANY($3::text[])) AS total_memories,
         (SELECT MAX(created_at)::text FROM memories
          WHERE user_id = $1 AND agent_id = $2) AS last_memory_at,
         (SELECT MIN(created_at)::text FROM memories
          WHERE user_id = $1 AND agent_id = $2) AS oldest_memory_at`,
      [userId, agentId, knownTypeArr],
    ),
  ]);

  // Build type rows in metadata order (identity, commitment, then by weight)
  const countsByType = new Map<string, number>();
  for (const r of typesRes.rows) countsByType.set(r.type, parseInt(r.count, 10));
  const excerptByType = new Map<string, string | null>();
  for (const r of excerptsRes.rows) excerptByType.set(r.type, r.content);

  const types: MemorySchemaTypeRow[] = TYPE_METADATA.map((meta) => ({
    ...meta,
    count: countsByType.get(meta.type) ?? 0,
    example_excerpt: truncateExcerpt(excerptByType.get(meta.type) ?? null),
  }));

  // Build namespace rows in metadata order
  const countsByNs = new Map<string, number>();
  for (const r of namespacesRes.rows) countsByNs.set(r.name, parseInt(r.count, 10));
  const namespaces: MemorySchemaNamespaceRow[] = NAMESPACE_METADATA.map((meta) => ({
    ...meta,
    count: countsByNs.get(meta.name) ?? 0,
  }));

  // Convert ms-epoch timestamps (created_at is bigint ms in this codebase)
  const totalsRow = totalsRes.rows[0] || { total_memories: "0", last_memory_at: null, oldest_memory_at: null };
  const toIso = (v: string | null): string | null => {
    if (v == null) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    return new Date(n).toISOString();
  };

  return {
    types,
    namespaces,
    special_rules: SPECIAL_RULES,
    totals: {
      total_memories: parseInt(totalsRow.total_memories, 10) || 0,
      last_memory_at: toIso(totalsRow.last_memory_at),
      oldest_memory_at: toIso(totalsRow.oldest_memory_at),
    },
    spec_version: "v1.0.0",
  };
}
