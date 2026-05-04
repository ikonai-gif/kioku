/**
 * Phase 6 PR-C (R-luca-computer-ui) — Shared Kioku WebSocket hook.
 *
 * Replaces the per-component WS open scattered across partner-chat.tsx and
 * LiveBrowserFrame.tsx. One connection per (roomId, sessionToken) tuple is
 * held in a module-level registry, refcounted by hook mounts, and torn down
 * after a short grace period when the last consumer unmounts.
 *
 * BRO1 plan-review (R446 + N1+N2 corrections):
 *   N1 — `subscribe` MUST return a synchronous unsubscribe so React's
 *        cleanup→setup ordering (cleanup-OLD before mount-NEW) gives us a
 *        clean room-switch with zero stale-listener window. Holder
 *        teardown is also synchronous.
 *   N2 — In dev (HMR) the module-level registry is wiped between hot
 *        reloads which can leak the prior WS. We mirror the registry on
 *        `window.__kiokuWsRegistry` ONLY when `import.meta.env.DEV` is
 *        true; production keeps a clean module scope.
 *
 * Security guarantees (R-convention-security-merge-gate cat 8):
 *   1. Token lives ONLY in the holder's closure; cleared on close.
 *   2. Per-token holder isolation — different sessionToken ⇒ different
 *      key ⇒ different connection. No cross-account leakage.
 *   3. Room-switch race: caller's old listener is unsubscribed BEFORE the
 *      new holder's listeners attach (React cleanup-then-setup order).
 *   4. Defence-in-depth on receive: messages whose `data.roomId` is
 *      present and ≠ current room are dropped client-side. Server-side
 *      `roomClients.get(roomId)` (server/ws.ts) remains the source of
 *      truth — this is belt-and-suspenders for room-switch race window.
 *   5. No XSS surface added: hook returns plain JS values; rendering is
 *      the consumer's responsibility.
 *
 * Auth lifecycle (BRO1 R448 BLOCKER-C2 + MUST-FIX-C1):
 *   • Consumer contract: `sessionToken` is passed as a prop. When it
 *     changes (login / logout / rotate), the hook’s effect key changes
 *     and a brand-new holder is acquired; the OLD holder is released
 *     synchronously (N1). Consumers therefore MUST re-read the token
 *     from `useAuth()` (or equivalent) and re-pass it — NOT cache the
 *     stale value. partner-chat + LiveBrowserFrame do this today via
 *     `const { sessionToken } = useAuth()`.
 *   • Server closes the WS with code 4001 "Unauthorized" on auth
 *     failure (server/ws.ts:122). The 1008 code is also treated as
 *     auth-failure per RFC 6455 (Policy Violation). On either, the
 *     holder is destroyed (no retry storm) and a
 *     `kioku-auth-failed` CustomEvent is dispatched on `window` so
 *     the host (App.tsx) can force a logout → re-login flow.
 *   • Normal close codes (1000, 1006, 1012, …) trigger backoff
 *     reconnect through R418 `nextBackoffMs` as before.
 *   • Cross-tab token rotation: when another tab logs out, the
 *     httpOnly cookie is invalidated server-side; the next message
 *     from this tab's WS triggers a server close → 4001 → our
 *     auth-failure branch. No client-side storage listener needed.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { nextBackoffMs } from "@/lib/ws-reconnect";

// ── Public types ─────────────────────────────────────────────────────

export type KiokuWsMessage = { type: string; [k: string]: unknown };
export type KiokuWsListener = (msg: KiokuWsMessage) => void;

export interface UseKiokuWebSocketOptions {
  roomId: number | null | undefined;
  sessionToken: string | null | undefined;
  /** Disable connection without unmounting — default true. */
  enabled?: boolean;
  /** Override for tests so the close grace timer doesn't slow them down. */
  closeGraceMs?: number;
  /**
   * Override for tests — by default we use `window.WebSocket`. Tests inject
   * a fake. This is the ONLY non-default constructor path. Production never
   * passes this.
   */
  wsFactory?: (url: string) => WebSocket;
}

export interface UseKiokuWebSocketResult {
  /** True iff readyState === OPEN. */
  connected: boolean;
  /** Register a message listener. Returns synchronous unsubscribe (N1). */
  subscribe: (listener: KiokuWsListener) => () => void;
  /** Send JSON payload. Returns false when WS is not OPEN (strict-fail, Q-A). */
  send: (payload: object) => boolean;
}

// ── Internal holder ───────────────────────────────────────────────────

interface HolderOpts {
  closeGraceMs: number;
  wsFactory?: (url: string) => WebSocket;
}

interface Holder {
  key: string;
  roomId: number;
  /** Refcount of mounted hooks pointing at this holder. */
  refs: number;
  /** Pending close timer when refs hits 0. Cleared on re-acquire. */
  closeTimer: ReturnType<typeof setTimeout> | null;
  /** Live listeners. Order doesn't matter; Set keeps add/remove O(1). */
  listeners: Set<KiokuWsListener>;
  /** Connected-state subscribers (so React can re-render on open/close). */
  connectedSubs: Set<(c: boolean) => void>;
  /** Current WS instance — null while reconnecting. */
  ws: WebSocket | null;
  /** True when readyState is OPEN. */
  connected: boolean;
  /** Reconnect attempt counter for backoff. */
  reconnectAttempt: number;
  /** Reconnect timer if scheduled. */
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  /** True once teardown has begun — blocks reconnect. */
  destroyed: boolean;
  /** Bound ws URL builder so we don't keep the token in module scope. */
  buildUrl: () => string;
  /** Test-only WS factory. */
  wsFactory?: (url: string) => WebSocket;
  /** Send subscribe payloads on open + reconnect. */
  emitSubscribes: (ws: WebSocket) => void;
}

// ── Registry (with HMR fallback per N2) ──────────────────────────────

declare global {
  // eslint-disable-next-line no-var
  var __kiokuWsRegistry: Map<string, Holder> | undefined;
}

function getRegistry(): Map<string, Holder> {
  // Production: clean module-scope Map. Dev/HMR: persist across hot reloads
  // via window so the prior WS can be torn down rather than leaked.
  const isDev =
    typeof import.meta !== "undefined" &&
    !!(import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV;
  if (isDev && typeof window !== "undefined") {
    const w = window as unknown as { __kiokuWsRegistry?: Map<string, Holder> };
    if (!w.__kiokuWsRegistry) w.__kiokuWsRegistry = new Map();
    return w.__kiokuWsRegistry;
  }
  if (!globalThis.__kiokuWsRegistry) {
    globalThis.__kiokuWsRegistry = new Map();
  }
  return globalThis.__kiokuWsRegistry;
}

// ── Holder lifecycle ─────────────────────────────────────────────────

function makeKey(roomId: number, token: string): string {
  // We hash neither — we just keep them in closure scope on the holder.
  // The Map key is opaque to callers and never leaves this module.
  // R459 — token may be empty when auth is cookie-only (auto-restore from
  // httpOnly kioku_session). The Map key still uniquely identifies the
  // room since cookies are scoped per-origin.
  return `${roomId}::${token}`;
}

function buildWsUrl(token: string): string {
  // R459 — when token is empty, omit ?token= so the server falls back
  // to httpOnly cookie auth (server/ws.ts authenticateWs reads
  // kioku_session cookie). Cookies are sent automatically on same-origin
  // WebSocket upgrade requests.
  const qs = token ? `?token=${encodeURIComponent(token)}` : "";
  if (typeof window === "undefined") {
    return `ws://localhost/ws${qs}`;
  }
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws${qs}`;
}

function notifyConnected(h: Holder) {
  for (const sub of h.connectedSubs) sub(h.connected);
}

function attachWs(h: Holder) {
  if (h.destroyed) return;
  const url = h.buildUrl();
  const ws = h.wsFactory ? h.wsFactory(url) : new WebSocket(url);
  h.ws = ws;

  ws.onopen = () => {
    if (h.destroyed) {
      try { ws.close(); } catch { /* noop */ }
      return;
    }
    h.connected = true;
    h.reconnectAttempt = 0;
    h.emitSubscribes(ws);
    notifyConnected(h);
  };

  ws.onmessage = (ev: MessageEvent) => {
    if (h.destroyed) return;
    let data: KiokuWsMessage | null = null;
    try {
      data = JSON.parse(typeof ev.data === "string" ? ev.data : "") as KiokuWsMessage;
    } catch {
      return;
    }
    if (!data || typeof data !== "object") return;

    // Defence-in-depth (Q4): drop messages tagged with a different roomId.
    // Server already gates via roomClients.get(roomId); this catches the
    // brief room-switch race where the new subscribe hasn't propagated yet.
    const dataRoomId = (data as { roomId?: unknown }).roomId;
    if (typeof dataRoomId === "number" && dataRoomId !== h.roomId) {
      return;
    }

    for (const fn of h.listeners) {
      try { fn(data); } catch { /* listener-local error, isolate */ }
    }
  };

  ws.onclose = (ev: CloseEvent) => {
    if (h.ws === ws) h.ws = null;
    if (h.connected) {
      h.connected = false;
      notifyConnected(h);
    }
    if (h.destroyed) return;

    // BRO1 R448 BLOCKER-C2 — auth-failure reconnect loop break.
    // Server closes with:
    //   • 1008 (Policy Violation) — standard auth-failure close code.
    //   • 4001..4099 (application-defined) — server/ws.ts uses 4001
    //     "Unauthorized" on `authenticateWsAsync` failure (verified
    //     server/ws.ts:122).
    // On those codes, KILL the holder so we stop retry storm with a
    // permanently-bad token. Consumers observe `connected: false` and
    // get an `kioku-auth-failed` window event so the host can force
    // logout / re-login. Normal codes (1000 clean close, 1006 abnormal,
    // 1012 service restart, etc.) still reconnect through backoff.
    const code = typeof ev?.code === "number" ? ev.code : 0;
    const isAuthFail =
      code === 1008 || (code >= 4000 && code < 4100);
    if (isAuthFail) {
      if (typeof window !== "undefined") {
        try {
          window.dispatchEvent(
            new CustomEvent("kioku-auth-failed", {
              detail: { code, reason: ev?.reason ?? null },
            }),
          );
        } catch { /* env without CustomEvent — ignore */ }
      }
      // Mark destroyed so no reconnect fires. Don't delete from registry
      // here — releaseHolder path owns that. New acquire with a fresh
      // token will get a DIFFERENT key (per-token holder) and a new
      // holder entry.
      destroyHolder(h);
      return;
    }

    const delay = nextBackoffMs(h.reconnectAttempt++);
    h.reconnectTimer = setTimeout(() => {
      h.reconnectTimer = null;
      attachWs(h);
    }, delay);
  };

  ws.onerror = () => {
    try { ws.close(); } catch { /* noop */ }
  };
}

function destroyHolder(h: Holder) {
  if (h.destroyed) return;
  h.destroyed = true;
  if (h.reconnectTimer !== null) {
    clearTimeout(h.reconnectTimer);
    h.reconnectTimer = null;
  }
  if (h.closeTimer !== null) {
    clearTimeout(h.closeTimer);
    h.closeTimer = null;
  }
  h.listeners.clear();
  h.connectedSubs.clear();
  if (h.ws) {
    try { h.ws.close(); } catch { /* noop */ }
    h.ws = null;
  }
}

function acquireHolder(
  registry: Map<string, Holder>,
  key: string,
  roomId: number,
  token: string,
  opts: HolderOpts,
): Holder {
  let h = registry.get(key);
  if (h) {
    h.refs += 1;
    if (h.closeTimer !== null) {
      clearTimeout(h.closeTimer);
      h.closeTimer = null;
    }
    return h;
  }
  // Token captured in closure; never stored on the holder object.
  const buildUrl = () => buildWsUrl(token);
  h = {
    key,
    roomId,
    refs: 1,
    closeTimer: null,
    listeners: new Set(),
    connectedSubs: new Set(),
    ws: null,
    connected: false,
    reconnectAttempt: 0,
    reconnectTimer: null,
    destroyed: false,
    buildUrl,
    wsFactory: opts.wsFactory,
    emitSubscribes: (ws: WebSocket) => {
      // Dual subscribe: room (numeric) + user-topic (Luca Board). Both
      // re-emitted on every reconnect.
      try {
        ws.send(JSON.stringify({ type: "subscribe", roomId }));
        ws.send(JSON.stringify({ type: "subscribe", topic: "user" }));
      } catch { /* close handler will reconnect */ }
    },
  };
  registry.set(key, h);
  attachWs(h);
  return h;
}

function releaseHolder(
  registry: Map<string, Holder>,
  h: Holder,
  graceMs: number,
) {
  h.refs = Math.max(0, h.refs - 1);
  if (h.refs > 0) return;
  // Schedule grace close; another mount in the next tick will cancel it.
  if (h.closeTimer !== null) clearTimeout(h.closeTimer);
  h.closeTimer = setTimeout(() => {
    if (h.refs > 0) return; // re-acquired in the meantime
    if (registry.get(h.key) === h) registry.delete(h.key);
    destroyHolder(h);
  }, graceMs);
}

// ── Hook ──────────────────────────────────────────────────────────────

const DEFAULT_GRACE_MS = 5000;

export function useKiokuWebSocket(
  opts: UseKiokuWebSocketOptions,
): UseKiokuWebSocketResult {
  const {
    roomId,
    sessionToken,
    enabled = true,
    closeGraceMs = DEFAULT_GRACE_MS,
    wsFactory,
  } = opts;

  // R459 — sessionToken is optional. When the user restored a session from
  // an httpOnly cookie (App.tsx /api/auth/me path), `sessionToken` in
  // React state is null but the cookie authorises us anyway. Previous
  // behaviour gated active on `!!sessionToken` which left WS forever in
  // "Reconnecting..." for cookie-only sessions and broke partner-chat
  // real-time updates. Now active only requires a roomId; the WS upgrade
  // request carries the cookie automatically.
  const active = enabled && typeof roomId === "number";
  const key = active ? makeKey(roomId as number, sessionToken ?? "") : null;

  const holderRef = useRef<Holder | null>(null);
  const [connected, setConnected] = useState<boolean>(false);

  useEffect(() => {
    if (!active || key === null) {
      setConnected(false);
      return;
    }
    const registry = getRegistry();
    const h = acquireHolder(
      registry,
      key,
      roomId as number,
      sessionToken ?? "",
      { closeGraceMs, wsFactory },
    );
    holderRef.current = h;

    // Subscribe to connected-state updates.
    const onConnected = (c: boolean) => setConnected(c);
    h.connectedSubs.add(onConnected);
    setConnected(h.connected);

    // Synchronous cleanup (N1): unsubscribe + release happen in React
    // cleanup phase BEFORE the next effect's setup runs.
    return () => {
      h.connectedSubs.delete(onConnected);
      if (holderRef.current === h) holderRef.current = null;
      releaseHolder(registry, h, closeGraceMs);
    };
  }, [active, key, roomId, sessionToken, closeGraceMs, wsFactory]);

  // Stable subscribe / send: route to whatever holder is current.
  const subscribe = useMemo(() => {
    return (listener: KiokuWsListener): (() => void) => {
      const h = holderRef.current;
      if (!h) {
        // Caller is in the gap between unmount and next mount, or the hook
        // is disabled. Return a no-op unsubscribe so callers don't crash.
        return () => { /* noop */ };
      }
      h.listeners.add(listener);
      return () => {
        // N1 — synchronous unsubscribe. We use the captured holder, not
        // holderRef.current, so the unsubscribe targets the holder the
        // caller registered with (defensive against room-switch race).
        h.listeners.delete(listener);
      };
    };
    // Recreated when roomId/token changes so closures grab the right holder.
  }, [active, key]);

  const send = useMemo(() => {
    return (payload: object): boolean => {
      const h = holderRef.current;
      if (!h || !h.ws || h.ws.readyState !== WebSocket.OPEN) return false;
      try {
        h.ws.send(JSON.stringify(payload));
        return true;
      } catch {
        return false;
      }
    };
  }, [active, key]);

  return { connected, subscribe, send };
}

// ── Test-only exports ─────────────────────────────────────────────────

/**
 * Test-only: clear the module registry. Production code MUST NOT call this.
 * Exported through a stable name so tests can reset state between cases.
 */
export function __resetKiokuWsRegistryForTests(): void {
  const registry = getRegistry();
  for (const h of registry.values()) destroyHolder(h);
  registry.clear();
}

/** Test-only inspector. */
export function __getKiokuWsRegistrySizeForTests(): number {
  return getRegistry().size;
}

/**
 * Test-only: acquire/release/inspect the holder layer directly so unit
 * tests can validate registry semantics without React. Production code
 * MUST go through `useKiokuWebSocket()`.
 */
export const __testInternals = {
  makeKey,
  buildWsUrl,
  getRegistry,
  acquire(
    roomId: number,
    token: string,
    opts: HolderOpts = { closeGraceMs: DEFAULT_GRACE_MS },
  ) {
    const registry = getRegistry();
    const key = makeKey(roomId, token);
    return acquireHolder(registry, key, roomId, token, opts);
  },
  release(h: Holder, graceMs: number = DEFAULT_GRACE_MS) {
    releaseHolder(getRegistry(), h, graceMs);
  },
  destroy(h: Holder) { destroyHolder(h); },
  inspectHolder(h: Holder) {
    return {
      key: h.key,
      roomId: h.roomId,
      refs: h.refs,
      connected: h.connected,
      destroyed: h.destroyed,
      listenerCount: h.listeners.size,
      hasCloseTimer: h.closeTimer !== null,
      hasReconnectTimer: h.reconnectTimer !== null,
      reconnectAttempt: h.reconnectAttempt,
      ws: h.ws,
    };
  },
};

export type { Holder as __HolderForTests };
