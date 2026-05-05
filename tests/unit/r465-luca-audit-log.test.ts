// R465 — luca_audit_log unit tests.
//
// Acceptance criteria:
//   1) stableJsonStringify produces same hash for keys-in-different-order.
//   2) stableJsonStringify is stable across nested objects.
//   3) hashLucaInput is sha256 hex (64 chars) and deterministic.
//   4) hashLucaInput differs for differing inputs.
//   5) hashLucaInput tolerates undefined / null / cyclic refs without throwing.
//   6) inferStatusFromResult flags rate_limited and blocked correctly.
//   7) inferStatusFromResult returns ok for non-error JSON or non-JSON strings.
//   8) recordLucaAudit never throws on DB failure (best-effort).
//   9) recordLucaAudit truncates tool name to 64 chars, errorDetail to 500.
//  10) Audit insert uses positional params (no SQL injection in tool/error).

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock storage.pool BEFORE importing audit-log so the module
//    closes over the mocked pool. Use vi.hoisted so vi.mock factories
//    can reference the spies (vi.mock is hoisted above imports).
const { __poolQuery, __loggerWarn } = vi.hoisted(() => ({
  __poolQuery: vi.fn(),
  __loggerWarn: vi.fn(),
}));
vi.mock("../../server/storage", () => ({
  pool: { query: __poolQuery },
}));
vi.mock("../../server/logger", () => ({
  logger: { warn: __loggerWarn, info: vi.fn(), error: vi.fn() },
  default: { warn: __loggerWarn, info: vi.fn(), error: vi.fn() },
}));

import {
  stableJsonStringify,
  hashLucaInput,
  inferStatusFromResult,
  recordLucaAudit,
} from "../../server/lib/luca-tools/audit-log";

beforeEach(() => {
  __poolQuery.mockReset();
  __loggerWarn.mockReset();
});

describe("R465 — stableJsonStringify", () => {
  it("produces same string for keys in different order", () => {
    expect(stableJsonStringify({ a: 1, b: 2 })).toBe(stableJsonStringify({ b: 2, a: 1 }));
  });
  it("recursively sorts nested object keys", () => {
    const a = stableJsonStringify({ outer: { z: 1, a: 2 }, top: 3 });
    const b = stableJsonStringify({ top: 3, outer: { a: 2, z: 1 } });
    expect(a).toBe(b);
  });
  it("preserves array order (semantically meaningful)", () => {
    const a = stableJsonStringify([1, 2, 3]);
    const b = stableJsonStringify([3, 2, 1]);
    expect(a).not.toBe(b);
  });
  it("handles cyclic references without throwing", () => {
    const obj: any = { a: 1 };
    obj.self = obj;
    expect(() => stableJsonStringify(obj)).not.toThrow();
    expect(stableJsonStringify(obj)).toContain("__cycle__");
  });
  it("collapses non-serializable values to sentinels", () => {
    const s = stableJsonStringify({ fn: () => 1, undef: undefined, big: 10n });
    expect(s).toContain("__function__");
    expect(s).toContain("__undefined__");
    expect(s).toContain("__bigint__:10");
  });
});

describe("R465 — hashLucaInput", () => {
  it("produces sha256 hex (64 lowercase chars)", () => {
    const h = hashLucaInput({ q: "hello" });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
  it("is deterministic across calls", () => {
    expect(hashLucaInput({ q: "hello" })).toBe(hashLucaInput({ q: "hello" }));
  });
  it("differs for different inputs", () => {
    expect(hashLucaInput({ q: "hello" })).not.toBe(hashLucaInput({ q: "world" }));
  });
  it("treats undefined / empty object identically", () => {
    expect(hashLucaInput(undefined)).toBe(hashLucaInput({}));
    expect(hashLucaInput(null)).toBe(hashLucaInput({}));
  });
  it("ignores key order (relies on stableJsonStringify)", () => {
    expect(hashLucaInput({ a: 1, b: 2 })).toBe(hashLucaInput({ b: 2, a: 1 }));
  });
});

describe("R465 — inferStatusFromResult", () => {
  it("returns rate_limited for {error:'rate_limited',...}", () => {
    expect(inferStatusFromResult(JSON.stringify({ error: "rate_limited", retry_after_sec: 60 })))
      .toBe("rate_limited");
  });
  it("returns blocked for {error:'gate_blocked'}", () => {
    expect(inferStatusFromResult(JSON.stringify({ error: "gate_blocked" }))).toBe("blocked");
    expect(inferStatusFromResult(JSON.stringify({ error: "blocked" }))).toBe("blocked");
  });
  it("returns ok for normal JSON results", () => {
    expect(inferStatusFromResult(JSON.stringify({ count: 5, results: [] }))).toBe("ok");
  });
  it("returns ok for non-JSON strings", () => {
    expect(inferStatusFromResult("plain text response")).toBe("ok");
    expect(inferStatusFromResult("")).toBe("ok");
  });
  it("returns ok when error field is unrelated", () => {
    expect(inferStatusFromResult(JSON.stringify({ error: "self_config_failed" }))).toBe("ok");
  });
});

describe("R465 — recordLucaAudit", () => {
  it("inserts a row with positional params (no SQL injection)", async () => {
    __poolQuery.mockResolvedValueOnce({ rowCount: 1 });
    await recordLucaAudit({
      userId: 1,
      agentId: 42,
      tool: "luca_self_config",
      classification: "READ_ONLY",
      status: "ok",
      inputHash: "a".repeat(64),
      latencyMs: 12,
    });
    expect(__poolQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = __poolQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT\s+INTO\s+luca_audit_log/i);
    expect(params).toEqual([
      1,
      42,
      "luca_self_config",
      "READ_ONLY",
      "ok",
      "a".repeat(64),
      12,
      null,
    ]);
  });

  it("never throws on DB failure (best-effort)", async () => {
    __poolQuery.mockRejectedValueOnce(new Error("db down"));
    await expect(
      recordLucaAudit({
        userId: 1,
        agentId: null,
        tool: "luca_recall_self",
        classification: "READ_ONLY",
        status: "error",
        inputHash: "b".repeat(64),
        latencyMs: 5,
        errorDetail: "boom",
      }),
    ).resolves.toBeUndefined();
    expect(__loggerWarn).toHaveBeenCalled();
  });

  it("truncates tool name to 64 chars", async () => {
    __poolQuery.mockResolvedValueOnce({ rowCount: 1 });
    const longTool = "luca_" + "x".repeat(200);
    await recordLucaAudit({
      userId: 1,
      agentId: null,
      tool: longTool,
      classification: "UNKNOWN",
      status: "ok",
      inputHash: "c".repeat(64),
      latencyMs: 1,
    });
    const [, params] = __poolQuery.mock.calls[0];
    expect((params[2] as string).length).toBeLessThanOrEqual(64);
  });

  it("truncates errorDetail to 500 chars", async () => {
    __poolQuery.mockResolvedValueOnce({ rowCount: 1 });
    const longErr = "x".repeat(2000);
    await recordLucaAudit({
      userId: 1,
      agentId: null,
      tool: "luca_self_config",
      classification: "READ_ONLY",
      status: "error",
      inputHash: "d".repeat(64),
      latencyMs: 1,
      errorDetail: longErr,
    });
    const [, params] = __poolQuery.mock.calls[0];
    expect((params[7] as string).length).toBe(500);
  });

  it("preserves null errorDetail when not supplied", async () => {
    __poolQuery.mockResolvedValueOnce({ rowCount: 1 });
    await recordLucaAudit({
      userId: 1,
      agentId: 1,
      tool: "luca_self_config",
      classification: "READ_ONLY",
      status: "ok",
      inputHash: "e".repeat(64),
      latencyMs: 1,
    });
    const [, params] = __poolQuery.mock.calls[0];
    expect(params[7]).toBeNull();
  });

  it("never includes raw input or input fields anywhere in SQL params", async () => {
    __poolQuery.mockResolvedValueOnce({ rowCount: 1 });
    const sensitiveQuery = "БОСС секрет 12345";
    const inputHash = hashLucaInput({ query: sensitiveQuery });
    await recordLucaAudit({
      userId: 1,
      agentId: 1,
      tool: "luca_recall_self",
      classification: "READ_ONLY",
      status: "ok",
      inputHash,
      latencyMs: 1,
    });
    const [, params] = __poolQuery.mock.calls[0];
    const allParamsStr = JSON.stringify(params);
    expect(allParamsStr).not.toContain(sensitiveQuery);
    expect(allParamsStr).not.toContain("12345");
  });

  it("clamps negative latency to 0", async () => {
    __poolQuery.mockResolvedValueOnce({ rowCount: 1 });
    await recordLucaAudit({
      userId: 1,
      agentId: 1,
      tool: "luca_self_config",
      classification: "READ_ONLY",
      status: "ok",
      inputHash: "f".repeat(64),
      latencyMs: -10,
    });
    const [, params] = __poolQuery.mock.calls[0];
    expect(params[6]).toBe(0);
  });
});
