/**
 * Luca Day 6 — executePartnerTool middleware wiring tests.
 *
 * We test the thin gate-interception slice of executePartnerTool by
 * mocking:
 *   - storage.getAgent (returns Luca or another agent)
 *   - the gate module (createPendingApproval / ApprovalError)
 *   - the ws-events module
 *   - the env helpers (toggle gate on/off, enforce vs log_only)
 *
 * We verify the middleware behavior WITHOUT exercising the downstream
 * dispatcher — tests that toggle a non-Luca agent or a READ_ONLY tool
 * expect the function to fall through past the gate block and eventually
 * hit the V1a early-route or the switch; we short-circuit by using a
 * tool name that fails the defense-in-depth guard for non-Luca (or the
 * V1a branch for Luca with a read-only tool) to avoid reaching real
 * handlers.
 *
 * This is the middleware contract, not the gate internals. Gate logic
 * is tested in gate.test.ts.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Mock env helpers to drive gate on/off in-test.
let gateActive = true;
let gateEnforcing = true;
vi.mock("../../lib/luca/env", async () => {
  const actual = await vi.importActual<any>("../../lib/luca/env");
  return {
    ...actual,
    isApprovalGateActive: () => gateActive,
    isApprovalGateEnforcing: () => gateEnforcing,
  };
});

// Mock storage.getAgent so we can flip the caller between Luca and not.
let agentResponse: { id: number; name: string } | null = {
  id: 16,
  name: "Luca",
};
vi.mock("../../storage", async () => {
  const actual = await vi.importActual<any>("../../storage");
  return {
    ...actual,
    storage: {
      ...actual.storage,
      getAgent: async () => agentResponse,
    },
  };
});

// Mock gate module so we can assert invocations + control outcomes.
const createPendingApproval = vi.fn();
vi.mock("../../lib/luca-approvals/gate", async () => {
  const actual = await vi.importActual<any>("../../lib/luca-approvals/gate");
  return {
    ...actual,
    createPendingApproval: (...a: unknown[]) => createPendingApproval(...a),
  };
});

// Mock ws-events.
const broadcastApprovalRequested = vi.fn();
vi.mock("../../lib/luca-approvals/ws-events", () => ({
  broadcastApprovalRequested: (...a: unknown[]) => broadcastApprovalRequested(...a),
  broadcastApprovalDecided: vi.fn(),
  rowToRequestedPayload: vi.fn((r: any) => r),
}));

// Mock the V1a registry so we don't hit real run_code / search etc.
// when the gate passes through a non-HIGH luca_* tool.
const dispatchLucaTool = vi.fn();
vi.mock("../../lib/luca-tools/registry", async () => {
  const actual = await vi.importActual<any>("../../lib/luca-tools/registry");
  return {
    ...actual,
    dispatchLucaTool: (...a: unknown[]) => dispatchLucaTool(...a),
  };
});

import { executePartnerTool } from "../../deliberation";
import { ApprovalError } from "../../lib/luca-approvals/gate";

beforeEach(() => {
  vi.clearAllMocks();
  gateActive = true;
  gateEnforcing = true;
  agentResponse = { id: 16, name: "Luca" };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("executePartnerTool: approval-gate middleware", () => {
  it("intercepts HIGH_STAKES (clone_voice) for Luca when enforcing", async () => {
    createPendingApproval.mockResolvedValue({
      id: "row-1",
      agentId: 16,
      userId: 10,
      meetingId: null,
      turnId: null,
      toolName: "clone_voice",
      draftPayload: { name: "v1", audio: "x" },
      status: "pending",
      codeSha: "abc",
      createdAt: new Date(),
      expiresAt: new Date("2026-04-23T10:00:00Z"),
      decidedAt: null,
      executedAt: null,
      executionResult: null,
      decisionNote: null,
      finalPayload: null,
    });

    const result = await executePartnerTool(
      "clone_voice",
      { name: "v1", audio: "https://example.com/a.wav" },
      10,
      16,
      undefined,
      { turnId: "t-1" },
    );

    const parsed = JSON.parse(result);
    expect(parsed.status).toBe("pending_approval");
    expect(parsed.approval_id).toBe("row-1");
    expect(parsed.tool_name).toBe("clone_voice");
    expect(parsed.expires_at).toBe("2026-04-23T10:00:00.000Z");

    expect(createPendingApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 16,
        userId: 10,
        toolName: "clone_voice",
        turnId: "t-1",
      }),
    );
    expect(broadcastApprovalRequested).toHaveBeenCalledTimes(1);
  });

  it("does NOT intercept READ_ONLY (workspace_read) for Luca", async () => {
    dispatchLucaTool.mockResolvedValue("file contents");
    // workspace_read is NOT a luca_* tool, so it'd hit the Studio switch.
    // But it's allowed (in LUCA_STUDIO_TOOL_NAMES), and it's LOW/READ.
    // We expect the gate to pass through. We can't easily assert "reached
    // switch" but we CAN assert the gate did NOT call createPendingApproval.
    // The call will then flow through and eventually fail at the switch
    // default clause (or hit a real handler); we don't care — we just
    // want to confirm no gate intercept.
    try {
      await executePartnerTool(
        "workspace_read",
        { path: "/luca/notes/a.md" },
        10,
        16,
        undefined,
      );
    } catch {
      /* downstream dispatcher may throw — we only care about the gate */
    }
    expect(createPendingApproval).not.toHaveBeenCalled();
    expect(broadcastApprovalRequested).not.toHaveBeenCalled();
  });

  it("does NOT intercept when flag is off", async () => {
    gateActive = false;
    try {
      await executePartnerTool(
        "clone_voice",
        { name: "v1", audio: "x" },
        10,
        16,
      );
    } catch { /* downstream can throw */ }
    expect(createPendingApproval).not.toHaveBeenCalled();
  });

  it("log_only mode: creates shadow row for observability but does NOT intercept", async () => {
    gateEnforcing = false;
    // Active but not enforcing.
    try {
      await executePartnerTool(
        "clone_voice",
        { name: "v1", audio: "x" },
        10,
        16,
      );
    } catch { /* downstream can throw */ }
    // Shadow mode: DB row is created (for dedupe verification + observability)
    // but no broadcast and no early return. Execution falls through to
    // normal path (which throws here because of the test's mock shape).
    expect(createPendingApproval).toHaveBeenCalledTimes(1);
    expect(broadcastApprovalRequested).not.toHaveBeenCalled();
  });

  it("skips the gate when _skipApprovalGate=true (decide re-entry)", async () => {
    try {
      await executePartnerTool(
        "clone_voice",
        { name: "v1", audio: "x" },
        10,
        16,
        undefined,
        { _skipApprovalGate: true, _approvalId: "row-1" },
      );
    } catch { /* downstream can throw */ }
    expect(createPendingApproval).not.toHaveBeenCalled();
  });

  it("does NOT intercept when agent is not Luca", async () => {
    agentResponse = { id: 99, name: "Другой агент" };
    try {
      await executePartnerTool(
        "send_new_email",
        { to: "x@y.z" },
        10,
        99,
      );
    } catch { /* downstream can throw */ }
    expect(createPendingApproval).not.toHaveBeenCalled();
  });

  it("falls open (executes normally) when gate.createPendingApproval throws a non-queue-full error", async () => {
    createPendingApproval.mockRejectedValue(new Error("db down"));
    // We return something from dispatchLucaTool so fall-through reaches it.
    dispatchLucaTool.mockResolvedValue("ok");
    let result: string;
    try {
      result = await executePartnerTool(
        "clone_voice",
        { name: "v1", audio: "x" },
        10,
        16,
      );
    } catch (e) {
      // If downstream also throws, fine — we just want to confirm we moved
      // past the gate and gate didn't swallow silently.
      result = "";
    }
    // Gate called but threw; middleware logged & continued. No pending_approval
    // envelope returned.
    expect(createPendingApproval).toHaveBeenCalled();
    if (result) {
      expect(result).not.toContain("pending_approval");
    }
  });

  it("returns approval_queue_full envelope when cap hit", async () => {
    createPendingApproval.mockRejectedValue(
      new ApprovalError("approval_queue_full", "cap hit"),
    );
    const result = await executePartnerTool(
      "clone_voice",
      { name: "v1", audio: "x" },
      10,
      16,
    );
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe("error");
    expect(parsed.error).toBe("approval_queue_full");
  });

  it("threads meetingId and turnId into createPendingApproval", async () => {
    createPendingApproval.mockResolvedValue({
      id: "row-x",
      agentId: 16,
      userId: 10,
      meetingId: "m-1",
      turnId: "t-42",
      toolName: "clone_voice",
      draftPayload: {},
      status: "pending",
      codeSha: "x",
      createdAt: new Date(),
      expiresAt: new Date(),
      decidedAt: null,
      executedAt: null,
      executionResult: null,
      decisionNote: null,
      finalPayload: null,
    });
    await executePartnerTool(
      "clone_voice",
      { name: "v", audio: "x" },
      10,
      16,
      undefined,
      { meetingId: "m-1", turnId: "t-42" },
    );
    expect(createPendingApproval).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: "m-1", turnId: "t-42" }),
    );
  });
});
