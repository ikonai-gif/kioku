/**
 * [LUCA-086] RLS Phase 1 — withRLS unit tests + migration policy guard.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const mockQuery = vi.fn();
const mockRelease = vi.fn();
const mockConnect = vi.fn();

vi.mock("../../server/storage", () => ({
  pool: { connect: (...a: any[]) => mockConnect(...a) },
}));

import { withRLS } from "../../server/lib/rls";

beforeEach(() => {
  vi.clearAllMocks();
  mockConnect.mockResolvedValue({ query: mockQuery, release: mockRelease });
  mockQuery.mockResolvedValue({ rows: [] });
});

describe("withRLS (LUCA-086)", () => {
  it("BEGIN, set_config(app.user_id), fn, COMMIT — and releases the client", async () => {
    const out = await withRLS(42, async () => "ok");
    expect(out).toBe("ok");
    expect(mockQuery.mock.calls[0][0]).toBe("BEGIN");
    expect(String(mockQuery.mock.calls[1][0])).toContain("set_config");
    expect(String(mockQuery.mock.calls[1][0])).toContain("app.user_id");
    expect(mockQuery.mock.calls[1][1]).toEqual(["42"]);
    expect(mockQuery.mock.calls[2][0]).toBe("COMMIT");
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("passes the live client into fn", async () => {
    await withRLS(7, async (client) => {
      await client.query("SELECT 1");
      return null;
    });
    expect(mockQuery).toHaveBeenCalledWith("SELECT 1");
  });

  it("ROLLBACK + rethrow on fn error — still releases", async () => {
    await expect(
      withRLS(7, async () => { throw new Error("boom"); }),
    ).rejects.toThrow("boom");
    const cmds = mockQuery.mock.calls.map((c) => c[0]);
    expect(cmds).toContain("ROLLBACK");
    expect(cmds).not.toContain("COMMIT");
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid userId without touching the pool", async () => {
    for (const bad of [0, -5, 1.5, NaN]) {
      await expect(withRLS(bad as number, async () => null)).rejects.toThrow(/invalid userId/);
    }
    expect(mockConnect).not.toHaveBeenCalled();
  });
});

describe("migration 0021 policy guard (BRO2 fix #5 to LUCA-086)", () => {
  it("keeps FORCE and the COALESCE/NULLIF legacy-safe policy", () => {
    const m = readFileSync(join(__dirname, "..", "..", "migrations", "0021_rls_phase1.sql"), "utf-8");
    expect(m).toContain("FORCE ROW LEVEL SECURITY");
    expect(m).toContain("COALESCE(current_setting(");
    expect(m).toContain("NULLIF(current_setting(");
    expect(m).toContain(")::int");
  });
});
