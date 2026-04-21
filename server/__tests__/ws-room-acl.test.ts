/**
 * W7 F4.3 — WS room ACL regression guard
 *
 * Per v2.1 plan §F4.3: `server/ws.ts:97-104` is already secure —
 * `storage.getRoom(msg.roomId, userId)` with the authenticated JWT userId
 * scopes the query to `rooms.userId = userId`, returning `undefined` if
 * user A subscribes to user B's room. Code change: none.
 *
 * This file locks the contract so future edits can't silently strip the
 * scoping. Two layers:
 *
 *  1. Behavioural — re-implement the exact subscribe handler against a
 *     stub storage. Assert user A subscribing to B's room gets a
 *     `{type: "error", message: "Room not found"}` frame, never the
 *     `subscribed` frame. Also assert the happy path still works for
 *     the room's real owner.
 *
 *  2. Source — readFileSync on ws.ts: assert the `subscribe` handler
 *     still calls `storage.getRoom(msg.roomId, userId)` with both args
 *     (the 2-arg form is the ACL). A single-arg call would be the
 *     regression.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ── Behavioural test: mirror ws.ts:92-119 subscribe handler ──

type Room = { id: number; userId: number };

function makeHandler(stubStorage: {
  getRoom: (id: number, userId?: number) => Promise<Room | undefined>;
}, authenticatedUserId: number) {
  // Exact mirror of the ws.ts subscribe flow:
  //   const room = await storage.getRoom(msg.roomId, userId);
  //   if (!room) → error "Room not found"
  //   else → subscribed
  return async function handleSubscribe(msg: { type: string; roomId: number }): Promise<
    | { type: "subscribed"; roomId: number }
    | { type: "error"; message: string }
    | null
  > {
    if (msg.type !== "subscribe" || typeof msg.roomId !== "number") return null;
    const room = await stubStorage.getRoom(msg.roomId, authenticatedUserId);
    if (!room) {
      return { type: "error", message: "Room not found" };
    }
    return { type: "subscribed", roomId: msg.roomId };
  };
}

// Stub storage that models the SQL scoping: getRoom(id, userId) returns
// row ONLY if room.userId === userId. Single-arg path returns the row
// regardless — which is precisely what we're guarding against.
function makeScopedStorage(rooms: Room[]) {
  return {
    getRoom: async (id: number, userId?: number) => {
      const room = rooms.find((r) => r.id === id);
      if (!room) return undefined;
      if (userId !== undefined && room.userId !== userId) return undefined;
      return room;
    },
  };
}

describe("W7 F4.3 — WS subscribe handler enforces room ownership via storage.getRoom(id, userId)", () => {
  const USER_A = 1;
  const USER_B = 2;
  const ROOM_OWNED_BY_A = { id: 101, userId: USER_A };
  const ROOM_OWNED_BY_B = { id: 202, userId: USER_B };
  const rooms = [ROOM_OWNED_BY_A, ROOM_OWNED_BY_B];

  it("user A can subscribe to A's own room (happy path)", async () => {
    const storage = makeScopedStorage(rooms);
    const handle = makeHandler(storage, USER_A);
    const out = await handle({ type: "subscribe", roomId: ROOM_OWNED_BY_A.id });
    expect(out).toEqual({ type: "subscribed", roomId: ROOM_OWNED_BY_A.id });
  });

  it("user A attempting to subscribe to user B's room → error, NOT subscribed", async () => {
    const storage = makeScopedStorage(rooms);
    const handle = makeHandler(storage, USER_A);
    const out = await handle({ type: "subscribe", roomId: ROOM_OWNED_BY_B.id });
    expect(out).toEqual({ type: "error", message: "Room not found" });
  });

  it("user A attempting to subscribe to non-existent room → error (same shape — no info leak)", async () => {
    const storage = makeScopedStorage(rooms);
    const handle = makeHandler(storage, USER_A);
    const out = await handle({ type: "subscribe", roomId: 9999 });
    expect(out).toEqual({ type: "error", message: "Room not found" });
  });

  it("regression guard: if getRoom were ever called WITHOUT userId, the ACL would be bypassed", async () => {
    // This test simulates the regression — prove a naive unscoped handler
    // would leak B's room to A. The source-pin test below blocks the
    // regression at the commit level.
    const storage = makeScopedStorage(rooms);
    const bypassHandler = async (msg: { type: string; roomId: number }) => {
      if (msg.type !== "subscribe") return null;
      // ❌ missing userId → returns B's room to A
      const room = await storage.getRoom(msg.roomId);
      return room ? { type: "subscribed" as const, roomId: msg.roomId } : { type: "error" as const };
    };
    const leaked = await bypassHandler({ type: "subscribe", roomId: ROOM_OWNED_BY_B.id });
    expect(leaked).toEqual({ type: "subscribed", roomId: ROOM_OWNED_BY_B.id });
    // Not an assertion on production — just demonstrates the attack shape
    // the scoped version (above) prevents.
  });
});

// ── Source pin: ws.ts still passes userId to storage.getRoom ──
describe("W7 F4.3 — source contract: ws.ts subscribe still ACL-scopes with userId", () => {
  const src = readFileSync(join(__dirname, "..", "ws.ts"), "utf8");

  it("getRoom is called with BOTH (roomId, userId) args inside the subscribe handler", () => {
    // Locate the subscribe block.
    const subIdx = src.indexOf('msg.type === "subscribe"');
    expect(subIdx, 'subscribe handler not found in ws.ts').toBeGreaterThan(-1);
    // Window to the error reply — covers the getRoom call.
    const endIdx = src.indexOf('"Room not found"', subIdx);
    expect(endIdx).toBeGreaterThan(subIdx);
    const win = src.slice(subIdx, endIdx + 200);
    // Must call getRoom with the 2-arg form. A single-arg call would
    // return the row regardless of ownership — that's the regression.
    expect(win).toMatch(/storage\.getRoom\(\s*msg\.roomId\s*,\s*userId\s*\)/);
    // Must check `if (!room)` and send the error frame.
    expect(win).toMatch(/if\s*\(\s*!room\s*\)/);
    expect(win).toMatch(/"Room not found"/);
  });

  it("ws connection auth rejects with 4001 when userId is null", () => {
    // Regression guard for the outer auth — a broken auth would let any
    // peer connect, and then even ACL-scoped getRoom would happily match
    // rows for whichever userId they forged upstream.
    expect(src).toMatch(/ws\.close\(\s*4001\s*,\s*["']Unauthorized["']\s*\)/);
  });
});
