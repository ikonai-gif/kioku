/**
 * PyodideRunner — Luca V1a Day 1 contract tests.
 *
 * Path B: tests run against `MockPyodideRunner` only. Real Pyodide lands in
 * Day 1.5 and MUST pass these same behavioral contracts. If you change a
 * test here, the real impl's behavior has to change with it — that's the
 * point of locking semantics in the mock first.
 *
 * Coverage:
 *   - SandboxKey validation (toSandboxKey regex).
 *   - Happy path: register → run → stdout/stderr/plots.
 *   - B1 globals isolation: ctxKey A writes globals, ctxKey B doesn't see them.
 *   - keepGlobals on/off: globals persist across same-ctxKey runs only if true.
 *   - SF2 eviction: evictSandbox wipes plots AND globals for that ctxKey,
 *     while leaving other ctxKeys untouched.
 *   - Status surface: timeout, memory_exceeded, error, throw, disabled.
 *   - Master-flag gate: run() returns "disabled" when LUCA_V1A_ENABLED=false;
 *     runCode() wrapper throws LucaFeatureDisabledError.
 *   - Diagnostics: hasSandbox / liveSandboxKeys.
 *   - Singleton: getPyodideRunner returns same instance;
 *     __setPyodideRunnerForTests clears it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MockPyodideRunner,
  __setPyodideRunnerForTests,
  getPyodideRunner,
  runCode,
  sandboxKeyForTurn,
  toSandboxKey,
  type SandboxKey,
} from "../../lib/luca/pyodide-runner";
import { LucaFeatureDisabledError } from "../../lib/luca/env";

function withEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => T | Promise<T>,
): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(overrides)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return Promise.resolve(fn()).finally(() => {
    for (const k of Object.keys(overrides)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

// Ensure flag is ON for runner-behavior tests; individual disabled-path tests
// override via withEnv.
beforeEach(() => {
  process.env.LUCA_V1A_ENABLED = "true";
});

afterEach(() => {
  delete process.env.LUCA_V1A_ENABLED;
  __setPyodideRunnerForTests(null);
});

describe("toSandboxKey", () => {
  it("accepts alphanumeric + underscore + dash up to 128 chars", () => {
    expect(toSandboxKey("abc")).toBe("abc");
    expect(toSandboxKey("A_b-1")).toBe("A_b-1");
    expect(toSandboxKey("x".repeat(128))).toBe("x".repeat(128));
  });

  it("rejects empty string", () => {
    expect(() => toSandboxKey("")).toThrow(/pyodide\.invalid_ctx_key/);
  });

  it("rejects strings longer than 128 chars", () => {
    expect(() => toSandboxKey("x".repeat(129))).toThrow(
      /pyodide\.invalid_ctx_key/,
    );
  });

  it("rejects disallowed characters (/, ., space, unicode)", () => {
    expect(() => toSandboxKey("a/b")).toThrow(/pyodide\.invalid_ctx_key/);
    expect(() => toSandboxKey("a.b")).toThrow(/pyodide\.invalid_ctx_key/);
    expect(() => toSandboxKey("a b")).toThrow(/pyodide\.invalid_ctx_key/);
    expect(() => toSandboxKey("ключ")).toThrow(/pyodide\.invalid_ctx_key/);
  });

  it("rejects leading dash or underscore (Bro2 N1: rm -rf safety)", () => {
    expect(() => toSandboxKey("-abc")).toThrow(/pyodide\.invalid_ctx_key/);
    expect(() => toSandboxKey("_abc")).toThrow(/pyodide\.invalid_ctx_key/);
    // allowed: dash/underscore AFTER first char
    expect(toSandboxKey("a-b_c")).toBe("a-b_c");
    expect(toSandboxKey("a_")).toBe("a_");
    expect(toSandboxKey("a-")).toBe("a-");
  });
});

describe("sandboxKeyForTurn", () => {
  it("produces a valid SandboxKey from UUID meeting+turn ids", () => {
    const meetingId = "12345678-1234-1234-1234-123456789abc";
    const turnId = "abcdef01-abcd-abcd-abcd-abcdef012345";
    const key = sandboxKeyForTurn(meetingId, turnId);
    expect(key).toBe("m_12345678123412341234123456789abc_t_abcdef01abcdabcdabcdabcdef012345");
    // Re-run through toSandboxKey must succeed (proves regex compliance).
    expect(() => toSandboxKey(key)).not.toThrow();
    // Total length 2 + 32 + 3 + 32 = 69, under the 128 cap.
    expect(key.length).toBe(69);
  });

  it("strips dashes from both ids deterministically", () => {
    const k1 = sandboxKeyForTurn("aa-bb", "cc-dd");
    const k2 = sandboxKeyForTurn("aabb", "ccdd");
    expect(k1).toBe(k2);
    expect(k1).toBe("m_aabb_t_ccdd");
  });

  it("rejects ids whose dash-stripped form violates regex", () => {
    // Space in meetingId leaks through (we only strip dashes)
    expect(() => sandboxKeyForTurn("bad id", "t1")).toThrow(/invalid_ctx_key/);
  });
});

describe("MockPyodideRunner.run — happy path", () => {
  it("returns ok with registered stdout/stderr and no plots", async () => {
    const runner = new MockPyodideRunner();
    runner.register("print(1+1)", { stdout: "2\n" });
    const r = await runner.run({
      ctxKey: toSandboxKey("a"),
      code: "print(1+1)",
    });
    expect(r.status).toBe("ok");
    expect(r.stdout).toBe("2\n");
    expect(r.stderr).toBe("");
    expect(r.plots).toEqual([]);
    expect(r.errorDetail).toBeNull();
  });

  it("returns ok with empty output for unregistered code (no-op)", async () => {
    const runner = new MockPyodideRunner();
    const r = await runner.run({
      ctxKey: toSandboxKey("a"),
      code: "whatever = 42",
    });
    expect(r.status).toBe("ok");
    expect(r.stdout).toBe("");
    expect(r.plots).toEqual([]);
  });

  it("returns plot artifacts with null s3Url on Day 1", async () => {
    const runner = new MockPyodideRunner();
    runner.register("plt.savefig('x.png')", {
      plots: ["x.png", "y.png"],
    });
    const r = await runner.run({
      ctxKey: toSandboxKey("a"),
      code: "plt.savefig('x.png')",
    });
    expect(r.status).toBe("ok");
    expect(r.plots).toHaveLength(2);
    expect(r.plots[0]).toEqual({
      filename: "x.png",
      s3Url: null,
      mimeType: "image/png",
    });
    expect(r.plots[1].filename).toBe("y.png");
  });
});

describe("MockPyodideRunner — B1 globals isolation", () => {
  it("globals written under ctxKey A are NOT visible under ctxKey B", async () => {
    const runner = new MockPyodideRunner();
    runner.register("x = 1", {
      writesGlobals: { x: 1 },
    });
    runner.register("print(x)", {
      stdout: "1\n",
      readsGlobals: ["x"],
    });

    const a = toSandboxKey("a");
    const b = toSandboxKey("b");

    // A writes x with keepGlobals.
    const w = await runner.run({ ctxKey: a, code: "x = 1", keepGlobals: true });
    expect(w.status).toBe("ok");

    // A can read it back.
    const rA = await runner.run({ ctxKey: a, code: "print(x)" });
    expect(rA.status).toBe("ok");
    expect(rA.stdout).toBe("1\n");

    // B cannot — globals are per-ctxKey.
    const rB = await runner.run({ ctxKey: b, code: "print(x)" });
    expect(rB.status).toBe("error");
    expect(rB.stderr).toContain("NameError");
    expect(rB.errorDetail).toContain("NameError");
  });

  it("keepGlobals=false does NOT persist writes to the sandbox", async () => {
    const runner = new MockPyodideRunner();
    runner.register("x = 1", { writesGlobals: { x: 1 } });
    runner.register("print(x)", { stdout: "1\n", readsGlobals: ["x"] });

    const a = toSandboxKey("a");
    // Default keepGlobals is undefined/false.
    await runner.run({ ctxKey: a, code: "x = 1" });

    const r = await runner.run({ ctxKey: a, code: "print(x)" });
    expect(r.status).toBe("error");
    expect(r.stderr).toContain("NameError");
  });
});

describe("MockPyodideRunner.evictSandbox — SF2", () => {
  it("wipes plots and globals for evicted ctxKey only", async () => {
    const runner = new MockPyodideRunner();
    runner.register("x = 1", { writesGlobals: { x: 1 } });
    runner.register("plot()", { plots: ["p.png"] });

    const a = toSandboxKey("a");
    const b = toSandboxKey("b");
    await runner.run({ ctxKey: a, code: "x = 1", keepGlobals: true });
    await runner.run({ ctxKey: a, code: "plot()" });
    await runner.run({ ctxKey: b, code: "x = 1", keepGlobals: true });

    expect(runner.hasSandbox(a)).toBe(true);
    expect(runner.hasSandbox(b)).toBe(true);

    await runner.evictSandbox(a);

    expect(runner.hasSandbox(a)).toBe(false);
    expect(runner.hasSandbox(b)).toBe(true);
    expect(runner.liveSandboxKeys()).toEqual([b]);
  });

  it("evicting a non-existent sandbox is a no-op", async () => {
    const runner = new MockPyodideRunner();
    await expect(
      runner.evictSandbox(toSandboxKey("never-existed")),
    ).resolves.toBeUndefined();
  });
});

describe("MockPyodideRunner — status surface", () => {
  it("returns timeout when sleepMs exceeds timeoutMs", async () => {
    const runner = new MockPyodideRunner();
    runner.register("while True: pass", { sleepMs: 999_999 });
    const r = await runner.run({
      ctxKey: toSandboxKey("a"),
      code: "while True: pass",
      timeoutMs: 100,
    });
    expect(r.status).toBe("timeout");
    expect(r.elapsedMs).toBe(100);
    expect(r.errorDetail).toContain("run_code_timeout");
  });

  it("caps timeoutMs at maxTimeoutMs (60s)", async () => {
    const runner = new MockPyodideRunner();
    runner.register("sleep", { sleepMs: 70_000 });
    const r = await runner.run({
      ctxKey: toSandboxKey("a"),
      code: "sleep",
      timeoutMs: 999_999, // caller asks for huge timeout — should cap
    });
    // With sleepMs=70_000 and capped timeout=60_000, sleep > timeout → timeout.
    expect(r.status).toBe("timeout");
    expect(r.elapsedMs).toBe(60_000);
  });

  it("returns memory_exceeded for scripts flagged as over-cap", async () => {
    const runner = new MockPyodideRunner();
    runner.register("bomb", { memoryExceeded: true });
    const r = await runner.run({
      ctxKey: toSandboxKey("a"),
      code: "bomb",
    });
    expect(r.status).toBe("memory_exceeded");
    expect(r.errorDetail).toContain("run_code_memory_exceeded");
  });

  it("returns error with traceback for script with status=error", async () => {
    const runner = new MockPyodideRunner();
    runner.register("1/0", {
      status: "error",
      stderr: "ZeroDivisionError: division by zero",
    });
    const r = await runner.run({
      ctxKey: toSandboxKey("a"),
      code: "1/0",
    });
    expect(r.status).toBe("error");
    expect(r.stderr).toContain("ZeroDivisionError");
    expect(r.errorDetail).toContain("ZeroDivisionError");
  });

  it("propagates infra throws (throwMessage) — caller maps to infrastructure_error", async () => {
    const runner = new MockPyodideRunner();
    runner.register("broken-wasm", { throwMessage: "wasm_load_failed" });
    await expect(
      runner.run({ ctxKey: toSandboxKey("a"), code: "broken-wasm" }),
    ).rejects.toThrow("wasm_load_failed");
  });
});

describe("MockPyodideRunner — master flag gate", () => {
  it("run() returns disabled when LUCA_V1A_ENABLED=false", async () => {
    await withEnv({ LUCA_V1A_ENABLED: "false" }, async () => {
      const runner = new MockPyodideRunner();
      runner.register("print(1)", { stdout: "1\n" });
      const r = await runner.run({
        ctxKey: toSandboxKey("a"),
        code: "print(1)",
      });
      expect(r.status).toBe("disabled");
      expect(r.stdout).toBe("");
      expect(r.errorDetail).toContain("luca_feature_disabled");
    });
  });

  it("runCode() throws LucaFeatureDisabledError when flag is off", async () => {
    await withEnv({ LUCA_V1A_ENABLED: undefined }, async () => {
      const runner = new MockPyodideRunner();
      runner.register("print(1)", { stdout: "1\n" });
      await expect(
        runCode(runner, { ctxKey: toSandboxKey("a"), code: "print(1)" }),
      ).rejects.toBeInstanceOf(LucaFeatureDisabledError);
    });
  });

  it("runCode() forwards to runner.run when flag is on", async () => {
    const runner = new MockPyodideRunner();
    runner.register("print(1)", { stdout: "1\n" });
    const r = await runCode(runner, {
      ctxKey: toSandboxKey("a"),
      code: "print(1)",
    });
    expect(r.status).toBe("ok");
    expect(r.stdout).toBe("1\n");
  });
});

describe("MockPyodideRunner — diagnostics", () => {
  it("hasSandbox returns false for ctxKey with no globals and no plots", async () => {
    const runner = new MockPyodideRunner();
    const a = toSandboxKey("a");
    // Run something that doesn't write globals or plots.
    runner.register("print(1)", { stdout: "1\n" });
    await runner.run({ ctxKey: a, code: "print(1)" });
    // Sandbox is created lazily but remains empty — hasSandbox should be false.
    expect(runner.hasSandbox(a)).toBe(false);
  });

  it("hasSandbox returns true once a plot is recorded", async () => {
    const runner = new MockPyodideRunner();
    runner.register("plot()", { plots: ["p.png"] });
    const a = toSandboxKey("a");
    await runner.run({ ctxKey: a, code: "plot()" });
    expect(runner.hasSandbox(a)).toBe(true);
  });

  it("liveSandboxKeys lists every ctxKey with a sandbox entry", async () => {
    const runner = new MockPyodideRunner();
    runner.register("plot()", { plots: ["p.png"] });
    const a = toSandboxKey("a");
    const b = toSandboxKey("b");
    await runner.run({ ctxKey: a, code: "plot()" });
    await runner.run({ ctxKey: b, code: "plot()" });
    const live: SandboxKey[] = runner.liveSandboxKeys();
    expect(live.sort()).toEqual([a, b].sort());
  });
});

describe("getPyodideRunner factory", () => {
  it("returns the same singleton across calls", () => {
    const a = getPyodideRunner();
    const b = getPyodideRunner();
    expect(a).toBe(b);
  });

  it("__setPyodideRunnerForTests(null) resets singleton", () => {
    const a = getPyodideRunner();
    __setPyodideRunnerForTests(null);
    const b = getPyodideRunner();
    expect(a).not.toBe(b);
  });

  it("__setPyodideRunnerForTests replaces singleton with a supplied instance", () => {
    const custom = new MockPyodideRunner();
    __setPyodideRunnerForTests(custom);
    expect(getPyodideRunner()).toBe(custom);
  });
});
