/**
 * Luca V1a — Google Calendar tool unit tests (luca_calendar_list).
 *
 * Deterministic: no network, no DB. Core checks need no env; handler paths
 * use vi.hoisted mocks for the env flag + the cloud-integrations client.
 *   - classify maps luca_calendar_list -> READ_ONLY
 *   - trust-policy labels it UNTRUSTED
 *   - tool spec + registry registration are correct
 *   - handler "ok" maps CalendarEvent[] through (mocked client)
 *   - handler "disabled" short-circuits when the flag is off
 *   - handler "error" surfaces the client error (e.g. missing scope)
 */
import { describe, expect, it, beforeEach, vi } from "vitest";

const { mockEnabled, mockList } = vi.hoisted(() => ({
  mockEnabled: vi.fn(),
  mockList: vi.fn(),
}));

vi.mock("../../lib/luca/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/luca/env")>();
  return { ...actual, isLucaToolEnabled: (...a: unknown[]) => mockEnabled(...a) };
});
vi.mock("../../cloud-integrations", () => ({
  listGoogleCalendarEvents: (...a: unknown[]) => mockList(...a),
}));

import { TOOL_WRITE_CLASS, classifyTool } from "../../lib/luca-approvals/classify";
import { getToolTrustLevel } from "../../lib/luca-tools/trust-policy";
import { calendarListTool, calendarListHandler } from "../../lib/luca-tools/calendar";
import { __getAllLucaToolSpecsForTests } from "../../lib/luca-tools/registry";

describe("luca_calendar_list — classification, trust, registry", () => {
  it("classify maps calendar read to READ_ONLY", () => {
    expect(TOOL_WRITE_CLASS.luca_calendar_list).toBe("READ_ONLY");
    expect(classifyTool("luca_calendar_list")).toBe("READ_ONLY");
  });
  it("trust-policy labels calendar UNTRUSTED", () => {
    expect(getToolTrustLevel("luca_calendar_list")).toBe("UNTRUSTED");
  });
  it("tool spec name + no required fields", () => {
    expect(calendarListTool.name).toBe("luca_calendar_list");
    expect((calendarListTool.input_schema as any).required ?? []).toEqual([]);
  });
  it("registry includes the calendar spec", () => {
    const all = __getAllLucaToolSpecsForTests().map((t) => t.name);
    expect(all).toContain("luca_calendar_list");
  });
});

describe("luca_calendar_list — handler", () => {
  beforeEach(() => {
    mockEnabled.mockReset();
    mockList.mockReset();
  });

  it("returns ok with mapped events when enabled", async () => {
    mockEnabled.mockReturnValue(true);
    mockList.mockResolvedValue([
      { id: "e1", summary: "Standup", start: "2026-06-09T09:00:00Z", end: "2026-06-09T09:15:00Z", status: "confirmed" },
    ]);
    const r = await calendarListHandler({ maxResults: 5 }, { userId: 10 });
    expect(r.status).toBe("ok");
    expect(r.trust_level).toBe("UNTRUSTED");
    expect(r.events?.[0]?.summary).toBe("Standup");
    expect(mockList).toHaveBeenCalledWith(10, { maxResults: 5, timeMinIso: undefined, timeMaxIso: undefined });
  });

  it("returns disabled when the flag is off (defense-in-depth)", async () => {
    mockEnabled.mockReturnValue(false);
    const r = await calendarListHandler({}, { userId: 10 });
    expect(r.status).toBe("disabled");
    expect(mockList).not.toHaveBeenCalled();
  });

  it("surfaces client error (e.g. missing calendar scope)", async () => {
    mockEnabled.mockReturnValue(true);
    mockList.mockRejectedValue(new Error("Google Calendar access not granted — reconnect Google to allow Calendar (read)."));
    const r = await calendarListHandler({}, { userId: 10 });
    expect(r.status).toBe("error");
    expect(r.error).toMatch(/reconnect Google/);
  });
});
