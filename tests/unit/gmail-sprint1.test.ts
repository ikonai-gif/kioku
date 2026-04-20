/**
 * KIOKU™ Gmail Sprint 1 — Unit Tests
 *
 * Happy-path unit tests for the four new Gmail functions added in Sprint 1:
 *   - getGmailThread
 *   - sendGmailReply
 *   - sendGmailNew
 *
 * All external I/O (fetch, DB pool) is mocked — no real emails are sent.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── pool mock (must be defined before vi.mock call) ──────────────────────────

const mockPoolQuery = vi.fn();

vi.mock("../../server/storage", () => ({
  pool: { query: mockPoolQuery },
  storage: {},
  recordToolActivityStart: vi.fn(),
  recordToolActivityEnd: vi.fn(),
  attachToolActivityToMessage: vi.fn(),
}));

// ── helpers ──────────────────────────────────────────────────────────────────

function makeHeaders(pairs: Record<string, string>) {
  return Object.entries(pairs).map(([name, value]) => ({ name, value }));
}

function mockFetchResponse(data: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: vi.fn().mockResolvedValue(data),
    text: vi.fn().mockResolvedValue(JSON.stringify(data)),
  };
}

/**
 * DB responses needed for the happy-path flow:
 *  1. listGmailAccounts → returns one account row
 *  2. getGmailTokenForAccount → returns the integration row with a non-expired token
 */
function setupDbForConnectedAccount() {
  const now = Date.now();
  const tokenExpiry = now + 3600 * 1000; // expires in 1 hour

  mockPoolQuery
    // listGmailAccounts query
    .mockResolvedValueOnce({
      rows: [{
        id: 42,
        email: "test@example.com",
        created_at: now,
        token_expiry: tokenExpiry,
        has_refresh: true,
      }],
    })
    // getGmailTokenForAccount query
    .mockResolvedValueOnce({
      rows: [{
        id: 42,
        access_token: "ya29.mock-token",
        refresh_token: "1//mock-refresh",
        token_expiry: tokenExpiry,
        email: "test@example.com",
        provider: "gmail",
      }],
    });
}

/** DB responds with no gmail accounts (disconnected state). */
function setupDbForNoAccounts() {
  mockPoolQuery.mockResolvedValueOnce({ rows: [] });
}

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mockPoolQuery.mockReset();
  fetchSpy = vi.spyOn(global, "fetch");
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── getGmailThread ───────────────────────────────────────────────────────────

describe("getGmailThread", () => {
  it("happy path: returns all messages in thread with correct shape", async () => {
    const { getGmailThread } = await import("../../server/cloud-integrations");

    setupDbForConnectedAccount();

    const mockThreadPayload = {
      messages: [
        {
          id: "msg-001",
          threadId: "thread-abc",
          snippet: "Hello world",
          payload: {
            headers: makeHeaders({
              From: "alice@example.com",
              To: "test@example.com",
              Subject: "Test subject",
              Date: "Mon, 1 Jan 2024 10:00:00 +0000",
            }),
            mimeType: "text/plain",
            body: { data: Buffer.from("Hello world body").toString("base64url") },
          },
        },
        {
          id: "msg-002",
          threadId: "thread-abc",
          snippet: "Re: Hello",
          payload: {
            headers: makeHeaders({
              From: "test@example.com",
              To: "alice@example.com",
              Subject: "Re: Test subject",
              Date: "Mon, 1 Jan 2024 11:00:00 +0000",
            }),
            mimeType: "text/plain",
            body: { data: Buffer.from("Reply body").toString("base64url") },
          },
        },
      ],
    };

    fetchSpy.mockResolvedValueOnce(
      mockFetchResponse(mockThreadPayload) as unknown as Response
    );

    const result = await getGmailThread(1, "test@example.com", "thread-abc");

    expect(fetchSpy).toHaveBeenCalledOnce();
    const calledUrl = fetchSpy.mock.calls[0][0] as string;
    expect(calledUrl).toContain("thread-abc");
    expect(calledUrl).toContain("format=full");

    expect(result.thread_id).toBe("thread-abc");
    expect(result.account).toBe("test@example.com");
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].id).toBe("msg-001");
    expect(result.messages[0].from).toBe("alice@example.com");
    expect(result.messages[0].subject).toBe("Test subject");
    expect(result.messages[1].id).toBe("msg-002");
  });

  it("throws when account is not connected", async () => {
    const { getGmailThread } = await import("../../server/cloud-integrations");
    setupDbForNoAccounts();

    await expect(
      getGmailThread(1, "nobody@example.com", "thread-xyz")
    ).rejects.toThrow("not connected");
  });

  it("throws when Gmail API returns error status", async () => {
    const { getGmailThread } = await import("../../server/cloud-integrations");
    setupDbForConnectedAccount();

    fetchSpy.mockResolvedValueOnce(
      mockFetchResponse({ error: "Not found" }, false, 404) as unknown as Response
    );

    await expect(
      getGmailThread(1, "test@example.com", "bad-thread")
    ).rejects.toThrow("404");
  });
});

// ── sendGmailNew ─────────────────────────────────────────────────────────────

describe("sendGmailNew", () => {
  it("happy path: sends email and returns sent_id + thread_id", async () => {
    const { sendGmailNew } = await import("../../server/cloud-integrations");
    setupDbForConnectedAccount();

    const mockSentResponse = { id: "sent-001", threadId: "thread-new-001" };
    fetchSpy.mockResolvedValueOnce(
      mockFetchResponse(mockSentResponse) as unknown as Response
    );

    const result = await sendGmailNew(
      1,
      "test@example.com",
      "recipient@example.com",
      "Test Subject",
      "Hello from unit test"
    );

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/messages/send");
    expect(opts.method).toBe("POST");

    const body = JSON.parse(opts.body as string);
    expect(body.raw).toBeTruthy();

    // Decode and verify headers in raw RFC 2822 message
    const decoded = Buffer.from(
      body.raw.replace(/-/g, "+").replace(/_/g, "/"),
      "base64"
    ).toString("utf8");
    expect(decoded).toContain("From: test@example.com");
    expect(decoded).toContain("To: recipient@example.com");
    expect(decoded).toContain("Subject: Test Subject");
    expect(decoded).toContain("Hello from unit test");

    expect(result.ok).toBe(true);
    expect(result.sent_id).toBe("sent-001");
    expect(result.thread_id).toBe("thread-new-001");
  });

  it("includes Cc header when cc is provided", async () => {
    const { sendGmailNew } = await import("../../server/cloud-integrations");
    setupDbForConnectedAccount();

    fetchSpy.mockResolvedValueOnce(
      mockFetchResponse({ id: "sent-002", threadId: "thread-002" }) as unknown as Response
    );

    await sendGmailNew(
      1,
      "test@example.com",
      "to@example.com",
      "Subject",
      "Body",
      "cc@example.com"
    );

    const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string);
    const decoded = Buffer.from(
      body.raw.replace(/-/g, "+").replace(/_/g, "/"),
      "base64"
    ).toString("utf8");
    expect(decoded).toContain("Cc: cc@example.com");
  });

  it("throws when account is not connected", async () => {
    const { sendGmailNew } = await import("../../server/cloud-integrations");
    setupDbForNoAccounts();

    await expect(
      sendGmailNew(1, "nobody@example.com", "to@x.com", "s", "b")
    ).rejects.toThrow("not connected");
  });
});

// ── sendGmailReply ───────────────────────────────────────────────────────────

describe("sendGmailReply", () => {
  it("happy path: fetches original headers and sends threaded reply", async () => {
    const { sendGmailReply } = await import("../../server/cloud-integrations");
    setupDbForConnectedAccount();

    // First fetch: original message metadata
    const origMsgPayload = {
      id: "msg-orig",
      threadId: "thread-reply-001",
      payload: {
        headers: makeHeaders({
          Subject: "Original subject",
          From: "sender@example.com",
          To: "test@example.com",
          "Message-ID": "<orig-msgid@example.com>",
          References: "",
          "In-Reply-To": "",
        }),
      },
    };
    const sentPayload = { id: "reply-001", threadId: "thread-reply-001" };

    fetchSpy
      .mockResolvedValueOnce(mockFetchResponse(origMsgPayload) as unknown as Response)
      .mockResolvedValueOnce(mockFetchResponse(sentPayload) as unknown as Response);

    const result = await sendGmailReply(
      1,
      "test@example.com",
      "msg-orig",
      "This is my reply"
    );

    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const [, sendOpts] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const sendBody = JSON.parse(sendOpts.body as string);
    expect(sendBody.threadId).toBe("thread-reply-001");

    const decoded = Buffer.from(
      sendBody.raw.replace(/-/g, "+").replace(/_/g, "/"),
      "base64"
    ).toString("utf8");
    expect(decoded).toContain("Subject: Re: Original subject");
    expect(decoded).toContain("In-Reply-To: <orig-msgid@example.com>");
    expect(decoded).toContain("This is my reply");

    expect(result.ok).toBe(true);
    expect(result.sent_id).toBe("reply-001");
    expect(result.thread_id).toBe("thread-reply-001");
  });

  it("does not double-prefix Re: if subject already starts with Re:", async () => {
    const { sendGmailReply } = await import("../../server/cloud-integrations");
    setupDbForConnectedAccount();

    const origMsgPayload = {
      id: "msg-re",
      threadId: "thread-re",
      payload: {
        headers: makeHeaders({
          Subject: "Re: Already prefixed",
          From: "sender@example.com",
          To: "test@example.com",
          "Message-ID": "<re-msgid@example.com>",
          References: "",
          "In-Reply-To": "",
        }),
      },
    };

    fetchSpy
      .mockResolvedValueOnce(mockFetchResponse(origMsgPayload) as unknown as Response)
      .mockResolvedValueOnce(
        mockFetchResponse({ id: "r2", threadId: "thread-re" }) as unknown as Response
      );

    await sendGmailReply(1, "test@example.com", "msg-re", "reply body");

    const [, sendOpts] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const sendBody = JSON.parse(sendOpts.body as string);
    const decoded = Buffer.from(
      sendBody.raw.replace(/-/g, "+").replace(/_/g, "/"),
      "base64"
    ).toString("utf8");

    expect(decoded).not.toContain("Re: Re:");
    expect(decoded).toContain("Subject: Re: Already prefixed");
  });
});
