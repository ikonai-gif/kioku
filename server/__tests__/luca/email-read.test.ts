/**
 * Luca V1a Step 4 PR A — Gmail read tools unit tests.
 *
 * Covers:
 *   - Four-level flag gate (master / tools-master / email-scope / per-tool):
 *     each flag individually off → tool is disabled and NOT listed in the
 *     registry output; handler returns status:"disabled" without side effects.
 *   - Input validation: required fields, type/length guards, whitespace
 *     rejection in Gmail IDs, over-length account email, q length cap.
 *   - Account resolution: explicit `account` picks the matching connected
 *     account (case-insensitive); missing account defaults to first;
 *     unknown account → error; zero connected accounts → error with
 *     reconnect hint.
 *   - Successful happy path for all three tools (inbox_list / email_read /
 *     email_thread) using dependency-injected fakes.
 *   - Forensic log: pending row + terminal row inserted for every call
 *     (both success and error paths).
 *   - SF3 identity: same inputs → same code_sha; different inputs → different
 *     code_sha; tool name is part of the identity so collisions between
 *     families are impossible.
 *   - Registry wiring: all three tools listed when all four flags are on;
 *     dispatch routes to the right handler by name.
 *
 * Mocking strategy: we mock `../../storage` to capture `tool_runs` inserts
 * (same pattern as read-url.test.ts) and pass fake cloud-integration
 * functions via the `deps` parameter on each handler. No network, no DB.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock storage BEFORE importing handlers.
const insertedRows: Record<string, unknown>[] = [];
vi.mock("../../storage", () => {
  const values = vi.fn(async (row: Record<string, unknown>) => {
    insertedRows.push(row);
  });
  const insert = vi.fn(() => ({ values }));
  return {
    db: { insert },
    pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
  };
});

import {
  inboxListHandler,
  emailReadHandler,
  emailThreadHandler,
  inboxListTool,
  emailReadTool,
  emailThreadTool,
  parseInboxListInput,
  parseEmailReadInput,
  parseEmailThreadInput,
  computeInboxListSha,
  computeEmailReadSha,
  computeEmailThreadSha,
  INBOX_LIST_DEFAULT_MAX_RESULTS,
  INBOX_LIST_CAP_MAX_RESULTS,
  INBOX_LIST_MAX_Q_LENGTH,
  ACCOUNT_EMAIL_MAX_LENGTH,
  GMAIL_ID_MAX_LENGTH,
  type EmailReadContext,
  type EmailReadDeps,
} from "../../lib/luca-tools/email-read";
import { toSandboxKey } from "../../lib/luca/pyodide-runner";
import {
  __getAllLucaToolSpecsForTests,
  dispatchLucaTool,
  getLucaTools,
} from "../../lib/luca-tools/registry";
import {
  classifyTool,
  classifyToolCall,
} from "../../lib/luca-approvals/classify";
import { getToolTrustLevel } from "../../lib/luca-tools/trust-policy";

// ─── Flag helpers ────────────────────────────────────────────────────────

const ALL_LUCA_FLAG_KEYS = [
  "LUCA_V1A_ENABLED",
  "LUCA_TOOLS_ENABLED",
  "LUCA_EMAIL_SCOPE_ENABLED",
  "LUCA_TOOL_EMAIL_READ_ENABLED",
  "LUCA_TOOL_RUN_CODE_ENABLED",
  "LUCA_TOOL_ANALYZE_IMAGE_ENABLED",
  "LUCA_TOOL_SEARCH_ENABLED",
  "LUCA_TOOL_READ_URL_ENABLED",
];

function setFlags(overrides: Record<string, string | undefined>) {
  for (const k of ALL_LUCA_FLAG_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function allEmailOn() {
  setFlags({
    LUCA_V1A_ENABLED: "true",
    LUCA_TOOLS_ENABLED: "true",
    LUCA_EMAIL_SCOPE_ENABLED: "true",
    LUCA_TOOL_EMAIL_READ_ENABLED: "true",
  });
}

function makeCtx(): EmailReadContext {
  return {
    userId: 10,
    meetingId: "11111111-1111-1111-1111-111111111111",
    turnId: "22222222-2222-2222-2222-222222222222",
    ctxKey: toSandboxKey(
      "m_111111111111111111111111111111111111_t_222222222222222222222222222222222222",
    ),
  };
}

// Fake helpers — narrow-typed to avoid `any` pollution.
function makeDeps(overrides: Partial<EmailReadDeps> = {}): EmailReadDeps {
  return {
    listGmailAccountsFn: vi.fn().mockResolvedValue([
      {
        id: 1,
        email: "kotkave@gmail.com",
        createdAt: 1700000000000,
        tokenExpiry: null,
        hasRefreshToken: true,
        expired: false,
      },
    ]),
    searchGmailAllFn: vi.fn().mockResolvedValue({
      messages: [
        {
          account: "kotkave@gmail.com",
          id: "m1",
          threadId: "t1",
          subject: "Welcome",
          from: "brevo@brevo.com",
          date: "Thu, 24 Apr 2026 10:00:00 +0000",
          snippet: "Hello Kote",
        },
        {
          account: "kotkave@gmail.com",
          id: "m2",
          threadId: "t2",
          subject: "Invoice",
          from: "billing@stripe.com",
          date: "Thu, 24 Apr 2026 11:00:00 +0000",
          snippet: "Your invoice is ready",
        },
      ],
      accountStatuses: [
        { email: "kotkave@gmail.com", ok: true, messages_found: 2 },
      ],
    }),
    readGmailMessageFn: vi.fn().mockResolvedValue({
      account: "kotkave@gmail.com",
      subject: "Welcome",
      from: "brevo@brevo.com",
      to: "kotkave@gmail.com",
      date: "Thu, 24 Apr 2026 10:00:00 +0000",
      body: "Hello Kote, welcome to Brevo",
      truncated: false,
    }),
    getGmailThreadFn: vi.fn().mockResolvedValue({
      thread_id: "t1",
      account: "kotkave@gmail.com",
      messages: [
        {
          id: "m1",
          from: "brevo@brevo.com",
          to: "kotkave@gmail.com",
          subject: "Welcome",
          date: "Thu, 24 Apr 2026 10:00:00 +0000",
          body: "Hello Kote",
          snippet: "Hello Kote",
        },
        {
          id: "m3",
          from: "kotkave@gmail.com",
          to: "brevo@brevo.com",
          subject: "Re: Welcome",
          date: "Thu, 24 Apr 2026 10:30:00 +0000",
          body: "Thanks!",
          snippet: "Thanks!",
        },
      ],
    }),
    ...overrides,
  };
}

beforeEach(() => {
  insertedRows.length = 0;
  allEmailOn();
});

afterEach(() => {
  setFlags({});
});

// ─── Input validation ────────────────────────────────────────────────────

describe("parseInboxListInput", () => {
  it("accepts empty object (all fields optional)", () => {
    expect(parseInboxListInput({})).toEqual({
      account: undefined,
      q: undefined,
      max_results: undefined,
    });
  });

  it("lowercases account", () => {
    const r = parseInboxListInput({ account: "Kotkave@Gmail.COM" });
    expect(r.account).toBe("kotkave@gmail.com");
  });

  it("rejects non-string account", () => {
    expect(() => parseInboxListInput({ account: 42 })).toThrow(/account/);
  });

  it(`rejects account longer than ${ACCOUNT_EMAIL_MAX_LENGTH} chars`, () => {
    const huge = "a".repeat(ACCOUNT_EMAIL_MAX_LENGTH + 1) + "@x.com";
    expect(() => parseInboxListInput({ account: huge })).toThrow(/exceeds/);
  });

  it(`rejects q longer than ${INBOX_LIST_MAX_Q_LENGTH} chars`, () => {
    const huge = "a".repeat(INBOX_LIST_MAX_Q_LENGTH + 1);
    expect(() => parseInboxListInput({ q: huge })).toThrow(/exceeds/);
  });

  it("rejects NaN / Infinity / non-integer / zero / negative max_results", () => {
    for (const bad of [NaN, Infinity, -1, 0, 1.5, "10", true]) {
      expect(() =>
        parseInboxListInput({ max_results: bad as unknown }),
      ).toThrow(/max_results/);
    }
  });

  it("accepts valid max_results", () => {
    expect(parseInboxListInput({ max_results: 5 }).max_results).toBe(5);
  });
});

describe("parseEmailReadInput", () => {
  it("requires account and message_id", () => {
    expect(() => parseEmailReadInput({})).toThrow(/account/);
    expect(() =>
      parseEmailReadInput({ account: "a@b.com" }),
    ).toThrow(/message_id/);
  });

  it("rejects whitespace in message_id", () => {
    expect(() =>
      parseEmailReadInput({ account: "a@b.com", message_id: "abc def" }),
    ).toThrow(/message_id/);
    expect(() =>
      parseEmailReadInput({ account: "a@b.com", message_id: "abc\ndef" }),
    ).toThrow(/message_id/);
  });

  it(`rejects message_id longer than ${GMAIL_ID_MAX_LENGTH} chars`, () => {
    const huge = "a".repeat(GMAIL_ID_MAX_LENGTH + 1);
    expect(() =>
      parseEmailReadInput({ account: "a@b.com", message_id: huge }),
    ).toThrow(/exceeds/);
  });

  it("accepts valid input", () => {
    const r = parseEmailReadInput({
      account: "A@B.COM",
      message_id: "abc123",
    });
    expect(r).toEqual({ account: "a@b.com", message_id: "abc123" });
  });
});

describe("parseEmailThreadInput", () => {
  it("requires account and thread_id", () => {
    expect(() => parseEmailThreadInput({})).toThrow(/account/);
    expect(() =>
      parseEmailThreadInput({ account: "a@b.com" }),
    ).toThrow(/thread_id/);
  });

  it("accepts valid input", () => {
    const r = parseEmailThreadInput({
      account: "a@b.com",
      thread_id: "t1",
    });
    expect(r).toEqual({ account: "a@b.com", thread_id: "t1" });
  });
});

// ─── SF3 code_sha identity ───────────────────────────────────────────────

describe("code_sha identity", () => {
  it("inbox_list: same inputs → same sha", () => {
    expect(computeInboxListSha("a@b.com", "is:unread", 10)).toBe(
      computeInboxListSha("a@b.com", "is:unread", 10),
    );
  });

  it("inbox_list: different max_results → different sha", () => {
    expect(computeInboxListSha("a@b.com", "", 10)).not.toBe(
      computeInboxListSha("a@b.com", "", 20),
    );
  });

  it("inbox_list: different account → different sha", () => {
    expect(computeInboxListSha("a@b.com", "", 10)).not.toBe(
      computeInboxListSha("b@c.com", "", 10),
    );
  });

  it("email_read: same inputs → same sha", () => {
    expect(computeEmailReadSha("a@b.com", "m1")).toBe(
      computeEmailReadSha("a@b.com", "m1"),
    );
  });

  it("cross-family collision impossible (tool in identity)", () => {
    // Same notional parameters, different tools — shas must differ.
    expect(computeEmailReadSha("a@b.com", "x")).not.toBe(
      computeEmailThreadSha("a@b.com", "x"),
    );
  });
});

// ─── Flag-gate: disabled path for each handler ───────────────────────────

describe("flag gate", () => {
  it.each([
    ["LUCA_V1A_ENABLED"],
    ["LUCA_TOOLS_ENABLED"],
    ["LUCA_EMAIL_SCOPE_ENABLED"],
    ["LUCA_TOOL_EMAIL_READ_ENABLED"],
  ])(
    "inbox_list returns disabled when %s is off",
    async (flag) => {
      allEmailOn();
      delete process.env[flag as string];
      const r = await inboxListHandler({}, makeCtx(), makeDeps());
      expect(r.status).toBe("disabled");
      expect(r.error).toMatch(/luca_feature_disabled/);
      // No tool_runs row on disabled path.
      expect(insertedRows).toHaveLength(0);
    },
  );

  it.each([
    ["LUCA_V1A_ENABLED"],
    ["LUCA_TOOLS_ENABLED"],
    ["LUCA_EMAIL_SCOPE_ENABLED"],
    ["LUCA_TOOL_EMAIL_READ_ENABLED"],
  ])(
    "email_read returns disabled when %s is off",
    async (flag) => {
      allEmailOn();
      delete process.env[flag as string];
      const r = await emailReadHandler(
        { account: "a@b.com", message_id: "m1" },
        makeCtx(),
        makeDeps(),
      );
      expect(r.status).toBe("disabled");
    },
  );

  it.each([
    ["LUCA_V1A_ENABLED"],
    ["LUCA_TOOLS_ENABLED"],
    ["LUCA_EMAIL_SCOPE_ENABLED"],
    ["LUCA_TOOL_EMAIL_READ_ENABLED"],
  ])(
    "email_thread returns disabled when %s is off",
    async (flag) => {
      allEmailOn();
      delete process.env[flag as string];
      const r = await emailThreadHandler(
        { account: "a@b.com", thread_id: "t1" },
        makeCtx(),
        makeDeps(),
      );
      expect(r.status).toBe("disabled");
    },
  );
});

// ─── Happy paths ─────────────────────────────────────────────────────────

describe("inboxListHandler happy path", () => {
  it("lists messages filtered to resolved account", async () => {
    const deps = makeDeps();
    const r = await inboxListHandler(
      { q: "from:brevo.com", max_results: 5 },
      makeCtx(),
      deps,
    );
    expect(r.status).toBe("ok");
    expect(r.account).toBe("kotkave@gmail.com");
    expect(r.messages).toHaveLength(2);
    expect(r.messages![0]).toMatchObject({
      id: "m1",
      thread_id: "t1",
      subject: "Welcome",
    });
    expect(r.trust_level).toBe("UNTRUSTED");
    // pending + terminal rows
    expect(insertedRows).toHaveLength(2);
    expect(insertedRows[0].status).toBe("pending");
    expect(insertedRows[1].status).toBe("ok");
    expect(insertedRows[0].tool).toBe("luca_inbox_list");
  });

  it("caps max_results at INBOX_LIST_CAP_MAX_RESULTS", async () => {
    const deps = makeDeps();
    const searchFn = deps.searchGmailAllFn as ReturnType<typeof vi.fn>;
    await inboxListHandler(
      { max_results: INBOX_LIST_CAP_MAX_RESULTS + 100 },
      makeCtx(),
      deps,
    );
    // Verify the helper was called with the CAPPED value (3rd arg).
    expect(searchFn.mock.calls[0][2]).toBe(INBOX_LIST_CAP_MAX_RESULTS);
  });

  it("defaults to first account when account omitted", async () => {
    const deps = makeDeps({
      listGmailAccountsFn: vi.fn().mockResolvedValue([
        {
          id: 1,
          email: "first@gmail.com",
          createdAt: 1,
          tokenExpiry: null,
          hasRefreshToken: true,
          expired: false,
        },
        {
          id: 2,
          email: "second@gmail.com",
          createdAt: 2,
          tokenExpiry: null,
          hasRefreshToken: true,
          expired: false,
        },
      ]),
      searchGmailAllFn: vi.fn().mockResolvedValue({
        messages: [
          {
            account: "first@gmail.com",
            id: "m1",
            threadId: "t1",
            subject: "A",
            from: "x@y.com",
            date: "",
            snippet: "",
          },
          {
            account: "second@gmail.com",
            id: "m2",
            threadId: "t2",
            subject: "B",
            from: "x@y.com",
            date: "",
            snippet: "",
          },
        ],
        accountStatuses: [],
      }),
    });
    const r = await inboxListHandler({}, makeCtx(), deps);
    expect(r.account).toBe("first@gmail.com");
    // Filtered down to only first account's message.
    expect(r.messages!.map((m) => m.id)).toEqual(["m1"]);
  });

  it("errors when user has no connected accounts", async () => {
    const deps = makeDeps({
      listGmailAccountsFn: vi.fn().mockResolvedValue([]),
    });
    const r = await inboxListHandler({}, makeCtx(), deps);
    expect(r.status).toBe("error");
    expect(r.error).toMatch(/no_accounts|no Gmail account connected/i);
    // pending + terminal(error) rows
    expect(insertedRows).toHaveLength(2);
    expect(insertedRows[1].status).toBe("error");
  });

  it("errors when requested account is not connected", async () => {
    const deps = makeDeps();
    const r = await inboxListHandler(
      { account: "missing@example.com" },
      makeCtx(),
      deps,
    );
    expect(r.status).toBe("error");
    expect(r.error).toMatch(/account_not_connected/);
  });
});

describe("emailReadHandler happy path", () => {
  it("returns full message body", async () => {
    const deps = makeDeps();
    const r = await emailReadHandler(
      { account: "kotkave@gmail.com", message_id: "m1" },
      makeCtx(),
      deps,
    );
    expect(r.status).toBe("ok");
    expect(r.body).toBe("Hello Kote, welcome to Brevo");
    expect(r.truncated).toBe(false);
    expect(r.trust_level).toBe("UNTRUSTED");
    expect(insertedRows).toHaveLength(2);
    // Output must NOT contain the body itself (privacy: only length metadata).
    const terminal = insertedRows[1] as Record<string, unknown>;
    const output = terminal.output as Record<string, unknown> | null;
    expect(output).not.toBeNull();
    expect(JSON.stringify(output)).not.toContain("Hello Kote");
    expect(output!.body_len).toBe("Hello Kote, welcome to Brevo".length);
  });

  it("surfaces errors from Gmail helper", async () => {
    const deps = makeDeps({
      readGmailMessageFn: vi
        .fn()
        .mockRejectedValue(new Error("Gmail message fetch failed: 404")),
    });
    const r = await emailReadHandler(
      { account: "kotkave@gmail.com", message_id: "m-missing" },
      makeCtx(),
      deps,
    );
    expect(r.status).toBe("error");
    expect(r.error).toMatch(/404/);
  });

  it("maps timeout errors to status:'timeout'", async () => {
    const deps = makeDeps({
      readGmailMessageFn: vi
        .fn()
        .mockRejectedValue(new Error("request timeout after 20000ms")),
    });
    const r = await emailReadHandler(
      { account: "kotkave@gmail.com", message_id: "m1" },
      makeCtx(),
      deps,
    );
    expect(r.status).toBe("timeout");
  });
});

describe("emailThreadHandler happy path", () => {
  it("returns full thread", async () => {
    const deps = makeDeps();
    const r = await emailThreadHandler(
      { account: "kotkave@gmail.com", thread_id: "t1" },
      makeCtx(),
      deps,
    );
    expect(r.status).toBe("ok");
    expect(r.thread_id).toBe("t1");
    expect(r.messages).toHaveLength(2);
    expect(r.trust_level).toBe("UNTRUSTED");
  });
});

// ─── Anthropic specs ─────────────────────────────────────────────────────

describe("Anthropic tool specs", () => {
  it("inbox_list spec shape", () => {
    expect(inboxListTool.name).toBe("luca_inbox_list");
    expect(inboxListTool.input_schema.type).toBe("object");
    expect(inboxListTool.input_schema.required ?? []).toEqual([]);
  });
  it("email_read spec requires account + message_id", () => {
    expect(emailReadTool.input_schema.required).toEqual([
      "account",
      "message_id",
    ]);
  });
  it("email_thread spec requires account + thread_id", () => {
    expect(emailThreadTool.input_schema.required).toEqual([
      "account",
      "thread_id",
    ]);
  });
});

// ─── Classification ──────────────────────────────────────────────────────

describe("classify.ts integration", () => {
  it("all three classify as READ_ONLY", () => {
    expect(classifyTool("luca_inbox_list")).toBe("READ_ONLY");
    expect(classifyTool("luca_email_read")).toBe("READ_ONLY");
    expect(classifyTool("luca_email_thread")).toBe("READ_ONLY");
  });

  it("classifyToolCall doesn't upgrade READ_ONLY", () => {
    expect(classifyToolCall("luca_inbox_list", { q: "anything" })).toBe(
      "READ_ONLY",
    );
  });
});

// ─── Trust policy ────────────────────────────────────────────────────────

describe("trust-policy.ts integration", () => {
  it("all three are UNTRUSTED", () => {
    expect(getToolTrustLevel("luca_inbox_list")).toBe("UNTRUSTED");
    expect(getToolTrustLevel("luca_email_read")).toBe("UNTRUSTED");
    expect(getToolTrustLevel("luca_email_thread")).toBe("UNTRUSTED");
  });
});

// ─── Registry wiring ─────────────────────────────────────────────────────

describe("registry wiring", () => {
  it("all three tools listed when all four flags on", () => {
    allEmailOn();
    const names = getLucaTools().map((t) => t.name);
    expect(names).toContain("luca_inbox_list");
    expect(names).toContain("luca_email_read");
    expect(names).toContain("luca_email_thread");
  });

  it.each([
    ["LUCA_V1A_ENABLED"],
    ["LUCA_TOOLS_ENABLED"],
    ["LUCA_EMAIL_SCOPE_ENABLED"],
    ["LUCA_TOOL_EMAIL_READ_ENABLED"],
  ])(
    "all three tools OMITTED when %s is off",
    (flag) => {
      allEmailOn();
      delete process.env[flag as string];
      const names = getLucaTools().map((t) => t.name);
      expect(names).not.toContain("luca_inbox_list");
      expect(names).not.toContain("luca_email_read");
      expect(names).not.toContain("luca_email_thread");
    },
  );

  it("__getAllLucaToolSpecsForTests includes all three regardless of flags", () => {
    setFlags({}); // all off
    const names = __getAllLucaToolSpecsForTests().map((t) => t.name);
    expect(names).toContain("luca_inbox_list");
    expect(names).toContain("luca_email_read");
    expect(names).toContain("luca_email_thread");
  });

  it("dispatchLucaTool routes luca_inbox_list to handler", async () => {
    // With email flags off, the handler returns status:"disabled" — that
    // proves dispatch reached the right function without executing real
    // Gmail calls.
    setFlags({
      LUCA_V1A_ENABLED: "true",
      LUCA_TOOLS_ENABLED: "true",
      // email scope off
    });
    const ctx = {
      ...makeCtx(),
    };
    const r = (await dispatchLucaTool(
      "luca_inbox_list",
      {},
      // dispatch takes a union context — cast is fine for the test surface.
      ctx as unknown as Parameters<typeof dispatchLucaTool>[2],
    )) as { status: string };
    expect(r.status).toBe("disabled");
  });

  it("dispatchLucaTool routes luca_email_read to handler", async () => {
    setFlags({
      LUCA_V1A_ENABLED: "true",
      LUCA_TOOLS_ENABLED: "true",
    });
    const r = (await dispatchLucaTool(
      "luca_email_read",
      { account: "a@b.com", message_id: "m1" },
      makeCtx() as unknown as Parameters<typeof dispatchLucaTool>[2],
    )) as { status: string };
    expect(r.status).toBe("disabled");
  });

  it("dispatchLucaTool routes luca_email_thread to handler", async () => {
    setFlags({
      LUCA_V1A_ENABLED: "true",
      LUCA_TOOLS_ENABLED: "true",
    });
    const r = (await dispatchLucaTool(
      "luca_email_thread",
      { account: "a@b.com", thread_id: "t1" },
      makeCtx() as unknown as Parameters<typeof dispatchLucaTool>[2],
    )) as { status: string };
    expect(r.status).toBe("disabled");
  });

  it("unknown tool name still throws", async () => {
    await expect(
      dispatchLucaTool(
        "luca_does_not_exist",
        {},
        makeCtx() as unknown as Parameters<typeof dispatchLucaTool>[2],
      ),
    ).rejects.toThrow(/luca_tool_not_found/);
  });
});
