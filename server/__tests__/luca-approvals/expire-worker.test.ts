/**
 * Luca Day 6 — expire-worker.ts unit tests.
 *
 * We exercise runExpireTick() directly (bypassing the setInterval)
 * and assert that it flips timed-out rows and fans out one WS event
 * per row via the broadcast helpers. The DB is faked via the same
 * injection harness used by gate.test.ts.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  __setGateDbForTests,
  __resetGateDbForTests,
} from "../../lib/luca-approvals/gate";
import {
  runExpireTick,
  startApprovalExpireWorker,
  stopApprovalExpireWorker,
} from "../../lib/luca-approvals/expire-worker";
import type { ToolApproval } from "@shared/schema";

// Mock ws-events so we can assert broadcasts. Both real and mock live
// under the same module path; vi.mock hoists.
vi.mock("../../lib/luca-approvals/ws-events", () => ({
  broadcastApprovalDecided: vi.fn(),
  broadcastApprovalRequested: vi.fn(),
  rowToRequestedPayload: vi.fn((row: ToolApproval) => row),
}));

import { broadcastApprovalDecided } from "../../lib/luca-approvals/ws-events";

/**
 * Minimal fake that implements `.update(t).set(patch).where(cond).returning()`
 * by re-interpreting the predicate directly against a row store.
 */
class FakeDb {
  rows: ToolApproval[] = [];
  update(_t: unknown) {
    const self = this;
    return {
      set(patch: Partial<ToolApproval>) {
        return {
          where(_cond: unknown) {
            return {
              returning: async () => {
                // The worker only filters by status='pending' AND expires_at < now.
                // We pull `now` from the patch's decidedAt field which gate.ts
                // passes. Fall back to real now if absent.
                const now =
                  (patch.decidedAt as Date | undefined) ?? new Date();
                const hits: ToolApproval[] = [];
                for (const r of self.rows) {
                  if (r.status === "pending" && r.expiresAt < now) {
                    Object.assign(r, patch);
                    hits.push(r);
                  }
                }
                return hits;
              },
            };
          },
        };
      },
    };
  }
}

let fake: FakeDb;

beforeEach(() => {
  fake = new FakeDb();
  __setGateDbForTests(fake);
  vi.clearAllMocks();
});

afterEach(() => {
  __resetGateDbForTests();
  stopApprovalExpireWorker();
});

const baseRow = (overrides: Partial<ToolApproval> = {}): ToolApproval =>
  ({
    id: overrides.id ?? "row-1",
    agentId: 16,
    userId: 10,
    meetingId: null,
    turnId: null,
    toolName: "send_new_email",
    draftPayload: {},
    finalPayload: null,
    status: "pending",
    decisionNote: null,
    codeSha: "abc",
    createdAt: new Date(Date.now() - 48 * 3600 * 1000),
    expiresAt: new Date(Date.now() - 1000), // 1s past
    decidedAt: null,
    executedAt: null,
    executionResult: null,
    ...overrides,
  }) as ToolApproval;

describe("expire-worker: runExpireTick", () => {
  it("flips zero rows when none are pending past deadline", async () => {
    fake.rows.push(
      baseRow({ id: "a", expiresAt: new Date(Date.now() + 60_000) }),
    );
    const n = await runExpireTick();
    expect(n).toBe(0);
    expect(broadcastApprovalDecided).not.toHaveBeenCalled();
    expect(fake.rows[0].status).toBe("pending");
  });

  it("flips 1 expired row and broadcasts once", async () => {
    fake.rows.push(baseRow({ id: "a" }));
    const n = await runExpireTick();
    expect(n).toBe(1);
    expect(fake.rows[0].status).toBe("timeout");
    expect(broadcastApprovalDecided).toHaveBeenCalledTimes(1);
    expect(broadcastApprovalDecided).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "a",
        userId: 10,
        status: "timeout",
        toolName: "send_new_email",
      }),
    );
  });

  it("flips multiple expired rows and broadcasts one per row", async () => {
    fake.rows.push(baseRow({ id: "a" }));
    fake.rows.push(baseRow({ id: "b", toolName: "clone_voice" }));
    fake.rows.push(baseRow({ id: "c", expiresAt: new Date(Date.now() + 60_000) })); // not expired
    const n = await runExpireTick();
    expect(n).toBe(2);
    expect(broadcastApprovalDecided).toHaveBeenCalledTimes(2);
  });

  it("does not flip rows with status != pending", async () => {
    fake.rows.push(
      baseRow({ id: "a", status: "approved" as any, decidedAt: new Date() }),
    );
    const n = await runExpireTick();
    expect(n).toBe(0);
    expect(fake.rows[0].status).toBe("approved");
  });

  it("swallows broadcast errors without breaking the tick", async () => {
    const mock = broadcastApprovalDecided as unknown as {
      mockImplementationOnce: (f: () => void) => void;
    };
    mock.mockImplementationOnce(() => {
      throw new Error("ws crashed");
    });
    fake.rows.push(baseRow({ id: "a" }));
    fake.rows.push(baseRow({ id: "b" }));
    const n = await runExpireTick();
    expect(n).toBe(2); // both still flipped despite broadcast crash
  });

  it("returns 0 and does not throw on db error", async () => {
    // Replace update() with a thrower.
    const bomb = {
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => {
              throw new Error("db down");
            },
          }),
        }),
      }),
    };
    __setGateDbForTests(bomb);
    const n = await runExpireTick();
    expect(n).toBe(0);
  });
});

describe("expire-worker: start/stop lifecycle", () => {
  it("start returns a handle; stop clears it", () => {
    const h1 = startApprovalExpireWorker(3600 * 1000);
    expect(h1).toBeTruthy();
    // Idempotent — second start returns the same handle.
    const h2 = startApprovalExpireWorker(3600 * 1000);
    expect(h2).toBe(h1);
    stopApprovalExpireWorker();
    // After stop we can start again.
    const h3 = startApprovalExpireWorker(3600 * 1000);
    expect(h3).not.toBe(h1);
  });
});
