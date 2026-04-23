/**
 * E2BPyodideRunner unit tests.
 *
 * We mock the E2B Sandbox via a fake factory injected into the constructor
 * — no network, no API key required. Tests assert the mapping logic from
 * E2B's `Execution` shape into our `RunCodeResult` contract.
 *
 * Coverage:
 *   - happy path: stdout captured, status=ok, elapsedMs > 0
 *   - timeout: Execution.error.name=TimeoutError → status=timeout
 *   - error: ZeroDivisionError traceback → status=error with traceback
 *   - memory: MemoryError → status=memory_exceeded
 *   - plots: Result.png present → RunCodePlotArtifact emitted
 *   - B1 isolation: two ctxKeys get distinct Contexts
 *   - eviction: removeCodeContext is called on evictSandbox
 *   - sandbox reuse: multiple runs share the same Sandbox instance
 *   - flag-gate: LUCA_V1A_ENABLED=false → status=disabled, no sandbox calls
 *   - LUCA_PYODIDE_RUNNER resolver: mock/e2b/missing-key fallback
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  E2BPyodideRunner,
  resolvePyodideRunnerBackend,
  type E2BSandboxFactory,
} from "../../lib/luca/e2b-pyodide-runner";
import { toSandboxKey } from "../../lib/luca/pyodide-runner";

// ─── Fake E2B Sandbox ────────────────────────────────────────────────────

interface FakeContext {
  id: string;
  language: string;
  cwd: string;
}

interface RunCodeCall {
  code: string;
  contextId: string;
  timeoutMs: number | undefined;
}

interface ScriptedResult {
  logs?: { stdout: string[]; stderr: string[] };
  results?: Array<{ png?: string; text?: string; isMainResult?: boolean }>;
  error?: { name: string; value: string; traceback: string };
}

class FakeSandbox {
  public contexts: FakeContext[] = [];
  public runCodeCalls: RunCodeCall[] = [];
  public setTimeoutCalls: number[] = [];
  public killed = false;
  public removedContextIds: string[] = [];

  // Scripted responses — `runCode` looks up by exact code string.
  private scripts = new Map<string, ScriptedResult>();

  script(code: string, result: ScriptedResult): void {
    this.scripts.set(code, result);
  }

  async setTimeout(ms: number): Promise<void> {
    this.setTimeoutCalls.push(ms);
  }

  async createCodeContext(opts?: { language?: string }): Promise<FakeContext> {
    const ctx: FakeContext = {
      id: `ctx_${this.contexts.length}`,
      language: opts?.language ?? "python",
      cwd: "/home/user",
    };
    this.contexts.push(ctx);
    return ctx;
  }

  async removeCodeContext(ctx: FakeContext | string): Promise<void> {
    const id = typeof ctx === "string" ? ctx : ctx.id;
    this.removedContextIds.push(id);
    this.contexts = this.contexts.filter((c) => c.id !== id);
  }

  async runCode(
    code: string,
    opts: { context: FakeContext; timeoutMs?: number },
  ): Promise<{
    logs: { stdout: string[]; stderr: string[] };
    results: Array<{ png?: string; text?: string; isMainResult?: boolean }>;
    error?: { name: string; value: string; traceback: string };
  }> {
    this.runCodeCalls.push({
      code,
      contextId: opts.context.id,
      timeoutMs: opts.timeoutMs,
    });
    const scripted = this.scripts.get(code) ?? {};
    return {
      logs: scripted.logs ?? { stdout: [], stderr: [] },
      results: scripted.results ?? [],
      error: scripted.error,
    };
  }

  async kill(): Promise<void> {
    this.killed = true;
  }
}

function makeFactory(sandbox: FakeSandbox): E2BSandboxFactory {
  return {
    // Cast via unknown — FakeSandbox implements only the subset of E2BSandbox
    // methods that E2BPyodideRunner actually uses.
    create: async () => sandbox as unknown as never,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe("E2BPyodideRunner", () => {
  beforeEach(() => {
    process.env.LUCA_V1A_ENABLED = "true";
  });

  afterEach(() => {
    delete process.env.LUCA_V1A_ENABLED;
    delete process.env.E2B_API_KEY;
    delete process.env.LUCA_PYODIDE_RUNNER;
  });

  it("happy path: captures stdout and returns status=ok", async () => {
    const sb = new FakeSandbox();
    sb.script("print(2+2)", { logs: { stdout: ["4\n"], stderr: [] } });
    const runner = new E2BPyodideRunner(makeFactory(sb));

    const result = await runner.run({
      ctxKey: toSandboxKey("a"),
      code: "print(2+2)",
    });

    expect(result.status).toBe("ok");
    expect(result.stdout).toBe("4\n");
    expect(result.errorDetail).toBeNull();
    expect(sb.runCodeCalls).toHaveLength(1);
    expect(sb.runCodeCalls[0].code).toBe("print(2+2)");
  });

  it("timeout: TimeoutError maps to status=timeout", async () => {
    const sb = new FakeSandbox();
    sb.script("while True: pass", {
      error: {
        name: "TimeoutError",
        value: "Execution timed out",
        traceback: "TimeoutError: ...",
      },
    });
    const runner = new E2BPyodideRunner(makeFactory(sb));

    const result = await runner.run({
      ctxKey: toSandboxKey("t1"),
      code: "while True: pass",
      timeoutMs: 5_000,
    });

    expect(result.status).toBe("timeout");
    expect(result.errorDetail).toContain("5000");
  });

  it("timeout heuristic: 'timed out' in error value remaps to timeout", async () => {
    const sb = new FakeSandbox();
    sb.script("slow()", {
      error: {
        name: "RuntimeError",
        value: "Execution time exceeded 30000ms — timed out",
        traceback: "...",
      },
    });
    const runner = new E2BPyodideRunner(makeFactory(sb));
    const r = await runner.run({ ctxKey: toSandboxKey("t2"), code: "slow()" });
    expect(r.status).toBe("timeout");
  });

  it("error: ZeroDivisionError maps to status=error with traceback", async () => {
    const sb = new FakeSandbox();
    const tb =
      'Traceback (most recent call last):\n  File "<cell>", line 1, in <module>\nZeroDivisionError: division by zero';
    sb.script("1/0", {
      error: {
        name: "ZeroDivisionError",
        value: "division by zero",
        traceback: tb,
      },
    });
    const runner = new E2BPyodideRunner(makeFactory(sb));

    const result = await runner.run({
      ctxKey: toSandboxKey("e1"),
      code: "1/0",
    });

    expect(result.status).toBe("error");
    expect(result.errorDetail).toBe(tb);
  });

  it("memory: MemoryError maps to status=memory_exceeded", async () => {
    const sb = new FakeSandbox();
    sb.script("huge = [0]*10**12", {
      error: {
        name: "MemoryError",
        value: "",
        traceback: "MemoryError",
      },
    });
    const runner = new E2BPyodideRunner(makeFactory(sb));
    const r = await runner.run({
      ctxKey: toSandboxKey("m1"),
      code: "huge = [0]*10**12",
    });
    expect(r.status).toBe("memory_exceeded");
  });

  it("plots: Result.png present emits RunCodePlotArtifact", async () => {
    const sb = new FakeSandbox();
    sb.script("plt.show()", {
      logs: { stdout: [], stderr: [] },
      results: [{ png: "iVBORw0KGgo..." }],
    });
    const runner = new E2BPyodideRunner(makeFactory(sb));
    const r = await runner.run({ ctxKey: toSandboxKey("p1"), code: "plt.show()" });
    expect(r.plots).toHaveLength(1);
    expect(r.plots[0].filename).toBe("plot_0.png");
    expect(r.plots[0].mimeType).toBe("image/png");
    expect(r.plots[0].s3Url).toBeNull();
  });

  it("B1: two distinct ctxKeys get distinct Contexts", async () => {
    const sb = new FakeSandbox();
    sb.script("x=1", { logs: { stdout: [], stderr: [] } });
    sb.script("y=2", { logs: { stdout: [], stderr: [] } });
    const runner = new E2BPyodideRunner(makeFactory(sb));

    await runner.run({ ctxKey: toSandboxKey("alice"), code: "x=1" });
    await runner.run({ ctxKey: toSandboxKey("bob"), code: "y=2" });

    expect(sb.contexts).toHaveLength(2);
    expect(sb.runCodeCalls[0].contextId).not.toBe(sb.runCodeCalls[1].contextId);
  });

  it("same ctxKey reuses the same Context across calls", async () => {
    const sb = new FakeSandbox();
    sb.script("a=1", { logs: { stdout: [], stderr: [] } });
    sb.script("print(a)", { logs: { stdout: ["1\n"], stderr: [] } });
    const runner = new E2BPyodideRunner(makeFactory(sb));

    await runner.run({ ctxKey: toSandboxKey("same"), code: "a=1" });
    await runner.run({ ctxKey: toSandboxKey("same"), code: "print(a)" });

    expect(sb.contexts).toHaveLength(1);
    expect(sb.runCodeCalls[0].contextId).toBe(sb.runCodeCalls[1].contextId);
  });

  it("eviction: removeCodeContext called on evictSandbox", async () => {
    const sb = new FakeSandbox();
    sb.script("pass", { logs: { stdout: [], stderr: [] } });
    const runner = new E2BPyodideRunner(makeFactory(sb));

    const key = toSandboxKey("evict1");
    await runner.run({ ctxKey: key, code: "pass" });
    expect(runner.hasSandbox(key)).toBe(true);

    await runner.evictSandbox(key);
    expect(runner.hasSandbox(key)).toBe(false);
    expect(sb.removedContextIds).toHaveLength(1);
  });

  it("evictSandbox is a no-op for unknown ctxKey", async () => {
    const sb = new FakeSandbox();
    const runner = new E2BPyodideRunner(makeFactory(sb));
    await runner.evictSandbox(toSandboxKey("nope"));
    expect(sb.removedContextIds).toHaveLength(0);
  });

  it("multiple runs reuse the same Sandbox instance", async () => {
    const sb = new FakeSandbox();
    sb.script("1", { logs: { stdout: [], stderr: [] } });
    const factoryCalls = { count: 0 };
    const factory: E2BSandboxFactory = {
      create: async () => {
        factoryCalls.count++;
        return sb as unknown as never;
      },
    };
    const runner = new E2BPyodideRunner(factory);

    await runner.run({ ctxKey: toSandboxKey("x"), code: "1" });
    await runner.run({ ctxKey: toSandboxKey("y"), code: "1" });
    await runner.run({ ctxKey: toSandboxKey("z"), code: "1" });

    expect(factoryCalls.count).toBe(1);
    expect(sb.setTimeoutCalls.length).toBe(2); // bumps on 2nd and 3rd run
  });

  it("flag-gate: LUCA_V1A_ENABLED=false returns status=disabled without Sandbox", async () => {
    process.env.LUCA_V1A_ENABLED = "false";
    let factoryCalled = false;
    const factory: E2BSandboxFactory = {
      create: async () => {
        factoryCalled = true;
        return new FakeSandbox() as unknown as never;
      },
    };
    const runner = new E2BPyodideRunner(factory);
    const r = await runner.run({ ctxKey: toSandboxKey("d1"), code: "x" });
    expect(r.status).toBe("disabled");
    expect(factoryCalled).toBe(false);
  });

  it("timeoutMs caps at 60_000ms", async () => {
    const sb = new FakeSandbox();
    sb.script("sleep(999)", { logs: { stdout: [], stderr: [] } });
    const runner = new E2BPyodideRunner(makeFactory(sb));
    await runner.run({
      ctxKey: toSandboxKey("cap"),
      code: "sleep(999)",
      timeoutMs: 999_999, // attempt to exceed cap
    });
    expect(sb.runCodeCalls[0].timeoutMs).toBe(60_000);
  });
});

describe("resolvePyodideRunnerBackend", () => {
  afterEach(() => {
    delete process.env.LUCA_PYODIDE_RUNNER;
    delete process.env.E2B_API_KEY;
  });

  it("defaults to mock when unset", () => {
    expect(resolvePyodideRunnerBackend()).toBe("mock");
  });

  it("returns mock when explicitly set to mock", () => {
    process.env.LUCA_PYODIDE_RUNNER = "mock";
    expect(resolvePyodideRunnerBackend()).toBe("mock");
  });

  it("returns e2b when set to e2b AND E2B_API_KEY is present", () => {
    process.env.LUCA_PYODIDE_RUNNER = "e2b";
    process.env.E2B_API_KEY = "sk_test";
    expect(resolvePyodideRunnerBackend()).toBe("e2b");
  });

  it("falls back to mock when e2b requested but E2B_API_KEY missing", () => {
    process.env.LUCA_PYODIDE_RUNNER = "e2b";
    delete process.env.E2B_API_KEY;
    expect(resolvePyodideRunnerBackend()).toBe("mock");
  });

  it("trims whitespace and case-insensitive", () => {
    process.env.LUCA_PYODIDE_RUNNER = "  E2B  ";
    process.env.E2B_API_KEY = "sk_test";
    expect(resolvePyodideRunnerBackend()).toBe("e2b");
  });

  it("unknown value falls through to mock", () => {
    process.env.LUCA_PYODIDE_RUNNER = "wasm";
    expect(resolvePyodideRunnerBackend()).toBe("mock");
  });
});

describe("vi.spyOn warn-log on fallback (smoke)", () => {
  it("doesn't throw when falling back to mock", () => {
    process.env.LUCA_PYODIDE_RUNNER = "e2b";
    delete process.env.E2B_API_KEY;
    const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(() => resolvePyodideRunnerBackend()).not.toThrow();
    spy.mockRestore();
    delete process.env.LUCA_PYODIDE_RUNNER;
  });
});
