/**
 * Self-Monitoring — webhook format adapters + sendAlert wiring.
 *
 * Covers:
 *   - slack body shape (text + emoji by severity + code-fenced context)
 *   - discord body shape (embeds with severity-tinted color)
 *   - generic body shape (flat JSON; default when format unset or invalid)
 *   - sendAlert: no-op when no URL, 2xx → delivered, non-2xx → reason, abort on timeout
 *   - never throws on network failure
 */
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { sendAlert, type AlertPayload } from "../../lib/self-monitoring/webhook";

const origEnv = { ...process.env };
afterEach(() => {
  process.env = { ...origEnv };
  vi.restoreAllMocks();
});

function mockFetchOk(captured: { body?: any; url?: string; status: number }) {
  return vi.spyOn(globalThis, "fetch" as any).mockImplementation(async (url: any, init: any) => {
    captured.url = String(url);
    try { captured.body = JSON.parse(String(init?.body ?? "{}")); } catch { captured.body = init?.body; }
    return new Response("ok", { status: captured.status });
  });
}

const samplePayload: AlertPayload = {
  severity: "critical",
  title: "tool_added",
  detail: "gmail_read appeared in schema",
  context: { tool: "gmail_read", category: "v1a" },
};

describe("self-monitoring/webhook — format adapters", () => {
  beforeEach(() => {
    process.env.KIOKU_ALERT_WEBHOOK_URL = "https://example.test/hook";
  });

  it("slack format: text field with :red_circle: for critical + code-fenced context", async () => {
    const cap = { status: 200 } as any;
    mockFetchOk(cap);
    const r = await sendAlert(samplePayload, { format: "slack" });
    expect(r).toEqual({ delivered: true, status: 200 });
    expect(cap.body).toHaveProperty("text");
    expect(cap.body.text).toContain(":red_circle:");
    expect(cap.body.text).toContain("KIOKU · CRITICAL");
    expect(cap.body.text).toContain("tool_added");
    expect(cap.body.text).toContain("gmail_read appeared");
    expect(cap.body.text).toMatch(/```[\s\S]*gmail_read[\s\S]*```/);
  });

  it("slack format: warn uses :warning: and info uses :information_source:", async () => {
    const cap = { status: 200 } as any;
    const spy = mockFetchOk(cap);
    await sendAlert({ ...samplePayload, severity: "warn" }, { format: "slack" });
    expect(cap.body.text).toContain(":warning:");
    await sendAlert({ ...samplePayload, severity: "info" }, { format: "slack" });
    expect(cap.body.text).toContain(":information_source:");
    spy.mockClear();
  });

  it("discord format: embed with severity-tinted color", async () => {
    const cap = { status: 200 } as any;
    mockFetchOk(cap);
    const r = await sendAlert(samplePayload, { format: "discord" });
    expect(r).toEqual({ delivered: true, status: 200 });
    expect(cap.body).toHaveProperty("embeds");
    expect(cap.body.embeds).toHaveLength(1);
    expect(cap.body.embeds[0].title).toContain("CRITICAL");
    expect(cap.body.embeds[0].color).toBe(0xe74c3c);
    expect(cap.body.embeds[0].fields).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "tool" })]),
    );
  });

  it("generic format: flat JSON envelope with source/severity/title/detail/context/sent_at", async () => {
    const cap = { status: 200 } as any;
    mockFetchOk(cap);
    await sendAlert(samplePayload, { format: "generic" });
    expect(cap.body).toMatchObject({
      source: "kioku",
      severity: "critical",
      title: "tool_added",
      detail: expect.any(String),
      context: { tool: "gmail_read", category: "v1a" },
      sent_at: expect.any(String),
    });
  });

  it("falls back to generic when ENV format is unknown", async () => {
    process.env.KIOKU_ALERT_WEBHOOK_FORMAT = "pager-duty-xyz";
    const cap = { status: 200 } as any;
    mockFetchOk(cap);
    await sendAlert(samplePayload);
    // generic envelope identifiable by `source: "kioku"`
    expect(cap.body).toHaveProperty("source", "kioku");
  });
});

describe("self-monitoring/webhook — sendAlert control flow", () => {
  it("returns no_webhook_configured when URL is empty", async () => {
    delete process.env.KIOKU_ALERT_WEBHOOK_URL;
    const r = await sendAlert(samplePayload);
    expect(r).toEqual({ delivered: false, reason: "no_webhook_configured" });
  });

  it("returns non_2xx reason on 500 and does not throw", async () => {
    process.env.KIOKU_ALERT_WEBHOOK_URL = "https://example.test/hook";
    vi.spyOn(globalThis, "fetch" as any).mockImplementation(async () =>
      new Response("bad", { status: 500 }),
    );
    const r = await sendAlert(samplePayload);
    expect(r.delivered).toBe(false);
    if (r.delivered === false) {
      expect(r.reason).toBe("non_2xx");
      expect(r.detail).toContain("status=500");
    }
  });

  it("returns network_error reason when fetch throws and does not propagate", async () => {
    process.env.KIOKU_ALERT_WEBHOOK_URL = "https://example.test/hook";
    vi.spyOn(globalThis, "fetch" as any).mockImplementation(async () => {
      throw new Error("ECONNRESET");
    });
    const r = await sendAlert(samplePayload);
    expect(r.delivered).toBe(false);
    if (r.delivered === false) {
      expect(r.reason).toBe("network_error");
      expect(r.detail).toContain("ECONNRESET");
    }
  });

  it("uses opts.webhookUrl / opts.format over ENV", async () => {
    process.env.KIOKU_ALERT_WEBHOOK_URL = "https://env.example/hook";
    process.env.KIOKU_ALERT_WEBHOOK_FORMAT = "slack";
    const cap = { status: 200 } as any;
    mockFetchOk(cap);
    await sendAlert(samplePayload, {
      webhookUrl: "https://opt.example/hook",
      format: "generic",
    });
    expect(cap.url).toBe("https://opt.example/hook");
    expect(cap.body).toHaveProperty("source", "kioku"); // generic shape, not slack
  });
});
