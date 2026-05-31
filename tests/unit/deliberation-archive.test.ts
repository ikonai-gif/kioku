/**
 * [BRO2-318c] PR-1 — Deliberation archive/retention.
 * Unit tests for the storage-layer SQL contracts (no real DB; pg Pool mocked).
 * Verifies: visibility rule (running + latest 5, not archived), rn>5 auto-archive,
 * manual archive guard (finished only), restore, and archived listing.
 * Deletion is PR-2 and is intentionally NOT covered here.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock the pg Pool so storage uses a fake query() we can inspect ──
const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
vi.mock("pg", () => ({
  Pool: class FakePool {
    query = query;
    on() {}
    connect() {}
    end() {}
  },
}));
// Heavy import-time deps that we don't exercise here
vi.mock("../../server/embeddings", () => ({ embedText: vi.fn() }));
vi.mock("../../server/emotion-scorer", () => ({ scoreEmotion: vi.fn() }));

const { storage } = await import("../../server/storage");

const lastSql = () => String(query.mock.calls.at(-1)?.[0] ?? "");
const lastParams = () => query.mock.calls.at(-1)?.[1] as any[];

beforeEach(() => {
  query.mockClear();
  query.mockResolvedValue({ rows: [], rowCount: 1 });
});

describe("deliberation archive — storage SQL contracts", () => {
  it("getVisibleDeliberationsByRoom shows running + latest 5, excludes archived", async () => {
    await storage.getVisibleDeliberationsByRoom(10);
    const sql = lastSql();
    expect(sql).toContain("status = 'running'");
    expect(sql).toContain("rn <= $2");
    expect(sql).toContain("archived_at IS NULL");
    expect(lastParams()).toEqual([10, 5]);
  });

  it("getArchivedDeliberationsByRoom returns archived, newest first", async () => {
    await storage.getArchivedDeliberationsByRoom(10);
    const sql = lastSql();
    expect(sql).toContain("archived_at IS NOT NULL");
    expect(sql).toContain("ORDER BY archived_at DESC");
    expect(lastParams()).toEqual([10]);
  });

  it("archiveOldRoomSessions archives only beyond the newest `keep` (default 5)", async () => {
    await storage.archiveOldRoomSessions(10);
    const sql = lastSql();
    expect(sql).toContain("rn > $2");
    expect(sql).toContain("status IN ('completed','failed')");
    const params = lastParams();
    expect(params[0]).toBe(10);
    expect(params[1]).toBe(5);
    expect(typeof params[2]).toBe("number"); // archived_at = Date.now() (ms)
  });

  it("archiveDeliberationSession only archives finished, unarchived sessions", async () => {
    await storage.archiveDeliberationSession("dlb_10_1780154753618");
    const sql = lastSql();
    expect(sql).toContain("status IN ('completed','failed')");
    expect(sql).toContain("archived_at IS NULL");
    expect(lastParams()[0]).toBe("dlb_10_1780154753618");
  });

  it("archiveDeliberationSession returns false when nothing was updated (e.g. running)", async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const ok = await storage.archiveDeliberationSession("dlb_running");
    expect(ok).toBe(false);
  });

  it("restoreDeliberationSession clears archived_at", async () => {
    await storage.restoreDeliberationSession("dlb_10_1780154753618");
    const sql = lastSql();
    expect(sql).toContain("SET archived_at = NULL");
    expect(lastParams()).toEqual(["dlb_10_1780154753618"]);
  });

  it("archiveAllRoomsOldSessions (backstop) partitions by room, archives beyond keep, no room filter", async () => {
    await storage.archiveAllRoomsOldSessions();
    const sql = lastSql();
    expect(sql).toContain("PARTITION BY room_id");
    expect(sql).toContain("rn > $1");
    expect(sql).toContain("status IN ('completed','failed')");
    expect(sql).not.toContain("room_id = $"); // global, not scoped to one room
    const params = lastParams();
    expect(params[0]).toBe(5);
    expect(typeof params[1]).toBe("number");
  });
});
