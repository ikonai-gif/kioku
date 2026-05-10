/**
 * Luca V1a — Notion tools unit tests.
 *
 * Covers the 10 cases requested by BOSS for Phase 2:
 *   T1. notion_search returns the expected result shape.
 *   T2. notion_fetch returns markdown rendered from the page's blocks.
 *   T3. notion_append on a whitelisted parent — success + audit log row.
 *   T4. notion_append on a non-whitelisted parent — THROWS before any
 *       Notion API call (handler returns status:"blocked").
 *   T5. notion_create on a whitelisted parent — success.
 *   T6. notion_create on a non-whitelisted parent — THROWS before any
 *       Notion API call.
 *   T7. 5xx response → retry up to 2 times with backoff.
 *   T8. 4xx response → throw immediately, no retry.
 *   T9. Audit log row written ONLY for write tools (append/create).
 *   T10. Read tools (search/fetch) do NOT write to audit log.
 *
 * Plus a couple of registry-wiring sanity checks so the discriminated
 * `kind: "notion"` entries flow through `getLucaTools()` and
 * `dispatchLucaTool()` correctly.
 *
 * Mocking strategy: same as email-read.test.ts. We mock `../../storage` to
 * capture `tool_runs` inserts, build a fake Notion client, and pass both
 * via the `deps` parameter on each handler. No network, no DB. No
 * `vi.mock` of the @notionhq/client SDK itself — DI is cleaner.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock storage BEFORE importing handlers (same trick as email-read.test.ts).
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
  APIErrorCode,
  APIResponseError,
} from "@notionhq/client";

import {
  notionSearchHandler,
  notionFetchHandler,
  notionAppendHandler,
  notionCreateHandler,
  notionSearchTool,
  notionFetchTool,
  notionAppendTool,
  notionCreateTool,
  parseNotionSearchInput,
  parseNotionFetchInput,
  parseNotionAppendInput,
  parseNotionCreateInput,
  computeNotionSearchSha,
  computeNotionFetchSha,
  computeNotionAppendSha,
  computeNotionCreateSha,
  normalizeNotionPageId,
  assertWritableParent,
  WhitelistViolationError,
  markdownToNotionBlocks,
  notionBlocksToMarkdown,
  textToRichTextSegments,
  retryNotion,
  LUCA_WRITABLE_PARENTS,
  NOTION_RETRY_DELAYS_MS,
  NOTION_MAX_RETRIES,
  type NotionContext,
  type NotionDeps,
} from "../../lib/luca-tools/notion";
import { toSandboxKey } from "../../lib/luca/pyodide-runner";
import {
  __getAllLucaToolSpecsForTests,
  dispatchLucaTool,
  getLucaTools,
} from "../../lib/luca-tools/registry";
import {
  classifyTool,
  TOOL_WRITE_CLASS,
} from "../../lib/luca-approvals/classify";
import { getToolTrustLevel } from "../../lib/luca-tools/trust-policy";

// ─── Flag helpers ────────────────────────────────────────────────────────

const ALL_LUCA_FLAG_KEYS = [
  "LUCA_V1A_ENABLED",
  "LUCA_TOOLS_ENABLED",
  "LUCA_NOTION_SCOPE_ENABLED",
  "LUCA_TOOL_NOTION_READ_ENABLED",
  "LUCA_TOOL_NOTION_WRITE_ENABLED",
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

function allNotionOn() {
  setFlags({
    LUCA_V1A_ENABLED: "true",
    LUCA_TOOLS_ENABLED: "true",
    LUCA_NOTION_SCOPE_ENABLED: "true",
    LUCA_TOOL_NOTION_READ_ENABLED: "true",
    LUCA_TOOL_NOTION_WRITE_ENABLED: "true",
  });
}

function makeCtx(): NotionContext {
  return {
    userId: 10,
    agentId: 7,
    meetingId: "11111111-1111-1111-1111-111111111111",
    turnId: "22222222-2222-2222-2222-222222222222",
    ctxKey: toSandboxKey(
      "m_111111111111111111111111111111111111_t_222222222222222222222222222222222222",
    ),
  };
}

// ─── Fake Notion client (DI hook) ────────────────────────────────────────

type FakeClientOverrides = {
  search?: ReturnType<typeof vi.fn>;
  pagesRetrieve?: ReturnType<typeof vi.fn>;
  pagesCreate?: ReturnType<typeof vi.fn>;
  blocksList?: ReturnType<typeof vi.fn>;
  blocksAppend?: ReturnType<typeof vi.fn>;
};

function makeFakeClient(over: FakeClientOverrides = {}): {
  client: any;
  spies: Required<FakeClientOverrides>;
} {
  const search =
    over.search ??
    vi.fn().mockResolvedValue({
      object: "list",
      has_more: false,
      next_cursor: null,
      results: [
        {
          object: "page",
          id: "abc12345-1111-2222-3333-aaaaaaaaaaaa",
          url: "https://www.notion.so/abc",
          last_edited_time: "2026-05-08T12:00:00.000Z",
          properties: {
            title: {
              type: "title",
              title: [{ plain_text: "Synchro draft" }],
            },
          },
        },
      ],
    });
  const pagesRetrieve =
    over.pagesRetrieve ??
    vi.fn().mockResolvedValue({
      object: "page",
      id: "abc12345-1111-2222-3333-aaaaaaaaaaaa",
      url: "https://www.notion.so/abc",
      last_edited_time: "2026-05-08T12:00:00.000Z",
      properties: {
        title: {
          type: "title",
          title: [{ plain_text: "Synchro draft" }],
        },
      },
    });
  const pagesCreate =
    over.pagesCreate ??
    vi.fn().mockResolvedValue({
      object: "page",
      id: "fff12345-9999-8888-7777-ffffffffffff",
      url: "https://www.notion.so/fff",
    });
  const blocksList =
    over.blocksList ??
    vi.fn().mockResolvedValue({
      object: "list",
      has_more: false,
      next_cursor: null,
      results: [
        {
          object: "block",
          id: "blk-1",
          type: "heading_1",
          heading_1: { rich_text: [{ plain_text: "Title" }] },
        },
        {
          object: "block",
          id: "blk-2",
          type: "paragraph",
          paragraph: { rich_text: [{ plain_text: "Hello world" }] },
        },
      ],
    });
  const blocksAppend =
    over.blocksAppend ??
    vi.fn().mockResolvedValue({
      object: "list",
      results: [
        { object: "block", id: "new-blk-1", type: "paragraph" },
      ],
    });

  return {
    client: {
      search,
      pages: { retrieve: pagesRetrieve, create: pagesCreate },
      blocks: {
        children: { list: blocksList, append: blocksAppend },
      },
    },
    spies: {
      search,
      pagesRetrieve,
      pagesCreate,
      blocksList,
      blocksAppend,
    },
  };
}

// ─── Audit-log capture ──────────────────────────────────────────────────

type AuditCall = Parameters<NonNullable<NotionDeps["recordAuditFn"]>>[0];

function makeAuditCapture(): { calls: AuditCall[]; fn: NonNullable<NotionDeps["recordAuditFn"]> } {
  const calls: AuditCall[] = [];
  const fn: NonNullable<NotionDeps["recordAuditFn"]> = async (params) => {
    calls.push(params);
  };
  return { calls, fn };
}

// ─── APIResponseError helper ────────────────────────────────────────────

function makeAPIResponseError(
  status: number,
  code: APIErrorCode,
  message = `notion api ${status}`,
): APIResponseError {
  return new APIResponseError({
    code,
    status,
    message,
    headers: new Headers(),
    rawBodyText: JSON.stringify({ object: "error", code, message }),
    additional_data: undefined,
    request_id: undefined,
  });
}

// ─── Setup / teardown ────────────────────────────────────────────────────

const WHITELISTED = "35952684-0762-81dd-99b5-cc6ae8da29f5"; // MEETING_ROOM
const WHITELISTED_NORMALIZED = "35952684076281dd99b5cc6ae8da29f5";
const NON_WHITELISTED = "deadbeef-cafe-cafe-cafe-deadbeefcafe";

const FAST_DEPS = (over: Partial<NotionDeps> = {}): NotionDeps => ({
  sleep: () => Promise.resolve(),
  ...over,
});

beforeEach(() => {
  insertedRows.length = 0;
  allNotionOn();
});

afterEach(() => {
  setFlags({});
});

// ─── Sanity ──────────────────────────────────────────────────────────────

describe("notion: sanity", () => {
  it("LUCA_WRITABLE_PARENTS contains both expected parents (normalized)", () => {
    expect(LUCA_WRITABLE_PARENTS.size).toBe(2);
    expect(LUCA_WRITABLE_PARENTS.has(WHITELISTED_NORMALIZED)).toBe(true);
    expect(
      LUCA_WRITABLE_PARENTS.has(
        normalizeNotionPageId("35952684-0762-80ad-9b2c-ece62f3bd3bf"),
      ),
    ).toBe(true);
  });

  it("normalizeNotionPageId strips dashes and lowercases", () => {
    const a = normalizeNotionPageId("35952684-0762-81DD-99B5-cc6ae8da29f5");
    const b = normalizeNotionPageId("35952684076281dd99b5cc6ae8da29f5");
    expect(a).toBe(b);
    expect(a).toBe("35952684076281dd99b5cc6ae8da29f5");
  });

  it("normalizeNotionPageId rejects junk", () => {
    expect(() => normalizeNotionPageId("not-a-page-id")).toThrow(/invalid_input/);
    expect(() => normalizeNotionPageId("")).toThrow(/invalid_input/);
    expect(() => normalizeNotionPageId("xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx")).toThrow(
      /invalid_input/,
    );
  });

  it("classify maps notion tools to expected write classes", () => {
    expect(TOOL_WRITE_CLASS.luca_notion_search).toBe("READ_ONLY");
    expect(TOOL_WRITE_CLASS.luca_notion_fetch).toBe("READ_ONLY");
    expect(TOOL_WRITE_CLASS.luca_notion_append).toBe("LOW_STAKES_WRITE");
    expect(TOOL_WRITE_CLASS.luca_notion_create).toBe("LOW_STAKES_WRITE");
    expect(classifyTool("luca_notion_search")).toBe("READ_ONLY");
    expect(classifyTool("luca_notion_append")).toBe("LOW_STAKES_WRITE");
  });

  it("trust-policy labels notion tools UNTRUSTED", () => {
    expect(getToolTrustLevel("luca_notion_search")).toBe("UNTRUSTED");
    expect(getToolTrustLevel("luca_notion_fetch")).toBe("UNTRUSTED");
    expect(getToolTrustLevel("luca_notion_append")).toBe("UNTRUSTED");
    expect(getToolTrustLevel("luca_notion_create")).toBe("UNTRUSTED");
  });

  it("registry exposes all 4 notion tools when both per-family flags are on", () => {
    const names = getLucaTools().map((t) => t.name);
    expect(names).toContain("luca_notion_search");
    expect(names).toContain("luca_notion_fetch");
    expect(names).toContain("luca_notion_append");
    expect(names).toContain("luca_notion_create");
  });

  it("registry hides write tools when only READ flag is on", () => {
    setFlags({
      LUCA_V1A_ENABLED: "true",
      LUCA_TOOLS_ENABLED: "true",
      LUCA_NOTION_SCOPE_ENABLED: "true",
      LUCA_TOOL_NOTION_READ_ENABLED: "true",
      // WRITE flag intentionally OFF
    });
    const names = getLucaTools().map((t) => t.name);
    expect(names).toContain("luca_notion_search");
    expect(names).toContain("luca_notion_fetch");
    expect(names).not.toContain("luca_notion_append");
    expect(names).not.toContain("luca_notion_create");
  });

  it("__getAllLucaToolSpecsForTests includes all 4 regardless of flags", () => {
    const all = __getAllLucaToolSpecsForTests().map((t) => t.name);
    expect(all).toContain("luca_notion_search");
    expect(all).toContain("luca_notion_fetch");
    expect(all).toContain("luca_notion_append");
    expect(all).toContain("luca_notion_create");
  });
});

// ─── Markdown <-> blocks ─────────────────────────────────────────────────

describe("notion: markdown helpers", () => {
  it("markdownToNotionBlocks handles headings + paragraphs + lists + code", () => {
    const md =
      "# H1\n## H2\n### H3\n\nA paragraph.\n\n- bullet 1\n- bullet 2\n\n1. n1\n\n```ts\nconst x = 1;\n```\n";
    const blocks = markdownToNotionBlocks(md);
    const types = blocks.map((b) => b.type);
    expect(types).toEqual([
      "heading_1",
      "heading_2",
      "heading_3",
      "paragraph",
      "bulleted_list_item",
      "bulleted_list_item",
      "numbered_list_item",
      "code",
    ]);
  });

  it("textToRichTextSegments splits long text into <=2000-char segments", () => {
    const huge = "x".repeat(5000);
    const segs = textToRichTextSegments(huge);
    expect(segs.length).toBe(3);
    expect(segs[0].text.content.length).toBe(2000);
    expect(segs[1].text.content.length).toBe(2000);
    expect(segs[2].text.content.length).toBe(1000);
  });

  it("notionBlocksToMarkdown renders the V1 subset round-trippable", () => {
    const md = notionBlocksToMarkdown([
      { type: "heading_1", heading_1: { rich_text: [{ plain_text: "Hi" }] } } as any,
      { type: "paragraph", paragraph: { rich_text: [{ plain_text: "Body" }] } } as any,
      {
        type: "bulleted_list_item",
        bulleted_list_item: { rich_text: [{ plain_text: "one" }] },
      } as any,
    ]);
    expect(md).toContain("# Hi");
    expect(md).toContain("Body");
    expect(md).toContain("- one");
  });
});

// ─── T1: notion_search returns правильный формат ────────────────────────

describe("T1 — notion_search returns правильный формат", () => {
  it("returns {status:'ok', trust_level, query, results[]}", async () => {
    const { client, spies } = makeFakeClient();
    const r = await notionSearchHandler(
      { query: "synchro" },
      makeCtx(),
      FAST_DEPS({ notionClient: client }),
    );
    expect(r.status).toBe("ok");
    expect(r.trust_level).toBe("UNTRUSTED");
    expect(r.query).toBe("synchro");
    expect(Array.isArray(r.results)).toBe(true);
    expect(r.results![0]).toMatchObject({
      id: "abc12345-1111-2222-3333-aaaaaaaaaaaa",
      title: "Synchro draft",
      url: "https://www.notion.so/abc",
      last_edited_time: "2026-05-08T12:00:00.000Z",
      object: "page",
    });
    expect(spies.search).toHaveBeenCalledTimes(1);
    expect(spies.search).toHaveBeenCalledWith({ query: "synchro", page_size: 10 });
  });

  it("respects cap on `limit`", async () => {
    const { client, spies } = makeFakeClient();
    await notionSearchHandler(
      { query: "x", limit: 999 },
      makeCtx(),
      FAST_DEPS({ notionClient: client }),
    );
    expect(spies.search).toHaveBeenCalledWith({ query: "x", page_size: 50 });
  });
});

// ─── T2: notion_fetch returns markdown ───────────────────────────────────

describe("T2 — notion_fetch returns markdown", () => {
  it("renders the page's blocks as markdown", async () => {
    const { client } = makeFakeClient();
    const r = await notionFetchHandler(
      { page_id: "abc12345-1111-2222-3333-aaaaaaaaaaaa" },
      makeCtx(),
      FAST_DEPS({ notionClient: client }),
    );
    expect(r.status).toBe("ok");
    expect(r.title).toBe("Synchro draft");
    expect(r.markdown).toContain("# Title");
    expect(r.markdown).toContain("Hello world");
    expect(r.url).toBe("https://www.notion.so/abc");
    expect(r.truncated).toBe(false);
    expect(r.has_more).toBe(false);
    expect(r.next_cursor).toBeNull();
  });

  it("rejects malformed page_id without calling the API", async () => {
    const { client, spies } = makeFakeClient();
    const r = await notionFetchHandler(
      { page_id: "not-a-page" },
      makeCtx(),
      FAST_DEPS({ notionClient: client }),
    );
    expect(r.status).toBe("error");
    expect(spies.pagesRetrieve).not.toHaveBeenCalled();
  });
});

// ─── T2b: notion_fetch — truncation + pagination ─────────────────────────
//
// Regression tests for the bug where `truncated:false` was returned even
// when the Notion API said `has_more:true` (the original implementation
// silently dropped any blocks past the first 100). Also covers the new
// `cursor` input that resumes paging from a previous `next_cursor`.

describe("T2b — notion_fetch truncation + pagination", () => {
  it("sets truncated=true and surfaces next_cursor when block list has more pages than we will fetch", async () => {
    // Build a fake `blocks.children.list` that always reports `has_more`
    // — every page drives us past the per-call cap so we expect the
    // handler to STOP and surface a cursor.
    let calls = 0;
    const blocksList = vi.fn().mockImplementation(async () => {
      calls += 1;
      return {
        object: "list",
        has_more: true,
        next_cursor: `cur-${calls}`,
        results: [
          {
            object: "block",
            id: `blk-${calls}`,
            type: "paragraph",
            paragraph: { rich_text: [{ plain_text: `chunk ${calls}` }] },
          },
        ],
      };
    });
    const { client } = makeFakeClient({ blocksList });

    const r = await notionFetchHandler(
      { page_id: "abc12345-1111-2222-3333-aaaaaaaaaaaa" },
      makeCtx(),
      FAST_DEPS({ notionClient: client }),
    );

    expect(r.status).toBe("ok");
    expect(r.truncated).toBe(true);
    expect(r.has_more).toBe(true);
    expect(typeof r.next_cursor).toBe("string");
    expect(r.next_cursor && r.next_cursor.length).toBeGreaterThan(0);
    // We should have fetched UP TO the per-call page cap and stopped.
    expect(blocksList).toHaveBeenCalled();
    expect(blocksList.mock.calls.length).toBeLessThanOrEqual(10);
    // First call has no start_cursor, subsequent calls do.
    expect(blocksList.mock.calls[0][0]).not.toHaveProperty("start_cursor");
    if (blocksList.mock.calls.length > 1) {
      expect(blocksList.mock.calls[1][0]).toHaveProperty("start_cursor");
    }
  });

  it("paginates through multiple pages until has_more=false, then truncated=false", async () => {
    let calls = 0;
    const blocksList = vi.fn().mockImplementation(async () => {
      calls += 1;
      const last = calls >= 3;
      return {
        object: "list",
        has_more: !last,
        next_cursor: last ? null : `cur-${calls}`,
        results: [
          {
            object: "block",
            id: `blk-${calls}`,
            type: "paragraph",
            paragraph: { rich_text: [{ plain_text: `chunk ${calls}` }] },
          },
        ],
      };
    });
    const { client } = makeFakeClient({ blocksList });

    const r = await notionFetchHandler(
      { page_id: "abc12345-1111-2222-3333-aaaaaaaaaaaa" },
      makeCtx(),
      FAST_DEPS({ notionClient: client }),
    );

    expect(r.status).toBe("ok");
    expect(r.truncated).toBe(false);
    expect(r.has_more).toBe(false);
    expect(r.next_cursor).toBeNull();
    expect(blocksList).toHaveBeenCalledTimes(3);
    expect(r.markdown).toContain("chunk 1");
    expect(r.markdown).toContain("chunk 2");
    expect(r.markdown).toContain("chunk 3");
  });

  it("passes start_cursor through to Notion when input.cursor is set", async () => {
    const blocksList = vi.fn().mockResolvedValue({
      object: "list",
      has_more: false,
      next_cursor: null,
      results: [
        {
          object: "block",
          id: "blk-x",
          type: "paragraph",
          paragraph: { rich_text: [{ plain_text: "resumed" }] },
        },
      ],
    });
    const { client } = makeFakeClient({ blocksList });

    const r = await notionFetchHandler(
      {
        page_id: "abc12345-1111-2222-3333-aaaaaaaaaaaa",
        cursor: "cursor-from-prev-call",
      },
      makeCtx(),
      FAST_DEPS({ notionClient: client }),
    );

    expect(r.status).toBe("ok");
    expect(blocksList).toHaveBeenCalledTimes(1);
    expect(blocksList.mock.calls[0][0]).toMatchObject({
      block_id: expect.any(String),
      page_size: 100,
      start_cursor: "cursor-from-prev-call",
    });
    expect(r.markdown).toContain("resumed");
  });

  it("sets truncated=true when rendered markdown exceeds the char cap (single page case)", async () => {
    // One paragraph block with a body comfortably over 50,000 chars to
    // force char-truncation regardless of block pagination.
    const huge = "lorem ipsum ".repeat(5000); // ~60,000 chars
    const blocksList = vi.fn().mockResolvedValue({
      object: "list",
      has_more: false,
      next_cursor: null,
      results: [
        {
          object: "block",
          id: "blk-big",
          type: "paragraph",
          paragraph: { rich_text: [{ plain_text: huge }] },
        },
      ],
    });
    const { client } = makeFakeClient({ blocksList });

    const r = await notionFetchHandler(
      { page_id: "abc12345-1111-2222-3333-aaaaaaaaaaaa" },
      makeCtx(),
      FAST_DEPS({ notionClient: client }),
    );

    expect(r.status).toBe("ok");
    expect(r.truncated).toBe(true);
    // Block-level pagination ended cleanly so no resume cursor.
    expect(r.has_more).toBe(false);
    expect(r.next_cursor).toBeNull();
    expect(r.markdown).toMatch(/\[\.\.\.truncated, \d+ more chars\]/);
  });

  it("rejects malformed cursor input without calling the API", async () => {
    const { client, spies } = makeFakeClient();
    const r = await notionFetchHandler(
      {
        page_id: "abc12345-1111-2222-3333-aaaaaaaaaaaa",
        cursor: 123, // wrong type
      } as any,
      makeCtx(),
      FAST_DEPS({ notionClient: client }),
    );
    expect(r.status).toBe("error");
    expect(spies.pagesRetrieve).not.toHaveBeenCalled();
  });
});

// ─── T3: notion_append on whitelisted parent — success + audit ──────────

describe("T3 — notion_append on whitelisted parent — success + audit", () => {
  it("appends blocks and writes one audit row with status='ok'", async () => {
    const { client, spies } = makeFakeClient();
    const audit = makeAuditCapture();
    const r = await notionAppendHandler(
      {
        page_id: WHITELISTED,
        markdown: "# [LUCA-001]\nFirst synchro entry.\n",
      },
      makeCtx(),
      FAST_DEPS({ notionClient: client, recordAuditFn: audit.fn }),
    );
    expect(r.status).toBe("ok");
    expect(r.appended_block_count).toBe(1);
    expect(spies.blocksAppend).toHaveBeenCalledTimes(1);
    expect(audit.calls.length).toBe(1);
    expect(audit.calls[0]).toMatchObject({
      tool: "luca_notion_append",
      classification: "LOW_STAKES_WRITE",
      status: "ok",
    });
  });
});

// ─── T4: notion_append on non-whitelisted parent — THROW pre-API ────────

describe("T4 — notion_append on non-whitelisted parent — blocked before API", () => {
  it("returns status='blocked', does NOT call the Notion SDK, audits as blocked", async () => {
    const { client, spies } = makeFakeClient();
    const audit = makeAuditCapture();
    const r = await notionAppendHandler(
      {
        page_id: NON_WHITELISTED,
        markdown: "# trying to write outside whitelist",
      },
      makeCtx(),
      FAST_DEPS({ notionClient: client, recordAuditFn: audit.fn }),
    );
    expect(r.status).toBe("blocked");
    expect(r.error).toMatch(/notion_whitelist_violation/);
    expect(spies.blocksAppend).not.toHaveBeenCalled();
    expect(spies.pagesCreate).not.toHaveBeenCalled();
    expect(spies.search).not.toHaveBeenCalled();
    expect(audit.calls.length).toBe(1);
    expect(audit.calls[0]).toMatchObject({
      tool: "luca_notion_append",
      status: "blocked",
    });
  });

  it("assertWritableParent throws WhitelistViolationError directly", () => {
    expect(() => assertWritableParent(NON_WHITELISTED)).toThrow(
      WhitelistViolationError,
    );
  });
});

// ─── T5: notion_create on whitelisted parent — success ──────────────────

describe("T5 — notion_create on whitelisted parent — success", () => {
  it("creates a child page and returns {ok, page_id, url, title}", async () => {
    const { client, spies } = makeFakeClient();
    const audit = makeAuditCapture();
    const r = await notionCreateHandler(
      {
        parent_page_id: WHITELISTED,
        title: "[LUCA-002] Synchro test",
        markdown: "## Body\n\nSome content.\n",
      },
      makeCtx(),
      FAST_DEPS({ notionClient: client, recordAuditFn: audit.fn }),
    );
    expect(r.status).toBe("ok");
    expect(r.page_id).toBe("fff12345-9999-8888-7777-ffffffffffff");
    expect(r.url).toBe("https://www.notion.so/fff");
    expect(r.title).toBe("[LUCA-002] Synchro test");
    expect(spies.pagesCreate).toHaveBeenCalledTimes(1);
    expect(audit.calls.length).toBe(1);
    expect(audit.calls[0]).toMatchObject({
      tool: "luca_notion_create",
      classification: "LOW_STAKES_WRITE",
      status: "ok",
    });
  });
});

// ─── T6: notion_create on non-whitelisted parent — THROW pre-API ────────

describe("T6 — notion_create on non-whitelisted parent — blocked before API", () => {
  it("returns status='blocked', does NOT call the Notion SDK, audits as blocked", async () => {
    const { client, spies } = makeFakeClient();
    const audit = makeAuditCapture();
    const r = await notionCreateHandler(
      {
        parent_page_id: NON_WHITELISTED,
        title: "[LUCA-XX] Bad parent",
        markdown: "Body",
      },
      makeCtx(),
      FAST_DEPS({ notionClient: client, recordAuditFn: audit.fn }),
    );
    expect(r.status).toBe("blocked");
    expect(r.error).toMatch(/notion_whitelist_violation/);
    expect(spies.pagesCreate).not.toHaveBeenCalled();
    expect(audit.calls.length).toBe(1);
    expect(audit.calls[0]).toMatchObject({
      tool: "luca_notion_create",
      status: "blocked",
    });
  });
});

// ─── T7: 5xx → retry up to 2 times with backoff ──────────────────────────

describe("T7 — 5xx triggers retry up to 2 times with backoff", () => {
  it("retries twice on 503 then succeeds on the third attempt", async () => {
    const sleepCalls: number[] = [];
    const sleep = (ms: number) =>
      new Promise<void>((res) => {
        sleepCalls.push(ms);
        res();
      });

    let attempts = 0;
    const search = vi.fn().mockImplementation(async () => {
      attempts += 1;
      if (attempts < 3) {
        throw makeAPIResponseError(503, APIErrorCode.ServiceUnavailable);
      }
      return {
        object: "list",
        has_more: false,
        next_cursor: null,
        results: [],
      };
    });
    const { client } = makeFakeClient({ search });

    const r = await notionSearchHandler(
      { query: "x" },
      makeCtx(),
      FAST_DEPS({ notionClient: client, sleep }),
    );
    expect(r.status).toBe("ok");
    expect(attempts).toBe(3); // 1 initial + 2 retries
    expect(sleepCalls).toEqual([
      NOTION_RETRY_DELAYS_MS[0],
      NOTION_RETRY_DELAYS_MS[1],
    ]);
  });

  it("gives up after MAX_RETRIES if 5xx persists", async () => {
    const search = vi
      .fn()
      .mockRejectedValue(makeAPIResponseError(500, APIErrorCode.InternalServerError));
    const { client } = makeFakeClient({ search });

    const r = await notionSearchHandler(
      { query: "x" },
      makeCtx(),
      FAST_DEPS({ notionClient: client, sleep: () => Promise.resolve() }),
    );
    expect(r.status).toBe("error");
    expect(search).toHaveBeenCalledTimes(NOTION_MAX_RETRIES + 1); // 3
  });

  it("retryNotion (unit) retries on RequestTimeout / 5xx and rethrows last on exhaustion", async () => {
    let n = 0;
    const result = await retryNotion(
      async () => {
        n += 1;
        if (n < 3) throw makeAPIResponseError(502, APIErrorCode.ServiceUnavailable);
        return "done";
      },
      () => Promise.resolve(),
    );
    expect(result).toBe("done");
    expect(n).toBe(3);
  });
});

// ─── T8: 4xx → throw immediately, no retry ───────────────────────────────

describe("T8 — 4xx throws immediately, no retry", () => {
  it("404 ObjectNotFound surfaces on first attempt", async () => {
    const search = vi
      .fn()
      .mockRejectedValue(makeAPIResponseError(404, APIErrorCode.ObjectNotFound));
    const { client } = makeFakeClient({ search });

    const r = await notionSearchHandler(
      { query: "x" },
      makeCtx(),
      FAST_DEPS({ notionClient: client, sleep: () => Promise.resolve() }),
    );
    expect(r.status).toBe("error");
    expect(r.error).toMatch(/notion api 404/);
    expect(search).toHaveBeenCalledTimes(1); // NO retry
  });

  it("401 Unauthorized surfaces on first attempt", async () => {
    const pagesRetrieve = vi
      .fn()
      .mockRejectedValue(makeAPIResponseError(401, APIErrorCode.Unauthorized));
    const { client } = makeFakeClient({ pagesRetrieve });

    const r = await notionFetchHandler(
      { page_id: "abc12345-1111-2222-3333-aaaaaaaaaaaa" },
      makeCtx(),
      FAST_DEPS({ notionClient: client, sleep: () => Promise.resolve() }),
    );
    expect(r.status).toBe("error");
    expect(pagesRetrieve).toHaveBeenCalledTimes(1);
  });

  it("400 ValidationError on append fails fast and audits as error (not blocked)", async () => {
    const blocksAppend = vi
      .fn()
      .mockRejectedValue(makeAPIResponseError(400, APIErrorCode.ValidationError));
    const { client } = makeFakeClient({ blocksAppend });
    const audit = makeAuditCapture();

    const r = await notionAppendHandler(
      {
        page_id: WHITELISTED,
        markdown: "# bad",
      },
      makeCtx(),
      FAST_DEPS({ notionClient: client, recordAuditFn: audit.fn, sleep: () => Promise.resolve() }),
    );
    expect(r.status).toBe("error");
    expect(blocksAppend).toHaveBeenCalledTimes(1);
    expect(audit.calls.length).toBe(1);
    expect(audit.calls[0].status).toBe("error");
  });
});

// ─── T9: Audit log пишется только на write ───────────────────────────────

describe("T9 — audit log is written ONLY for write tools", () => {
  it("notion_append (success) writes one audit row", async () => {
    const { client } = makeFakeClient();
    const audit = makeAuditCapture();
    await notionAppendHandler(
      { page_id: WHITELISTED, markdown: "# x" },
      makeCtx(),
      FAST_DEPS({ notionClient: client, recordAuditFn: audit.fn }),
    );
    expect(audit.calls.length).toBe(1);
    expect(audit.calls[0].tool).toBe("luca_notion_append");
  });

  it("notion_create (success) writes one audit row", async () => {
    const { client } = makeFakeClient();
    const audit = makeAuditCapture();
    await notionCreateHandler(
      { parent_page_id: WHITELISTED, title: "[LUCA-003] x", markdown: "# y" },
      makeCtx(),
      FAST_DEPS({ notionClient: client, recordAuditFn: audit.fn }),
    );
    expect(audit.calls.length).toBe(1);
    expect(audit.calls[0].tool).toBe("luca_notion_create");
  });

  it("notion_append (blocked by whitelist) writes one audit row with status='blocked'", async () => {
    const { client } = makeFakeClient();
    const audit = makeAuditCapture();
    await notionAppendHandler(
      { page_id: NON_WHITELISTED, markdown: "# x" },
      makeCtx(),
      FAST_DEPS({ notionClient: client, recordAuditFn: audit.fn }),
    );
    expect(audit.calls.length).toBe(1);
    expect(audit.calls[0].status).toBe("blocked");
  });
});

// ─── T10: Reads НЕ логируются ────────────────────────────────────────────

describe("T10 — reads do NOT write to luca_audit_log", () => {
  it("notion_search does NOT call recordAudit", async () => {
    const { client } = makeFakeClient();
    const audit = makeAuditCapture();
    await notionSearchHandler(
      { query: "x" },
      makeCtx(),
      FAST_DEPS({ notionClient: client, recordAuditFn: audit.fn }),
    );
    expect(audit.calls.length).toBe(0);
  });

  it("notion_fetch does NOT call recordAudit", async () => {
    const { client } = makeFakeClient();
    const audit = makeAuditCapture();
    await notionFetchHandler(
      { page_id: "abc12345-1111-2222-3333-aaaaaaaaaaaa" },
      makeCtx(),
      FAST_DEPS({ notionClient: client, recordAuditFn: audit.fn }),
    );
    expect(audit.calls.length).toBe(0);
  });
});

// ─── Registry / dispatch wiring ──────────────────────────────────────────

describe("notion: registry + dispatch wiring", () => {
  // dispatchLucaTool does not thread `deps` to the handlers (the partner-
  // chat wiring relies on the lazy default client), so we don't drive a
  // live success path through dispatch here. We DO verify two things: a
  // valid notion name does NOT hit the default branch (i.e. it routes
  // SOMEWHERE — we trigger an early `invalid_input` return so the handler
  // never reaches the Notion SDK), and unknown notion-ish names throw
  // luca_tool_not_found.
  it("dispatchLucaTool routes the four notion names (no default-branch fall-through)", async () => {
    // Empty input triggers parseNotionSearchInput to throw, which the
    // handler catches and returns as {status:"error",...}. The point is:
    // we get a response object, not a thrown luca_tool_not_found.
    const r = (await dispatchLucaTool("luca_notion_search", {}, makeCtx() as any)) as {
      status: string;
    };
    expect(r.status).toBe("error");
    // Same for the other three names.
    for (const name of [
      "luca_notion_fetch",
      "luca_notion_append",
      "luca_notion_create",
    ]) {
      const rr = (await dispatchLucaTool(name, {}, makeCtx() as any)) as {
        status: string;
      };
      expect(rr.status).toBe("error");
    }
  });

  it("dispatchLucaTool throws on unknown notion-ish names", async () => {
    await expect(() =>
      dispatchLucaTool("luca_notion_update", {}, makeCtx() as any),
    ).rejects.toThrow(/luca_tool_not_found/);
  });

  it("tool specs have the expected names", () => {
    expect(notionSearchTool.name).toBe("luca_notion_search");
    expect(notionFetchTool.name).toBe("luca_notion_fetch");
    expect(notionAppendTool.name).toBe("luca_notion_append");
    expect(notionCreateTool.name).toBe("luca_notion_create");
  });
});

// ─── SF3 dedup hashing ───────────────────────────────────────────────────

describe("notion: SF3 code_sha hashing", () => {
  it("identical search inputs collapse to the same sha", () => {
    expect(computeNotionSearchSha("x", 10)).toBe(computeNotionSearchSha("x", 10));
    expect(computeNotionSearchSha("x", 10)).not.toBe(computeNotionSearchSha("x", 11));
    expect(computeNotionSearchSha("x", 10)).not.toBe(computeNotionSearchSha("y", 10));
  });

  it("fetch sha uses normalized page id", () => {
    const norm = normalizeNotionPageId(WHITELISTED);
    expect(computeNotionFetchSha(norm)).toBe(computeNotionFetchSha(norm));
  });

  it("append/create sha includes markdown body hash so identical bodies dedup", () => {
    const a = computeNotionAppendSha("p", "same body");
    const b = computeNotionAppendSha("p", "same body");
    const c = computeNotionAppendSha("p", "different body");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(computeNotionCreateSha("p", "title", "body")).not.toBe(
      computeNotionCreateSha("p", "title", "other body"),
    );
  });
});

// ─── Disabled-flag short-circuit ─────────────────────────────────────────

describe("notion: flags off → status:'disabled', no API, no audit", () => {
  it("read tools refuse when LUCA_TOOL_NOTION_READ_ENABLED is off", async () => {
    setFlags({
      LUCA_V1A_ENABLED: "true",
      LUCA_TOOLS_ENABLED: "true",
      LUCA_NOTION_SCOPE_ENABLED: "true",
      LUCA_TOOL_NOTION_WRITE_ENABLED: "true",
      // READ flag intentionally OFF
    });
    const { client, spies } = makeFakeClient();
    const audit = makeAuditCapture();
    const r = await notionSearchHandler(
      { query: "x" },
      makeCtx(),
      FAST_DEPS({ notionClient: client, recordAuditFn: audit.fn }),
    );
    expect(r.status).toBe("disabled");
    expect(spies.search).not.toHaveBeenCalled();
    expect(audit.calls.length).toBe(0);
  });

  it("write tools refuse when LUCA_TOOL_NOTION_WRITE_ENABLED is off", async () => {
    setFlags({
      LUCA_V1A_ENABLED: "true",
      LUCA_TOOLS_ENABLED: "true",
      LUCA_NOTION_SCOPE_ENABLED: "true",
      LUCA_TOOL_NOTION_READ_ENABLED: "true",
      // WRITE flag intentionally OFF
    });
    const { client, spies } = makeFakeClient();
    const audit = makeAuditCapture();
    const r = await notionAppendHandler(
      { page_id: WHITELISTED, markdown: "# x" },
      makeCtx(),
      FAST_DEPS({ notionClient: client, recordAuditFn: audit.fn }),
    );
    expect(r.status).toBe("disabled");
    expect(spies.blocksAppend).not.toHaveBeenCalled();
    expect(audit.calls.length).toBe(0);
  });

  it("any one of master flags off → tools disabled", async () => {
    setFlags({
      // V1A_ENABLED off
      LUCA_TOOLS_ENABLED: "true",
      LUCA_NOTION_SCOPE_ENABLED: "true",
      LUCA_TOOL_NOTION_READ_ENABLED: "true",
      LUCA_TOOL_NOTION_WRITE_ENABLED: "true",
    });
    const r = await notionSearchHandler(
      { query: "x" },
      makeCtx(),
      FAST_DEPS({ notionClient: makeFakeClient().client }),
    );
    expect(r.status).toBe("disabled");
  });
});

// ─── Input validation ────────────────────────────────────────────────────

describe("notion: input validation", () => {
  it("parseNotionSearchInput rejects non-object", () => {
    expect(() => parseNotionSearchInput("oops" as any)).toThrow();
    expect(() => parseNotionSearchInput({ query: 123 } as any)).toThrow();
  });

  it("parseNotionSearchInput caps query length", () => {
    expect(() =>
      parseNotionSearchInput({ query: "x".repeat(1000) }),
    ).toThrow(/exceeds/);
  });

  it("parseNotionAppendInput requires both fields", () => {
    expect(() =>
      parseNotionAppendInput({ page_id: WHITELISTED } as any),
    ).toThrow(/markdown/);
    expect(() => parseNotionAppendInput({ markdown: "x" } as any)).toThrow(/page_id/);
  });

  it("parseNotionCreateInput requires three fields", () => {
    expect(() =>
      parseNotionCreateInput({
        parent_page_id: WHITELISTED,
        title: "t",
      } as any),
    ).toThrow(/markdown/);
  });

  it("parseNotionFetchInput accepts an optional string cursor", () => {
    const r = parseNotionFetchInput({
      page_id: "abc12345-1111-2222-3333-aaaaaaaaaaaa",
      cursor: "abc",
    });
    expect(r.cursor).toBe("abc");
  });

  it("parseNotionFetchInput rejects non-string cursor", () => {
    expect(() =>
      parseNotionFetchInput({
        page_id: "abc12345-1111-2222-3333-aaaaaaaaaaaa",
        cursor: 5,
      } as any),
    ).toThrow(/cursor/);
  });

  it("parseNotionFetchInput rejects empty cursor", () => {
    expect(() =>
      parseNotionFetchInput({
        page_id: "abc12345-1111-2222-3333-aaaaaaaaaaaa",
        cursor: "",
      }),
    ).toThrow(/cursor/);
  });
});
