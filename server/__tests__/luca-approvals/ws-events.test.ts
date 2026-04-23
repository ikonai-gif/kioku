/**
 * Luca Day 6 — ws-events.ts unit tests.
 *
 * Verify that the event builders format the payload correctly and
 * route through broadcastToUser. We mock the ws module so we can
 * inspect args.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolApproval } from "@shared/schema";

vi.mock("../../ws", () => ({
  broadcastToUser: vi.fn(),
}));

import { broadcastToUser } from "../../ws";
import {
  broadcastApprovalRequested,
  broadcastApprovalDecided,
  rowToRequestedPayload,
} from "../../lib/luca-approvals/ws-events";

beforeEach(() => {
  vi.clearAllMocks();
});

const fakeRow: ToolApproval = {
  id: "11111111-1111-1111-1111-111111111111",
  agentId: 16,
  userId: 10,
  meetingId: null,
  turnId: "22222222-2222-2222-2222-222222222222",
  toolName: "send_new_email",
  draftPayload: { to: "x@y.z", subject: "hi" },
  finalPayload: null,
  status: "pending",
  decisionNote: null,
  codeSha: "abc",
  createdAt: new Date("2026-04-22T10:00:00Z"),
  expiresAt: new Date("2026-04-23T10:00:00Z"),
  decidedAt: null,
  executedAt: null,
  executionResult: null,
} as ToolApproval;

describe("ws-events: broadcastApprovalRequested", () => {
  it("routes via broadcastToUser with the right type and fields", () => {
    broadcastApprovalRequested({
      approvalId: fakeRow.id,
      userId: fakeRow.userId,
      agentId: fakeRow.agentId,
      toolName: fakeRow.toolName,
      draftPayload: fakeRow.draftPayload,
      classification: "HIGH_STAKES_WRITE",
      meetingId: fakeRow.meetingId,
      turnId: fakeRow.turnId,
      createdAt: fakeRow.createdAt,
      expiresAt: fakeRow.expiresAt,
    });
    expect(broadcastToUser).toHaveBeenCalledTimes(1);
    expect(broadcastToUser).toHaveBeenCalledWith(
      10,
      expect.objectContaining({
        type: "luca.approval.requested",
        approval_id: fakeRow.id,
        agent_id: 16,
        tool_name: "send_new_email",
        classification: "HIGH_STAKES_WRITE",
        meeting_id: null,
        turn_id: fakeRow.turnId,
        created_at: "2026-04-22T10:00:00.000Z",
        expires_at: "2026-04-23T10:00:00.000Z",
      }),
    );
  });

  it("passes draft_payload through unchanged", () => {
    broadcastApprovalRequested({
      approvalId: "x",
      userId: 10,
      agentId: 16,
      toolName: "workspace_save",
      draftPayload: { path: "/luca/notes/a.md", content: "hello" },
      classification: "HIGH_STAKES_WRITE",
      meetingId: null,
      turnId: null,
      createdAt: new Date(),
      expiresAt: new Date(),
    });
    const call = (broadcastToUser as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    const payload = call[1] as Record<string, unknown>;
    expect(payload.draft_payload).toEqual({
      path: "/luca/notes/a.md",
      content: "hello",
    });
  });
});

describe("ws-events: broadcastApprovalDecided", () => {
  it("emits luca.approval.decided with the right status", () => {
    broadcastApprovalDecided({
      approvalId: "x",
      userId: 10,
      status: "approved",
      toolName: "send_new_email",
      finalPayload: { to: "x@y.z" },
      decidedAt: new Date("2026-04-22T11:00:00Z"),
    });
    expect(broadcastToUser).toHaveBeenCalledWith(
      10,
      expect.objectContaining({
        type: "luca.approval.decided",
        approval_id: "x",
        status: "approved",
        tool_name: "send_new_email",
        decided_at: "2026-04-22T11:00:00.000Z",
        execution_result: null,
      }),
    );
  });

  it("includes execution_result when provided", () => {
    broadcastApprovalDecided({
      approvalId: "x",
      userId: 10,
      status: "approved",
      toolName: "send_new_email",
      finalPayload: { to: "x@y.z" },
      decidedAt: new Date(),
      executionResult: { ok: true, messageId: "abc" },
    });
    const call = (broadcastToUser as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    const payload = call[1] as Record<string, unknown>;
    expect(payload.execution_result).toEqual({ ok: true, messageId: "abc" });
  });

  it("handles timeout status", () => {
    broadcastApprovalDecided({
      approvalId: "x",
      userId: 10,
      status: "timeout",
      toolName: "clone_voice",
      finalPayload: null,
      decidedAt: new Date(),
    });
    const call = (broadcastToUser as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect((call[1] as Record<string, unknown>).status).toBe("timeout");
  });
});

describe("ws-events: rowToRequestedPayload", () => {
  it("maps ToolApproval row to requested payload shape", () => {
    const payload = rowToRequestedPayload(fakeRow, "HIGH_STAKES_WRITE");
    expect(payload).toEqual({
      approvalId: fakeRow.id,
      userId: fakeRow.userId,
      agentId: fakeRow.agentId,
      toolName: fakeRow.toolName,
      draftPayload: fakeRow.draftPayload,
      classification: "HIGH_STAKES_WRITE",
      meetingId: fakeRow.meetingId,
      turnId: fakeRow.turnId,
      createdAt: fakeRow.createdAt,
      expiresAt: fakeRow.expiresAt,
    });
  });
});
