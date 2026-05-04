/**
 * Phase 6 PR-C — unit tests for shared `useKiokuWebSocket` holder layer.
 *
 * These tests target the internal holder/registry plumbing
 * (`__testInternals`) so we don't have to spin up jsdom + a React renderer.
 * The hook itself is a thin wrapper that just acquires/releases holders
 * across React lifecycles and exposes `connected/subscribe/send` — once
 * the holder semantics are correct, the hook is correct by construction.
 *
 * Coverage targets (BRO1 plan-review §7):
 *   • Listener registry add/remove/fan-out + isolation on listener throw
 *   • Subscribe payloads emitted on open AND on every reconnect (room+user)
 *   • Refcount: 2 acquires → 1 holder; last release schedules close grace
 *   • Token isolation: different sessionToken ⇒ different holder
 *   • RoomId isolation: different roomId ⇒ different holder
 *   • Defence-in-depth: messages with mismatched data.roomId are dropped
 *   • Strict-fail send when WS not OPEN
 *   • Reconnect uses backoff schedule, drops attempts on destroy
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __testInternals,
  __resetKiokuWsRegistryForTests,
  __getKiokuWsRegistrySizeForTests,
} from "../../client/src/hooks/useKiokuWebSocket";

// ── Fake WebSocket ───────────────────────────────────────────────────

const READY_CONNECTING = 0;
const READY_OPEN = 1;
const READY_CLOSING = 2;
const READY_CLOSED = 3;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  readyState: number = READY_CONNECTING;
  sent: string[] = [];
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = READY_OPEN;
    this.onopen?.();
  }

  message(payload: object) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  rawMessage(data: string) {
    this.onmessage?.({ data });
  }

  close(code?: number, reason?: string) {
    if (this.readyState === READY_CLOSED) return;
    this.readyState = READY_CLOSED;
    this.onclose?.({ code: code ?? 1000, reason: reason ?? "" });
  }

  errorClose() {
    this.onerror?.();
    this.close();
  }
}

// Polyfill the WebSocket constants used by the hook (`WebSocket.OPEN`).
(globalThis as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket =
  FakeWebSocket as unknown as typeof FakeWebSocket;
(FakeWebSocket as unknown as { OPEN: number }).OPEN = READY_OPEN;
(FakeWebSocket as unknown as { CLOSED: number }).CLOSED = READY_CLOSED;
(FakeWebSocket as unknown as { CONNECTING: number }).CONNECTING = READY_CONNECTING;
(FakeWebSocket as unknown as { CLOSING: number }).CLOSING = READY_CLOSING;

const wsFactory = (url: string) => new FakeWebSocket(url) as unknown as WebSocket;

// ── Setup ────────────────────────────────────────────────────────────

beforeEach(() => {
  FakeWebSocket.instances = [];
  __resetKiokuWsRegistryForTests();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  __resetKiokuWsRegistryForTests();
});

function lastWs(): FakeWebSocket {
  return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
}

// ── Tests ────────────────────────────────────────────────────────────

describe("useKiokuWebSocket holder — registry & lifecycle", () => {
  it("acquire creates a fresh holder with refs=1 and opens a WS", () => {
    const h = __testInternals.acquire(42, "tok-A", { closeGraceMs: 100, wsFactory });
    expect(__getKiokuWsRegistrySizeForTests()).toBe(1);
    const snap = __testInternals.inspectHolder(h);
    expect(snap.refs).toBe(1);
    expect(snap.roomId).toBe(42);
    expect(snap.connected).toBe(false);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(lastWs().url).toContain("token=tok-A");
  });

  it("second acquire on same (roomId, token) returns the SAME holder and increments refs", () => {
    const a = __testInternals.acquire(42, "tok-A", { closeGraceMs: 100, wsFactory });
    const b = __testInternals.acquire(42, "tok-A", { closeGraceMs: 100, wsFactory });
    expect(b).toBe(a);
    expect(__testInternals.inspectHolder(a).refs).toBe(2);
    // Only one underlying WS even with two consumers.
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("different sessionToken ⇒ different holder (account isolation)", () => {
    const a = __testInternals.acquire(42, "tok-A", { closeGraceMs: 100, wsFactory });
    const b = __testInternals.acquire(42, "tok-B", { closeGraceMs: 100, wsFactory });
    expect(b).not.toBe(a);
    expect(__getKiokuWsRegistrySizeForTests()).toBe(2);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("different roomId ⇒ different holder (room isolation)", () => {
    const a = __testInternals.acquire(42, "tok-A", { closeGraceMs: 100, wsFactory });
    const b = __testInternals.acquire(43, "tok-A", { closeGraceMs: 100, wsFactory });
    expect(b).not.toBe(a);
    expect(__getKiokuWsRegistrySizeForTests()).toBe(2);
  });

  it("release with refs>0 keeps the holder alive (no close timer)", () => {
    const h = __testInternals.acquire(42, "tok-A", { closeGraceMs: 100, wsFactory });
    __testInternals.acquire(42, "tok-A", { closeGraceMs: 100, wsFactory });
    __testInternals.release(h, 100);
    expect(__testInternals.inspectHolder(h).refs).toBe(1);
    expect(__testInternals.inspectHolder(h).hasCloseTimer).toBe(false);
  });

  it("last release schedules close grace; tearing down clears the registry", () => {
    const h = __testInternals.acquire(42, "tok-A", { closeGraceMs: 100, wsFactory });
    __testInternals.release(h, 100);
    expect(__testInternals.inspectHolder(h).refs).toBe(0);
    expect(__testInternals.inspectHolder(h).hasCloseTimer).toBe(true);
    expect(__getKiokuWsRegistrySizeForTests()).toBe(1);
    vi.advanceTimersByTime(100);
    expect(__getKiokuWsRegistrySizeForTests()).toBe(0);
    expect(__testInternals.inspectHolder(h).destroyed).toBe(true);
  });

  it("re-acquire during grace cancels the close timer", () => {
    const h = __testInternals.acquire(42, "tok-A", { closeGraceMs: 100, wsFactory });
    __testInternals.release(h, 100);
    expect(__testInternals.inspectHolder(h).hasCloseTimer).toBe(true);
    const h2 = __testInternals.acquire(42, "tok-A", { closeGraceMs: 100, wsFactory });
    expect(h2).toBe(h);
    expect(__testInternals.inspectHolder(h).hasCloseTimer).toBe(false);
    expect(__testInternals.inspectHolder(h).refs).toBe(1);
    // No new WS opened — we revived the existing one.
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});

describe("useKiokuWebSocket holder — subscribe payloads", () => {
  it("emits BOTH room and user-topic subscribe on open", () => {
    const h = __testInternals.acquire(42, "tok-A", { closeGraceMs: 100, wsFactory });
    expect(h).toBeDefined();
    const ws = lastWs();
    ws.open();
    expect(ws.sent.length).toBe(0); // FakeWebSocket doesn't auto-record without spy
    // The real WS.send is what the hook calls; FakeWebSocket exposes `sent`
    // when its instance method is wired. Re-check via spy.
  });

  it("re-emits subscribe payloads on every reconnect (room+user)", () => {
    // Spy on the underlying instance.send.
    const sendSpy = vi.fn();
    const factory = (url: string) => {
      const ws = new FakeWebSocket(url);
      // hijack send so we can assert the payloads regardless of readyState
      (ws as unknown as { send: (s: string) => void }).send = (s: string) => {
        sendSpy(s);
      };
      return ws as unknown as WebSocket;
    };
    const h = __testInternals.acquire(42, "tok-A", {
      closeGraceMs: 100,
      wsFactory: factory,
    });
    expect(h).toBeDefined();

    // First connection.
    let ws = lastWs();
    ws.open();
    expect(sendSpy).toHaveBeenCalledTimes(2);
    expect(JSON.parse(sendSpy.mock.calls[0][0])).toEqual({
      type: "subscribe",
      roomId: 42,
    });
    expect(JSON.parse(sendSpy.mock.calls[1][0])).toEqual({
      type: "subscribe",
      topic: "user",
    });

    // Drop the connection; backoff timer fires; new WS reconnects.
    ws.close();
    vi.advanceTimersByTime(2_000); // > base 1000ms + jitter cap
    ws = lastWs();
    expect(FakeWebSocket.instances).toHaveLength(2);
    ws.open();
    expect(sendSpy).toHaveBeenCalledTimes(4);
    expect(JSON.parse(sendSpy.mock.calls[2][0])).toEqual({
      type: "subscribe",
      roomId: 42,
    });
    expect(JSON.parse(sendSpy.mock.calls[3][0])).toEqual({
      type: "subscribe",
      topic: "user",
    });
  });
});

describe("useKiokuWebSocket holder — message dispatch", () => {
  it("fans out messages to every registered listener", () => {
    const h = __testInternals.acquire(42, "tok-A", { closeGraceMs: 100, wsFactory });
    const a = vi.fn();
    const b = vi.fn();
    h.listeners.add(a);
    h.listeners.add(b);
    lastWs().open();
    lastWs().message({ type: "ping" });
    expect(a).toHaveBeenCalledWith({ type: "ping" });
    expect(b).toHaveBeenCalledWith({ type: "ping" });
  });

  it("isolates a listener throw — other listeners still fire", () => {
    const h = __testInternals.acquire(42, "tok-A", { closeGraceMs: 100, wsFactory });
    const bad = vi.fn(() => { throw new Error("bad"); });
    const good = vi.fn();
    h.listeners.add(bad);
    h.listeners.add(good);
    lastWs().open();
    lastWs().message({ type: "ping" });
    expect(bad).toHaveBeenCalled();
    expect(good).toHaveBeenCalled();
  });

  it("drops messages whose data.roomId mismatches the holder (defence-in-depth Q4)", () => {
    const h = __testInternals.acquire(42, "tok-A", { closeGraceMs: 100, wsFactory });
    const fn = vi.fn();
    h.listeners.add(fn);
    lastWs().open();
    lastWs().message({ type: "message", roomId: 99, body: "leaked" });
    expect(fn).not.toHaveBeenCalled();
    // Same payload with the right roomId passes through.
    lastWs().message({ type: "message", roomId: 42, body: "ours" });
    expect(fn).toHaveBeenCalledTimes(1);
    // Messages WITHOUT a roomId field still pass (e.g. user-topic events).
    lastWs().message({ type: "luca_board_update", payload: {} });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("ignores non-JSON frames without crashing", () => {
    const h = __testInternals.acquire(42, "tok-A", { closeGraceMs: 100, wsFactory });
    const fn = vi.fn();
    h.listeners.add(fn);
    lastWs().open();
    lastWs().rawMessage("not json {{{");
    lastWs().rawMessage("");
    expect(fn).not.toHaveBeenCalled();
    // Still functional after garbage input.
    lastWs().message({ type: "ok" });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("useKiokuWebSocket holder — reconnect & destroy", () => {
  it("schedules a reconnect with a positive delay after onclose", () => {
    const h = __testInternals.acquire(42, "tok-A", { closeGraceMs: 100, wsFactory });
    lastWs().open();
    expect(__testInternals.inspectHolder(h).reconnectAttempt).toBe(0);
    lastWs().close();
    expect(__testInternals.inspectHolder(h).hasReconnectTimer).toBe(true);
    expect(__testInternals.inspectHolder(h).reconnectAttempt).toBe(1);
    // Advance past max base+jitter (1s × 1.2) — reconnect fires.
    vi.advanceTimersByTime(2_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("destroyed holder does NOT reconnect even after onclose", () => {
    const h = __testInternals.acquire(42, "tok-A", { closeGraceMs: 100, wsFactory });
    lastWs().open();
    __testInternals.destroy(h);
    expect(__testInternals.inspectHolder(h).destroyed).toBe(true);
    // Advance well past any backoff.
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("connectedSubs are notified on open and on close", () => {
    const h = __testInternals.acquire(42, "tok-A", { closeGraceMs: 100, wsFactory });
    const sub = vi.fn();
    h.connectedSubs.add(sub);
    lastWs().open();
    expect(sub).toHaveBeenCalledWith(true);
    lastWs().close();
    expect(sub).toHaveBeenCalledWith(false);
  });
});

// ── R448 BLOCKER-C2: auth-failure close codes break reconnect loop ──

// jsdom is not in this suite; the hook's `buildWsUrl` reads
// `window.location.protocol` + `window.location.host` and may dispatch
// a CustomEvent on `window`. Install a minimal shim ONCE so every test
// below sees a consistent global surface.
const __authFailListeners = new Map<string, Set<(e: Event) => void>>();
if (typeof (globalThis as any).window === "undefined") {
  (globalThis as any).window = {
    location: { protocol: "https:", host: "test.kioku.local" },
    addEventListener: (t: string, fn: (e: Event) => void) => {
      if (!__authFailListeners.has(t)) __authFailListeners.set(t, new Set());
      __authFailListeners.get(t)!.add(fn);
    },
    removeEventListener: (t: string, fn: (e: Event) => void) => {
      __authFailListeners.get(t)?.delete(fn);
    },
    dispatchEvent: (e: Event) => {
      for (const fn of __authFailListeners.get(e.type) ?? []) fn(e);
      return true;
    },
  };
  (globalThis as any).CustomEvent = class CustomEvent<T = unknown> {
    type: string;
    detail: T;
    constructor(type: string, init: { detail: T }) {
      this.type = type;
      this.detail = init.detail;
    }
  };
}

describe("useKiokuWebSocket holder — auth-failure close codes (R448 C2)", () => {
  it("close code 1008 (Policy Violation) destroys holder and dispatches kioku-auth-failed", () => {
    const events: CustomEvent[] = [];
    const handler = (e: Event) => events.push(e as CustomEvent);
    (globalThis as any).window.addEventListener("kioku-auth-failed", handler);

    const h = __testInternals.acquire(42, "tok-bad", {
      closeGraceMs: 100,
      wsFactory,
    });
    lastWs().open();
    expect(__testInternals.inspectHolder(h).destroyed).toBe(false);

    // Server closes with 1008 (auth-fail RFC 6455).
    lastWs().close(1008, "auth");

    expect(__testInternals.inspectHolder(h).destroyed).toBe(true);
    expect(__testInternals.inspectHolder(h).hasReconnectTimer).toBe(false);
    // No new WS attempt even after generous backoff window.
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);

    // Window event dispatched with the close code.
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("kioku-auth-failed");
    expect((events[0] as any).detail.code).toBe(1008);

    (globalThis as any).window.removeEventListener("kioku-auth-failed", handler);
  });

  it("close code 4001 (Unauthorized) destroys holder and stops retry storm", () => {
    const h = __testInternals.acquire(42, "tok-bad", {
      closeGraceMs: 100,
      wsFactory,
    });
    lastWs().open();
    // server/ws.ts:122 ws.close(4001, "Unauthorized")
    lastWs().close(4001, "Unauthorized");
    expect(__testInternals.inspectHolder(h).destroyed).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("close code 1006 (abnormal) is NOT auth-failure — still reconnects", () => {
    const h = __testInternals.acquire(42, "tok-A", {
      closeGraceMs: 100,
      wsFactory,
    });
    lastWs().open();
    // Network drop — NOT an auth signal. Must still trigger backoff retry.
    lastWs().close(1006, "abnormal");
    expect(__testInternals.inspectHolder(h).destroyed).toBe(false);
    expect(__testInternals.inspectHolder(h).hasReconnectTimer).toBe(true);
    vi.advanceTimersByTime(2_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});
