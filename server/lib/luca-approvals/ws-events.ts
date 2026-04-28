/**
 * Luca Day 6 — WebSocket event fan-out for approval gate.
 *
 * Two events, both per-user (not room-scoped — Luca Board UI is global):
 *
 *   luca.approval.requested — gate created a new pending row. UI adds
 *                              the card to the board. Fields: approvalId,
 *                              toolName, draftPayload, classification,
 *                              createdAt, expiresAt.
 *
 *   luca.approval.decided   — decision landed (send/edit/reject/timeout).
 *                              UI flips the card to "sent / rejected /
 *                              edited / timed out" and greys the buttons.
 *                              Fields: approvalId, status, finalPayload,
 *                              decidedAt.
 *
 * Both wrap `broadcastToUser` from server/ws.ts. Broadcast is best-effort
 * — if no one is subscribed, the row is still durable in the DB and the
 * UI picks it up on next polling refresh.
 */

import { broadcastToUser } from "../../ws";
import type { ToolApproval } from "@shared/schema";
import type { ToolWriteClass } from "./classify";

export interface ApprovalRequestedPayload {
  approvalId: string;
  userId: number;
  agentId: number;
  toolName: string;
  draftPayload: unknown;
  classification: ToolWriteClass;
  meetingId: string | null;
  turnId: string | null;
  createdAt: Date;
  expiresAt: Date;
}

export interface ApprovalDecidedPayload {
  approvalId: string;
  userId: number;
  status: "approved" | "edited" | "rejected" | "timeout" | "error";
  toolName: string;
  finalPayload: unknown;
  decidedAt: Date;
  /** Only present when status === "approved"|"edited" AND execution has run. */
  executionResult?: unknown;
}

/**
 * Fan out a luca.approval.requested event. Called by the middleware
 * immediately after `createPendingApproval` returns a fresh row.
 *
 * Dedupe hits re-use the original row — callers should NOT broadcast
 * again for a dedupe hit (the UI already has that card).
 */
export function broadcastApprovalRequested(
  payload: ApprovalRequestedPayload,
): void {
  broadcastToUser(payload.userId, {
    type: "luca.approval.requested",
    approval_id: payload.approvalId,
    agent_id: payload.agentId,
    tool_name: payload.toolName,
    draft_payload: payload.draftPayload,
    classification: payload.classification,
    meeting_id: payload.meetingId,
    turn_id: payload.turnId,
    created_at: payload.createdAt.toISOString(),
    expires_at: payload.expiresAt.toISOString(),
  });
}

/**
 * Fan out a luca.approval.decided event. Called by the decide endpoint
 * after `decideApproval` returns, AND by the expire worker for timeouts,
 * AND after `recordExecutionResult` (so UI can render tool output).
 */
export function broadcastApprovalDecided(payload: ApprovalDecidedPayload): void {
  broadcastToUser(payload.userId, {
    type: "luca.approval.decided",
    approval_id: payload.approvalId,
    status: payload.status,
    tool_name: payload.toolName,
    final_payload: payload.finalPayload,
    decided_at: payload.decidedAt.toISOString(),
    execution_result: payload.executionResult ?? null,
  });
}

/**
 * Convenience: map a ToolApproval DB row + classification into the
 * "requested" payload. Keeps call-sites slim.
 */
export function rowToRequestedPayload(
  row: ToolApproval,
  classification: ToolWriteClass,
): ApprovalRequestedPayload {
  return {
    approvalId: row.id,
    userId: row.userId,
    agentId: row.agentId,
    toolName: row.toolName,
    draftPayload: row.draftPayload,
    classification,
    meetingId: row.meetingId,
    turnId: row.turnId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

/**
 * LEO PR-A — Telegram tool real-time event fan-out.
 *
 * Three sibling events that mirror the lifecycle the dispatcher walks
 * after the gate has cleared `send_telegram_message`:
 *
 *   luca.telegram.sent      — sendTelegramMessage returned ok=true. UI
 *                              flashes a green checkmark on the Luca
 *                              Board outreach lane and persists in the
 *                              recent-activity feed.
 *   luca.telegram.failed    — sendTelegramMessage returned ok=false
 *                              (rate-limit, fetch_threw, non-2xx, missing
 *                              token). UI surfaces the error code so BOSS
 *                              can act (e.g. reconnect Telegram). NO
 *                              email fallback by design.
 *   luca.telegram.deferred  — quiet-hours short-circuited the send. UI
 *                              shows the queued state with the deferred
 *                              ISO timestamp so BOSS knows when it will
 *                              wake up. PR-B replays the queue.
 *
 * Like the approval events above, this is best-effort — broadcast
 * failures are swallowed by the caller (the dispatcher) so the tool
 * call still returns a structured result.
 */
export interface TelegramEventPayload {
  userId: number;
  status: "sent" | "failed" | "deferred";
  urgency: "high" | "normal" | "low";
  /** The on-the-wire text (already truncated to 200 chars by telegram.ts). */
  message: string;
  /** Stable error code on failed sends. Null on sent / deferred. */
  error?: string | null;
  /** Caller-supplied context (e.g. "vip_sender:...", "defer_until=..."). */
  reason?: string | null;
  /** Optional luca_telegram_log row id when caller has it (else null). */
  logId?: string | null;
  /** Wall-clock at the moment the dispatcher decided this status. */
  timestamp: Date;
}

export function broadcastTelegramEvent(payload: TelegramEventPayload): void {
  const type =
    payload.status === "sent"
      ? "luca.telegram.sent"
      : payload.status === "failed"
        ? "luca.telegram.failed"
        : "luca.telegram.deferred";
  broadcastToUser(payload.userId, {
    type,
    log_id: payload.logId ?? null,
    urgency: payload.urgency,
    message: payload.message,
    error: payload.error ?? null,
    reason: payload.reason ?? null,
    timestamp: payload.timestamp.toISOString(),
  });
}
