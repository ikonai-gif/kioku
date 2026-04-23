/**
 * TRUST registry — Luca V1a Day -1 stub.
 *
 * The registry is Luca's answer to prompt injection: every tool output that
 * re-enters the LLM's context (web search snippets, fetched URL bodies,
 * read files) gets a TRUST verdict before it's allowed to influence
 * subsequent memory-writing behaviour.
 *
 * Day -1 provides only the INTERFACE and a naive in-memory default impl.
 * Real verification (canary slots, attack-signature matching, IDPI
 * invariants) lands on Day 3. We want the shape pinned now so downstream
 * Day N PRs wire against a stable contract.
 *
 * Bro2 F2 (Luca V1 impl plan review): TRUST must be a registry, not a flag
 * — different tool outputs need different verifier strategies (Brave
 * snippet vs read_url body vs run_code stdout). Hence the `register` /
 * `verify` split.
 *
 * Threat model stays simple for Day -1:
 *   - VERIFIED  → content passed a canary echo check + no attack signature.
 *   - SUSPECT   → content tripped a signature (e.g. "ignore previous
 *                 instructions", zero-width marker, system-role injection).
 *                 Caller MUST markUntrusted on TurnStateStore.
 *   - UNKNOWN   → no verifier registered for this source type. Caller
 *                 decides policy (V1a default: treat as SUSPECT for memory
 *                 writes; fine for read-only).
 */
import logger from "../../logger";

export type TrustVerdict = "VERIFIED" | "SUSPECT" | "UNKNOWN";

export interface TrustSample {
  /**
   * Where the content came from. Day 3 verifiers key off this.
   *   "brave_search" | "read_url" | "run_code_stdout" | "drive_read" | ...
   */
  sourceType: string;
  /** The raw content that will re-enter the LLM context. */
  content: string;
  /**
   * Optional per-source metadata. Canary slot id, URL, file path, etc.
   * Opaque to the registry — passed through to verifiers.
   */
  meta?: Record<string, unknown>;
}

export interface TrustResult {
  verdict: TrustVerdict;
  /** Short machine-readable tag, e.g. "attack_sig:ignore_prev", "canary_ok". */
  signal: string;
  /** Human-readable detail for logs / error surfaces. */
  detail: string;
  /** Which verifier produced this verdict ("__default__" for fallback). */
  verifierName: string;
}

export interface TrustVerifier {
  name: string;
  /**
   * Return a verdict for the given sample. A verifier that can't judge
   * should return UNKNOWN (not throw) so the registry can try the next one.
   *
   * SECURITY (audit pass-3 D23): if a verifier DOES throw, the thrown
   * Error's `.message` will be surfaced in `TrustResult.detail` which is
   * returned to callers and may reach UI/logs. Throw messages MUST be
   * generic (e.g. "canary mismatch", "signature detected") and MUST NOT
   * include any user-influenced data from `sample.content` — even a
   * prefix. The verifier must treat `sample.content` as secret-equivalent
   * for error-message purposes.
   */
  verify(sample: TrustSample): Promise<TrustResult>;
}

export interface TrustRegistry {
  register(sourceType: string, verifier: TrustVerifier): void;
  /**
   * Verify a sample. Dispatches to the verifier registered for
   * `sample.sourceType`. Returns UNKNOWN if no verifier is registered AND
   * no default is installed. Never throws on verifier failure — logs and
   * returns SUSPECT (fail-closed on verifier errors — opposite of
   * TurnStateStore because this gate is authoritative).
   */
  verify(sample: TrustSample): Promise<TrustResult>;
  /** Install a catch-all verifier used when no per-sourceType one matches. */
  setDefault(verifier: TrustVerifier): void;
  /** Test/diagnostic helper. */
  listRegistered(): string[];
}

// ─── Default implementation ──────────────────────────────────────────────

/**
 * Day -1 naive default: UNKNOWN for everything. Real verifiers come on
 * Day 3 (canaries) and Day 4 (attack-signature matcher). The point of
 * this stub is to make downstream tool handlers able to call
 * `registry.verify(...)` without type errors or null checks, and to let
 * us write the dispatcher logic tests now.
 */
export const unknownVerifier: TrustVerifier = {
  name: "__unknown_default__",
  async verify(sample) {
    return {
      verdict: "UNKNOWN",
      signal: "no_verifier_registered",
      detail: `No verifier for sourceType=${sample.sourceType}; Day -1 stub`,
      verifierName: this.name,
    };
  },
};

export class DefaultTrustRegistry implements TrustRegistry {
  private readonly bySource = new Map<string, TrustVerifier>();
  private defaultVerifier: TrustVerifier = unknownVerifier;

  register(sourceType: string, verifier: TrustVerifier): void {
    if (this.bySource.has(sourceType)) {
      logger.warn(
        { sourceType, prev: this.bySource.get(sourceType)?.name, next: verifier.name },
        "[luca.trustRegistry] overwriting verifier",
      );
    }
    this.bySource.set(sourceType, verifier);
  }

  setDefault(verifier: TrustVerifier): void {
    this.defaultVerifier = verifier;
  }

  async verify(sample: TrustSample): Promise<TrustResult> {
    const verifier = this.bySource.get(sample.sourceType) ?? this.defaultVerifier;
    try {
      return await verifier.verify(sample);
    } catch (err) {
      // Fail-closed: if a verifier throws, treat content as SUSPECT.
      logger.error(
        { err: (err as Error).message, sourceType: sample.sourceType, verifier: verifier.name },
        "[luca.trustRegistry] verifier threw → SUSPECT",
      );
      return {
        verdict: "SUSPECT",
        signal: "verifier_error",
        detail: `${verifier.name} threw: ${(err as Error).message}`,
        verifierName: verifier.name,
      };
    }
  }

  listRegistered(): string[] {
    return Array.from(this.bySource.keys()).sort();
  }
}

let singleton: TrustRegistry | null = null;

/**
 * Process-wide registry. Day -1 returns an empty DefaultTrustRegistry;
 * Day 3 will populate it at boot with canary + attack-sig verifiers.
 */
export function getTrustRegistry(): TrustRegistry {
  if (!singleton) singleton = new DefaultTrustRegistry();
  return singleton;
}

/** Test-only: replace singleton so tests don't leak verifier state. */
export function __setTrustRegistryForTests(r: TrustRegistry | null): void {
  singleton = r;
}
