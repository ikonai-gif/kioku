/**
 * Luca V1a Day 5 — read_url tool unit tests.
 *
 * Covers:
 *   - Three-level flag gate (master/tools/per-tool)
 *   - Input validation: url required, non-empty, max length, max_chars
 *     positive integer, NaN/Infinity guards (D30 lesson)
 *   - SSRF fence: https only, reject http/file/javascript, reject
 *     localhost/127.0.0.1/10./172.16./192.168./169.254.169.254 and
 *     *.internal / *.local / IPv6 loopback
 *   - Content-type whitelist: accept text/html, text/plain, application/json,
 *     vendor +json / +xml; reject image/png, application/octet-stream
 *   - Content-Length pre-check: reject >2MB before reading body
 *   - Body size post-check: reject >2MB after read if server lied
 *   - Timeout → status:timeout
 *   - Redirect: follow relative + absolute, re-validate each hop's SSRF,
 *     reject redirect to loopback, max-hop cap, missing Location
 *   - HTML compaction: strips script/style/head/iframe, decodes entities,
 *     preserves paragraph breaks, collapses whitespace
 *   - Truncation adds ellipsis + [truncated] marker
 *   - Forensic log: pending row + terminal row
 *   - Registry: tool listed when all 3 flags on; dispatch routes
 *   - SF3 code_sha identity: same url+max_chars → same sha, timeout_ms NOT
 *     in identity
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
  readUrlHandler,
  readUrlTool,
  parseReadUrlInput,
  computeReadUrlSha,
  validateReadUrl,
  extractMediaType,
  isAllowedContentType,
  compactHtmlToText,
  decodeHtmlEntities,
  truncateCompacted,
  compactByMediaType,
  fetchUrlWithRedirects,
  READ_URL_DEFAULT_MAX_CHARS,
  READ_URL_CAP_MAX_CHARS,
  READ_URL_DEFAULT_TIMEOUT_MS,
  READ_URL_MAX_TIMEOUT_MS,
  READ_URL_MAX_BYTES,
  READ_URL_MAX_URL_LENGTH,
  READ_URL_MAX_REDIRECTS,
  type ReadUrlContext,
} from "../../lib/luca-tools/read-url";
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
  "LUCA_TOOL_READ_URL_ENABLED",
  "LUCA_TOOL_RUN_CODE_ENABLED",
  "LUCA_TOOL_ANALYZE_IMAGE_ENABLED",
  "LUCA_TOOL_SEARCH_ENABLED",
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
    LUCA_TOOL_READ_URL_ENABLED: "true",
  });
}

function makeCtx(): ReadUrlContext {
  return {
    userId: 10,
    meetingId: "11111111-1111-1111-1111-111111111111",
    turnId: "22222222-2222-2222-2222-222222222222",
    ctxKey: toSandboxKey(
      "m_111111111111111111111111111111111111_t_222222222222222222222222222222222222",
    ),
  };
}

/** Build a minimal Response-like object for fetch mocks. */
function makeResponse(
  body: string | Uint8Array,
  init?: {
    status?: number;
    statusText?: string;
    headers?: Record<string, string>;
  },
): Response {
  const status = init?.status ?? 200;
  const statusText = init?.statusText ?? "OK";
  const headers = new Headers(init?.headers ?? {});
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers,
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
    async text() {
      return new TextDecoder().decode(bytes);
    },
    async json() {
      return JSON.parse(new TextDecoder().decode(bytes));
    },
  } as unknown as Response;
}

beforeEach(() => {
  insertedRows.length = 0;
  allOn();
});

afterEach(() => {
  setFlags({});
});

// ─── parseReadUrlInput ───────────────────────────────────────────────────

describe("parseReadUrlInput", () => {
  it("accepts minimal valid input", () => {
    const r = parseReadUrlInput({ url: "https://example.com/x" });
    expect(r.url).toBe("https://example.com/x");
    expect(r.max_chars).toBeUndefined();
    expect(r.timeout_ms).toBeUndefined();
  });

  it("rejects non-object raw input", () => {
    expect(() => parseReadUrlInput(null)).toThrow(/expected object/);
    expect(() => parseReadUrlInput("hi")).toThrow(/expected object/);
    expect(() => parseReadUrlInput(42)).toThrow(/expected object/);
  });

  it("rejects missing/non-string url", () => {
    expect(() => parseReadUrlInput({})).toThrow(/url/);
    expect(() => parseReadUrlInput({ url: 123 })).toThrow(/url/);
    expect(() => parseReadUrlInput({ url: "" })).toThrow(/non-empty/);
  });

  it("rejects url exceeding max length", () => {
    const huge = "https://example.com/" + "a".repeat(READ_URL_MAX_URL_LENGTH);
    expect(() => parseReadUrlInput({ url: huge })).toThrow(/char limit/);
  });

  it("rejects invalid max_chars", () => {
    expect(() =>
      parseReadUrlInput({ url: "https://x.com/", max_chars: "100" }),
    ).toThrow(/max_chars/);
    expect(() =>
      parseReadUrlInput({ url: "https://x.com/", max_chars: 0 }),
    ).toThrow(/max_chars/);
    expect(() =>
      parseReadUrlInput({ url: "https://x.com/", max_chars: -5 }),
    ).toThrow(/max_chars/);
    expect(() =>
      parseReadUrlInput({ url: "https://x.com/", max_chars: 3.5 }),
    ).toThrow(/max_chars/);
    expect(() =>
      parseReadUrlInput({ url: "https://x.com/", max_chars: Infinity }),
    ).toThrow(/max_chars/);
    expect(() =>
      parseReadUrlInput({ url: "https://x.com/", max_chars: NaN }),
    ).toThrow(/max_chars/);
  });

  it("rejects NaN/Infinity timeout_ms (D30 lesson)", () => {
    expect(() =>
      parseReadUrlInput({ url: "https://x.com/", timeout_ms: NaN }),
    ).toThrow(/timeout_ms/);
    expect(() =>
      parseReadUrlInput({ url: "https://x.com/", timeout_ms: Infinity }),
    ).toThrow(/timeout_ms/);
    expect(() =>
      parseReadUrlInput({ url: "https://x.com/", timeout_ms: -1 }),
    ).toThrow(/timeout_ms/);
    expect(() =>
      parseReadUrlInput({ url: "https://x.com/", timeout_ms: 0 }),
    ).toThrow(/timeout_ms/);
    expect(() =>
      parseReadUrlInput({ url: "https://x.com/", timeout_ms: "fast" }),
    ).toThrow(/timeout_ms/);
  });

  it("accepts valid max_chars + timeout_ms together", () => {
    const r = parseReadUrlInput({
      url: "https://example.com/",
      max_chars: 5000,
      timeout_ms: 8000,
    });
    expect(r.max_chars).toBe(5000);
    expect(r.timeout_ms).toBe(8000);
  });
});

// ─── validateReadUrl (SSRF fence) ────────────────────────────────────────

describe("validateReadUrl", () => {
  it("accepts public https URL", () => {
    const r = validateReadUrl("https://example.com/articles/1");
    expect(r.ok).toBe(true);
    expect(r.fetchUrl).toBe("https://example.com/articles/1");
  });

  it("preserves query string, strips fragment", () => {
    const r = validateReadUrl("https://example.com/x?a=1&b=2#section");
    expect(r.ok).toBe(true);
    expect(r.fetchUrl).toBe("https://example.com/x?a=1&b=2");
  });

  it("rejects http:// (non-TLS)", () => {
    const r = validateReadUrl("http://example.com/");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/https only/);
  });

  it("rejects file://", () => {
    const r = validateReadUrl("file:///etc/passwd");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/https only/);
  });

  it("rejects data: URIs", () => {
    const r = validateReadUrl("data:text/html,hello");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/https only/);
  });

  it("rejects javascript:", () => {
    const r = validateReadUrl("javascript:alert(1)");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/https only/);
  });

  it("rejects malformed URL", () => {
    const r = validateReadUrl("not a url");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/malformed URL/);
  });

  it("rejects localhost", () => {
    const r = validateReadUrl("https://localhost/x");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/blocked/);
  });

  it("rejects 127.0.0.1", () => {
    const r = validateReadUrl("https://127.0.0.1/x");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/blocked/);
  });

  it("rejects RFC1918 10.x", () => {
    expect(validateReadUrl("https://10.0.0.1/x").ok).toBe(false);
  });

  it("rejects RFC1918 172.16-31", () => {
    expect(validateReadUrl("https://172.16.0.1/x").ok).toBe(false);
    expect(validateReadUrl("https://172.31.255.255/x").ok).toBe(false);
    // 172.32+ is public range
    expect(validateReadUrl("https://172.32.0.1/x").ok).toBe(true);
  });

  it("rejects RFC1918 192.168.x", () => {
    expect(validateReadUrl("https://192.168.1.1/x").ok).toBe(false);
  });

  it("rejects AWS metadata 169.254.169.254", () => {
    const r = validateReadUrl("https://169.254.169.254/latest/meta-data/");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/blocked/);
  });

  it("rejects GCP metadata host by name", () => {
    const r = validateReadUrl("https://metadata.google.internal/");
    expect(r.ok).toBe(false);
  });

  it("rejects *.internal and *.local", () => {
    expect(validateReadUrl("https://foo.internal/x").ok).toBe(false);
    expect(validateReadUrl("https://bar.local/x").ok).toBe(false);
  });

  it("rejects IPv6 loopback", () => {
    expect(validateReadUrl("https://[::1]/x").ok).toBe(false);
  });

  it("rejects IPv6 link-local", () => {
    expect(validateReadUrl("https://[fe80::1]/x").ok).toBe(false);
  });

  it("rejects IPv6 unique-local (fc00::/7)", () => {
    expect(validateReadUrl("https://[fc00::1]/x").ok).toBe(false);
    expect(validateReadUrl("https://[fd00::1]/x").ok).toBe(false);
  });

  it("accepts public IPv4", () => {
    const r = validateReadUrl("https://8.8.8.8/x");
    expect(r.ok).toBe(true);
  });
});

// ─── extractMediaType + isAllowedContentType ─────────────────────────────

describe("extractMediaType", () => {
  it("parses with charset", () => {
    expect(extractMediaType("text/html; charset=utf-8")).toBe("text/html");
  });
  it("lowercases", () => {
    expect(extractMediaType("Text/HTML")).toBe("text/html");
  });
  it("handles empty / null", () => {
    expect(extractMediaType(null)).toBe("");
    expect(extractMediaType("")).toBe("");
  });
  it("trims whitespace", () => {
    expect(extractMediaType("  application/json  ")).toBe("application/json");
  });
});

describe("isAllowedContentType", () => {
  it("accepts whitelist entries", () => {
    expect(isAllowedContentType("text/html")).toBe(true);
    expect(isAllowedContentType("text/plain")).toBe(true);
    expect(isAllowedContentType("application/json")).toBe(true);
    expect(isAllowedContentType("application/xhtml+xml")).toBe(true);
    expect(isAllowedContentType("text/markdown")).toBe(true);
    expect(isAllowedContentType("text/xml")).toBe(true);
    expect(isAllowedContentType("application/xml")).toBe(true);
  });
  it("accepts vendor +json / +xml suffix", () => {
    expect(isAllowedContentType("application/vnd.github+json")).toBe(true);
    expect(isAllowedContentType("application/atom+xml")).toBe(true);
  });
  it("rejects binary types", () => {
    expect(isAllowedContentType("image/png")).toBe(false);
    expect(isAllowedContentType("image/jpeg")).toBe(false);
    expect(isAllowedContentType("application/octet-stream")).toBe(false);
    expect(isAllowedContentType("application/pdf")).toBe(false);
    expect(isAllowedContentType("video/mp4")).toBe(false);
    expect(isAllowedContentType("")).toBe(false);
  });
});

// ─── HTML compaction ─────────────────────────────────────────────────────

describe("decodeHtmlEntities", () => {
  it("decodes named entities", () => {
    expect(decodeHtmlEntities("A &amp; B")).toBe("A & B");
    expect(decodeHtmlEntities("&lt;tag&gt;")).toBe("<tag>");
    expect(decodeHtmlEntities("&quot;hi&quot;")).toBe('"hi"');
    expect(decodeHtmlEntities("a&nbsp;b")).toBe("a b");
  });
  it("decodes numeric entities", () => {
    expect(decodeHtmlEntities("&#65;")).toBe("A");
    expect(decodeHtmlEntities("&#x41;")).toBe("A");
    expect(decodeHtmlEntities("&#8212;")).toBe("\u2014"); // em-dash
  });
  it("leaves unknown entities alone", () => {
    expect(decodeHtmlEntities("&notarealentity;")).toBe("&notarealentity;");
  });
  it("ignores invalid numeric codepoints", () => {
    expect(decodeHtmlEntities("&#9999999999;")).toBe("&#9999999999;");
  });
});

describe("compactHtmlToText", () => {
  it("strips script blocks entirely", () => {
    const out = compactHtmlToText(
      "<p>Hello</p><script>alert('xss')</script><p>World</p>",
    );
    expect(out).not.toMatch(/alert/);
    expect(out).toMatch(/Hello/);
    expect(out).toMatch(/World/);
  });

  it("strips style blocks entirely", () => {
    const out = compactHtmlToText(
      "<p>Hi</p><style>p{color:red}</style><p>Bye</p>",
    );
    expect(out).not.toMatch(/color:red/);
    expect(out).toMatch(/Hi/);
    expect(out).toMatch(/Bye/);
  });

  it("strips head section", () => {
    const out = compactHtmlToText(
      "<html><head><title>T</title><meta name='x' content='y'></head><body>Body</body></html>",
    );
    expect(out).toBe("Body");
  });

  it("strips iframes and svg", () => {
    const out = compactHtmlToText(
      "<p>A</p><iframe src='x'>ignored</iframe><svg><path/></svg><p>B</p>",
    );
    expect(out).not.toMatch(/ignored/);
    expect(out).toMatch(/A/);
    expect(out).toMatch(/B/);
  });

  it("preserves paragraph breaks for block tags", () => {
    const out = compactHtmlToText("<p>First</p><p>Second</p><p>Third</p>");
    expect(out.split(/\n+/)).toEqual(["First", "Second", "Third"]);
  });

  it("decodes entities", () => {
    const out = compactHtmlToText("<p>A &amp; B</p>");
    expect(out).toBe("A & B");
  });

  it("collapses horizontal whitespace within a line", () => {
    const out = compactHtmlToText("<span>Hello     \t\tworld</span>");
    expect(out).toBe("Hello world");
  });

  it("collapses 3+ newlines into a single paragraph break", () => {
    const out = compactHtmlToText("Line1\n\n\n\n\nLine2");
    expect(out).toBe("Line1\n\nLine2");
  });

  it("strips HTML comments", () => {
    const out = compactHtmlToText("<p>A</p><!-- secret --><p>B</p>");
    expect(out).not.toMatch(/secret/);
  });

  it("handles br tags as newlines", () => {
    const out = compactHtmlToText("Line1<br>Line2<br/>Line3");
    expect(out).toMatch(/Line1\nLine2\nLine3/);
  });
});

describe("truncateCompacted", () => {
  it("no-op when under limit", () => {
    expect(truncateCompacted("hello", 100)).toBe("hello");
  });
  it("adds ellipsis + marker when over limit", () => {
    const r = truncateCompacted("a".repeat(1000), 50);
    expect(r.length).toBeLessThanOrEqual(50);
    expect(r).toMatch(/\[truncated\]$/);
  });
});

describe("compactByMediaType", () => {
  it("strips HTML for text/html", () => {
    expect(compactByMediaType("<p>hi</p>", "text/html")).toBe("hi");
  });
  it("strips HTML for application/xhtml+xml", () => {
    expect(compactByMediaType("<p>hi</p>", "application/xhtml+xml")).toBe("hi");
  });
  it("leaves JSON intact", () => {
    expect(compactByMediaType('  {"a":1}  ', "application/json")).toBe('{"a":1}');
  });
  it("leaves plain text intact (just trims)", () => {
    expect(compactByMediaType("  hello world  ", "text/plain")).toBe(
      "hello world",
    );
  });
  it("leaves markdown intact", () => {
    expect(compactByMediaType("# Heading\n\nBody", "text/markdown")).toBe(
      "# Heading\n\nBody",
    );
  });
});

// ─── computeReadUrlSha (SF3) ─────────────────────────────────────────────

describe("computeReadUrlSha", () => {
  it("same url+max_chars → same sha", () => {
    expect(computeReadUrlSha("https://x.com/", 8000)).toBe(
      computeReadUrlSha("https://x.com/", 8000),
    );
  });
  it("different url → different sha", () => {
    expect(computeReadUrlSha("https://x.com/", 8000)).not.toBe(
      computeReadUrlSha("https://y.com/", 8000),
    );
  });
  it("different max_chars → different sha", () => {
    expect(computeReadUrlSha("https://x.com/", 8000)).not.toBe(
      computeReadUrlSha("https://x.com/", 4000),
    );
  });
  it("is hex sha256 (64 chars)", () => {
    const sha = computeReadUrlSha("https://x.com/", 8000);
    expect(sha).toMatch(/^[a-f0-9]{64}$/);
  });
});

// ─── fetchUrlWithRedirects ───────────────────────────────────────────────

describe("fetchUrlWithRedirects", () => {
  it("returns body on 200", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      makeResponse("<p>Hello</p>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
    const r = await fetchUrlWithRedirects(
      "https://example.com/a",
      5000,
      fetchFn as unknown as typeof fetch,
    );
    expect(r.body).toBe("<p>Hello</p>");
    expect(r.mediaType).toBe("text/html");
    expect(r.redirectHops).toBe(0);
    expect(r.finalUrl).toBe("https://example.com/a");
  });

  it("follows absolute redirects and re-validates SSRF", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(
        makeResponse("", {
          status: 302,
          headers: { location: "https://final.example.com/x" },
        }),
      )
      .mockResolvedValueOnce(
        makeResponse("body", {
          headers: { "content-type": "text/plain" },
        }),
      );
    const r = await fetchUrlWithRedirects(
      "https://example.com/a",
      5000,
      fetchFn as unknown as typeof fetch,
    );
    expect(r.redirectHops).toBe(1);
    expect(r.finalUrl).toBe("https://final.example.com/x");
    expect(r.body).toBe("body");
  });

  it("resolves relative Location against current URL", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(
        makeResponse("", {
          status: 301,
          headers: { location: "/other" },
        }),
      )
      .mockResolvedValueOnce(
        makeResponse("x", { headers: { "content-type": "text/plain" } }),
      );
    const r = await fetchUrlWithRedirects(
      "https://example.com/a",
      5000,
      fetchFn as unknown as typeof fetch,
    );
    expect(r.finalUrl).toBe("https://example.com/other");
  });

  it("rejects redirect to loopback (SSRF via redirect)", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(
      makeResponse("", {
        status: 302,
        headers: { location: "https://127.0.0.1/x" },
      }),
    );
    await expect(
      fetchUrlWithRedirects(
        "https://example.com/a",
        5000,
        fetchFn as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/redirect target rejected/);
  });

  it("rejects redirect to metadata endpoint", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(
      makeResponse("", {
        status: 302,
        headers: { location: "https://169.254.169.254/" },
      }),
    );
    await expect(
      fetchUrlWithRedirects(
        "https://example.com/a",
        5000,
        fetchFn as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/redirect target rejected/);
  });

  it("rejects redirect with no Location header", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(
      makeResponse("", { status: 302, headers: {} }),
    );
    await expect(
      fetchUrlWithRedirects(
        "https://example.com/a",
        5000,
        fetchFn as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/no Location header/);
  });

  it("caps redirect hops", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      makeResponse("", {
        status: 302,
        headers: { location: "https://example.com/loop" },
      }),
    );
    await expect(
      fetchUrlWithRedirects(
        "https://example.com/a",
        5000,
        fetchFn as unknown as typeof fetch,
      ),
    ).rejects.toThrow(new RegExp(`exceeded ${READ_URL_MAX_REDIRECTS} redirect hops`));
  });

  it("rejects non-2xx terminal response", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      makeResponse("not found", {
        status: 404,
        statusText: "Not Found",
        headers: { "content-type": "text/plain" },
      }),
    );
    await expect(
      fetchUrlWithRedirects(
        "https://example.com/a",
        5000,
        fetchFn as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/HTTP 404/);
  });

  it("rejects Content-Length over cap", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      makeResponse("x", {
        headers: {
          "content-type": "text/html",
          "content-length": String(READ_URL_MAX_BYTES + 1),
        },
      }),
    );
    await expect(
      fetchUrlWithRedirects(
        "https://example.com/a",
        5000,
        fetchFn as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/Content-Length/);
  });

  it("rejects actual body over cap when server lied on CL", async () => {
    const big = new Uint8Array(READ_URL_MAX_BYTES + 10);
    const fetchFn = vi.fn().mockResolvedValue(
      makeResponse(big, {
        headers: { "content-type": "text/plain" }, // no content-length
      }),
    );
    await expect(
      fetchUrlWithRedirects(
        "https://example.com/a",
        5000,
        fetchFn as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/body exceeds/);
  });

  it("rejects non-whitelisted content-type", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      makeResponse("binary", {
        headers: { "content-type": "application/octet-stream" },
      }),
    );
    await expect(
      fetchUrlWithRedirects(
        "https://example.com/a",
        5000,
        fetchFn as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/content-type/);
  });

  it("rejects image/png", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      makeResponse("png-bytes", {
        headers: { "content-type": "image/png" },
      }),
    );
    await expect(
      fetchUrlWithRedirects(
        "https://example.com/a",
        5000,
        fetchFn as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/content-type/);
  });

  it("accepts application/json", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      makeResponse('{"k":"v"}', {
        headers: { "content-type": "application/json" },
      }),
    );
    const r = await fetchUrlWithRedirects(
      "https://example.com/api",
      5000,
      fetchFn as unknown as typeof fetch,
    );
    expect(r.mediaType).toBe("application/json");
    expect(r.body).toBe('{"k":"v"}');
  });

  it("accepts vendor +json", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      makeResponse('{}', {
        headers: { "content-type": "application/vnd.github+json" },
      }),
    );
    const r = await fetchUrlWithRedirects(
      "https://example.com/api",
      5000,
      fetchFn as unknown as typeof fetch,
    );
    expect(r.mediaType).toBe("application/vnd.github+json");
  });

  it("aborts on timeout", async () => {
    const fetchFn = vi.fn().mockImplementation((_url: string, opts?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });
    await expect(
      fetchUrlWithRedirects(
        "https://example.com/a",
        50,
        fetchFn as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/timeout/);
  }, 2000);
});

// ─── readUrlHandler ──────────────────────────────────────────────────────

describe("readUrlHandler — flag gate", () => {
  it("returns disabled when master flag off", async () => {
    setFlags({
      LUCA_TOOLS_ENABLED: "true",
      LUCA_TOOL_READ_URL_ENABLED: "true",
    });
    const r = await readUrlHandler(
      { url: "https://example.com/" },
      makeCtx(),
    );
    expect(r.status).toBe("disabled");
    expect(insertedRows).toHaveLength(0);
  });

  it("returns disabled when tools-master off", async () => {
    setFlags({
      LUCA_V1A_ENABLED: "true",
      LUCA_TOOL_READ_URL_ENABLED: "true",
    });
    const r = await readUrlHandler(
      { url: "https://example.com/" },
      makeCtx(),
    );
    expect(r.status).toBe("disabled");
  });

  it("returns disabled when per-tool off", async () => {
    setFlags({
      LUCA_V1A_ENABLED: "true",
      LUCA_TOOLS_ENABLED: "true",
    });
    const r = await readUrlHandler(
      { url: "https://example.com/" },
      makeCtx(),
    );
    expect(r.status).toBe("disabled");
  });
});

describe("readUrlHandler — SSRF", () => {
  it("rejects http:// before any network call", async () => {
    const fetchFn = vi.fn();
    const r = await readUrlHandler(
      { url: "http://example.com/" },
      makeCtx(),
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(r.status).toBe("error");
    expect(r.error).toMatch(/ssrf/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects localhost", async () => {
    const fetchFn = vi.fn();
    const r = await readUrlHandler(
      { url: "https://localhost/" },
      makeCtx(),
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(r.status).toBe("error");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects metadata endpoint", async () => {
    const fetchFn = vi.fn();
    const r = await readUrlHandler(
      { url: "https://169.254.169.254/latest/" },
      makeCtx(),
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(r.status).toBe("error");
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("readUrlHandler — happy path", () => {
  it("fetches HTML and returns compacted text", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      makeResponse(
        "<html><head><title>T</title></head><body><p>Hello &amp; world</p><script>x</script></body></html>",
        { headers: { "content-type": "text/html; charset=utf-8" } },
      ),
    );
    const r = await readUrlHandler(
      { url: "https://example.com/x" },
      makeCtx(),
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(r.status).toBe("ok");
    expect(r.content).toBe("Hello & world");
    expect(r.media_type).toBe("text/html");
    expect(r.truncated).toBe(false);
    expect(r.redirect_hops).toBe(0);
    expect(r.final_url).toBe("https://example.com/x");
  });

  it("fetches JSON and returns it as-is (trimmed)", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      makeResponse('  {"k":"v"}  ', {
        headers: { "content-type": "application/json" },
      }),
    );
    const r = await readUrlHandler(
      { url: "https://example.com/api" },
      makeCtx(),
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(r.status).toBe("ok");
    expect(r.content).toBe('{"k":"v"}');
    expect(r.media_type).toBe("application/json");
  });

  it("truncates when max_chars cap hits", async () => {
    const big = "x".repeat(500);
    const fetchFn = vi.fn().mockResolvedValue(
      makeResponse(big, { headers: { "content-type": "text/plain" } }),
    );
    const r = await readUrlHandler(
      { url: "https://example.com/", max_chars: 100 },
      makeCtx(),
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(r.status).toBe("ok");
    expect(r.truncated).toBe(true);
    expect(r.content.length).toBeLessThanOrEqual(100);
    expect(r.content).toMatch(/\[truncated\]$/);
  });

  it("caps max_chars at CAP_MAX_CHARS (caller cannot exceed)", async () => {
    // Caller asks for way more than the cap — handler should clamp down.
    const body = "y".repeat(READ_URL_CAP_MAX_CHARS + 10000);
    const fetchFn = vi.fn().mockResolvedValue(
      makeResponse(body, { headers: { "content-type": "text/plain" } }),
    );
    const r = await readUrlHandler(
      { url: "https://example.com/", max_chars: READ_URL_CAP_MAX_CHARS * 10 },
      makeCtx(),
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(r.status).toBe("ok");
    expect(r.content.length).toBeLessThanOrEqual(READ_URL_CAP_MAX_CHARS);
  });
});

describe("readUrlHandler — errors", () => {
  it("returns status:timeout when fetch aborts", async () => {
    const fetchFn = vi.fn().mockImplementation((_url: string, opts?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });
    const r = await readUrlHandler(
      { url: "https://example.com/", timeout_ms: 50 },
      makeCtx(),
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(r.status).toBe("timeout");
    expect(r.error).toMatch(/timeout/);
  }, 2000);

  it("returns status:error on HTTP 500", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      makeResponse("server error", {
        status: 500,
        statusText: "Internal Server Error",
        headers: { "content-type": "text/plain" },
      }),
    );
    const r = await readUrlHandler(
      { url: "https://example.com/" },
      makeCtx(),
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(r.status).toBe("error");
    expect(r.error).toMatch(/500/);
  });

  it("returns status:error on non-allowed content-type", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      makeResponse("", {
        headers: { "content-type": "image/png" },
      }),
    );
    const r = await readUrlHandler(
      { url: "https://example.com/logo" },
      makeCtx(),
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(r.status).toBe("error");
    expect(r.error).toMatch(/content-type/);
  });
});

describe("readUrlHandler — forensic log", () => {
  it("inserts pending row + terminal ok row", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      makeResponse("<p>hi</p>", {
        headers: { "content-type": "text/html" },
      }),
    );
    await readUrlHandler(
      { url: "https://example.com/x" },
      makeCtx(),
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(insertedRows).toHaveLength(2);
    expect(insertedRows[0].status).toBe("pending");
    expect(insertedRows[0].tool).toBe("luca_read_url");
    expect(insertedRows[0].networkAttempted).toBe(true);
    expect(insertedRows[1].status).toBe("ok");
    expect(insertedRows[1].codeSha).toBe(insertedRows[0].codeSha);
    const out = insertedRows[1].output as Record<string, unknown>;
    expect(out.final_url).toBe("https://example.com/x");
    expect(out.media_type).toBe("text/html");
  });

  it("inserts pending + terminal error row on HTTP fail", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      makeResponse("fail", {
        status: 500,
        statusText: "Server Error",
        headers: { "content-type": "text/plain" },
      }),
    );
    await readUrlHandler(
      { url: "https://example.com/x" },
      makeCtx(),
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(insertedRows).toHaveLength(2);
    expect(insertedRows[0].status).toBe("pending");
    expect(insertedRows[1].status).toBe("error");
    expect(insertedRows[1].errorDetail).toMatch(/500/);
  });

  it("does NOT insert row when tool is disabled", async () => {
    setFlags({});
    await readUrlHandler(
      { url: "https://example.com/x" },
      makeCtx(),
    );
    expect(insertedRows).toHaveLength(0);
  });
});

// ─── Registry / dispatch integration ─────────────────────────────────────

describe("registry integration", () => {
  it("luca_read_url is listed in full tool specs", () => {
    const all = __getAllLucaToolSpecsForTests();
    expect(all.some((t) => t.name === "luca_read_url")).toBe(true);
  });

  it("getLucaTools() includes luca_read_url when all 3 flags on", () => {
    const tools = getLucaTools();
    expect(tools.some((t) => t.name === "luca_read_url")).toBe(true);
  });

  it("getLucaTools() omits luca_read_url when per-tool flag off", () => {
    setFlags({ LUCA_V1A_ENABLED: "true", LUCA_TOOLS_ENABLED: "true" });
    const tools = getLucaTools();
    expect(tools.some((t) => t.name === "luca_read_url")).toBe(false);
  });

  it("dispatchLucaTool routes luca_read_url → readUrlHandler", async () => {
    // We don't mock fetch here, just verify the dispatcher returns a result
    // shape of readUrlHandler (status field). Using an SSRF reject so we
    // never actually touch the network — confirms routing without egress.
    const r = await dispatchLucaTool(
      "luca_read_url",
      { url: "https://localhost/" },
      makeCtx(),
    );
    expect((r as { status: string }).status).toBe("error");
    expect((r as { error: string }).error).toMatch(/ssrf/);
  });

  it("dispatchLucaTool throws luca_tool_not_found for unknown", async () => {
    await expect(
      dispatchLucaTool("luca_does_not_exist", {}, makeCtx()),
    ).rejects.toThrow(/luca_tool_not_found/);
  });
});

// ─── Tool spec sanity ────────────────────────────────────────────────────

describe("readUrlTool spec", () => {
  it("has expected shape", () => {
    expect(readUrlTool.name).toBe("luca_read_url");
    expect(readUrlTool.description).toMatch(/https/);
    expect(readUrlTool.input_schema.type).toBe("object");
    expect(readUrlTool.input_schema.required).toEqual(["url"]);
  });
});
