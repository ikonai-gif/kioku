/**
 * [BRO2-A15 / LUCA-076] CRON-1 PR1 — unit tests.
 * Flags off => early return (zero blast radius); rate cap; formatter
 * budget; audit-context tagging; schedule validation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { __execTool, __sendTg, __audit } = vi.hoisted(() => ({
  __execTool: vi.fn(),
  __sendTg: vi.fn(),
  __audit: vi.fn(async () => {}),
}));
vi.mock("../../server/deliberation", () => ({ executePartnerTool: __execTool }));
vi.mock("../../server/lib/telegram", () => ({ sendTelegramMessage: __sendTg }));
vi.mock("../../server/lib/redis", () => ({ getRedisClient: () => null }));
// [LUCA-088] audit chokepoint is mocked so unit tests assert the explicit
// cron-path audit for non-luca_ tools without touching a real pool.
vi.mock("../../server/lib/luca-tools/audit-log", () => ({
  recordLucaAudit: __audit,
  hashLucaInput: () => "h".repeat(64),
  inferStatusFromResult: () => "ok",
}));
vi.mock("../../server/lib/luca-approvals/classify", () => ({ classifyTool: () => "READ_ONLY" }));
vi.mock("../../server/storage", () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
vi.mock("../../server/logger", () => {
  const l = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logger: l, default: l };
});

import {
  runMorningBrief,
  formatMorningBrief,
  routinesEnabled,
  cronTelegramApproved,
} from "../../server/cron/morning-brief";
import { morningBriefSchedule } from "../../server/cron/index";
import { checkAndMarkCronRun, __resetCronRateLimiterForTests } from "../../server/cron/rate-limiter";
import { currentAuditContext, runWithAuditContext } from "../../server/lib/luca-tools/audit-context";

beforeEach(() => {
  __execTool.mockReset();
  __sendTg.mockReset();
  __audit.mockClear();
  __resetCronRateLimiterForTests();
});

describe("CRON-1 — kill-switch (LUCA-076 §6)", () => {
  it("LUCA_ROUTINES_ENABLED unset/false → skipped, no tool calls, no send", async () => {
    const res = await runMorningBrief({} as NodeJS.ProcessEnv);
    expect(res).toEqual({ status: "skipped", reason: "routines_disabled" });
    expect(__execTool).not.toHaveBeenCalled();
    expect(__sendTg).not.toHaveBeenCalled();
  });
  it("flags parse strictly", () => {
    expect(routinesEnabled({ LUCA_ROUTINES_ENABLED: "true" } as any)).toBe(true);
    expect(routinesEnabled({ LUCA_ROUTINES_ENABLED: "1" } as any)).toBe(false);
    expect(cronTelegramApproved({} as any)).toBe(false);
  });
});

describe("CRON-1 — telegram gate (LUCA-076 §3, HARD RULE)", () => {
  it("routines on but LUCA_CRON_TELEGRAM_APPROVED off → composes, does NOT send", async () => {
    __execTool.mockResolvedValue("[]");
    const res = await runMorningBrief({ LUCA_ROUTINES_ENABLED: "true" } as any);
    expect(res).toEqual({ status: "skipped", reason: "telegram_not_approved" });
    expect(__execTool).toHaveBeenCalledTimes(3);
    expect(__sendTg).not.toHaveBeenCalled();
  });
  it("both flags on → sends to TELEGRAM_BOSS_CHAT_ID", async () => {
    __execTool.mockResolvedValue("[]");
    __sendTg.mockResolvedValue({ delivered: true });
    const res = await runMorningBrief({
      LUCA_ROUTINES_ENABLED: "true",
      LUCA_CRON_TELEGRAM_APPROVED: "true",
      TELEGRAM_BOSS_CHAT_ID: "12345",
    } as any);
    expect(res.status).toBe("sent");
    expect(__sendTg).toHaveBeenCalledTimes(1);
    const arg = __sendTg.mock.calls[0][0];
    expect(arg.chatId).toBe("12345");
    expect(arg.urgency).toBe("normal");
    expect(arg.reason).toContain("LUCA-076");
  });
});

describe("CRON-1 — explicit audit for non-luca_ tools (LUCA-088)", () => {
  it("records email_triage and list_tasks; leaves luca_calendar_list to the dispatcher", async () => {
    __execTool.mockResolvedValue("[]");
    await runMorningBrief({ LUCA_ROUTINES_ENABLED: "true" } as any);
    const audited = __audit.mock.calls.map((c) => c[0].tool);
    expect(audited).toContain("email_triage");
    expect(audited).toContain("list_tasks");
    // luca_* tools are audited inside the dispatcher (R465 scope) — a second
    // row here would be a duplicate.
    expect(audited).not.toContain("luca_calendar_list");
    for (const call of __audit.mock.calls) {
      expect(call[0].classification).toBe("READ_ONLY");
      expect(call[0].latencyMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("audits even when the tool call rejects (error result hashed, not thrown)", async () => {
    __execTool.mockRejectedValue(new Error("gmail down"));
    const res = await runMorningBrief({ LUCA_ROUTINES_ENABLED: "true" } as any);
    expect(res).toEqual({ status: "skipped", reason: "telegram_not_approved" });
    const audited = __audit.mock.calls.map((c) => c[0].tool);
    expect(audited).toContain("email_triage");
    expect(audited).toContain("list_tasks");
  });
});

describe("CRON-1 — rate cap (LUCA-076 §6)", () => {
  it("second run within cap window is blocked (memory fallback)", async () => {
    const t0 = Date.now();
    expect(await checkAndMarkCronRun("CRON-1", 6, t0)).toBe(true);
    expect(await checkAndMarkCronRun("CRON-1", 6, t0 + 3600_000)).toBe(false);
    expect(await checkAndMarkCronRun("CRON-1", 6, t0 + 7 * 3600_000)).toBe(true);
  });
});

describe("CRON-1 — formatter budget (LUCA-076 §2)", () => {
  it("clips each block and stays within total budget", () => {
    const long = "x".repeat(500);
    const msg = formatMorningBrief({ dateLabel: "11 июня", calendarSummary: long, emailSummary: long, tasksSummary: long });
    expect(msg.length).toBeLessThanOrEqual(640);
    expect(msg).toContain("☀️ Доброе утро, Котэ");
    expect(msg).toContain("📅 СЕГОДНЯ:");
    expect(msg).toContain("📬 ПОЧТА:");
    expect(msg).toContain("✅ АКТИВНЫЕ ЗАДАЧИ:");
  });
});

describe("audit context (LUCA-076 §4)", () => {
  it("defaults to user/null; tags cron inside runWithAuditContext", async () => {
    expect(currentAuditContext()).toEqual({ source: "user", jobId: null });
    await runWithAuditContext({ source: "cron", jobId: "CRON-1" }, async () => {
      expect(currentAuditContext()).toEqual({ source: "cron", jobId: "CRON-1" });
    });
    expect(currentAuditContext()).toEqual({ source: "user", jobId: null });
  });
});

describe("schedule (LUCA-076 §1/§7)", () => {
  it("default 0 9 * * *; invalid env falls back", () => {
    expect(morningBriefSchedule({} as any)).toBe("0 9 * * *");
    expect(morningBriefSchedule({ LUCA_CRON_MORNING_BRIEF_TIME: "garbage" } as any)).toBe("0 9 * * *");
    expect(morningBriefSchedule({ LUCA_CRON_MORNING_BRIEF_TIME: "30 8 * * *" } as any)).toBe("30 8 * * *");
  });
});
