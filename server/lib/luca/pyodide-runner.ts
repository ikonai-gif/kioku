/**
 * PyodideRunner — Luca V1a Day 1 contract + mock impl.
 *
 * This module defines the interface that Luca's `run_code` tool will use to
 * execute user code in a sandboxed Python (Pyodide) runtime. The REAL Pyodide
 * integration is deliberately deferred to a follow-up PR (Day 1.5) so that
 * this PR is dependency-free and can be reviewed/merged without touching
 * Railway image size.
 *
 * What lands HERE:
 *   - `PyodideRunner` interface — the shape the rest of Luca will code against.
 *   - `RunCodeInput` / `RunCodeResult` types — stable across Day 1→1.5→6.
 *   - `MockPyodideRunner` — deterministic in-memory impl for tests. Simulates
 *     stdout, stderr, timeouts, memory caps, per-ctxKey sandbox isolation
 *     (B1), and per-ctxKey /tmp eviction (SF2).
 *   - `SandboxKey` — opaque branded type so callers can't pass raw strings.
 *
 * What lands in Day 1.5 (separate PR):
 *   - `RealPyodideRunner` — lazy-init `pyodide` package, 30s timeout,
 *     256MB memory cap, matplotlib savefig shim → /tmp/sandbox/<ctxKey>/.
 *   - S3 upload of plot artifacts (Day 3 SF4 whitelist applies).
 *
 * Bro2 Day -1 follow-up: Day 1 pins the sandboxing invariants (B1, SF2)
 * via mock so the real impl on Day 1.5 has concrete contract tests to pass.
 * That's why this PR is "interface + mock + behavioral tests" — we lock the
 * semantics before the external dep lands.
 *
 * Bro2 Day 1 review (M1): The 25 mock tests do NOT literally transfer —
 * ~20 of them exercise `MockPyodideRunner.register()`, which is a mock-only
 * fixture hook not present on the `PyodideRunner` interface. What IS stable
 * across Day 1 → Day 1.5 are the **behavioral invariants**: B1 globals
 * isolation, SF2 eviction, `maxTimeoutMs` cap, `RunCodeStatus` surface
 * (ok|error|timeout|memory_exceeded|disabled), flag-gate double defense.
 * Day 1.5 must ship an analogous real-Python test suite that asserts these
 * same invariants against `RealPyodideRunner` — plus an N=10 ctxKeys
 * property-based test for namespace isolation (Bro2 N3).
 */
import { LucaFeatureDisabledError, isLucaEnabled } from "./env";
import logger from "../../logger";

// ─── Types ──────────────────────────────────────────────────────────────

/**
 * Opaque branded sandbox identifier. Prevents callers from accidentally
 * passing a raw string where a typed sandbox key is expected.
 *
 * Typical construction: `sandboxKeyForTurn(meetingId, turnId)` or a random
 * UUID for standalone `run_code` calls.
 */
export type SandboxKey = string & { readonly __brand: "SandboxKey" };

/**
 * SandboxKey validator. First char MUST be alphanumeric — leading `-` is
 * rejected so `rm -rf /tmp/sandbox/<key>/` on Day 1.5 can't ever have its
 * key argument interpreted as a CLI flag (belt-and-braces — absolute paths
 * already protect us, but zero-cost hardening per Bro2 Day 1 N1).
 */
export function toSandboxKey(s: string): SandboxKey {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(s)) {
    throw new Error(
      `pyodide.invalid_ctx_key: must match /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/, got: ${JSON.stringify(s)}`,
    );
  }
  return s as SandboxKey;
}

/**
 * Construct a deterministic SandboxKey for a meeting-scoped turn.
 *
 * Pattern: `m_<meetingId-no-dashes>_t_<turnId-no-dashes>`. UUIDs are 36 chars
 * with 4 dashes → 32 hex chars each → total key length 2 + 32 + 3 + 32 = 69,
 * well under the 128-char regex limit. First char `m` is alphanumeric so
 * leading-dash hardening (Bro2 Day 1 N1) holds.
 *
 * Use this helper instead of hand-constructing ctxKey strings so B1 globals
 * isolation and SF2 per-ctxKey filesystem cleanup both see the same naming.
 */
export function sandboxKeyForTurn(meetingId: string, turnId: string): SandboxKey {
  const mid = meetingId.replace(/-/g, "");
  const tid = turnId.replace(/-/g, "");
  return toSandboxKey(`m_${mid}_t_${tid}`);
}

export interface RunCodeInput {
  /** Sandbox scope. Globals are isolated per-ctxKey (B1). */
  ctxKey: SandboxKey;
  /** Python source. No size limit here — enforced at the tool-handler layer. */
  code: string;
  /** Override default 30_000ms timeout. Caps at 60_000ms (plan Day 1). */
  timeoutMs?: number;
  /**
   * Opt-in: preserve the sandbox after this call so a follow-up call with
   * the same `ctxKey` sees the same globals. Off by default — most tool
   * invocations are stateless. Callers set true explicitly (e.g. REPL mode).
   */
  keepGlobals?: boolean;
}

export interface RunCodePlotArtifact {
  /**
   * Filename under the per-ctxKey sandbox dir. Day 1.5 will also expose
   * an S3 URL after upload; Day 1 mock only exposes the logical filename.
   */
  filename: string;
  /** Day 1.5 populates this; Day 1 mock leaves null. */
  s3Url: string | null;
  /** MIME type — usually image/png. */
  mimeType: string;
}

export type RunCodeStatus =
  | "ok"
  | "error"
  | "timeout"
  | "memory_exceeded"
  | "disabled";

export interface RunCodeResult {
  status: RunCodeStatus;
  stdout: string;
  stderr: string;
  /** Plot artifacts produced via `plt.savefig()` or `plt.show()` (shim). */
  plots: RunCodePlotArtifact[];
  /** Wall-clock duration in ms. */
  elapsedMs: number;
  /**
   * Populated only when status === "error". Python traceback or a
   * runner-level error message.
   */
  errorDetail: string | null;
}

export interface PyodideRunner {
  /**
   * Execute code and return a `RunCodeResult`. Never throws on user-code
   * failure — returns `status: "error"` with traceback. May throw on
   * runner-infrastructure failure (e.g. WASM load) — callers handle that
   * separately (tool-handler maps to `run_code_infrastructure_error`).
   *
   * **Flag gate (Bro2 Day 1 M2)**: when `LUCA_V1A_ENABLED=false`, this
   * method returns `{ status: "disabled", ... }` rather than throwing.
   * Tool-handler code SHOULD prefer {@link runCode} (the wrapper), which
   * throws `LucaFeatureDisabledError` — easier to enforce at call sites
   * that expect success-or-throw. Calling `run()` directly is supported
   * but you MUST branch on `status === "disabled"` in that path.
   */
  run(input: RunCodeInput): Promise<RunCodeResult>;

  /**
   * Best-effort sandbox eviction. SF2: after each turn the turn-runner
   * calls this so /tmp/sandbox/<ctxKey>/ doesn't accumulate plots. Mock
   * impl tracks eviction in-memory; real impl rm-rf's the sandbox dir.
   */
  evictSandbox(ctxKey: SandboxKey): Promise<void>;

  /**
   * Test/diagnostic helper: returns true if a sandbox currently exists
   * for this ctxKey (either has globals pinned via keepGlobals or has
   * un-evicted plot artifacts).
   */
  hasSandbox(ctxKey: SandboxKey): boolean;
}

// ─── Mock implementation ────────────────────────────────────────────────

interface MockScript {
  /** If set, overrides status regardless of other fields. */
  status?: RunCodeStatus;
  stdout?: string;
  stderr?: string;
  plots?: string[]; // just filenames
  /** Simulate long-running call for timeout tests. */
  sleepMs?: number;
  /** Simulate memory overrun. */
  memoryExceeded?: boolean;
  /** Simulate infra throw. */
  throwMessage?: string;
  /**
   * Python globals this script WRITES (keepGlobals=true scenarios).
   * Used by mock to verify B1 isolation.
   */
  writesGlobals?: Record<string, unknown>;
  /**
   * Python globals this script READS. Mock returns "error" with a
   * traceback-like stderr if a required global is missing in THIS
   * ctxKey's sandbox.
   */
  readsGlobals?: string[];
}

interface SandboxState {
  globals: Record<string, unknown>;
  /** Filenames of un-evicted plots. */
  plots: string[];
}

/**
 * Deterministic mock. Accepts a script registry keyed by code string so
 * tests can assert exact behavior without running Python.
 *
 * Test pattern:
 *   const runner = new MockPyodideRunner();
 *   runner.register("print(1+1)", { stdout: "2\n" });
 *   const r = await runner.run({ ctxKey: toSandboxKey("a"), code: "print(1+1)" });
 *   expect(r.stdout).toBe("2\n");
 */
export class MockPyodideRunner implements PyodideRunner {
  private readonly scripts = new Map<string, MockScript>();
  private readonly sandboxes = new Map<SandboxKey, SandboxState>();

  /**
   * @param defaultTimeoutMs default per-call timeout; override via RunCodeInput.
   * @param maxTimeoutMs hard ceiling; caller-supplied timeouts are capped to
   *   this value. Hardcoded at 60s per Bro2 Day 1 Q3 — promote to an env
   *   var (`LUCA_RUN_CODE_MAX_TIMEOUT_MS`) only if prod observability shows
   *   real workloads legitimately needing more than 60s.
   * @param now clock injection for deterministic `elapsedMs` in tests.
   */
  constructor(
    private readonly defaultTimeoutMs: number = 30_000,
    private readonly maxTimeoutMs: number = 60_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Register a script response for a given exact code string. */
  register(code: string, script: MockScript): void {
    this.scripts.set(code, script);
  }

  private getOrCreateSandbox(ctxKey: SandboxKey): SandboxState {
    let s = this.sandboxes.get(ctxKey);
    if (!s) {
      s = { globals: {}, plots: [] };
      this.sandboxes.set(ctxKey, s);
    }
    return s;
  }

  async run(input: RunCodeInput): Promise<RunCodeResult> {
    if (!isLucaEnabled()) {
      return {
        status: "disabled",
        stdout: "",
        stderr: "",
        plots: [],
        elapsedMs: 0,
        errorDetail: "luca_feature_disabled: LUCA_V1A_ENABLED=false",
      };
    }

    const timeoutMs = Math.min(
      input.timeoutMs ?? this.defaultTimeoutMs,
      this.maxTimeoutMs,
    );
    const script = this.scripts.get(input.code);
    const start = this.now();

    if (!script) {
      // Unregistered code → treat as no-op print for predictability.
      return {
        status: "ok",
        stdout: "",
        stderr: "",
        plots: [],
        elapsedMs: 0,
        errorDetail: null,
      };
    }

    if (script.throwMessage) {
      throw new Error(script.throwMessage);
    }

    if (script.sleepMs != null && script.sleepMs > timeoutMs) {
      return {
        status: "timeout",
        stdout: script.stdout ?? "",
        stderr: "",
        plots: [],
        elapsedMs: timeoutMs,
        errorDetail: `run_code_timeout: exceeded ${timeoutMs}ms`,
      };
    }

    if (script.memoryExceeded) {
      return {
        status: "memory_exceeded",
        stdout: script.stdout ?? "",
        stderr: "",
        plots: [],
        elapsedMs: this.now() - start,
        errorDetail: "run_code_memory_exceeded: 256MB cap",
      };
    }

    const sandbox = this.getOrCreateSandbox(input.ctxKey);

    // B1: verify every required global is present in THIS ctxKey's sandbox.
    if (script.readsGlobals) {
      for (const name of script.readsGlobals) {
        if (!(name in sandbox.globals)) {
          return {
            status: "error",
            stdout: script.stdout ?? "",
            stderr: `NameError: name '${name}' is not defined`,
            plots: [],
            elapsedMs: this.now() - start,
            errorDetail: `NameError: name '${name}' is not defined`,
          };
        }
      }
    }

    // Write globals (for keepGlobals scenarios).
    if (script.writesGlobals && input.keepGlobals) {
      Object.assign(sandbox.globals, script.writesGlobals);
    }

    // Accumulate plot artifacts.
    const newPlots: RunCodePlotArtifact[] = [];
    if (script.plots) {
      for (const filename of script.plots) {
        sandbox.plots.push(filename);
        newPlots.push({ filename, s3Url: null, mimeType: "image/png" });
      }
    }

    if (script.status === "error") {
      return {
        status: "error",
        stdout: script.stdout ?? "",
        stderr: script.stderr ?? "",
        plots: newPlots,
        elapsedMs: this.now() - start,
        errorDetail: script.stderr ?? "unspecified error",
      };
    }

    return {
      status: script.status ?? "ok",
      stdout: script.stdout ?? "",
      stderr: script.stderr ?? "",
      plots: newPlots,
      elapsedMs: this.now() - start,
      errorDetail: null,
    };
  }

  async evictSandbox(ctxKey: SandboxKey): Promise<void> {
    this.sandboxes.delete(ctxKey);
  }

  hasSandbox(ctxKey: SandboxKey): boolean {
    const s = this.sandboxes.get(ctxKey);
    if (!s) return false;
    return (
      Object.keys(s.globals).length > 0 || s.plots.length > 0
    );
  }

  /**
   * Test helper: enumerate live ctxKeys.
   *
   * MOCK-ONLY (Bro2 Day 1 N2): this method is NOT on the `PyodideRunner`
   * interface. `RealPyodideRunner` on Day 1.5 has no cheap in-process
   * enumeration because sandbox state lives in `/tmp/sandbox/` + Pyodide
   * heap. If you need "is this key live?" in production code, use
   * {@link hasSandbox}, which IS on the interface.
   */
  liveSandboxKeys(): SandboxKey[] {
    return Array.from(this.sandboxes.keys());
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────

let singleton: PyodideRunner | null = null;

/**
 * Process-wide runner. Day 1 returns `MockPyodideRunner` in all environments
 * (including prod) because the real Pyodide binding isn't wired yet AND the
 * master flag is off. Day 1.5 will introduce a real-vs-mock switch.
 */
export function getPyodideRunner(): PyodideRunner {
  if (!singleton) {
    singleton = new MockPyodideRunner();
    logger.info(
      "[luca.pyodideRunner] using MockPyodideRunner (Day 1); real Pyodide wire-up is Day 1.5",
    );
  }
  return singleton;
}

/** Test-only: replace singleton so tests don't leak state. */
export function __setPyodideRunnerForTests(r: PyodideRunner | null): void {
  singleton = r;
}

/**
 * Thin wrapper that enforces master-flag. Tool handlers call this instead
 * of `runner.run` directly. Throws `LucaFeatureDisabledError` if the flag
 * is off — the tool registry will map that to a user-visible
 * `luca_feature_disabled` error.
 */
export async function runCode(
  runner: PyodideRunner,
  input: RunCodeInput,
): Promise<RunCodeResult> {
  if (!isLucaEnabled()) {
    throw new LucaFeatureDisabledError("LUCA_V1A_ENABLED=false");
  }
  return runner.run(input);
}
