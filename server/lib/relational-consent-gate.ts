// Phase 1a — _relational PII consent gate (injection/read path).
//
// WHY: relational memories are always-injected via getInjectionCandidates
// (storage.ts: `type IN ('identity','relational','aesthetic','procedural')`),
// with NO consent check on the read path — checkMemoryConsent only gates the
// WRITE path (deliberation.ts). So third-party PII about real people leaked
// into context regardless of consent. This closes that on the read path.
//
// SCOPE: gates ONLY the PII relational namespaces ratified in [BRO2-322]
// FINAL DECISIONS #5 (PII person-slugs = kote, nicole; the unsharded bare
// `_relational` bucket also holds PII pending the 1b re-shard). Internal-agent
// relational (`_relational:bro2|bro3|boss`) is NOT PII and is left untouched.
//
// BEHAVIOUR (Variant A, proposed-default — pending BRO4 ratification):
// when consent_sensitive is false, PII relational rows are removed from the
// injection set. No deletion of stored data; reversible; read-path only.

export const RELATIONAL_PII_NAMESPACES: ReadonlySet<string> = new Set([
  "_relational",
  "_relational:kote",
  "_relational:nicole",
]);

export function isRelationalPiiNamespace(namespace: string | null | undefined): boolean {
  if (!namespace) return false;
  return RELATIONAL_PII_NAMESPACES.has(namespace);
}

/**
 * Remove PII relational rows from an injection-candidate set when the user has
 * not granted sensitive consent. Pure + side-effect free for easy unit testing.
 */
export function gateRelationalPiiByConsent<T extends { namespace?: string | null }>(
  rows: readonly T[],
  consentSensitive: boolean,
): T[] {
  if (consentSensitive) return [...rows];
  return rows.filter((r) => !isRelationalPiiNamespace(r.namespace));
}
