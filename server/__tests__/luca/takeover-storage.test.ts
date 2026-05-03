/**
 * Phase 5 PR-B (R-luca-computer-ui) — appendTakeoverLog / getTakeoverLog.
 *
 * BRO1 R438 MUST-FIX-B1 verification:
 *   1. appendTakeoverLog uses atomic SQL JSONB concat (no read-modify-write)
 *   2. write target is `takeover_log`, NOT `media_urls`
 *   3. getTakeoverLog returns parsed array on hit
 *   4. getTakeoverLog returns [] on miss / no row
 *   5. ts ordering preserved across multiple appends
 *   6. silently no-ops on empty stepId
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("pg", () => {
  function MockPool(this: any) {
    this.query = queryMock;
    this.on = vi.fn();
    this.end = vi.fn().mockResolvedValue(undefined);
    this.connect = vi.fn();
  }
  return { Pool: MockPool };
});
vi.mock("drizzle-orm/node-postgres", () => ({ drizzle: vi.fn(() => ({})) }));
vi.mock("drizzle-orm", async (orig) => {
  const real = await (orig() as Promise<any>);
  return { ...real, eq: (a: any, b: any) => ({ a, b }) };
});
vi.mock("../../logger", () => ({
  default: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { appendTakeoverLog, getTakeoverLog } from "../../storage";

beforeEach(() => {
  queryMock.mockReset();
});

describe("appendTakeoverLog", () => {
  it("issues atomic JSONB concat against takeover_log column (NOT media_urls)", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await appendTakeoverLog("step-1", { ts: 1700, userId: 5, mode: "interactive" });
    expect(queryMock).toHaveBeenCalledTimes(1);
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toMatch(/UPDATE\s+tool_activity_log/i);
    expect(sql).toMatch(/SET\s+takeover_log\s*=/);
    expect(sql).not.toMatch(/media_urls/);
    expect(sql).toMatch(/jsonb_build_array/);
    expect(sql).toMatch(/COALESCE\s*\(\s*takeover_log/);
    expect(sql).toMatch(/WHERE\s+step_id\s*=\s*\$1/);
  });

  it("passes ts/userId/mode payload through JSON.stringify in $2", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await appendTakeoverLog("step-2", { ts: 9999, userId: 7, mode: "released" });
    const params = queryMock.mock.calls[0][1] as unknown[];
    expect(params[0]).toBe("step-2");
    expect(typeof params[1]).toBe("string");
    const parsed = JSON.parse(String(params[1]));
    expect(parsed).toEqual({ ts: 9999, userId: 7, mode: "released" });
  });

  it("no-ops on empty stepId — never queries DB", async () => {
    await appendTakeoverLog("", { ts: 1, userId: 1, mode: "interactive" });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("swallows DB errors (best-effort audit)", async () => {
    queryMock.mockRejectedValueOnce(new Error("boom"));
    await expect(
      appendTakeoverLog("step-x", { ts: 1, userId: 1, mode: "interactive" })
    ).resolves.toBeUndefined();
  });
});

describe("getTakeoverLog", () => {
  it("returns parsed array when DB row contains JSONB array", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          takeover_log: [
            { ts: 1, userId: 5, mode: "interactive" },
            { ts: 2, userId: 5, mode: "released" },
          ],
        },
      ],
    });
    const log = await getTakeoverLog("step-1");
    expect(log.length).toBe(2);
    expect(log[0].mode).toBe("interactive");
    expect(log[1].mode).toBe("released");
    // ts ordering preserved
    expect(log[0].ts).toBeLessThan(log[1].ts);
  });

  it("parses string-encoded JSONB (older driver path)", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ takeover_log: '[{"ts":1,"userId":5,"mode":"interactive"}]' }],
    });
    const log = await getTakeoverLog("step-1");
    expect(log).toEqual([{ ts: 1, userId: 5, mode: "interactive" }]);
  });

  it("returns [] when row missing", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const log = await getTakeoverLog("step-1");
    expect(log).toEqual([]);
  });

  it("returns [] on empty stepId without querying", async () => {
    const log = await getTakeoverLog("");
    expect(log).toEqual([]);
    expect(queryMock).not.toHaveBeenCalled();
  });
});
