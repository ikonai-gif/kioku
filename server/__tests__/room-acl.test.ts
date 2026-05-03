/**
 * Phase 5 (R-luca-computer-ui) — room ACL helper.
 *
 * BRO1 R438 NICE: explicit test that assertRoomOwnership uses LIMIT 1 (not a
 * full scan). Tests cover:
 *   1. assertRoomOwnership returns { id, userId } on owned room
 *   2. throws RoomNotFoundError on missing/other-user room
 *   3. throws RoomNotFoundError on non-finite ids (early-exit)
 *   4. SQL uses LIMIT 1 (read query passed to pool.query)
 *   5. assertRoomOwnershipWithFields returns extra columns
 *   6. assertRoomOwnershipWithFields rejects unknown field name
 *
 * Pattern mirrors agent-browser-live-frame.test.ts — pg + drizzle stubbed via
 * vi.mock so no real DB.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── pg / drizzle mocks ───────────────────────────────────────────────────
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

import {
  assertRoomOwnership,
  assertRoomOwnershipWithFields,
  RoomNotFoundError,
} from "../lib/room-acl";

beforeEach(() => {
  queryMock.mockReset();
});

describe("assertRoomOwnership", () => {
  it("returns { id, userId } for an owned room", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ id: "42", user_id: "10" }],
    });
    const r = await assertRoomOwnership(42, 10);
    expect(r).toEqual({ id: 42, userId: 10 });
  });

  it("throws RoomNotFoundError on missing/other-user room", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await expect(assertRoomOwnership(999, 10)).rejects.toBeInstanceOf(
      RoomNotFoundError,
    );
  });

  it("throws RoomNotFoundError without hitting DB on non-finite ids", async () => {
    await expect(assertRoomOwnership(Number.NaN, 10)).rejects.toBeInstanceOf(
      RoomNotFoundError,
    );
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("uses LIMIT 1 in the SELECT (no full scan)", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 1, user_id: 1 }] });
    await assertRoomOwnership(1, 1);
    const sql = String(queryMock.mock.calls[0]?.[0] ?? "");
    expect(/LIMIT\s+1/i.test(sql)).toBe(true);
    // Bound params passed correctly
    expect(queryMock.mock.calls[0]?.[1]).toEqual([1, 1]);
  });

  it("RoomNotFoundError carries roomId, userId, code, status", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    try {
      await assertRoomOwnership(7, 3);
      expect.fail("should have thrown");
    } catch (e: any) {
      expect(e).toBeInstanceOf(RoomNotFoundError);
      expect(e.code).toBe("ROOM_NOT_FOUND");
      expect(e.status).toBe(404);
      expect(e.roomId).toBe(7);
      expect(e.userId).toBe(3);
    }
  });
});

describe("assertRoomOwnershipWithFields", () => {
  it("returns extra columns on success", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { id: 5, user_id: 8, agent_ids: "[1,2]", name: "Test" },
      ],
    });
    const r = await assertRoomOwnershipWithFields(5, 8, ["agentIds", "name"]);
    expect(r.id).toBe(5);
    expect(r.userId).toBe(8);
    expect(r.agentIds).toBe("[1,2]");
    expect(r.name).toBe("Test");
  });

  it("rejects unknown field at runtime", async () => {
    await expect(
      assertRoomOwnershipWithFields(1, 1, ["totallyMadeUp" as any]),
    ).rejects.toThrow(/unknown field/);
  });

  it("throws RoomNotFoundError on miss", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await expect(
      assertRoomOwnershipWithFields(99, 99, ["name"]),
    ).rejects.toBeInstanceOf(RoomNotFoundError);
  });

  it("includes id, user_id and selected fields in SELECT cols", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 1, user_id: 1, name: "x" }] });
    await assertRoomOwnershipWithFields(1, 1, ["name"]);
    const sql = String(queryMock.mock.calls[0]?.[0] ?? "");
    expect(sql).toMatch(/SELECT\s+id,\s*user_id,\s*name/i);
    expect(/LIMIT\s+1/i.test(sql)).toBe(true);
  });
});
