/**
 * Luca V1a Day -1 — TurnStateStore unit tests.
 *
 * Covers the InMemoryTurnStateStore impl end-to-end (same interface as
 * Redis; behavior equivalence is the goal). Redis impl is exercised only
 * indirectly via `createDefaultTurnStateStore` type-check; full Redis
 * integration tests land alongside the turn-runner wiring on Day 5.
 */
import { describe, expect, it } from "vitest";
import {
  InMemoryTurnStateStore,
  RedisTurnStateStore,
  createDefaultTurnStateStore,
  type TurnStateStore,
} from "../../lib/luca/turn-state-store";

function makeStore(): { store: InMemoryTurnStateStore; tick: (ms: number) => void } {
  let now = 1_000_000;
  const store = new InMemoryTurnStateStore(() => now, 60_000);
  return { store, tick: (ms) => { now += ms; } };
}

describe("luca/turn-state-store — InMemoryTurnStateStore", () => {
  it("defaults to unlocked + trusted when nothing stored", async () => {
    const { store } = makeStore();
    expect(await store.isLocked("t1")).toEqual({ locked: false, reason: null });
    expect(await store.getTrust("t1")).toBe("trusted");
  });

  it("markUntrusted flips both lock and trust", async () => {
    const { store } = makeStore();
    await store.markUntrusted("t1", "attack_sig:ignore_prev");
    expect(await store.isLocked("t1")).toEqual({
      locked: true,
      reason: "attack_sig:ignore_prev",
    });
    expect(await store.getTrust("t1")).toBe("untrusted");
  });

  it("markUntrusted is idempotent and preserves first reason (SETNX semantics)", async () => {
    const { store } = makeStore();
    await store.markUntrusted("t1", "first_reason");
    await store.markUntrusted("t1", "second_reason");
    expect((await store.isLocked("t1")).reason).toBe("first_reason");
  });

  it("setTrust(untrusted) without lock does NOT lock (trust and lock are separate)", async () => {
    const { store } = makeStore();
    await store.setTrust("t1", "untrusted");
    expect(await store.getTrust("t1")).toBe("untrusted");
    expect((await store.isLocked("t1")).locked).toBe(false);
  });

  it("setTrust(trusted) after markUntrusted does NOT unlock (lock is sticky by design)", async () => {
    const { store } = makeStore();
    await store.markUntrusted("t1", "reason");
    await store.setTrust("t1", "trusted");
    // Trust can be overridden, but the lock stays locked — that's the
    // security invariant. The only way to unlock is clear() at turn end.
    expect((await store.isLocked("t1")).locked).toBe(true);
    expect(await store.getTrust("t1")).toBe("trusted");
  });

  it("clear() removes all state for a turn", async () => {
    const { store } = makeStore();
    await store.markUntrusted("t1", "x");
    await store.clear("t1");
    expect(await store.isLocked("t1")).toEqual({ locked: false, reason: null });
    expect(await store.getTrust("t1")).toBe("trusted");
    expect(store.size()).toBe(0);
  });

  it("TTL expiry returns default state and removes entry lazily", async () => {
    const { store, tick } = makeStore();
    await store.markUntrusted("t1", "r");
    expect((await store.isLocked("t1")).locked).toBe(true);
    tick(60_001);
    expect(await store.isLocked("t1")).toEqual({ locked: false, reason: null });
    expect(await store.getTrust("t1")).toBe("trusted");
    expect(store.size()).toBe(0);
  });

  it("state is per-turn: operations on t1 do not bleed to t2", async () => {
    const { store } = makeStore();
    await store.markUntrusted("t1", "r1");
    expect((await store.isLocked("t2")).locked).toBe(false);
    expect(await store.getTrust("t2")).toBe("trusted");
  });
});

describe("luca/turn-state-store — factory", () => {
  it("createDefaultTurnStateStore returns a usable TurnStateStore without REDIS_URL", async () => {
    const prev = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    try {
      const store: TurnStateStore = createDefaultTurnStateStore();
      await store.markUntrusted("t1", "r");
      expect((await store.isLocked("t1")).locked).toBe(true);
      await store.clear("t1");
    } finally {
      if (prev !== undefined) process.env.REDIS_URL = prev;
    }
  });

  it("exposes RedisTurnStateStore as a public class (wiring smoke test)", () => {
    // No actual Redis here; just verify the class is exported and
    // constructible with a mock client so downstream Day-5 code can
    // DI it in tests.
    const fake = {
      set: async () => "OK",
      get: async () => null,
      mget: async () => [null, null],
      del: async () => 0,
    } as any;
    const s = new RedisTurnStateStore(fake);
    expect(s).toBeInstanceOf(RedisTurnStateStore);
  });
});
