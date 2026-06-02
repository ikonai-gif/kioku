/**
 * [PR-2] Deliberation deletion — storage SQL contract (no real DB; pg mocked).
 * Verifies the 90-day delete-and-log query: deletes ONLY archived rows older
 * than the cutoff, logs each into deliberation_session_deletion_log, returns the
 * deleted count. The scheduler gates this behind DELIBERATION_DELETE_ENABLED;
 * here we exercise the storage method directly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 3 });
vi.mock("pg", () => ({
  Pool: class FakePool { query = query; on() {} connect() {} end() {} },
}));
vi.mock("../../server/embeddings", () => ({ embedText: vi.fn() }));
vi.mock("../../server/emotion-scorer", () => ({ scoreEmotion: vi.fn() }));

const { storage } = await import("../../server/storage");

const lastSql = () => String(query.mock.calls.at(-1)?.[0] ?? "");
const lastParams = () => query.mock.calls.at(-1)?.[1] as any[];
const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  query.mockClear();
  query.mockResolvedValue({ rows: [], rowCount: 3 });
});

describe("deliberation deletion — storage SQL contract (PR-2)", () => {
  it("deletes ONLY archived rows older than the cutoff and logs each deletion", async () => {
    await storage.deleteOldArchivedSessions(90);
    const sql = lastSql();
    expect(sql).toContain("DELETE FROM kioku_deliberation_sessions");
    expect(sql).toContain("archived_at IS NOT NULL");
    expect(sql).toContain("archived_at < $1");
    expect(sql).toContain("INSERT INTO deliberation_session_deletion_log");
  });

  it("cutoff is exactly now minus retentionDays (default 90 days)", async () => {
    const before = Date.now();
    await storage.deleteOldArchivedSessions(90);
    const after = Date.now();
    const [cutoff, now, reason] = lastParams();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
    expect(now - cutoff).toBe(90 * DAY);
    expect(typeof reason).toBe("string");
  });

  it("honors a custom retention window", async () => {
    await storage.deleteOldArchivedSessions(30);
    const [cutoff, now] = lastParams();
    expect(now - cutoff).toBe(30 * DAY);
  });

  it("defaults to 90 days when called with no args", async () => {
    await storage.deleteOldArchivedSessions();
    const [cutoff, now] = lastParams();
    expect(now - cutoff).toBe(90 * DAY);
  });

  it("returns the number of rows deleted", async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 7 });
    const n = await storage.deleteOldArchivedSessions();
    expect(n).toBe(7);
  });
});
