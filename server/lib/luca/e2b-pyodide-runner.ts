/**
 * E2BPyodideRunner — real Python execution via @e2b/code-interpreter.
 *
 * Day 1.5 — replaces MockPyodideRunner in production when
 * `LUCA_PYODIDE_RUNNER=e2b`. Implements the same `PyodideRunner` contract
 * so call sites (tool-handlers, deliberation) don't care which backend.
 *
 * Architecture:
 *   - **Single process-wide Sandbox**. E2B sandboxes cost ~$0.00003/s idle
 *     and take ~1s to spin up. We keep ONE alive for the whole process and
 *     periodically bump its timeout to survive. B1 isolation comes from
 *     per-ctxKey Jupyter **contexts** inside that sandbox, not from
 *     separate sandboxes.
 *   - **Context per ctxKey**. Each ctxKey maps to a dedicated
 *     `createCodeContext()` result cached in memory. `evictSandbox(ctxKey)`
 *     calls `removeCodeContext()` — cheap, zero network cost after that.
 *   - **Lazy Sandbox init**. First `run()` creates the sandbox; subsequent
 *     calls reuse it. On sandbox death (timeout, kill) we transparently
 *     recreate on the next call.
 *   - **Timeout mapping**. E2B's `runCode({ timeoutMs })` rejects the
 *     Execution's `error.name === "TimeoutError"` when the code runs past
 *     its budget. We map that to `status: "timeout"`.
 *   - **Error mapping**. Any `Execution.error` with a Python-side name
 *     (NameError, ZeroDivisionError, etc.) → `status: "error"` + traceback.
 *   - **Memory**. E2B default template has 2 GiB RAM; OOM surfaces as an
 *     error with MemoryError / OSError. We keep the existing "memory_exceeded"
 *     status for parity with mock but E2B reports it as a regular error —
 *     we heuristic-check the error name and remap if needed.
 *   - **Plots**. When matplotlib `plt.show()` is called in a Jupyter cell,
 *     E2B returns the PNG as `Result.png` (base64). We keep the base64 in
 *     memory on this class for now; Day 3+ will upload to SF4-whitelisted
 *     S3 and populate `s3Url`.
 *
 * NOT in scope for Day 1.5 (explicit follow-ups):
 *   - S3 upload for plots — Day 3 SF4 wiring.
 *   - matplotlib `plt.savefig()` path capture — Day 1.5 only surfaces
 *     `plt.show()` via Jupyter display_data. `savefig()` writes to
 *     `/home/user/` inside the E2B container; retrieving requires `filesystem.read`.
 *     Current v1 contract uses `plt.show()` which is the Jupyter convention
 *     and matches how Claude/Anthropic agents emit charts.
 *   - LUCA_RUN_CODE_MAX_TIMEOUT_MS env-var — still hardcoded 60s (promote later).
 */
import {
  Sandbox as E2BSandbox,
  type Context as E2BContext,
  type Execution as E2BExecution,
} from "@e2b/code-interpreter";

import { LucaFeatureDisabledError, isLucaEnabled } from "./env";
import logger from "../../logger";
import type {
  PyodideRunner,
  RunCodeInput,
  RunCodeResult,
  RunCodePlotArtifact,
  SandboxKey,
} from "./pyodide-runner";

/**
 * Sandbox lease duration. E2B auto-kills after `timeoutMs` of inactivity.
 * We bump on every run(). 5 minutes balances keep-alive cost vs stale
 * sandbox risk. Hobby plan caps at 60m so this is safely below.
 */
const SANDBOX_TIMEOUT_MS = 5 * 60_000;

/**
 * Factory for the underlying E2B Sandbox. Exposed for tests — tests inject
 * a mock sandbox so unit tests don't hit the real API.
 */
export interface E2BSandboxFactory {
  create(): Promise<E2BSandbox>;
}

const defaultFactory: E2BSandboxFactory = {
  async create() {
    // API key read from E2B_API_KEY env var automatically by the SDK.
    return E2BSandbox.create({ timeoutMs: SANDBOX_TIMEOUT_MS });
  },
};

interface ContextState {
  context: E2BContext;
  /** When true, ctxKey has been used at least once; eviction semantics care. */
  primed: boolean;
}

export class E2BPyodideRunner implements PyodideRunner {
  private sandbox: E2BSandbox | null = null;
  private readonly contexts = new Map<SandboxKey, ContextState>();
  private sandboxInitPromise: Promise<E2BSandbox> | null = null;

  constructor(
    private readonly factory: E2BSandboxFactory = defaultFactory,
    private readonly defaultTimeoutMs: number = 30_000,
    private readonly maxTimeoutMs: number = 60_000,
  ) {}

  private async getSandbox(): Promise<E2BSandbox> {
    if (this.sandbox) {
      // Bump lease — best-effort. If the sandbox died mid-flight, the next
      // runCode will throw and we'll recreate on the attempt after.
      try {
        await this.sandbox.setTimeout(SANDBOX_TIMEOUT_MS);
        return this.sandbox;
      } catch (err) {
        logger.warn(
          { err },
          "[luca.e2bRunner] setTimeout failed, sandbox likely dead; recreating",
        );
        this.sandbox = null;
        this.contexts.clear();
      }
    }

    // Guard against concurrent init stampede.
    if (!this.sandboxInitPromise) {
      this.sandboxInitPromise = this.factory
        .create()
        .then((sb) => {
          this.sandbox = sb;
          logger.info("[luca.e2bRunner] E2B sandbox created");
          return sb;
        })
        .finally(() => {
          this.sandboxInitPromise = null;
        });
    }
    return this.sandboxInitPromise;
  }

  private async getOrCreateContext(
    ctxKey: SandboxKey,
    sandbox: E2BSandbox,
  ): Promise<E2BContext> {
    const existing = this.contexts.get(ctxKey);
    if (existing) return existing.context;

    const context = await sandbox.createCodeContext({ language: "python" });
    this.contexts.set(ctxKey, { context, primed: true });
    return context;
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
    const start = Date.now();

    let execution: E2BExecution;
    try {
      const sandbox = await this.getSandbox();
      const context = await this.getOrCreateContext(input.ctxKey, sandbox);
      execution = await sandbox.runCode(input.code, {
        context,
        timeoutMs,
        // requestTimeoutMs defaults to 30s; allow it to exceed run timeoutMs
        // so the sandbox round-trip itself isn't prematurely aborted.
        requestTimeoutMs: Math.max(30_000, timeoutMs + 5_000),
      });
    } catch (err) {
      // Network / sandbox-creation / setTimeout errors all land here. This
      // is infrastructure failure, NOT user-code failure — mock runner
      // throws in this case too. Tool-handler maps to
      // `run_code_infrastructure_error`.
      throw err;
    }

    const elapsedMs = Date.now() - start;
    const stdout = execution.logs.stdout.join("");
    const stderr = execution.logs.stderr.join("");

    // NOTE: keepGlobals=true means context persists (Jupyter keeps state).
    // keepGlobals=false: Day 1.5 heuristic — we still share the context
    // because Jupyter is stateful by design; callers who want isolation
    // should use distinct ctxKeys. Matches mock semantics where keepGlobals
    // only gates explicit writes but reads don't auto-clear.

    if (execution.error) {
      const errName = execution.error.name;
      const traceback = execution.error.traceback || execution.error.value;

      // Timeout heuristic: E2B surfaces timeout as an error named
      // "TimeoutError" or carrying "timed out" in the value. Normalize.
      if (
        errName === "TimeoutError" ||
        /timed out|execution time exceeded/i.test(execution.error.value ?? "")
      ) {
        return {
          status: "timeout",
          stdout,
          stderr,
          plots: [],
          elapsedMs,
          errorDetail: `run_code_timeout: exceeded ${timeoutMs}ms`,
        };
      }

      // Memory heuristic: MemoryError or OOM-like messages.
      if (
        errName === "MemoryError" ||
        /memoryerror|out of memory|cannot allocate/i.test(
          execution.error.value ?? "",
        )
      ) {
        return {
          status: "memory_exceeded",
          stdout,
          stderr,
          plots: this.extractPlots(execution),
          elapsedMs,
          errorDetail: "run_code_memory_exceeded",
        };
      }

      return {
        status: "error",
        stdout,
        stderr,
        plots: this.extractPlots(execution),
        elapsedMs,
        errorDetail: traceback,
      };
    }

    return {
      status: "ok",
      stdout,
      stderr,
      plots: this.extractPlots(execution),
      elapsedMs,
      errorDetail: null,
    };
  }

  private extractPlots(execution: E2BExecution): RunCodePlotArtifact[] {
    const plots: RunCodePlotArtifact[] = [];
    let idx = 0;
    for (const result of execution.results) {
      if (result.png) {
        // Day 3 SF4 follow-up: upload to LUCA_S3_BUCKET here and populate
        // `s3Url`. For Day 1.5 we emit the logical filename only and keep
        // the base64 available via `result.png` for direct inline preview
        // at the tool-handler layer (tool-handler currently doesn't surface
        // raw base64; will be wired when S3 lands).
        plots.push({
          filename: `plot_${idx++}.png`,
          s3Url: null,
          mimeType: "image/png",
        });
      }
    }
    return plots;
  }

  async evictSandbox(ctxKey: SandboxKey): Promise<void> {
    const existing = this.contexts.get(ctxKey);
    if (!existing) return;
    this.contexts.delete(ctxKey);

    if (this.sandbox) {
      try {
        await this.sandbox.removeCodeContext(existing.context);
      } catch (err) {
        // Eviction is best-effort — dead sandbox or already-removed context
        // is not a fatal error. Log and move on.
        logger.warn(
          { err, ctxKey },
          "[luca.e2bRunner] removeCodeContext failed during eviction",
        );
      }
    }
  }

  hasSandbox(ctxKey: SandboxKey): boolean {
    return this.contexts.has(ctxKey);
  }

  /**
   * Test-only: kill the underlying E2B sandbox, clearing all contexts.
   * Production code never calls this — the sandbox lives until its
   * timeout expires or the process dies.
   */
  async __shutdownForTests(): Promise<void> {
    const sb = this.sandbox;
    this.sandbox = null;
    this.contexts.clear();
    if (sb) {
      try {
        await sb.kill();
      } catch {
        // swallow
      }
    }
  }
}

/**
 * Runtime selector for the pyodide runner backend.
 *
 * Values:
 *   - `"mock"` (default): in-process MockPyodideRunner. Free.
 *   - `"e2b"`: E2BPyodideRunner — requires E2B_API_KEY. Usage-based billing.
 *
 * Also auto-falls-back to `"mock"` when E2B_API_KEY is missing, even if
 * the env requests `"e2b"`. We log a warning but don't crash — this is
 * the same "fail open to safe default" pattern used elsewhere in Luca.
 */
export type PyodideRunnerBackend = "mock" | "e2b";

export function resolvePyodideRunnerBackend(): PyodideRunnerBackend {
  const raw = (process.env.LUCA_PYODIDE_RUNNER ?? "mock").toLowerCase().trim();
  if (raw === "e2b") {
    if (!process.env.E2B_API_KEY) {
      logger.warn(
        "[luca.e2bRunner] LUCA_PYODIDE_RUNNER=e2b but E2B_API_KEY is unset; falling back to mock",
      );
      return "mock";
    }
    return "e2b";
  }
  return "mock";
}

/**
 * Runtime guard used by the factory so tests can inject without requiring
 * a live API key. Callers that need a flag-gated throw (like `runCode`)
 * should use the existing `runCode(runner, input)` wrapper.
 */
export function assertE2BAvailable(): void {
  if (!process.env.E2B_API_KEY) {
    throw new LucaFeatureDisabledError(
      "E2B_API_KEY missing — cannot use E2BPyodideRunner",
    );
  }
}
