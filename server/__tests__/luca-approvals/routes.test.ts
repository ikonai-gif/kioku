/**
 * Luca Day 6 — HTTP route tests for /api/luca/approvals/*.
 *
 * Strategy: mock the gate module and the dispatcher, mount the
 * routes on a bare Express app with a stub getUser, and drive via
 * supertest.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import express from "express";
import request from "supertest";

// ─── Mocks ───────────────────────────────────────────────────────

const listPendingForUser = vi.fn();
const getApproval = vi.fn();
const decideApproval = vi.fn();
const recordExecutionResult = vi.fn();

vi.mock("../../lib/luca-approvals/gate", async () => {
  const actual = await vi.importActual<any>("../../lib/luca-approvals/gate");
  return {
    ...actual,
    listPendingForUser: (...a: unknown[]) => listPendingForUser(...a),
    getApproval: (...a: unknown[]) => getApproval(...a),
    decideApproval: (...a: unknown[]) => decideApproval(...a),
    recordExecutionResult: (...a: unknown[]) => recordExecutionResult(...a),
  };
});

vi.mock("../../lib/luca-approvals/ws-events", () => ({
  broadcastApprovalDecided: vi.fn(),
  broadcastApprovalRequested: vi.fn(),
  rowToRequestedPayload: vi.fn((r: any) => r),
}));

// Mock executePartnerTool so we don't pull the whole dispatcher into
// route tests. We inject the return value per-test via the shared ref.
const executePartnerToolMock = vi.fn();
vi.mock("../../deliberation", () => ({
  executePartnerTool: (...a: unknown[]) => executePartnerToolMock(...a),
}));

import { registerLucaApprovalRoutes } from "../../luca-approval-routes";
import { ApprovalError } from "../../lib/luca-approvals/gate";

function makeApp(userId: number | null) {
  const app = express();
  app.use(express.json());
  registerLucaApprovalRoutes(app, async () => userId);
  return app;
}

const baseApproval = {
  id: "aaa-bbb",
  agentId: 16,
  userId: 10,
  meetingId: null,
  turnId: null,
  toolName: "send_new_email",
  draftPayload: { to: "x@y.z", subject: "hi" },
  finalPayload: null,
  status: "pending" as const,
  decisionNote: null,
  codeSha: "abc",
  createdAt: new Date("2026-04-22T10:00:00Z"),
  expiresAt: new Date("2026-04-23T10:00:00Z"),
  decidedAt: null,
  executedAt: null,
  executionResult: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── GET /api/luca/approvals ────────────────────────────────────

describe("GET /api/luca/approvals", () => {
  it("401 when unauthenticated", async () => {
    const app = makeApp(null);
    const res = await request(app).get("/api/luca/approvals");
    expect(res.status).toBe(401);
  });

  it("returns pending list for authed user", async () => {
    listPendingForUser.mockResolvedValue([baseApproval]);
    const app = makeApp(10);
    const res = await request(app).get("/api/luca/approvals");
    expect(res.status).toBe(200);
    expect(res.body.approvals).toHaveLength(1);
    expect(res.body.approvals[0].id).toBe("aaa-bbb");
    expect(listPendingForUser).toHaveBeenCalledWith(10, 50);
  });

  it("respects limit query param (clamped 1..200)", async () => {
    listPendingForUser.mockResolvedValue([]);
    const app = makeApp(10);
    await request(app).get("/api/luca/approvals?limit=500");
    expect(listPendingForUser).toHaveBeenCalledWith(10, 200);
    await request(app).get("/api/luca/approvals?limit=-5");
    expect(listPendingForUser).toHaveBeenLastCalledWith(10, 1);
    await request(app).get("/api/luca/approvals?limit=10");
    expect(listPendingForUser).toHaveBeenLastCalledWith(10, 10);
  });
});

// ─── GET /api/luca/approvals/:id ────────────────────────────────

describe("GET /api/luca/approvals/:id", () => {
  it("401 when unauthenticated", async () => {
    const app = makeApp(null);
    const res = await request(app).get("/api/luca/approvals/aaa-bbb");
    expect(res.status).toBe(401);
  });

  it("404 when row not found", async () => {
    getApproval.mockResolvedValue(null);
    const app = makeApp(10);
    const res = await request(app).get("/api/luca/approvals/missing");
    expect(res.status).toBe(404);
  });

  it("404 when row belongs to another user (existence masking)", async () => {
    getApproval.mockResolvedValue({ ...baseApproval, userId: 999 });
    const app = makeApp(10);
    const res = await request(app).get("/api/luca/approvals/aaa-bbb");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("approval_not_found");
  });

  it("200 + row when owned by user", async () => {
    getApproval.mockResolvedValue(baseApproval);
    const app = makeApp(10);
    const res = await request(app).get("/api/luca/approvals/aaa-bbb");
    expect(res.status).toBe(200);
    expect(res.body.approval.id).toBe("aaa-bbb");
  });
});

// ─── POST /api/luca/approvals/:id/decide ────────────────────────

describe("POST /api/luca/approvals/:id/decide", () => {
  it("401 when unauthenticated", async () => {
    const app = makeApp(null);
    const res = await request(app)
      .post("/api/luca/approvals/aaa-bbb/decide")
      .send({ action: "send" });
    expect(res.status).toBe(401);
  });

  it("400 when action is missing/unknown", async () => {
    const app = makeApp(10);
    const res = await request(app)
      .post("/api/luca/approvals/aaa-bbb/decide")
      .send({ action: "bogus" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_action");
  });

  it("rejects: no execution, returns approval", async () => {
    decideApproval.mockResolvedValue({
      approval: { ...baseApproval, status: "rejected", decidedAt: new Date() },
      shouldExecute: false,
      payloadToExecute: null,
    });
    const app = makeApp(10);
    const res = await request(app)
      .post("/api/luca/approvals/aaa-bbb/decide")
      .send({ action: "reject" });
    expect(res.status).toBe(200);
    expect(res.body.executed).toBe(false);
    expect(res.body.approval.status).toBe("rejected");
    expect(executePartnerToolMock).not.toHaveBeenCalled();
  });

  it("send: re-enters dispatcher with _skipApprovalGate=true", async () => {
    decideApproval.mockResolvedValue({
      approval: {
        ...baseApproval,
        status: "approved",
        finalPayload: baseApproval.draftPayload,
        decidedAt: new Date(),
      },
      shouldExecute: true,
      payloadToExecute: baseApproval.draftPayload,
    });
    executePartnerToolMock.mockResolvedValue(
      JSON.stringify({ ok: true, messageId: "m1" }),
    );
    recordExecutionResult.mockResolvedValue({
      ...baseApproval,
      status: "approved",
    });

    const app = makeApp(10);
    const res = await request(app)
      .post("/api/luca/approvals/aaa-bbb/decide")
      .send({ action: "send" });

    expect(res.status).toBe(200);
    expect(res.body.executed).toBe(true);
    expect(res.body.execution_ok).toBe(true);

    // Verify the re-entry call signature
    expect(executePartnerToolMock).toHaveBeenCalledTimes(1);
    const [toolName, payload, userId, agentId, roomId, opts] =
      executePartnerToolMock.mock.calls[0];
    expect(toolName).toBe("send_new_email");
    expect(payload).toEqual(baseApproval.draftPayload);
    expect(userId).toBe(10);
    expect(agentId).toBe(16);
    expect(roomId).toBeUndefined();
    expect(opts).toMatchObject({ _skipApprovalGate: true, _approvalId: "aaa-bbb" });

    expect(recordExecutionResult).toHaveBeenCalledWith("aaa-bbb", {
      ok: true,
      result: JSON.stringify({ ok: true, messageId: "m1" }),
    });
  });

  it("edit: passes edited_payload to dispatcher", async () => {
    const editedPayload = { to: "alice@edited.com", subject: "revised" };
    decideApproval.mockResolvedValue({
      approval: {
        ...baseApproval,
        status: "edited",
        finalPayload: editedPayload,
        decidedAt: new Date(),
      },
      shouldExecute: true,
      payloadToExecute: editedPayload,
    });
    executePartnerToolMock.mockResolvedValue("ok");
    recordExecutionResult.mockResolvedValue({
      ...baseApproval,
      status: "edited",
    });

    const app = makeApp(10);
    const res = await request(app)
      .post("/api/luca/approvals/aaa-bbb/decide")
      .send({ action: "edit", edited_payload: editedPayload });

    expect(res.status).toBe(200);
    expect(decideApproval).toHaveBeenCalledWith({
      approvalId: "aaa-bbb",
      action: "edit",
      deciderUserId: 10,
      editedPayload,
      note: undefined,
    });
    expect(executePartnerToolMock.mock.calls[0][1]).toEqual(editedPayload);
  });

  it("execution failure: marks execution_ok=false + continues", async () => {
    decideApproval.mockResolvedValue({
      approval: {
        ...baseApproval,
        status: "approved",
        finalPayload: baseApproval.draftPayload,
        decidedAt: new Date(),
      },
      shouldExecute: true,
      payloadToExecute: baseApproval.draftPayload,
    });
    executePartnerToolMock.mockRejectedValue(new Error("gmail 500"));
    recordExecutionResult.mockResolvedValue({
      ...baseApproval,
      status: "error",
    });

    const app = makeApp(10);
    const res = await request(app)
      .post("/api/luca/approvals/aaa-bbb/decide")
      .send({ action: "send" });

    expect(res.status).toBe(200);
    expect(res.body.executed).toBe(true);
    expect(res.body.execution_ok).toBe(false);
    expect(res.body.execution_result).toEqual({ error: "gmail 500" });
  });

  it("maps ApprovalError codes → http status", async () => {
    decideApproval.mockRejectedValue(
      new ApprovalError("approval_already_decided", "status is approved, not pending"),
    );
    const app = makeApp(10);
    const res = await request(app)
      .post("/api/luca/approvals/aaa-bbb/decide")
      .send({ action: "send" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("approval_already_decided");
  });

  it("approval_not_found → 404", async () => {
    decideApproval.mockRejectedValue(new ApprovalError("approval_not_found"));
    const app = makeApp(10);
    const res = await request(app)
      .post("/api/luca/approvals/aaa-bbb/decide")
      .send({ action: "send" });
    expect(res.status).toBe(404);
  });

  it("approval_not_authorized → 404 (existence mask)", async () => {
    decideApproval.mockRejectedValue(
      new ApprovalError("approval_not_authorized"),
    );
    const app = makeApp(10);
    const res = await request(app)
      .post("/api/luca/approvals/aaa-bbb/decide")
      .send({ action: "send" });
    expect(res.status).toBe(404);
  });

  it("approval_edit_missing_payload → 400", async () => {
    decideApproval.mockRejectedValue(
      new ApprovalError("approval_edit_missing_payload"),
    );
    const app = makeApp(10);
    const res = await request(app)
      .post("/api/luca/approvals/aaa-bbb/decide")
      .send({ action: "edit" });
    expect(res.status).toBe(400);
  });
});
