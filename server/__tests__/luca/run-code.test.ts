/**
 * Luca V1a Day 2 — run_code tool unit tests.
 *
 * Covers:
 *   - Three-level flag gate: master/tools/per-tool — any one off → disabled.
 *   - Input validation: code required, code >100KB rejected, timeout/keep_globals types.
 *   - SF3 code_sha: stable for (code, inputs=undefined), changes when code changes,
 *     V1→V2 forward compat (inputs=undefined vs inputs={} produce SAME sha because
 *     JSON.stringify({}) === JSON.stringify(undefined ?? {}) === "{}").
 *   - Timeout cap: caller-supplied 99999 → clamped to RUN_CODE_MAX_TIMEOUT_MS=20_000.
 *   - tool_runs forensic insert: pending row before runner call, terminal row after.
 *   - Runner throw: handler catches, inserts error terminal, returns {status:error}.
 *   - Runner status mapping: ok/error/timeout/memory_exceeded all forwarded.
 *   - Registry: tools listed only when all 3 flags on, dispatch unknown tool throws.
 *   - B1 pinned corpus (per plan Day 2 §B1 test corpus): same ctxKey keepGlobals=true
 *     → globals persist; different ctxKey → NameError; same ctxKey, different session
 *     (different ctxKey string) → NameError.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock `../storage` BEFORE importing anything that pulls `db`.
// We record every insert() value so tests can assert on the forensic log.
const insertedRows: Record<string, unknown>[] = [];

vi.mock("../../storage", () => {
  const values = vi.fn(async (row: Record<string, unknown>) => {
    insertedRows.push(row);
  });
  const insert = vi.fn(() => ({ values }));
  return {
    db: { insert },
    pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
  };
});

import {
  MockPyodideRunner,
  toSandboxKey,
  __setPyodideRunnerForTests,
} from "../../lib/luca/pyodide-runner";
import {
  computeCodeSha,
  parseRunCodeInput,
  runCodeHandler,
  runCodeTool,
  RUN_CODE_DEFAULT_TIMEOUT_MS,
  RUN_CODE_MAX_TIMEOUT_MS,
  type RunCodeContext,
} from "../../lib/luca-tools/run-code";
import {
  __getAllLucaToolSpecsForTests,
  dispatchLucaTool,
  getLucaTools,
} from "../../lib/luca-tools/registry";

function setFlags(overrides: Record<string, string | undefined>) {
  const keys = [
    "LUCA_V1A_ENABLED",
    "LUCA_TOOLS_ENABLED",
    "LUCA_TOOL_RUN_CODE_ENABLED",
  ];
  for (const k of keys) delete process.env[k];
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function allOn() {
  setFlags({
    LUCA_V1A_ENABLED: "true",
    LUCA_TOOLS_ENABLED: "true",
    LUCA_TOOL_RUN_CODE_ENABLED: "true",
  });
}

beforeEach(() => {
  insertedRows.length = 0;
  allOn();
  __setPyodideRunnerForTests(null);
});

afterEach(() => {
  setFlags({});
  __setPyodideRunnerForTests(null);
});

function ctx(overrides: Partial<RunCodeContext> = {}): RunCodeContext {
  return {
    userId: 10,
    agentId: 42,
    meetingId: "00000000-0000-0000-0000-000000000001",
    turnId: "00000000-0000-0000-0000-000000000002",
    ctxKey: toSandboxKey("meeting_abc_turn_1"),
    ...overrides,
  };
}

describe("parseRunCodeInput", () => {
  it("accepts valid input with defaults", () => {
    const r = parseRunCodeInput({ code: "print(1)" });
    expect(r.code).toBe("print(1)");
    expect(r.timeout_ms).toBeUndefined();
    expect(r.keep_globals).toBeUndefined();
  });

  it("accepts timeout_ms and keep_globals", () => {
    const r = parseRunCodeInput({
      code: "x=1",
      timeout_ms: 5000,
      keep_globals: true,
    });
    expect(r.timeout_ms).toBe(5000);
    expect(r.keep_globals).toBe(true);
  });

  it("rejects non-object input", () => {
    expect(() => parseRunCodeInput(null)).toThrow(/invalid_input/);
    expect(() => parseRunCodeInput("print(1)")).toThrow(/invalid_input/);
  });

  it("rejects missing or empty code", () => {
    expect(() => parseRunCodeInput({})).toThrow(/invalid_input.*code/);
    expect(() => parseRunCodeInput({ code: "" })).toThrow(/invalid_input.*code/);
    expect(() => parseRunCodeInput({ code: 42 })).toThrow(/invalid_input.*code/);
  });

  it("rejects code over 100KB", () => {
    const huge = "x".repeat(100_001);
    expect(() => parseRunCodeInput({ code: huge })).toThrow(/100KB/);
  });

  it("rejects invalid timeout_ms", () => {
    expect(() => parseRunCodeInput({ code: "p", timeout_ms: -1 })).toThrow(
      /timeout_ms/,
    );
    expect(() => parseRunCodeInput({ code: "p", timeout_ms: "5s" })).toThrow(
      /timeout_ms/,
    );
  });

  it("rejects non-boolean keep_globals", () => {
    expect(() =>
      parseRunCodeInput({ code: "p", keep_globals: "yes" }),
    ).toThrow(/keep_globals/);
  });
});

describe("computeCodeSha (SF3)", () => {
  it("is stable for same code + undefined inputs", () => {
    const a = computeCodeSha("print(1)");
    const b = computeCodeSha("print(1)");
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it("differs for different code", () => {
    expect(computeCodeSha("print(1)")).not.toBe(computeCodeSha("print(2)"));
  });

  it("undefined inputs === {} for V1→V2 forward compat", () => {
    // JSON.stringify(undefined ?? {}) === "{}"
    // JSON.stringify({}) === "{}"
    // So same code with undefined vs {} inputs must produce same sha
    // (ensures V1 rows match V2 retry-grouping lookups with no inputs).
    expect(computeCodeSha("print(1)", undefined)).toBe(
      computeCodeSha("print(1)", {}),
    );
  });

  it("differs when inputs differ (V2 forward compat)", () => {
    const a = computeCodeSha("print(x)", { file: "a.csv" });
    const b = computeCodeSha("print(x)", { file: "b.csv" });
    expect(a).not.toBe(b);
  });
});

describe("runCodeTool (Anthropic spec)", () => {
  it("has required fields and matches registry flag name", () => {
    expect(runCodeTool.name).toBe("run_code");
    expect(runCodeTool.description.length).toBeGreaterThan(50);
    expect(runCodeTool.input_schema.required).toContain("code");
    expect(Object.keys(runCodeTool.input_schema.properties ?? {})).toEqual(
      expect.arrayContaining(["code", "timeout_ms", "keep_globals"]),
    );
  });

  it("description mentions the tool-layer timeout cap", () => {
    // Bro2 hint: LLM reads the description — cap should be there so it
    // doesn't try to ask for 60_000ms.
    expect(runCodeTool.description).toContain("20s");
  });
});

describe("runCodeHandler — flag gates", () => {
  it("returns disabled when master flag off", async () => {
    setFlags({
      LUCA_V1A_ENABLED: "false",
      LUCA_TOOLS_ENABLED: "true",
      LUCA_TOOL_RUN_CODE_ENABLED: "true",
    });
    const r = await runCodeHandler({ code: "print(1)" }, ctx());
    expect(r.status).toBe("disabled");
    expect(r.error).toContain("luca_feature_disabled");
    // No forensic row when flag-off — tool wasn't supposed to be in registry.
    expect(insertedRows).toEqual([]);
  });

  it("returns disabled when tools-master off", async () => {
    setFlags({
      LUCA_V1A_ENABLED: "true",
      LUCA_TOOLS_ENABLED: "false",
      LUCA_TOOL_RUN_CODE_ENABLED: "true",
    });
    const r = await runCodeHandler({ code: "print(1)" }, ctx());
    expect(r.status).toBe("disabled");
    expect(insertedRows).toEqual([]);
  });

  it("returns disabled when per-tool flag off", async () => {
    setFlags({
      LUCA_V1A_ENABLED: "true",
      LUCA_TOOLS_ENABLED: "true",
      LUCA_TOOL_RUN_CODE_ENABLED: "false",
    });
    const r = await runCodeHandler({ code: "print(1)" }, ctx());
    expect(r.status).toBe("disabled");
    expect(insertedRows).toEqual([]);
  });
});

describe("runCodeHandler — tool_runs forensic insert", () => {
  it("inserts pending row BEFORE runner call + terminal row AFTER", async () => {
    const runner = new MockPyodideRunner();
    runner.register("print(1)", { stdout: "1\n" });
    __setPyodideRunnerForTests(runner);

    const r = await runCodeHandler({ code: "print(1)" }, ctx(), runner);
    expect(r.status).toBe("ok");
    expect(r.stdout).toBe("1\n");

    expect(insertedRows).toHaveLength(2);
    const [pending, terminal] = insertedRows;

    expect(pending.status).toBe("pending");
    expect(pending.tool).toBe("run_code");
    expect(pending.userId).toBe(10);
    expect(pending.agentId).toBe(42);
    expect(pending.ctxKey).toBe("meeting_abc_turn_1");
    expect(pending.output).toBeNull();
    expect(pending.elapsedMs).toBeNull();

    expect(terminal.status).toBe("ok");
    expect(terminal.codeSha).toBe(pending.codeSha); // SF3 shared
    expect(terminal.output).toMatchObject({ stdout: "1\n" });
    expect(terminal.networkAttempted).toBe(false);
  });

  it("inserts error terminal row when runner throws infra error", async () => {
    const runner = new MockPyodideRunner();
    runner.register("broken", { throwMessage: "wasm_load_failed" });
    __setPyodideRunnerForTests(runner);

    const r = await runCodeHandler({ code: "broken" }, ctx(), runner);
    expect(r.status).toBe("error");
    expect(r.error).toContain("run_code_infrastructure_error");
    expect(r.error).toContain("wasm_load_failed");

    expect(insertedRows).toHaveLength(2);
    expect(insertedRows[0].status).toBe("pending");
    expect(insertedRows[1].status).toBe("error");
    expect(insertedRows[1].errorDetail).toContain("wasm_load_failed");
  });

  it("forwards runner status for timeout", async () => {
    const runner = new MockPyodideRunner();
    runner.register("while True: pass", { sleepMs: 999_999 });
    __setPyodideRunnerForTests(runner);

    const r = await runCodeHandler(
      { code: "while True: pass", timeout_ms: 100 },
      ctx(),
      runner,
    );
    expect(r.status).toBe("timeout");
    expect(insertedRows[1].status).toBe("timeout");
  });

  it("forwards runner status for memory_exceeded", async () => {
    const runner = new MockPyodideRunner();
    runner.register("bomb", { memoryExceeded: true });
    __setPyodideRunnerForTests(runner);

    const r = await runCodeHandler({ code: "bomb" }, ctx(), runner);
    expect(r.status).toBe("memory_exceeded");
    expect(insertedRows[1].status).toBe("memory_exceeded");
  });
});

describe("runCodeHandler — timeout cap (plan N1)", () => {
  it("caps caller-requested timeout above RUN_CODE_MAX_TIMEOUT_MS", async () => {
    // sleepMs=19_000 < cap=20_000 → completes normally
    // sleepMs=25_000 > cap=20_000 → timeout at 20_000
    const runner = new MockPyodideRunner();
    runner.register("slow-but-ok", { sleepMs: 19_000 });
    runner.register("too-slow", { sleepMs: 25_000 });
    __setPyodideRunnerForTests(runner);

    // Caller asks for 60_000ms — should be clamped to 20_000ms.
    // sleepMs=25_000 > 20_000 → timeout.
    const r = await runCodeHandler(
      { code: "too-slow", timeout_ms: 60_000 },
      ctx(),
      runner,
    );
    expect(r.status).toBe("timeout");
  });

  it("defaults to RUN_CODE_DEFAULT_TIMEOUT_MS when unspecified", async () => {
    // sleepMs=9_000 > default=8_000 → timeout
    const runner = new MockPyodideRunner();
    runner.register("ten-sec", { sleepMs: 9_000 });
    __setPyodideRunnerForTests(runner);

    const r = await runCodeHandler({ code: "ten-sec" }, ctx(), runner);
    expect(r.status).toBe("timeout");
  });

  it("respects caller-lowered timeout below default", async () => {
    const runner = new MockPyodideRunner();
    runner.register("slow", { sleepMs: 6_000 });
    __setPyodideRunnerForTests(runner);

    // Default is 8_000, caller asks for 5_000, script sleeps 6_000 → timeout
    const r = await runCodeHandler(
      { code: "slow", timeout_ms: 5_000 },
      ctx(),
      runner,
    );
    expect(r.status).toBe("timeout");
  });

  it("exposes constants for caller inspection", () => {
    expect(RUN_CODE_DEFAULT_TIMEOUT_MS).toBe(8_000);
    expect(RUN_CODE_MAX_TIMEOUT_MS).toBe(20_000);
  });
});

describe("runCodeHandler — B1 pinned corpus (plan Day 2)", () => {
  // Pin the exact 3-run scenario from luca_tools_v1_impl_plan.md:
  //
  //   Run 1 (ctx="u10:a101:s1"): x = 1
  //   Run 2 (ctx="u10:a101:s1"): print(x)   → NameError (NOT "1") unless keepGlobals=true
  //   Run 3 (ctx="u10:a101:s2"): print(x)   → NameError (different session)
  //
  // Note: plan wording "NOT '1'" assumes default stateless mode. With
  // keepGlobals=true on Run 1, Run 2 in same ctx SHOULD see x=1. This
  // matches the B1 isolation invariant: globals are per-ctxKey AND only
  // persist when explicitly requested.

  it("stateless by default — Run 2 in same ctx does NOT see Run 1 globals", async () => {
    const runner = new MockPyodideRunner();
    runner.register("x = 1", { writesGlobals: { x: 1 } });
    runner.register("print(x)", { stdout: "1\n", readsGlobals: ["x"] });
    __setPyodideRunnerForTests(runner);

    const sameCtx = ctx({ ctxKey: toSandboxKey("u10_a101_s1") });

    // Run 1: write x=1 WITHOUT keepGlobals → sandbox sees no persistence
    const r1 = await runCodeHandler({ code: "x = 1" }, sameCtx, runner);
    expect(r1.status).toBe("ok");

    // Run 2: print(x) → NameError because Run 1 didn't keepGlobals
    const r2 = await runCodeHandler({ code: "print(x)" }, sameCtx, runner);
    expect(r2.status).toBe("error");
    expect(r2.stderr).toContain("NameError");
  });

  it("keepGlobals=true — Run 2 in same ctx DOES see Run 1 globals", async () => {
    const runner = new MockPyodideRunner();
    runner.register("x = 1", { writesGlobals: { x: 1 } });
    runner.register("print(x)", { stdout: "1\n", readsGlobals: ["x"] });
    __setPyodideRunnerForTests(runner);

    const sameCtx = ctx({ ctxKey: toSandboxKey("u10_a101_s1") });

    await runCodeHandler(
      { code: "x = 1", keep_globals: true },
      sameCtx,
      runner,
    );
    const r2 = await runCodeHandler({ code: "print(x)" }, sameCtx, runner);
    expect(r2.status).toBe("ok");
    expect(r2.stdout).toBe("1\n");
  });

  it("different session (ctx=s2) does NOT see s1 globals (B1 isolation)", async () => {
    const runner = new MockPyodideRunner();
    runner.register("x = 1", { writesGlobals: { x: 1 } });
    runner.register("print(x)", { stdout: "1\n", readsGlobals: ["x"] });
    __setPyodideRunnerForTests(runner);

    const s1 = ctx({ ctxKey: toSandboxKey("u10_a101_s1") });
    const s2 = ctx({ ctxKey: toSandboxKey("u10_a101_s2") });

    // Run 1 in s1 with keepGlobals: writes x=1 into s1's sandbox
    await runCodeHandler(
      { code: "x = 1", keep_globals: true },
      s1,
      runner,
    );
    // Run 3 in s2: different ctxKey → different sandbox → NameError
    const r3 = await runCodeHandler({ code: "print(x)" }, s2, runner);
    expect(r3.status).toBe("error");
    expect(r3.stderr).toContain("NameError");
  });
});

describe("getLucaTools registry", () => {
  it("lists run_code when all 3 flags on", () => {
    allOn();
    const tools = getLucaTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("run_code");
  });

  it("omits run_code when per-tool flag off", () => {
    setFlags({
      LUCA_V1A_ENABLED: "true",
      LUCA_TOOLS_ENABLED: "true",
      LUCA_TOOL_RUN_CODE_ENABLED: "false",
    });
    expect(getLucaTools()).toEqual([]);
  });

  it("omits run_code when tools-master off", () => {
    setFlags({
      LUCA_V1A_ENABLED: "true",
      LUCA_TOOLS_ENABLED: "false",
      LUCA_TOOL_RUN_CODE_ENABLED: "true",
    });
    expect(getLucaTools()).toEqual([]);
  });

  it("omits run_code when master off", () => {
    setFlags({
      LUCA_V1A_ENABLED: "false",
      LUCA_TOOLS_ENABLED: "true",
      LUCA_TOOL_RUN_CODE_ENABLED: "true",
    });
    expect(getLucaTools()).toEqual([]);
  });

  it("__getAllLucaToolSpecsForTests ignores flags", () => {
    setFlags({}); // all off
    const all = __getAllLucaToolSpecsForTests();
    expect(all.map((t) => t.name)).toContain("run_code");
  });
});

describe("dispatchLucaTool", () => {
  it("routes run_code to its handler", async () => {
    const runner = new MockPyodideRunner();
    runner.register("print(1)", { stdout: "1\n" });
    __setPyodideRunnerForTests(runner);

    const r = (await dispatchLucaTool(
      "run_code",
      { code: "print(1)" },
      ctx(),
    )) as { status: string; stdout: string };
    expect(r.status).toBe("ok");
    expect(r.stdout).toBe("1\n");
  });

  it("throws luca_tool_not_found for unknown tool", async () => {
    await expect(
      dispatchLucaTool("mystery_tool", {}, ctx()),
    ).rejects.toThrow(/luca_tool_not_found/);
  });
});
