/**
 * LEO PR-A — server/lib/telegram.ts unit tests.
 *
 * Critical contract: the function MUST be fail-silent. None of these tests
 * uses `expect(...).rejects` — every error path must resolve to a
 * structured `{ok:false, error}` and write an audit row.
 *
 * `fetch` is stubbed globally; the audit-log insert is replaced by a
 * test seam (`__setLucaTelegramLogInsertForTests`) so we don't need a
 * real DB connection. Each test resets both seams so failures don't
 * cascade.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  sendTelegramMessage,
  __setLucaTelegramLogInsertForTests,
  __resetTelegramRateLimitForTests,
} from "../../server/lib/telegram";

type LogRow = {
  userId: number;
  message: string;
  urgency: "high" | "normal" | "low";
  delivered: boolean;
  error: string | null;
  reason: string | null;
};

let logRows: LogRow[] = [];
let originalFetch: typeof fetch | undefined;
let originalToken: string | undefined;
let originalChat: string | undefined;

beforeEach(() => {
  logRows = [];
  __setLucaTelegramLogInsertForTests(async (row) => {
    logRows.push(row);
  });
  __resetTelegramRateLimitForTests();
  originalFetch = globalThis.fetch;
  originalToken = process.env.TELEGRAM_BOT_TOKEN;
  originalChat = process.env.TELEGRAM_BOSS_CHAT_ID;
  process.env.TELEGRAM_BOT_TOKEN = "test-token-123";
  process.env.TELEGRAM_BOSS_CHAT_ID = "12345";
});

afterEach(() => {
  __setLucaTelegramLogInsertForTests(null);
  __resetTelegramRateLimitForTests();
  if (originalFetch) globalThis.fetch = originalFetch;
  if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = originalToken;
  if (originalChat === undefined) delete process.env.TELEGRAM_BOSS_CHAT_ID;
  else process.env.TELEGRAM_BOSS_CHAT_ID = originalChat;
});

describe("sendTelegramMessage — happy path", () => {
  it("calls Telegram API with the right URL+body and returns ok:true", async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, result: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    globalThis.fetch = fetchSpy as any;

    const result = await sendTelegramMessage({
      chatId: "12345",
      text: "hi",
      urgency: "high",
      userId: 7,
      reason: "vip_sender:foo",
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.truncated).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.telegram.org/bottest-token-123/sendMessage");
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body));
    expect(body.chat_id).toBe("12345");
    expect(body.text).toBe("hi");

    expect(logRows).toHaveLength(1);
    expect(logRows[0]).toMatchObject({
      userId: 7,
      message: "hi",
      urgency: "high",
      delivered: true,
      error: null,
      reason: "vip_sender:foo",
    });
  });
});

describe("sendTelegramMessage — fail-silent on network errors", () => {
  it("does NOT throw when fetch rejects; returns {ok:false, error:'fetch_threw:...'}", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as any;

    const result = await sendTelegramMessage({
      chatId: "12345",
      text: "ping",
      urgency: "normal",
      userId: 8,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("fetch_threw:");
    expect(result.error).toContain("ECONNREFUSED");
    expect(logRows).toHaveLength(1);
    expect(logRows[0].delivered).toBe(false);
    expect(logRows[0].error).toContain("fetch_threw:");
  });

  it("returns {ok:false, error:'fetch_<status>'} on non-2xx; logs delivered=false", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("Bad Request", { status: 400 }),
    ) as any;

    const result = await sendTelegramMessage({
      chatId: "12345",
      text: "x",
      urgency: "normal",
      userId: 8,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("fetch_400");
    expect(result.status).toBe(400);
    expect(logRows[0]?.delivered).toBe(false);
    expect(logRows[0]?.error).toBe("fetch_400");
  });
});

describe("sendTelegramMessage — config absence", () => {
  it("returns {ok:false, error:'telegram_not_configured'} when token unset; no fetch call", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as any;

    const result = await sendTelegramMessage({
      chatId: "12345",
      text: "x",
      urgency: "low",
      userId: 9,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("telegram_not_configured");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logRows).toHaveLength(1);
    expect(logRows[0].error).toBe("telegram_not_configured");
    expect(logRows[0].delivered).toBe(false);
  });
});

describe("sendTelegramMessage — 200-char truncation", () => {
  it("truncates text >200 chars before send and reports truncated:true", async () => {
    let bodyOnTheWire = "";
    globalThis.fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      bodyOnTheWire = body.text;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as any;

    const longText = "X".repeat(250);
    const result = await sendTelegramMessage({
      chatId: "12345",
      text: longText,
      urgency: "high",
      userId: 7,
    });

    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    expect(bodyOnTheWire.length).toBe(200);
    expect(logRows[0].message.length).toBe(200);
  });
});

describe("sendTelegramMessage — rate limiter (5/hour/chat)", () => {
  it("permits 5 sends and rejects the 6th with rate_limited", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ) as any;

    const inputs = Array.from({ length: 5 }, (_, i) => ({
      chatId: "limit-target",
      text: `msg ${i}`,
      urgency: "high" as const,
      userId: 7,
    }));
    for (const i of inputs) {
      const r = await sendTelegramMessage(i);
      expect(r.ok).toBe(true);
    }

    const sixth = await sendTelegramMessage({
      chatId: "limit-target",
      text: "should-be-blocked",
      urgency: "high",
      userId: 7,
    });
    expect(sixth.ok).toBe(false);
    expect(sixth.error).toBe("rate_limited");

    // Audit rows: 5 delivered + 1 rate_limited.
    expect(logRows.filter((r) => r.delivered)).toHaveLength(5);
    expect(logRows.filter((r) => r.error === "rate_limited")).toHaveLength(1);
  });

  it("rate limit is per-chatId (different chat is independent)", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ) as any;

    for (let i = 0; i < 5; i++) {
      const r = await sendTelegramMessage({
        chatId: "chat-A",
        text: `a${i}`,
        urgency: "high",
        userId: 7,
      });
      expect(r.ok).toBe(true);
    }
    // Different chatId — should still allow 5 sends.
    const r = await sendTelegramMessage({
      chatId: "chat-B",
      text: "b1",
      urgency: "high",
      userId: 7,
    });
    expect(r.ok).toBe(true);
  });
});
