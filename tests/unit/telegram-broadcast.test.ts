/**
 * LEO PR-A — broadcastTelegramEvent unit tests.
 *
 * Verifies the three sibling events emitted by ws-events.ts map to the
 * correct WS type strings and pass through the right payload fields.
 *
 * Critical contract:
 *   - status="sent"     -> type "luca.telegram.sent"
 *   - status="failed"   -> type "luca.telegram.failed"
 *   - status="deferred" -> type "luca.telegram.deferred"
 *
 * `broadcastToUser` is mocked so we can assert the exact (userId, payload)
 * pair without spinning up a WebSocket server.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mock state — vi.mock factories run before any module-scope
// `const` initializers, so we must wrap the spy in `vi.hoisted` to get a
// stable reference both inside the factory and in the assertions below.
const { broadcastToUser } = vi.hoisted(() => ({
  broadcastToUser: vi.fn(),
}));

vi.mock("../../server/ws", () => ({
  broadcastToUser,
}));

// Import AFTER vi.mock so the mock is wired in.
import { broadcastTelegramEvent } from "../../server/lib/luca-approvals/ws-events";

describe("broadcastTelegramEvent", () => {
  beforeEach(() => {
    broadcastToUser.mockClear();
  });

  afterEach(() => {
    broadcastToUser.mockReset();
  });

  it("emits luca.telegram.sent with the expected fields", () => {
    const ts = new Date("2026-04-27T22:00:00.000Z");
    broadcastTelegramEvent({
      userId: 10,
      status: "sent",
      urgency: "high",
      message: "hello",
      reason: "vip_sender:x",
      timestamp: ts,
    });

    expect(broadcastToUser).toHaveBeenCalledTimes(1);
    expect(broadcastToUser).toHaveBeenCalledWith(10, {
      type: "luca.telegram.sent",
      log_id: null,
      urgency: "high",
      message: "hello",
      error: null,
      reason: "vip_sender:x",
      timestamp: ts.toISOString(),
    });
  });

  it("emits luca.telegram.failed with the error code passed through", () => {
    const ts = new Date("2026-04-27T22:01:00.000Z");
    broadcastTelegramEvent({
      userId: 11,
      status: "failed",
      urgency: "normal",
      message: "boom",
      error: "rate_limited",
      timestamp: ts,
    });

    expect(broadcastToUser).toHaveBeenCalledTimes(1);
    expect(broadcastToUser).toHaveBeenCalledWith(11, {
      type: "luca.telegram.failed",
      log_id: null,
      urgency: "normal",
      message: "boom",
      error: "rate_limited",
      reason: null,
      timestamp: ts.toISOString(),
    });
  });

  it("emits luca.telegram.deferred with the defer-until reason", () => {
    const ts = new Date("2026-04-27T22:02:00.000Z");
    broadcastTelegramEvent({
      userId: 12,
      status: "deferred",
      urgency: "low",
      message: "queued",
      reason: "ctx|defer_until=2026-04-28T15:00:00.000Z",
      logId: "log-abc",
      timestamp: ts,
    });

    expect(broadcastToUser).toHaveBeenCalledTimes(1);
    expect(broadcastToUser).toHaveBeenCalledWith(12, {
      type: "luca.telegram.deferred",
      log_id: "log-abc",
      urgency: "low",
      message: "queued",
      error: null,
      reason: "ctx|defer_until=2026-04-28T15:00:00.000Z",
      timestamp: ts.toISOString(),
    });
  });

  it("normalizes missing optional fields to null", () => {
    const ts = new Date("2026-04-27T22:03:00.000Z");
    broadcastTelegramEvent({
      userId: 13,
      status: "sent",
      urgency: "high",
      message: "x",
      timestamp: ts,
    });

    expect(broadcastToUser).toHaveBeenCalledWith(13, {
      type: "luca.telegram.sent",
      log_id: null,
      urgency: "high",
      message: "x",
      error: null,
      reason: null,
      timestamp: ts.toISOString(),
    });
  });
});
