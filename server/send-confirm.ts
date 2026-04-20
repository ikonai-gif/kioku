/**
 * Gmail Send Confirmation Store
 *
 * One-time tokens with 15-minute TTL that hold a pending email action
 * (send_new or send_reply) until the UI owner confirms or cancels it.
 *
 * Storage: in-memory Map (no DB required, survives a single Railway instance
 * restart gracefully — worst case the user sees an expired token and retries).
 */

import { randomBytes } from "crypto";
import logger from "./logger";

// ── Types ────────────────────────────────────────────────────────────────────

export type PendingAction =
  | {
      kind: "send_new";
      userId: number;
      account: string;
      to: string;
      subject: string;
      body: string;
      cc?: string;
      bcc?: string;
    }
  | {
      kind: "send_reply";
      userId: number;
      account: string;
      messageId: string;
      body: string;
    };

export interface PendingEntry {
  token: string;
  action: PendingAction;
  expiresAt: number; // epoch ms
  usedAt?: number;   // set on first use to prevent replay
}

// ── Store ────────────────────────────────────────────────────────────────────

const TTL_MS = 15 * 60 * 1000; // 15 minutes

const store = new Map<string, PendingEntry>();

/** Purge expired/used tokens (called on every create to keep memory clean). */
function purge(): void {
  const now = Date.now();
  for (const [tok, entry] of store) {
    if (entry.usedAt || entry.expiresAt < now) {
      store.delete(tok);
    }
  }
}

/** Store a pending action and return a one-time confirmation token. */
export function createPending(action: PendingAction): { token: string; expiresAt: number } {
  purge();
  const token = randomBytes(24).toString("hex");
  const expiresAt = Date.now() + TTL_MS;
  store.set(token, { token, action, expiresAt });
  logger.info(
    { source: "send-confirm", kind: action.kind, userId: action.userId },
    "Email confirmation pending"
  );
  return { token, expiresAt };
}

/**
 * Consume a token — marks it used and returns the action payload.
 * Throws with a meaningful message on invalid / expired / already-used tokens.
 */
export function consumePending(token: string): PendingEntry {
  const entry = store.get(token);
  if (!entry) {
    throw Object.assign(new Error("Confirmation token not found or already used"), { status: 410 });
  }
  if (Date.now() > entry.expiresAt) {
    store.delete(token);
    throw Object.assign(new Error("Confirmation token expired"), { status: 410 });
  }
  if (entry.usedAt) {
    throw Object.assign(new Error("Confirmation token already used"), { status: 410 });
  }
  entry.usedAt = Date.now();
  return entry;
}

/** Peek at a token without consuming it (for preview before confirm/cancel). */
export function peekPending(token: string): PendingEntry | null {
  const entry = store.get(token);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { store.delete(token); return null; }
  if (entry.usedAt) return null;
  return entry;
}

/** Cancel a token (marks as used without executing the action). */
export function cancelPending(token: string): void {
  const entry = store.get(token);
  if (!entry) return; // already gone — fine
  entry.usedAt = Date.now();
}
