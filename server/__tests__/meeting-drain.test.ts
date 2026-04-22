/**
 * Tests for drainMeetings helper (W9 Item 3-4, Bro2 SF4).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { drainMeetings } from "../lib/meeting-drain";
import { RecordingMeetingEventBus } from "../lib/meeting-event-bus";

class FakePool {
  rows: Array<{ id: string; state: string }> = [];
  selects: Array<{ sql: string; params: any[] }> = [];
  updates: Array<{ sql: string; params: any[] }> = [];

  async query(sql: string, params: any[] = []): Promise<{ rows: any[] }> {
    if (/^SELECT\s+id\s+FROM\s+meetings/i.test(sql)) {
      this.selects.push({ sql, params });
      const active = this.rows.filter((r) => r.state !== "completed" && r.state !== "aborted");
      return { rows: active.map((r) => ({ id: r.id })) };
    }
    if (/^UPDATE\s+meetings\s+SET\s+state\s*=\s*'aborted'/i.test(sql)) {
      this.updates.push({ sql, params });
      const ids = params[0] as string[];
      for (const r of this.rows) if (ids.includes(r.id)) r.state = "aborted";
      return { rows: [] };
    }
    throw new Error("unexpected sql: " + sql);
  }
}

describe("drainMeetings", () => {
  let pool: FakePool;
  let bus: RecordingMeetingEventBus;

  beforeEach(() => {
    pool = new FakePool();
    bus = new RecordingMeetingEventBus();
  });

  it("dry run returns candidates without UPDATE or events", async () => {
    pool.rows = [
      { id: "m1", state: "active" },
      { id: "m2", state: "pending" },
      { id: "m3", state: "completed" },
    ];
    const result = await drainMeetings(pool as any, bus, { dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.count).toBe(2);
    expect(result.ids.sort()).toEqual(["m1", "m2"]);
    expect(pool.updates).toHaveLength(0);
    expect(bus.events).toHaveLength(0);
  });

  it("wet run updates state=aborted and emits one event per id", async () => {
    pool.rows = [
      { id: "m1", state: "active" },
      { id: "m2", state: "waiting_for_approval" },
    ];
    const result = await drainMeetings(pool as any, bus);
    expect(result.count).toBe(2);
    expect(pool.updates).toHaveLength(1);
    expect(pool.updates[0].params[0].sort()).toEqual(["m1", "m2"]);
    // Fire-and-forget emits resolve synchronously for RecordingMeetingEventBus.
    await new Promise((r) => setImmediate(r));
    expect(bus.events).toHaveLength(2);
    expect(bus.events[0]).toMatchObject({
      event: "meeting.state.changed",
      payload: { state: "aborted", reason: "admin_drain" },
    });
    // F1: no content field on drain events.
    expect((bus.events[0].payload as any).content).toBeUndefined();
    expect(pool.rows.every((r) => r.state === "aborted")).toBe(true);
  });

  it("wet run with zero candidates is a no-op", async () => {
    pool.rows = [{ id: "m1", state: "completed" }];
    const result = await drainMeetings(pool as any, bus);
    expect(result.count).toBe(0);
    expect(pool.updates).toHaveLength(0);
    expect(bus.events).toHaveLength(0);
  });

  it("respects a custom limit", async () => {
    pool.rows = [{ id: "m1", state: "active" }];
    await drainMeetings(pool as any, bus, { limit: 5 });
    expect(pool.selects[0].params[0]).toBe(5);
  });
});
