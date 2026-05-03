/**
 * Phase 5 PR-B (R-luca-computer-ui) — WS liveFrameTakeover handler.
 *
 * Two layers (mirrors ws-room-acl.test.ts pattern):
 *
 *   1. Source-pin — readFileSync on ws.ts asserts the security gates wired
 *      per BRO1 R438 + R-convention-security-merge-gate are still present:
 *        a. assertRoomOwnership(roomId, userId) call
 *        b. checkAuthRateLimit("takeover:${userId}:${roomId}", 10, 60_000)
 *           — BRO1 R438 MUST-FIX-B2 (existing bucket, NOT new one)
 *        c. step status === "running" check (410-equivalent on done/error)
 *        d. acquireTakeover via luca-takeover module (single-tab lock)
 *        e. broadcastToRoom of liveFrameTakeoverState (cat 8 — WS surface)
 *        f. appendTakeoverLog audit append
 *
 *   2. Behavioural — re-implement the gate flow against in-memory state
 *      and the real luca-takeover module. Assert:
 *        - room mismatch → liveFrameTakeoverError ROOM_NOT_FOUND
 *        - finished step → STEP_FINISHED
 *        - non-existent step → STEP_NOT_FOUND
 *        - second tab acquire → LOCKED with current holder echoed
 *        - rate-limit returns RATE_LIMITED after burst
 *        - release by holder → success + state cleared
 *        - release by non-holder → NOT_HOLDER
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  acquireTakeover,
  releaseTakeover,
  __clearTakeoverStateForTests,
  getTakeover,
} from "../lib/luca-takeover";

// ─── Source-pin layer ────────────────────────────────────────────────────

describe("ws-takeover — source pin", () => {
  const wsPath = join(__dirname, "../ws.ts");
  const src = readFileSync(wsPath, "utf8");

  it("calls assertRoomOwnership(roomId, userId) inside the takeover handler", () => {
    expect(src).toMatch(/assertRoomOwnership\s*\(\s*roomId\s*,\s*userId\s*\)/);
  });

  it("uses checkAuthRateLimit(`takeover:${userId}:${roomId}`, 10, 60_000) — BRO1 R438 MUST-FIX-B2", () => {
    // The literal template + caps — guard against accidental loosening.
    expect(src).toMatch(
      /checkAuthRateLimit\(\s*`takeover:\$\{userId\}:\$\{roomId\}`\s*,\s*10\s*,\s*60_000\s*\)/,
    );
  });

  it("rejects when step status !== 'running' (410-equivalent on done/error)", () => {
    expect(src).toMatch(/stepRow\.status\s*!==\s*"running"/);
    expect(src).toMatch(/STEP_FINISHED/);
  });

  it("uses acquireTakeover from luca-takeover (single-tab lock)", () => {
    expect(src).toMatch(/acquireTakeover\s*\(/);
    expect(src).toMatch(/from\s+["']\.\/lib\/luca-takeover["']/);
  });

  it("broadcasts liveFrameTakeoverState on acquire/release (cat 8 — WS surface)", () => {
    expect(src).toMatch(/type:\s*["']liveFrameTakeoverState["']/);
    expect(src).toMatch(/broadcastToRoom\s*\(/);
  });

  it("appends audit entry on every state change (BRO1 R438 MUST-FIX-B1)", () => {
    expect(src).toMatch(/appendTakeoverLog\s*\(/);
  });

  it("does NOT use media_urls for takeover audit (separate column)", () => {
    // Guard: appendTakeoverLog is the ONLY audit path used by the handler.
    // Specifically the takeover handler block must not be calling
    // setToolActivityMedia or removeToolActivityMediaByKind.
    const handlerStart = src.indexOf("liveFrameTakeover");
    expect(handlerStart).toBeGreaterThan(-1);
    const handlerSlice = src.slice(handlerStart, handlerStart + 5000);
    expect(handlerSlice).not.toMatch(/setToolActivityMedia\s*\(/);
    expect(handlerSlice).not.toMatch(/removeToolActivityMediaByKind\s*\(/);
  });

  it("releases held takeovers in connection cleanup (orphaned-tab safety)", () => {
    // Cleanup path iterates heldTakeoverSteps and calls releaseTakeover.
    expect(src).toMatch(/heldTakeoverSteps/);
    expect(src).toMatch(/releaseTakeover\s*\(/);
  });
});

// ─── Behavioural layer ───────────────────────────────────────────────────

type GateResult =
  | { ok: true; state: ReturnType<typeof getTakeover> }
  | { ok: false; code: string; extras?: Record<string, unknown> };

interface FakeStep {
  stepId: string;
  roomId: number;
  status: "running" | "done" | "error";
}

interface FakeRoom {
  id: number;
  userId: number;
}

/**
 * Mirror of the ws.ts liveFrameTakeover handler — wired against in-memory
 * state so we can exercise every gate without spinning up a real WS.
 * Keep in sync with ws.ts edits.
 */
function makeHandler(opts: {
  rooms: FakeRoom[];
  steps: FakeStep[];
  rateLimit?: (key: string) => boolean;
}) {
  const rate = opts.rateLimit ?? (() => true);

  return async function handle(args: {
    userId: number;
    connectionId: string;
    roomId: number;
    stepId: string;
    mode: "interactive" | "passive" | "release";
  }): Promise<GateResult> {
    const room = opts.rooms.find(
      (r) => r.id === args.roomId && r.userId === args.userId,
    );
    if (!room) return { ok: false, code: "ROOM_NOT_FOUND" };

    if (!rate(`takeover:${args.userId}:${args.roomId}`)) {
      return { ok: false, code: "RATE_LIMITED" };
    }

    const step = opts.steps.find((s) => s.stepId === args.stepId);
    if (!step || step.roomId !== args.roomId) {
      return { ok: false, code: "STEP_NOT_FOUND" };
    }
    if (step.status !== "running") {
      return { ok: false, code: "STEP_FINISHED", extras: { status: step.status } };
    }

    if (args.mode === "release") {
      const after = releaseTakeover(args.stepId, args.connectionId);
      if (after === null) return { ok: true, state: null };
      return { ok: false, code: "NOT_HOLDER" };
    }

    const r = acquireTakeover({
      stepId: args.stepId,
      roomId: args.roomId,
      userId: args.userId,
      mode: args.mode,
      connectionId: args.connectionId,
    });
    if (!r.ok) {
      return {
        ok: false,
        code: "LOCKED",
        extras: { heldByUserId: r.current.userId },
      };
    }
    return { ok: true, state: getTakeover(args.stepId) };
  };
}

beforeEach(() => {
  __clearTakeoverStateForTests();
});

describe("ws-takeover — behavioural", () => {
  const USER_A = 1;
  const USER_B = 2;
  const ROOM_A = { id: 10, userId: USER_A };
  const STEP_RUNNING = { stepId: "s-run", roomId: 10, status: "running" as const };
  const STEP_DONE = { stepId: "s-done", roomId: 10, status: "done" as const };

  it("rejects ROOM_NOT_FOUND when user does not own the room", async () => {
    const handle = makeHandler({ rooms: [ROOM_A], steps: [STEP_RUNNING] });
    const r = await handle({
      userId: USER_B, connectionId: "c-B", roomId: 10,
      stepId: "s-run", mode: "interactive",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("ROOM_NOT_FOUND");
  });

  it("rejects STEP_NOT_FOUND on unknown stepId", async () => {
    const handle = makeHandler({ rooms: [ROOM_A], steps: [STEP_RUNNING] });
    const r = await handle({
      userId: USER_A, connectionId: "c-A", roomId: 10,
      stepId: "ghost", mode: "interactive",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("STEP_NOT_FOUND");
  });

  it("rejects STEP_FINISHED on done/error step (R438 410-equivalent)", async () => {
    const handle = makeHandler({ rooms: [ROOM_A], steps: [STEP_DONE] });
    const r = await handle({
      userId: USER_A, connectionId: "c-A", roomId: 10,
      stepId: "s-done", mode: "interactive",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("STEP_FINISHED");
      expect(r.extras?.status).toBe("done");
    }
  });

  it("returns LOCKED when a second tab tries to acquire while held", async () => {
    const handle = makeHandler({ rooms: [ROOM_A], steps: [STEP_RUNNING] });
    const first = await handle({
      userId: USER_A, connectionId: "c-A", roomId: 10,
      stepId: "s-run", mode: "interactive",
    });
    expect(first.ok).toBe(true);
    const second = await handle({
      userId: USER_A, connectionId: "c-OTHER", roomId: 10,
      stepId: "s-run", mode: "interactive",
    });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.code).toBe("LOCKED");
      expect(second.extras?.heldByUserId).toBe(USER_A);
    }
  });

  it("rate-limit gate returns RATE_LIMITED on 11th request (10/min)", async () => {
    let count = 0;
    const handle = makeHandler({
      rooms: [ROOM_A],
      steps: [STEP_RUNNING],
      rateLimit: () => {
        count += 1;
        return count <= 10;
      },
    });
    let lastCode: string | undefined;
    for (let i = 0; i < 11; i++) {
      const r = await handle({
        userId: USER_A, connectionId: "c-A", roomId: 10,
        stepId: "s-run", mode: "interactive",
      });
      if (!r.ok) lastCode = r.code;
    }
    expect(lastCode).toBe("RATE_LIMITED");
  });

  it("release by holder clears state; second tab can then acquire", async () => {
    const handle = makeHandler({ rooms: [ROOM_A], steps: [STEP_RUNNING] });
    await handle({
      userId: USER_A, connectionId: "c-A", roomId: 10,
      stepId: "s-run", mode: "interactive",
    });
    const release = await handle({
      userId: USER_A, connectionId: "c-A", roomId: 10,
      stepId: "s-run", mode: "release",
    });
    expect(release.ok).toBe(true);
    expect(getTakeover("s-run")).toBeNull();

    const reAcquire = await handle({
      userId: USER_A, connectionId: "c-NEW", roomId: 10,
      stepId: "s-run", mode: "interactive",
    });
    expect(reAcquire.ok).toBe(true);
  });

  it("release by non-holder returns NOT_HOLDER", async () => {
    const handle = makeHandler({ rooms: [ROOM_A], steps: [STEP_RUNNING] });
    await handle({
      userId: USER_A, connectionId: "c-A", roomId: 10,
      stepId: "s-run", mode: "interactive",
    });
    const release = await handle({
      userId: USER_A, connectionId: "c-OTHER", roomId: 10,
      stepId: "s-run", mode: "release",
    });
    expect(release.ok).toBe(false);
    if (!release.ok) expect(release.code).toBe("NOT_HOLDER");
  });

  it("acquire on running step succeeds with state echo (happy path)", async () => {
    const handle = makeHandler({ rooms: [ROOM_A], steps: [STEP_RUNNING] });
    const r = await handle({
      userId: USER_A, connectionId: "c-A", roomId: 10,
      stepId: "s-run", mode: "interactive",
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.state) {
      expect(r.state.mode).toBe("interactive");
      expect(r.state.userId).toBe(USER_A);
      expect(r.state.lockedByConnectionId).toBe("c-A");
    }
  });
});
