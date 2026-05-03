/**
 * Phase 1 — Activity timeline storage helper.
 *
 * Verifies getToolActivityForRoom:
 *   - filters by room_id
 *   - applies sinceMs filter (created_at > sinceMs)
 *   - caps limit between 1 and 500 (default 200)
 *   - returns rows in chronological (oldest-first) order
 *   - maps numeric BIGINTs to JS numbers
 *   - returns [] on DB error (does not throw)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("pg", () => {
  function MockPool(this: any) {
    this.query = vi.fn();
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
vi.mock("./logger", () => ({
  default: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { pool, getToolActivityForRoom } from "../storage";

beforeEach(() => {
  (pool as any).query = vi.fn();
});

const sampleRow = (overrides: Partial<Record<string, any>> = {}) => ({
  id: 1,
  step_id: "step-a",
  room_id: 99,
  message_id: null,
  user_id: 10,
  agent_id: 16,
  tool: "browse_website",
  status: "done",
  description: "open ikonbai.com",
  preview: "IKONBAI",
  started_at: 1_700_000_000_000,
  finished_at: 1_700_000_001_000,
  elapsed_ms: 1000,
  created_at: 1_700_000_000_500,
  ...overrides,
});

describe("getToolActivityForRoom", () => {
  it("queries with room_id, sinceMs and limit and returns mapped rows", async () => {
    (pool as any).query.mockResolvedValueOnce({
      rows: [
        sampleRow({ id: 3, created_at: 1_700_000_003_000 }),
        sampleRow({ id: 2, created_at: 1_700_000_002_000 }),
      ],
    });
    const out = await getToolActivityForRoom(99, { sinceMs: 1_700_000_000_000, limit: 50 });
    const call = (pool as any).query.mock.calls[0];
    expect(call[1]).toEqual([99, 1_700_000_000_000, 50]);
    // chronological order (reversed from DESC)
    expect(out.map((r) => r.id)).toEqual([2, 3]);
    expect(out[0].roomId).toBe(99);
    expect(out[0].tool).toBe("browse_website");
    expect(typeof out[0].startedAt).toBe("number");
  });

  it("defaults sinceMs=0 and limit=200 when not provided", async () => {
    (pool as any).query.mockResolvedValueOnce({ rows: [] });
    await getToolActivityForRoom(7);
    const call = (pool as any).query.mock.calls[0];
    expect(call[1]).toEqual([7, 0, 200]);
  });

  it("clamps limit to <= 500", async () => {
    (pool as any).query.mockResolvedValueOnce({ rows: [] });
    await getToolActivityForRoom(7, { limit: 99999 });
    expect((pool as any).query.mock.calls[0][1][2]).toBe(500);
  });

  it("clamps limit to >= 1", async () => {
    (pool as any).query.mockResolvedValueOnce({ rows: [] });
    await getToolActivityForRoom(7, { limit: -5 });
    // limit fallback: Math.max(NaN-or-neg, 1) — we accept >= 1
    expect((pool as any).query.mock.calls[0][1][2]).toBeGreaterThanOrEqual(1);
  });

  it("returns [] when DB query throws (does not bubble)", async () => {
    (pool as any).query.mockRejectedValueOnce(new Error("boom"));
    const out = await getToolActivityForRoom(7);
    expect(out).toEqual([]);
  });

  it("converts BIGINT-string created_at into number", async () => {
    (pool as any).query.mockResolvedValueOnce({
      rows: [sampleRow({ created_at: "1700000000999", started_at: "1700000000000" })],
    });
    const [row] = await getToolActivityForRoom(7);
    expect(row.createdAt).toBe(1_700_000_000_999);
    expect(row.startedAt).toBe(1_700_000_000_000);
  });
});
