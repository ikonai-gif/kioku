/**
 * Phase 5 (R-luca-computer-ui) — pinned artifacts storage helpers.
 *
 * Covers:
 *   1. pinArtifact happy path returns inserted row
 *   2. pinArtifact existing pin → idempotent (returns existing, no INSERT)
 *   3. pinArtifact validates type enum
 *   4. pinArtifact validates refId length
 *   5. pinArtifact hard-limit triggers PinnedArtifactLimitError at 100
 *   6. pinArtifact insert race (ON CONFLICT path) re-reads row
 *   7. unpinArtifact returns true on delete
 *   8. unpinArtifact returns false on miss / wrong user
 *   9. listPinnedArtifacts orders by created_at DESC, id DESC
 *
 * No real DB — pg/drizzle mocked at module level.
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

import {
  pinArtifact,
  unpinArtifact,
  listPinnedArtifacts,
  PinnedArtifactLimitError,
  PINNED_ARTIFACTS_HARD_LIMIT,
} from "../../storage";

beforeEach(() => {
  queryMock.mockReset();
});

describe("pinArtifact", () => {
  it("happy path inserts new row", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // existing check
      .mockResolvedValueOnce({ rows: [{ n: 0 }] }) // count
      .mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            room_id: 10,
            user_id: 5,
            type: "screenshot",
            ref_id: "k",
            label: "L",
            created_at: 1700000000,
          },
        ],
      });
    const r = await pinArtifact({
      roomId: 10,
      userId: 5,
      type: "screenshot",
      refId: "k",
      label: "L",
    });
    expect(r.id).toBe(1);
    expect(r.type).toBe("screenshot");
    expect(r.label).toBe("L");
    // Verify INSERT used ON CONFLICT DO NOTHING
    const insertCall = queryMock.mock.calls[2]?.[0] ?? "";
    expect(/ON\s+CONFLICT\s*\(\s*room_id\s*,\s*type\s*,\s*ref_id\s*\)\s*DO\s+NOTHING/i.test(String(insertCall))).toBe(true);
  });

  it("idempotent — existing pin returns same row, no INSERT", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          id: 99,
          room_id: 10,
          user_id: 5,
          type: "file",
          ref_id: "k",
          label: null,
          created_at: 1,
        },
      ],
    });
    const r = await pinArtifact({
      roomId: 10,
      userId: 5,
      type: "file",
      refId: "k",
    });
    expect(r.id).toBe(99);
    expect(queryMock).toHaveBeenCalledTimes(1); // existing-check only
  });

  it("rejects invalid type", async () => {
    await expect(
      pinArtifact({ roomId: 1, userId: 1, type: "bogus" as any, refId: "x" }),
    ).rejects.toThrow(/invalid pinned artifact type/);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("rejects empty refId", async () => {
    await expect(
      pinArtifact({ roomId: 1, userId: 1, type: "file", refId: "" }),
    ).rejects.toThrow(/invalid refId/);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("rejects refId > 256 chars", async () => {
    await expect(
      pinArtifact({ roomId: 1, userId: 1, type: "file", refId: "x".repeat(257) }),
    ).rejects.toThrow(/invalid refId/);
  });

  it("hard-limit at PINNED_ARTIFACTS_HARD_LIMIT throws PinnedArtifactLimitError", async () => {
    expect(PINNED_ARTIFACTS_HARD_LIMIT).toBe(100);
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // not existing
      .mockResolvedValueOnce({ rows: [{ n: 100 }] }); // count at limit
    try {
      await pinArtifact({
        roomId: 10,
        userId: 5,
        type: "file",
        refId: "new",
      });
      expect.fail("should have thrown");
    } catch (e: any) {
      expect(e).toBeInstanceOf(PinnedArtifactLimitError);
      expect(e.status).toBe(409);
      expect(e.code).toBe("PINNED_ARTIFACT_LIMIT");
    }
  });

  it("INSERT race (ON CONFLICT) re-reads row", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // existing
      .mockResolvedValueOnce({ rows: [{ n: 5 }] }) // count
      .mockResolvedValueOnce({ rows: [] }) // INSERT returned no rows (conflict)
      .mockResolvedValueOnce({
        rows: [{ id: 7, room_id: 10, user_id: 5, type: "file", ref_id: "x", label: null, created_at: 9 }],
      });
    const r = await pinArtifact({ roomId: 10, userId: 5, type: "file", refId: "x" });
    expect(r.id).toBe(7);
  });
});

describe("unpinArtifact", () => {
  it("returns true on delete", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 1 }] });
    const r = await unpinArtifact(1, 10);
    expect(r).toBe(true);
    // Verify user_id check in WHERE
    const sql = String(queryMock.mock.calls[0]?.[0] ?? "");
    expect(sql).toMatch(/WHERE\s+id\s*=\s*\$1\s+AND\s+user_id\s*=\s*\$2/i);
  });

  it("returns false on miss / not-owner", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const r = await unpinArtifact(1, 99);
    expect(r).toBe(false);
  });
});

describe("listPinnedArtifacts", () => {
  it("returns parsed rows", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { id: 2, room_id: 10, user_id: 5, type: "screenshot", ref_id: "b", label: "B", created_at: 200 },
        { id: 1, room_id: 10, user_id: 5, type: "file", ref_id: "a", label: null, created_at: 100 },
      ],
    });
    const items = await listPinnedArtifacts(10);
    expect(items).toHaveLength(2);
    expect(items[0].id).toBe(2);
    expect(items[1].label).toBe(null);
  });

  it("orders by created_at DESC, id DESC", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await listPinnedArtifacts(10);
    const sql = String(queryMock.mock.calls[0]?.[0] ?? "");
    expect(sql).toMatch(/ORDER\s+BY\s+created_at\s+DESC\s*,\s*id\s+DESC/i);
  });
});
