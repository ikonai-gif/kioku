/**
 * Tests for lib/jobs/jobs-webhook.ts — URL resolution + fallback on critical.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

(globalThis as any).__jobsWebhookTest = {
  sendAlert: vi.fn(async () => ({ delivered: true as const, status: 204 })),
};

vi.mock("../../lib/self-monitoring/webhook", () => ({
  sendAlert: (...args: any[]) => (globalThis as any).__jobsWebhookTest.sendAlert(...args),
}));

const sendAlertMock = (globalThis as any).__jobsWebhookTest.sendAlert as ReturnType<typeof vi.fn>;

import { notifyJob } from "../../lib/jobs/jobs-webhook";

describe("jobs/jobs-webhook · notifyJob", () => {
  const KEYS = ["JOBS_WEBHOOK_URL", "JOBS_WEBHOOK_FORMAT", "KIOKU_ALERT_WEBHOOK_URL"];
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of KEYS) saved[k] = process.env[k];
    for (const k of KEYS) delete process.env[k];
    sendAlertMock.mockClear();
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k] as string;
    }
  });

  it("sends to JOBS_WEBHOOK_URL when configured, default format=discord", async () => {
    process.env.JOBS_WEBHOOK_URL = "https://jobs-webhook";
    const r = await notifyJob({ severity: "info", title: "t", detail: "d" });
    expect(r).toEqual({ delivered: true, status: 204 });
    expect(sendAlertMock).toHaveBeenCalledOnce();
    const [_payload, opts] = sendAlertMock.mock.calls[0];
    expect(opts.webhookUrl).toBe("https://jobs-webhook");
    expect(opts.format).toBe("discord");
  });

  it("honors JOBS_WEBHOOK_FORMAT when valid", async () => {
    process.env.JOBS_WEBHOOK_URL = "https://jobs-webhook";
    process.env.JOBS_WEBHOOK_FORMAT = "slack";
    await notifyJob({ severity: "info", title: "t", detail: "d" });
    expect(sendAlertMock.mock.calls[0][1].format).toBe("slack");
  });

  it("falls back to default discord on bogus format", async () => {
    process.env.JOBS_WEBHOOK_URL = "https://jobs-webhook";
    process.env.JOBS_WEBHOOK_FORMAT = "bogus";
    await notifyJob({ severity: "info", title: "t", detail: "d" });
    expect(sendAlertMock.mock.calls[0][1].format).toBe("discord");
  });

  it("returns no_webhook_configured when JOBS_WEBHOOK_URL missing and severity not critical", async () => {
    const r = await notifyJob({ severity: "info", title: "t", detail: "d" });
    expect(r).toEqual({ delivered: false, reason: "no_webhook_configured" });
    expect(sendAlertMock).not.toHaveBeenCalled();
  });

  it("falls back to KIOKU_ALERT_WEBHOOK_URL ONLY for critical severity", async () => {
    process.env.KIOKU_ALERT_WEBHOOK_URL = "https://self-mon";
    const r = await notifyJob({ severity: "critical", title: "boom", detail: "d" });
    expect(r).toEqual({ delivered: true, status: 204 });
    expect(sendAlertMock).toHaveBeenCalledOnce();
    const [payload, opts] = sendAlertMock.mock.calls[0];
    expect(opts.webhookUrl).toBe("https://self-mon");
    expect(payload.title).toMatch(/FALLBACK/);
  });

  it("does not fall back on warn severity", async () => {
    process.env.KIOKU_ALERT_WEBHOOK_URL = "https://self-mon";
    const r = await notifyJob({ severity: "warn", title: "t", detail: "d" });
    expect(r).toEqual({ delivered: false, reason: "no_webhook_configured" });
  });
});
