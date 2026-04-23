/**
 * Luca Day 6 — HTTP routes for the approval gate.
 *
 * All routes live under `/api/luca/approvals/*` and require the
 * authenticated user to own the approval row. Master-key callers
 * (owner userId=10) are accepted via the same `getUser` helper as
 * the rest of the app.
 *
 * Endpoints:
 *   GET    /api/luca/approvals           — list pending for the user
 *   GET    /api/luca/approvals/:id       — fetch one (any status)
 *   POST   /api/luca/approvals/:id/decide — apply Kote's decision
 *
 * The /decide endpoint is the heart of the gate: it flips the row's
 * status, broadcasts luca.approval.decided, and (for send/edit) re-enters
 * `executePartnerTool` with `_skipApprovalGate:true` so the actual tool
 * handler runs with Kote's final payload. Execution result is recorded
 * back onto the same row via `recordExecutionResult` and a second
 * `luca.approval.decided` event goes out with the tool output.
 *
 * Re-entry rationale: the dispatcher knows how to run every tool (media,
 * workspace, remember, Gmail/Stripe/github_call, etc.); this file would
 * have to duplicate that routing. Threading a private option keeps the
 * gate + decide logic in one narrow module and reuses the battle-tested
 * dispatcher.
 */

import type { Express, Request, Response, NextFunction } from "express";
import logger from "./logger";
import {
  getApproval,
  listPendingForUser,
  decideApproval,
  recordExecutionResult,
  ApprovalError,
  type ApprovalAction,
} from "./lib/luca-approvals/gate";
import { broadcastApprovalDecided } from "./lib/luca-approvals/ws-events";
import { executePartnerTool } from "./deliberation";

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<any>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export function registerLucaApprovalRoutes(
  app: Express,
  getUser: (req: any) => Promise<number | null>,
): void {
  // ── GET /api/luca/approvals ─────────────────────────────────────
  // List pending approvals for the authenticated user. Newest first.
  // Default limit 50 (max 200 — UI paginates on scroll).
  app.get(
    "/api/luca/approvals",
    asyncHandler(async (req, res) => {
      const userId = await getUser(req);
      if (!userId) return res.status(401).json({ error: "Unauthorized" });
      const limitRaw = Number.parseInt(
        (req.query.limit as string) ?? "50",
        10,
      );
      const limit = Number.isFinite(limitRaw)
        ? Math.max(1, Math.min(200, limitRaw))
        : 50;
      const rows = await listPendingForUser(userId, limit);
      res.json({ approvals: rows });
    }),
  );

  // ── GET /api/luca/approvals/:id ─────────────────────────────────
  // Fetch one approval by id. Owner-only — returns 404 for non-owners
  // (avoid disclosing existence to cross-user probes).
  app.get(
    "/api/luca/approvals/:id",
    asyncHandler(async (req, res) => {
      const userId = await getUser(req);
      if (!userId) return res.status(401).json({ error: "Unauthorized" });
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const row = await getApproval(id as string);
      if (!row || row.userId !== userId) {
        return res.status(404).json({ error: "approval_not_found" });
      }
      res.json({ approval: row });
    }),
  );

  // ── POST /api/luca/approvals/:id/decide ─────────────────────────
  // Apply Kote's decision. Body: { action, edited_payload?, note? }.
  //
  //   action="send"    → status=approved   → re-enter dispatcher
  //   action="edit"    → status=edited     → re-enter dispatcher with edited_payload
  //   action="reject"  → status=rejected   → no execution
  //
  // On send/edit the endpoint re-enters `executePartnerTool` with
  // `_skipApprovalGate:true` and stores the result via
  // `recordExecutionResult`. The response includes the execution result
  // so the UI can show outcome immediately without a second fetch.
  app.post(
    "/api/luca/approvals/:id/decide",
    asyncHandler(async (req, res) => {
      const userId = await getUser(req);
      if (!userId) return res.status(401).json({ error: "Unauthorized" });

      const { action, edited_payload, note } = (req.body ?? {}) as {
        action?: string;
        edited_payload?: unknown;
        note?: string;
      };
      if (action !== "send" && action !== "edit" && action !== "reject") {
        return res.status(400).json({
          error: "invalid_action",
          detail: "action must be one of: send, edit, reject",
        });
      }

      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      let descriptor;
      try {
        descriptor = await decideApproval({
          approvalId: id as string,
          action: action as ApprovalAction,
          deciderUserId: userId,
          editedPayload: action === "edit" ? edited_payload : undefined,
          note: typeof note === "string" ? note : undefined,
        });
      } catch (e) {
        if (e instanceof ApprovalError) {
          const map: Record<string, number> = {
            approval_not_found: 404,
            approval_already_decided: 409,
            approval_not_authorized: 404, // mask existence
            approval_edit_missing_payload: 400,
            approval_invalid_action: 400,
            approval_queue_full: 429,
          };
          return res.status(map[e.code] ?? 400).json({ error: e.code, detail: e.message });
        }
        throw e;
      }

      // Broadcast the decision immediately (before execution) so the UI
      // flips status. We'll fire a second `decided` event with
      // execution_result once the tool handler returns.
      try {
        broadcastApprovalDecided({
          approvalId: descriptor.approval.id,
          userId: descriptor.approval.userId,
          status: descriptor.approval.status as
            | "approved"
            | "edited"
            | "rejected",
          toolName: descriptor.approval.toolName,
          finalPayload: descriptor.approval.finalPayload,
          decidedAt: descriptor.approval.decidedAt ?? new Date(),
        });
      } catch (e) {
        logger.warn(
          {
            component: "luca-approvals",
            event: "broadcast_decided_failed",
            approvalId: descriptor.approval.id,
            err: e instanceof Error ? e.message : String(e),
          },
          "[luca-approvals] broadcastApprovalDecided failed",
        );
      }

      // Rejection: done. Return the row.
      if (!descriptor.shouldExecute) {
        return res.json({
          approval: descriptor.approval,
          executed: false,
        });
      }

      // Send / edit: re-enter dispatcher with the approved payload.
      // `_skipApprovalGate:true` is the magic bit — without it we'd
      // recursively gate and insert a second pending row forever.
      let executionOk = true;
      let executionOutput: unknown = null;
      try {
        executionOutput = await executePartnerTool(
          descriptor.approval.toolName,
          descriptor.payloadToExecute as Record<string, unknown>,
          descriptor.approval.userId,
          descriptor.approval.agentId,
          undefined, // no roomId — Luca Board decisions aren't tied to a chat room
          { _skipApprovalGate: true, _approvalId: descriptor.approval.id },
        );
      } catch (e) {
        executionOk = false;
        executionOutput = { error: e instanceof Error ? e.message : String(e) };
        logger.error(
          {
            component: "luca-approvals",
            event: "post_approval_execution_failed",
            approvalId: descriptor.approval.id,
            tool: descriptor.approval.toolName,
            err: e instanceof Error ? e.message : String(e),
          },
          "[luca-approvals] post-approval tool execution threw",
        );
      }

      const updated = await recordExecutionResult(descriptor.approval.id, {
        ok: executionOk,
        result: executionOutput,
      });

      // Second broadcast — UI renders tool output under the decided card.
      try {
        broadcastApprovalDecided({
          approvalId: descriptor.approval.id,
          userId: descriptor.approval.userId,
          status: (updated?.status ?? descriptor.approval.status) as
            | "approved"
            | "edited"
            | "rejected"
            | "error",
          toolName: descriptor.approval.toolName,
          finalPayload: descriptor.approval.finalPayload,
          decidedAt: updated?.decidedAt ?? descriptor.approval.decidedAt ?? new Date(),
          executionResult: executionOutput,
        });
      } catch { /* already logged; continue */ }

      res.json({
        approval: updated ?? descriptor.approval,
        executed: true,
        execution_ok: executionOk,
        execution_result: executionOutput,
      });
    }),
  );
}
