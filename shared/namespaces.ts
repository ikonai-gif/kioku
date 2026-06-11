// shared/namespaces.ts
// Single runtime source of truth for memory namespaces (mirrors shared/namespaces.json).
// Enforced at two disjoint write paths: the `remember` tool (server/deliberation.ts,
// direct INSERT) and storage.createMemory (server/storage.ts).
//
// Design: pure, dependency-free. `normalizeNamespace` returns a decision; callers
// decide how to act (remember rejects unknown to educate Luca; createMemory coerces
// unknown to 'default' and warns, so a system write is never broken).
//
// A consistency test (tests/unit/namespaces-consistency.test.ts) asserts this file
// and namespaces.json agree, so the governance JSON never silently drifts.

export interface NamespaceDef {
  name: string;
  writable_by_luca: boolean;
  sensitive: boolean;
  pii: boolean | "by_slug";
}

// ── Canonical base namespaces (exact-match accepted) ──────────────────────
export const CANONICAL: readonly NamespaceDef[] = [
  { name: "_identity",             writable_by_luca: false, sensitive: true,  pii: false },
  { name: "_episode_summaries",    writable_by_luca: false, sensitive: false, pii: false },
  { name: "_self_improvements",    writable_by_luca: false, sensitive: false, pii: false },
  { name: "_self_monitoring",      writable_by_luca: true,  sensitive: false, pii: false },
  { name: "_self",                 writable_by_luca: false, sensitive: false, pii: false },
  { name: "_system",               writable_by_luca: false, sensitive: true,  pii: false },
  { name: "_health",               writable_by_luca: false, sensitive: true,  pii: true  },
  { name: "_allergies",            writable_by_luca: false, sensitive: true,  pii: true  },
  { name: "_biometric",            writable_by_luca: false, sensitive: true,  pii: true  },
  { name: "_face_scan",            writable_by_luca: false, sensitive: true,  pii: true  },
  { name: "_conversation_insights",writable_by_luca: true,  sensitive: false, pii: false },
  { name: "_episodic",             writable_by_luca: true,  sensitive: false, pii: false },
  { name: "_semantic",             writable_by_luca: true,  sensitive: false, pii: false },
  { name: "_procedural",           writable_by_luca: true,  sensitive: false, pii: false },
  { name: "_autobiographical",     writable_by_luca: true,  sensitive: false, pii: false },
  { name: "_emotional_state",      writable_by_luca: true,  sensitive: false, pii: false },
  { name: "_meta_cognitive",       writable_by_luca: true,  sensitive: false, pii: false },
  { name: "_reflections",          writable_by_luca: true,  sensitive: false, pii: false },
  { name: "_relational",           writable_by_luca: true,  sensitive: true,  pii: "by_slug" },
  { name: "decisions",             writable_by_luca: true,  sensitive: false, pii: false },
  { name: "_boss_decisions",       writable_by_luca: false, sensitive: false, pii: false },
  { name: "_projects",             writable_by_luca: true,  sensitive: false, pii: false },
  { name: "_commitment",           writable_by_luca: true,  sensitive: false, pii: false },
  { name: "_active_plans",         writable_by_luca: true,  sensitive: false, pii: false },
  { name: "_proactive_suggestions",writable_by_luca: true,  sensitive: false, pii: false },
  { name: "_feedback_requests",    writable_by_luca: true,  sensitive: false, pii: false },
  { name: "_knowledge",            writable_by_luca: true,  sensitive: false, pii: false },
  { name: "_lessons",              writable_by_luca: true,  sensitive: false, pii: false },
  { name: "_learning",             writable_by_luca: true,  sensitive: false, pii: false },
  { name: "_aesthetics",           writable_by_luca: true,  sensitive: false, pii: false },
  { name: "_aesthetic_profile",    writable_by_luca: false, sensitive: false, pii: false },
  { name: "_creations",            writable_by_luca: true,  sensitive: false, pii: false },
  { name: "_video",                writable_by_luca: true,  sensitive: false, pii: false },
  { name: "_audio",                writable_by_luca: true,  sensitive: false, pii: false },
  { name: "deliberation_positions",writable_by_luca: false, sensitive: false, pii: false },
  { name: "stable_positions",      writable_by_luca: false, sensitive: false, pii: false },
  { name: "_preferences",          writable_by_luca: true,  sensitive: true,  pii: false },
  { name: "_series_bible",         writable_by_luca: true,  sensitive: false, pii: false },
  { name: "default",               writable_by_luca: true,  sensitive: false, pii: false },
];

export const CANONICAL_NAMES: ReadonlySet<string> = new Set(CANONICAL.map((d) => d.name));

// ── Always-inject namespaces ──────────────────────────────────────────────
// Namespaces whose rows storage.getInjectionCandidates loads into the
// injection-candidate universe regardless of topic relevance. Single source of
// truth shared with the SQL WHERE so the list cannot silently drift.
// [BRO2-A7.1] _projects added: A7 (#228) injected the ACTIVE PROJECTS block but
// this source query never surfaced _projects rows, so the block rendered empty.
export const INJECTION_ALWAYS_NAMESPACES = ["_identity", "_episode_summaries", "_projects"] as const;
const SENSITIVE_BASE: ReadonlySet<string> = new Set(CANONICAL.filter((d) => d.sensitive).map((d) => d.name));

// ── Explicit legacy aliases (exact legacy string -> canonical) ────────────
export const LEGACY_ALIASES: Readonly<Record<string, string>> = {
  "_reflection": "_reflections",
  "_commitments": "_commitment",
  "_knowledge_Art History": "knowledge:art_history",
  "research": "knowledge:research",
  "strategy": "knowledge:strategy",
  "finance": "knowledge:finance",
  "legal": "knowledge:legal",
  "operations": "knowledge:operations",
  "product": "knowledge:product",
  "client_feedback": "knowledge:client_feedback",
  "client_preferences": "knowledge:client_preferences",
  "agent_coordination": "knowledge:agent_coordination",
  "marketing_strategy": "knowledge:marketing_strategy",
  "launch_campaign": "knowledge:launch_campaign",
  "beta_launch": "knowledge:beta_launch",
  "production_status": "knowledge:production_status",
  "_relational:boss_alter": "_relational:boss",
  "_series_bible:IKONBAI Confidential": "_series_bible:ikonbai_confidential",
  "_series_bible:Meta-coder": "_series_bible:meta_coder",
};

// ── Tag-style suffix strip (suffix is a note, base is the real type). ──────
// NEVER applied to entity prefixes (_relational:, knowledge:, _series_bible:).
export const SUFFIX_STRIP: ReadonlyArray<{ prefix: string; base: string }> = [
  { prefix: "_reflection:",       base: "_reflections" },
  { prefix: "_commitment:",       base: "_commitment" },
  { prefix: "_autobiographical:", base: "_autobiographical" },
  { prefix: "_procedural:",       base: "_procedural" },
  { prefix: "_emotional_state:",  base: "_emotional_state" },
  { prefix: "_meta_cognitive:",   base: "_meta_cognitive" },
];

// ── Dynamic entity patterns (suffix is an entity, preserved as slug) ──────
export const PERSON_SLUGS = {
  pii: ["kote", "nicole"] as const,
  internal: ["bro2", "bro3", "boss"] as const,
};
const PERSON_SLUG_ALL: ReadonlySet<string> = new Set<string>([...PERSON_SLUGS.pii, ...PERSON_SLUGS.internal]);
const PERSON_SLUG_PII: ReadonlySet<string> = new Set<string>(PERSON_SLUGS.pii);

export const DYNAMIC_PATTERNS: ReadonlyArray<{ prefix: string; regex: RegExp; kind: "knowledge" | "relational" | "series" }> = [
  { prefix: "knowledge:",     regex: /^knowledge:[a-z0-9][a-z0-9_]{1,63}$/,     kind: "knowledge" },
  { prefix: "_relational:",   regex: /^_relational:[a-z0-9][a-z0-9_]{0,39}$/,   kind: "relational" },
  { prefix: "_series_bible:", regex: /^_series_bible:[a-z0-9][a-z0-9_]{0,39}$/, kind: "series" },
];

// Normalize a free-form suffix into a slug: lowercase, non-alnum -> _, collapse, trim.
export function slugify(raw: string): string {
  return String(raw)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export interface NamespaceDecision {
  ok: boolean;            // false => caller should reject (remember) or coerce (createMemory)
  namespace: string | null; // resolved canonical namespace (null only for empty input)
  mapped: boolean;        // true if input was rewritten (alias/strip/slug-normalized)
  from?: string;          // original input when mapped
  reason?: string;        // human-readable reason when !ok
}

/**
 * Resolve an input namespace to its canonical form.
 * Order: empty -> canonical exact -> legacy alias -> suffix strip -> dynamic entity -> unknown.
 */
export function normalizeNamespace(input: unknown): NamespaceDecision {
  const ns = typeof input === "string" ? input.trim() : "";
  if (!ns) return { ok: true, namespace: null, mapped: false };

  // 1. exact canonical
  if (CANONICAL_NAMES.has(ns)) return { ok: true, namespace: ns, mapped: false };

  // 2. explicit legacy alias
  const alias = LEGACY_ALIASES[ns];
  if (alias) return { ok: true, namespace: alias, mapped: true, from: ns };

  // 3. tag-style suffix strip
  for (const { prefix, base } of SUFFIX_STRIP) {
    if (ns.startsWith(prefix)) return { ok: true, namespace: base, mapped: true, from: ns };
  }

  // 4. dynamic entity patterns
  for (const p of DYNAMIC_PATTERNS) {
    if (ns.startsWith(p.prefix)) {
      const rawSuffix = ns.slice(p.prefix.length);
      const slug = slugify(rawSuffix);
      const candidate = p.prefix + slug;
      if (!slug || !p.regex.test(candidate)) {
        return { ok: false, namespace: null, mapped: false, reason: `invalid slug '${rawSuffix}' for pattern ${p.prefix}<slug>` };
      }
      if (p.kind === "relational" && !PERSON_SLUG_ALL.has(slug)) {
        return {
          ok: false, namespace: null, mapped: false,
          reason: `unregistered person-slug '${slug}'. Known: ${[...PERSON_SLUG_ALL].join(", ")}. New people need Boss approval in shared/namespaces.json.`,
        };
      }
      const mapped = candidate !== ns;
      return { ok: true, namespace: candidate, mapped, from: mapped ? ns : undefined };
    }
  }

  // 5. unknown
  return { ok: false, namespace: null, mapped: false, reason: `unknown namespace '${ns}'` };
}

/** True if a (already-canonical) namespace holds sensitive/PII data. */
export function isSensitiveNamespace(ns: string | null | undefined): boolean {
  if (!ns) return false;
  if (SENSITIVE_BASE.has(ns)) return true;
  if (ns.startsWith("_relational:")) {
    const slug = ns.slice("_relational:".length);
    return PERSON_SLUG_PII.has(slug); // human slugs sensitive; internal agents not
  }
  return false;
}

/** Compact, human-readable list of Luca-writable namespaces for the remember tool prompt. */
export function lucaWritableNamespaceHint(): string {
  const bases = CANONICAL.filter((d) => d.writable_by_luca).map((d) => d.name);
  return [
    bases.join(", "),
    "plus patterns: knowledge:<topic>, _relational:<person> (kote|nicole|bro2|bro3|boss), _series_bible:<series>",
  ].join("; ");
}

// ── fact_key (BRO2-325 bi-temporal validity) ───────────────────────────────
// Canonical key for a factual attribute of an entity, e.g. "kote.hair_color".
// Enables contradiction-driven invalidation (same fact_key + different value =>
// close the old fact). Format: lowercase, a-z0-9_, at least one dot.
// Derived by the LLM in `remember`; storage only VALIDATES (never guesses).
export const FACT_KEY_REGEX = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;

export function isValidFactKey(input: unknown): boolean {
  return typeof input === "string" && FACT_KEY_REGEX.test(input);
}

// ── provenance hierarchy (BRO2-325 bi-temporal 2.1b) ───────────────────────
// A NEW fact may close (set valid_to) an existing fact ONLY when the new
// write's provenance is at least as strong. Prevents a luca_inferred write
// from silently overriding human-told truth.
export const PROVENANCE_STRENGTH: Record<string, number> = {
  boss_told: 100,
  user_told: 90,
  verified_import: 80,
  tool_observed: 70,
  agent_inferred: 50,
  luca_inferred: 50,
  unknown: 10,
};

export function provenanceStrength(p: string | null | undefined): number {
  if (!p) return PROVENANCE_STRENGTH.unknown;
  return PROVENANCE_STRENGTH[p] ?? PROVENANCE_STRENGTH.unknown;
}

/** True when a NEW fact (newProv) may supersede an existing fact (oldProv). */
export function canSupersede(
  newProv: string | null | undefined,
  oldProv: string | null | undefined,
): boolean {
  return provenanceStrength(newProv) >= provenanceStrength(oldProv);
}
