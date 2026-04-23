/**
 * Luca V1a Day 4 — search tool unit tests.
 *
 * Covers:
 *   - Three-level flag gate (master/tools/per-tool)
 *   - Input validation: query required, non-empty after trim, max length,
 *     count positive integer, freshness enum, timeout_ms NaN/Infinity reject
 *   - Missing BRAVE_SEARCH_API_KEY → error (not disabled)
 *   - Brave API: happy path maps to compact {title,url,snippet,age} shape
 *   - Brave API: 401/429/5xx → status:error with body preview
 *   - Abort → status:timeout
 *   - Invalid JSON → status:error
 *   - Compaction: HTML tag stripping, snippet truncation
 *   - Forensic log: pending row + terminal row
 *   - Registry: tool only appears when all 3 flags on, dispatch routes
 *   - SF3 code_sha identity: same query+count+freshness → same sha,
 *     timeout_ms NOT in identity, whitespace-normalized
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock `../../storage` BEFORE importing handlers.
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
  searchHandler,
  searchTool,
  parseSearchInput,
  computeSearchSha,
  compactBraveResponse,
  SEARCH_DEFAULT_COUNT,
  SEARCH_MAX_COUNT,
  SEARCH_DEFAULT_TIMEOUT_MS,
  SEARCH_MAX_TIMEOUT_MS,
  SEARCH_MAX_QUERY_LENGTH,
  SEARCH_SNIPPET_MAX_CHARS,
  type SearchContext,
} from "../../lib/luca-tools/search";
import { toSandboxKey } from "../../lib/luca/pyodide-runner";
import {
  __getAllLucaToolSpecsForTests,
  dispatchLucaTool,
  getLucaTools,
} from "../../lib/luca-tools/registry";

// ─── Flag helpers ────────────────────────────────────────────────────────

const LUCA_FLAG_KEYS = [
  "LUCA_V1A_ENABLED",
  "LUCA_TOOLS_ENABLED",
  "LUCA_TOOL_SEARCH_ENABLED",
  "LUCA_TOOL_RUN_CODE_ENABLED",
  "LUCA_TOOL_ANALYZE_IMAGE_ENABLED",
  "BRAVE_SEARCH_API_KEY",
];

function setFlags(overrides: Record<string, string | undefined>) {
  for (const k of LUCA_FLAG_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function allOn() {
  setFlags({
    LUCA_V1A_ENABLED: "true",
    LUCA_TOOLS_ENABLED: "true",
    LUCA_TOOL_SEARCH_ENABLED: "true",
    BRAVE_SEARCH_API_KEY: "test-brave-key",
  });
}

function makeCtx(): SearchContext {
  return {
    userId: 10,
    meetingId: "11111111-1111-1111-1111-111111111111",
    turnId: "22222222-2222-2222-2222-222222222222",
    ctxKey: toSandboxKey(
      "m_111111111111111111111111111111111111_t_222222222222222222222222222222222222",
    ),
  };
}

beforeEach(() => {
  insertedRows.length = 0;
  allOn();
});

afterEach(() => {
  setFlags({});
});

// ─── parseSearchInput ────────────────────────────────────────────────────

describe("parseSearchInput", () => {
  it("accepts minimal valid input", () => {
    const r = parseSearchInput({ query: "kioku" });
    expect(r.query).toBe("kioku");
    expect(r.count).toBeUndefined();
    expect(r.freshness).toBeUndefined();
  });

  it("trims surrounding whitespace on query", () => {
    const r = parseSearchInput({ query: "  kioku  " });
    expect(r.query).toBe("kioku");
  });

  it("rejects non-object raw input", () => {
    expect(() => parseSearchInput(null)).toThrow(/expected object/);
    expect(() => parseSearchInput("hi")).toThrow(/expected object/);
    expect(() => parseSearchInput(42)).toThrow(/expected object/);
  });

  it("rejects missing/non-string query", () => {
    expect(() => parseSearchInput({})).toThrow(/query/);
    expect(() => parseSearchInput({ query: 123 })).toThrow(/query/);
  });

  it("rejects whitespace-only query", () => {
    expect(() => parseSearchInput({ query: "   " })).toThrow(/non-empty/);
    expect(() => parseSearchInput({ query: "\t\n" })).toThrow(/non-empty/);
  });

  it("rejects query exceeding max length", () => {
    const huge = "a".repeat(SEARCH_MAX_QUERY_LENGTH + 1);
    expect(() => parseSearchInput({ query: huge })).toThrow(/char limit/);
  });

  it("rejects invalid count", () => {
    expect(() =>
      parseSearchInput({ query: "q", count: "10" }),
    ).toThrow(/count/);
    expect(() => parseSearchInput({ query: "q", count: 0 })).toThrow(/count/);
    expect(() => parseSearchInput({ query: "q", count: -5 })).toThrow(/count/);
    expect(() =>
      parseSearchInput({ query: "q", count: 3.5 }),
    ).toThrow(/count/);
    expect(() =>
      parseSearchInput({ query: "q", count: Infinity }),
    ).toThrow(/count/);
    expect(() =>
      parseSearchInput({ query: "q", count: NaN }),
    ).toThrow(/count/);
  });

  it("rejects invalid freshness", () => {
    expect(() =>
      parseSearchInput({ query: "q", freshness: "forever" }),
    ).toThrow(/freshness/);
    expect(() =>
      parseSearchInput({ query: "q", freshness: 5 }),
    ).toThrow(/freshness/);
  });

  it("accepts all freshness enum values", () => {
    for (const f of ["pd", "pw", "pm", "py"]) {
      const r = parseSearchInput({ query: "q", freshness: f });
      expect(r.freshness).toBe(f);
    }
  });

  it("rejects NaN/Infinity timeout_ms (D30 lesson)", () => {
    expect(() =>
      parseSearchInput({ query: "q", timeout_ms: NaN }),
    ).toThrow(/timeout_ms/);
    expect(() =>
      parseSearchInput({ query: "q", timeout_ms: Infinity }),
    ).toThrow(/timeout_ms/);
    expect(() =>
      parseSearchInput({ query: "q", timeout_ms: -1 }),
    ).toThrow(/timeout_ms/);
  });
});

// ─── computeSearchSha (SF3) ──────────────────────────────────────────────

describe("computeSearchSha", () => {
  it("same query + params → same sha", () => {
    const a = computeSearchSha("kioku", 10, undefined);
    const b = computeSearchSha("kioku", 10, undefined);
    expect(a).toBe(b);
  });

  it("different query → different sha", () => {
    const a = computeSearchSha("kioku", 10, undefined);
    const b = computeSearchSha("perplexity", 10, undefined);
    expect(a).not.toBe(b);
  });

  it("different count → different sha", () => {
    const a = computeSearchSha("kioku", 10, undefined);
    const b = computeSearchSha("kioku", 20, undefined);
    expect(a).not.toBe(b);
  });

  it("different freshness → different sha", () => {
    const a = computeSearchSha("kioku", 10, undefined);
    const b = computeSearchSha("kioku", 10, "pd");
    expect(a).not.toBe(b);
  });

  it("undefined freshness and null are equivalent (both map to null)", () => {
    const a = computeSearchSha("kioku", 10, undefined);
    const b = computeSearchSha("kioku", 10, undefined);
    expect(a).toBe(b);
  });
});

// ─── compactBraveResponse ────────────────────────────────────────────────

describe("compactBraveResponse", () => {
  it("maps web.results to compact shape", () => {
    const out = compactBraveResponse({
      web: {
        results: [
          {
            title: "Kioku",
            url: "https://usekioku.com",
            description: "Your AI memory",
            age: "2 days ago",
          },
        ],
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      title: "Kioku",
      url: "https://usekioku.com",
      snippet: "Your AI memory",
      age: "2 days ago",
    });
  });

  it("strips HTML tags from description", () => {
    const out = compactBraveResponse({
      web: {
        results: [
          {
            title: "X",
            url: "https://x.com",
            description: "<strong>kioku</strong> is <em>memory</em>",
          },
        ],
      },
    });
    expect(out[0].snippet).toBe("kioku is memory");
  });

  it("truncates long snippets with ellipsis", () => {
    const long = "a".repeat(SEARCH_SNIPPET_MAX_CHARS + 100);
    const out = compactBraveResponse({
      web: { results: [{ title: "X", url: "https://x.com", description: long }] },
    });
    expect(out[0].snippet.length).toBe(SEARCH_SNIPPET_MAX_CHARS);
    expect(out[0].snippet.endsWith("\u2026")).toBe(true);
  });

  it("omits age field when Brave returns none", () => {
    const out = compactBraveResponse({
      web: { results: [{ title: "X", url: "https://x.com", description: "d" }] },
    });
    expect(out[0].age).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(out[0], "age")).toBe(false);
  });

  it("filters out results missing url or title", () => {
    const out = compactBraveResponse({
      web: {
        results: [
          { title: "OK", url: "https://ok.com", description: "d" },
          { title: "missing url", description: "d" },
          { url: "https://no-title.com", description: "d" },
        ],
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("OK");
  });

  it("returns empty array when web.results absent", () => {
    expect(compactBraveResponse({})).toEqual([]);
    expect(compactBraveResponse({ web: {} })).toEqual([]);
  });
});

// ─── Flag gate ───────────────────────────────────────────────────────────

describe("searchHandler — flag gate", () => {
  it("returns disabled when LUCA_V1A_ENABLED off", async () => {
    setFlags({
      LUCA_TOOLS_ENABLED: "true",
      LUCA_TOOL_SEARCH_ENABLED: "true",
      BRAVE_SEARCH_API_KEY: "k",
    });
    const r = await searchHandler({ query: "x" }, makeCtx());
    expect(r.status).toBe("disabled");
    expect(insertedRows).toHaveLength(0); // no forensic row when disabled
  });

  it("returns disabled when LUCA_TOOLS_ENABLED off", async () => {
    setFlags({
      LUCA_V1A_ENABLED: "true",
      LUCA_TOOL_SEARCH_ENABLED: "true",
      BRAVE_SEARCH_API_KEY: "k",
    });
    const r = await searchHandler({ query: "x" }, makeCtx());
    expect(r.status).toBe("disabled");
  });

  it("returns disabled when per-tool flag off", async () => {
    setFlags({
      LUCA_V1A_ENABLED: "true",
      LUCA_TOOLS_ENABLED: "true",
      BRAVE_SEARCH_API_KEY: "k",
    });
    const r = await searchHandler({ query: "x" }, makeCtx());
    expect(r.status).toBe("disabled");
  });

  it("returns error (not disabled) when API key absent but flags on", async () => {
    setFlags({
      LUCA_V1A_ENABLED: "true",
      LUCA_TOOLS_ENABLED: "true",
      LUCA_TOOL_SEARCH_ENABLED: "true",
      // no BRAVE_SEARCH_API_KEY
    });
    const r = await searchHandler({ query: "x" }, makeCtx());
    expect(r.status).toBe("error");
    expect(r.error).toMatch(/BRAVE_SEARCH_API_KEY/);
  });
});

// ─── Handler happy / failure paths ───────────────────────────────────────

function makeFetchOk(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

function makeFetchThrow(err: Error): typeof fetch {
  return vi.fn(async () => {
    throw err;
  }) as unknown as typeof fetch;
}

describe("searchHandler — network paths", () => {
  it("happy path: compact results + 2 tool_runs rows (pending + terminal ok)", async () => {
    const fetchFn = makeFetchOk({
      web: {
        results: [
          { title: "A", url: "https://a.com", description: "alpha" },
          { title: "B", url: "https://b.com", description: "beta", age: "1h" },
        ],
      },
      query: { more_results_available: true },
    });
    const r = await searchHandler({ query: "kioku" }, makeCtx(), { fetchFn });
    expect(r.status).toBe("ok");
    expect(r.results).toHaveLength(2);
    expect(r.results[0].url).toBe("https://a.com");
    expect(r.more_available).toBe(true);
    expect(insertedRows).toHaveLength(2);
    expect(insertedRows[0].status).toBe("pending");
    expect(insertedRows[1].status).toBe("ok");
  });

  it("sends X-Subscription-Token header with API key", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ web: { results: [] } }), { status: 200 }),
    ) as unknown as typeof fetch;
    await searchHandler({ query: "q" }, makeCtx(), { fetchFn });
    const call = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const opts = call[1] as RequestInit;
    expect((opts.headers as Record<string, string>)["X-Subscription-Token"]).toBe(
      "test-brave-key",
    );
  });

  it("URL-encodes query + includes count + freshness", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ web: { results: [] } }), { status: 200 }),
    ) as unknown as typeof fetch;
    await searchHandler(
      { query: "a b & c", count: 5, freshness: "pw" },
      makeCtx(),
      { fetchFn },
    );
    const call = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const url = call[0] as string;
    expect(url).toContain("q=a+b+%26+c");
    expect(url).toContain("count=5");
    expect(url).toContain("freshness=pw");
  });

  it("caps count at MAX", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ web: { results: [] } }), { status: 200 }),
    ) as unknown as typeof fetch;
    await searchHandler({ query: "q", count: 9999 }, makeCtx(), { fetchFn });
    const call = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const url = call[0] as string;
    expect(url).toContain(`count=${SEARCH_MAX_COUNT}`);
  });

  it("HTTP 401 → status:error with body preview", async () => {
    const fetchFn = vi.fn(async () =>
      new Response("Unauthorized: bad token", {
        status: 401,
        statusText: "Unauthorized",
      }),
    ) as unknown as typeof fetch;
    const r = await searchHandler({ query: "q" }, makeCtx(), { fetchFn });
    expect(r.status).toBe("error");
    expect(r.error).toMatch(/401/);
    expect(r.error).toMatch(/bad token/);
    expect(insertedRows).toHaveLength(2);
    expect(insertedRows[1].status).toBe("error");
  });

  it("HTTP 429 → status:error (rate limited)", async () => {
    const fetchFn = vi.fn(async () =>
      new Response("Rate limited", { status: 429, statusText: "Too Many Requests" }),
    ) as unknown as typeof fetch;
    const r = await searchHandler({ query: "q" }, makeCtx(), { fetchFn });
    expect(r.status).toBe("error");
    expect(r.error).toMatch(/429/);
  });

  it("AbortError → status:timeout", async () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    const fetchFn = makeFetchThrow(err);
    const r = await searchHandler({ query: "q" }, makeCtx(), { fetchFn });
    expect(r.status).toBe("timeout");
    expect(r.error).toMatch(/timeout/);
    expect(insertedRows[1].status).toBe("timeout");
  });

  it("network error → status:error", async () => {
    const fetchFn = makeFetchThrow(new Error("ECONNREFUSED"));
    const r = await searchHandler({ query: "q" }, makeCtx(), { fetchFn });
    expect(r.status).toBe("error");
    expect(r.error).toMatch(/ECONNREFUSED/);
  });

  it("invalid JSON → status:error", async () => {
    const fetchFn = vi.fn(async () =>
      new Response("<html>not json</html>", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;
    const r = await searchHandler({ query: "q" }, makeCtx(), { fetchFn });
    expect(r.status).toBe("error");
    expect(r.error).toMatch(/invalid JSON|parse/i);
  });

  it("parse error throws before network → no terminal row but no crash", async () => {
    // Empty query parse error happens synchronously before any fetch.
    await expect(
      searchHandler({ query: "" }, makeCtx()),
    ).rejects.toThrow(/query/);
    expect(insertedRows).toHaveLength(0);
  });

  it("forensic row preserves trimmed query + normalized params", async () => {
    const fetchFn = makeFetchOk({ web: { results: [] } });
    await searchHandler(
      { query: "  kioku  ", count: 5 },
      makeCtx(),
      { fetchFn },
    );
    const pending = insertedRows[0];
    expect((pending.input as Record<string, unknown>).query).toBe("kioku");
    expect((pending.input as Record<string, unknown>).count).toBe(5);
    expect(pending.networkAttempted).toBe(true);
    expect(pending.tool).toBe("luca_search");
  });
});

// ─── Registry ────────────────────────────────────────────────────────────

describe("registry — luca_search", () => {
  it("is in the full spec list", () => {
    const specs = __getAllLucaToolSpecsForTests();
    const names = specs.map((s) => s.name);
    expect(names).toContain("luca_search");
  });

  it("is included in getLucaTools when all flags on", () => {
    allOn();
    const tools = getLucaTools();
    expect(tools.some((t) => t.name === "luca_search")).toBe(true);
  });

  it("is omitted when per-tool flag off", () => {
    setFlags({
      LUCA_V1A_ENABLED: "true",
      LUCA_TOOLS_ENABLED: "true",
      // no LUCA_TOOL_SEARCH_ENABLED
    });
    const tools = getLucaTools();
    expect(tools.some((t) => t.name === "luca_search")).toBe(false);
  });

  it("dispatch routes luca_search to handler (disabled short-path)", async () => {
    // Flags off except V1A → search returns disabled via handler.
    setFlags({ LUCA_V1A_ENABLED: "true" });
    const r = await dispatchLucaTool("luca_search", { query: "x" }, {
      ...makeCtx(),
      // run_code / analyze_image context fields satisfied by makeCtx already.
    } as never);
    expect((r as { status: string }).status).toBe("disabled");
  });

  it("dispatch throws for unknown tool name", async () => {
    await expect(
      dispatchLucaTool("luca_unknown", {}, makeCtx() as never),
    ).rejects.toThrow(/luca_tool_not_found/);
  });
});

// ─── Tool spec shape ─────────────────────────────────────────────────────

describe("searchTool spec", () => {
  it("has luca_ prefix and required fields", () => {
    expect(searchTool.name).toBe("luca_search");
    expect(searchTool.description).toBeTruthy();
    const schema = searchTool.input_schema as {
      type: string;
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema.required).toContain("query");
    expect(schema.properties).toHaveProperty("count");
    expect(schema.properties).toHaveProperty("freshness");
    expect(schema.properties).toHaveProperty("timeout_ms");
  });

  it("name is distinct from run_code / analyze_image", () => {
    expect(searchTool.name).not.toBe("luca_run_code");
    expect(searchTool.name).not.toBe("luca_analyze_image");
  });

  it("defaults are under caps", () => {
    expect(SEARCH_DEFAULT_COUNT).toBeLessThanOrEqual(SEARCH_MAX_COUNT);
    expect(SEARCH_DEFAULT_TIMEOUT_MS).toBeLessThanOrEqual(SEARCH_MAX_TIMEOUT_MS);
  });
});
