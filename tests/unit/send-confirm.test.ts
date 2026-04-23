/**
 * KIOKU™ Gmail Sprint 1 Cleanup — Send Confirmation Unit Tests
 *
 * Tests the in-memory pending-token store (server/send-confirm.ts):
 *   - createPending / consumePending / cancelPending / peekPending
 *   - TTL expiry behaviour (via fake timers)
 *   - One-time use enforcement
 *
 * Also covers the executePartnerTool "pending" path:
 *   - send_email_reply returns pending state string (no real send)
 *   - send_new_email returns pending state string (no real send)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("../../server/storage", () => ({
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
  db: {
    insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) })) })),
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([]), orderBy: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([]) })) })) })) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) })) })) })),
  },
  storage: {},
  recordToolActivityStart: vi.fn(),
  recordToolActivityEnd: vi.fn(),
  attachToolActivityToMessage: vi.fn(),
}));

// Mock broadcast so executePartnerTool doesn't blow up without a real WS
vi.mock("../../server/ws", () => ({
  broadcastToRoom: vi.fn(),
  broadcastToolActivity: vi.fn(),
  broadcastStreamChunk: vi.fn(),
}));

// ── send-confirm store tests ─────────────────────────────────────────────────

describe("send-confirm store", () => {
  // Re-import fresh module each test to reset in-memory state
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it("createPending returns a token and expiresAt ~15 min from now", async () => {
    const { createPending } = await import("../../server/send-confirm");
    const before = Date.now();
    const { token, expiresAt } = createPending({
      kind: "send_new",
      userId: 1,
      account: "a@b.com",
      to: "x@y.com",
      subject: "Test",
      body: "Hello",
    });

    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(20);
    expect(expiresAt).toBeGreaterThan(before + 14 * 60 * 1000); // at least 14 min
    expect(expiresAt).toBeLessThan(before + 16 * 60 * 1000);    // at most 16 min
  });

  it("consumePending with valid token returns the entry and marks it used", async () => {
    const { createPending, consumePending } = await import("../../server/send-confirm");
    const { token } = createPending({
      kind: "send_reply",
      userId: 2,
      account: "me@x.com",
      messageId: "msg-1",
      body: "Reply body",
    });

    const entry = consumePending(token);
    expect(entry.action.kind).toBe("send_reply");
    expect((entry.action as any).messageId).toBe("msg-1");
    expect(entry.usedAt).toBeDefined();
  });

  it("consumePending with already-used token throws 410", async () => {
    const { createPending, consumePending } = await import("../../server/send-confirm");
    const { token } = createPending({
      kind: "send_new",
      userId: 1,
      account: "a@b.com",
      to: "x@y.com",
      subject: "S",
      body: "B",
    });

    consumePending(token); // first use — OK
    expect(() => consumePending(token)).toThrow(/already used/i);

    try {
      consumePending(token);
    } catch (err: any) {
      expect(err.status).toBe(410);
    }
  });

  it("consumePending with unknown token throws 410", async () => {
    const { consumePending } = await import("../../server/send-confirm");
    expect(() => consumePending("does-not-exist")).toThrow(/not found/i);

    try {
      consumePending("bogus-token-xyz");
    } catch (err: any) {
      expect(err.status).toBe(410);
    }
  });

  it("consumePending with expired token throws 410", async () => {
    const { createPending, consumePending } = await import("../../server/send-confirm");
    const { token } = createPending({
      kind: "send_new",
      userId: 1,
      account: "a@b.com",
      to: "x@y.com",
      subject: "S",
      body: "B",
    });

    // Advance fake time past 15 minutes
    vi.advanceTimersByTime(16 * 60 * 1000);

    expect(() => consumePending(token)).toThrow(/expired/i);

    try {
      consumePending(token);
    } catch (err: any) {
      expect(err.status).toBe(410);
    }
  });

  it("cancelPending prevents consumePending", async () => {
    const { createPending, consumePending, cancelPending } = await import("../../server/send-confirm");
    const { token } = createPending({
      kind: "send_reply",
      userId: 3,
      account: "x@y.com",
      messageId: "m2",
      body: "text",
    });

    cancelPending(token);
    expect(() => consumePending(token)).toThrow(/already used/i);
  });

  it("peekPending returns entry without consuming it", async () => {
    const { createPending, peekPending, consumePending } = await import("../../server/send-confirm");
    const { token } = createPending({
      kind: "send_new",
      userId: 1,
      account: "a@b.com",
      to: "x@y.com",
      subject: "S",
      body: "B",
    });

    const peek = peekPending(token);
    expect(peek).not.toBeNull();
    expect(peek!.usedAt).toBeUndefined();

    // Still consumable after peek
    expect(() => consumePending(token)).not.toThrow();
  });

  it("peekPending returns null for unknown token", async () => {
    const { peekPending } = await import("../../server/send-confirm");
    expect(peekPending("nonexistent")).toBeNull();
  });
});

// ── executePartnerTool — pending state (no real send) ─────────────────────────

describe("executePartnerTool — send tools return pending state", () => {
  beforeEach(() => {
    vi.resetModules();
    // Override the pool mock for this describe block, ensuring recordToolActivityStart returns a promise
    vi.doMock("../../server/storage", () => ({
      pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
      db: {
        insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) })) })),
        select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([]), orderBy: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([]) })) })) })) })),
        update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) })) })) })),
      },
      storage: {},
      recordToolActivityStart: vi.fn().mockResolvedValue(undefined),
      recordToolActivityEnd: vi.fn().mockResolvedValue(undefined),
      attachToolActivityToMessage: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock("../../server/ws", () => ({
      broadcastToRoom: vi.fn(),
      broadcastToolActivity: vi.fn(),
      broadcastStreamChunk: vi.fn(),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("send_email_reply returns pending state string — no real Gmail call", async () => {
    const { executePartnerTool } = await import("../../server/deliberation");

    // Spy on fetch — it should NOT be called (no real email)
    const fetchSpy = vi.spyOn(global, "fetch");

    const result = await executePartnerTool(
      "send_email_reply",
      { account: "me@test.com", message_id: "msg-abc", body: "Hello reply" },
      99,   // userId
      10,   // agentId
      42,   // roomId
    );

    // Result must indicate pending state
    expect(result).toContain("pending");
    expect(result).toContain("confirmation");

    // Gmail API must NOT have been called
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("send_new_email returns pending state string — no real Gmail call", async () => {
    const { executePartnerTool } = await import("../../server/deliberation");
    const fetchSpy = vi.spyOn(global, "fetch");

    const result = await executePartnerTool(
      "send_new_email",
      {
        account: "me@test.com",
        to: "friend@test.com",
        subject: "Hello",
        body: "World",
      },
      99,
      10,
      42,
    );

    expect(result).toContain("pending");
    expect(result).toContain("confirmation");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
