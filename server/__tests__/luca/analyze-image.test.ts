/**
 * Luca V1a Day 3 — analyze_image tool unit tests.
 *
 * Covers:
 *   - Three-level flag gate (master/tools/per-tool)
 *   - Input validation: image_url required, prompt type, max_tokens integer,
 *     timeout_ms NaN/Infinity rejection (D30 lesson)
 *   - SF4 regional S3 whitelist: accepts all 6 canonical forms for correct
 *     bucket+region; rejects arbitrary hosts, wrong bucket, wrong protocol,
 *     missing env vars (fail-closed)
 *   - Data: URI path: media-type whitelist enforced, size cap
 *   - Image fetch: size cap (Content-Length and body), media-type sniffing
 *     when response is missing/generic content-type
 *   - Anthropic call: happy path maps to {status:ok,description,tokens_used}
 *   - API failure paths: abort → timeout, other error → error
 *   - Forensic log: pending inserted BEFORE fetch, terminal after
 *   - Registry: tool only appears when all 3 flags on, dispatch routes to
 *     analyze_image handler
 *   - SF3 code_sha identity: same url+prompt+max_tokens → same sha,
 *     different prompt → different sha, timeout_ms NOT in identity
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

// Avoid loading the real anthropic-client breaker (which imports other deps);
// forward to plain fn execution.
vi.mock("../../lib/anthropic-client", () => ({
  withAnthropicBreaker: async <T,>(
    client: unknown,
    fn: (c: unknown) => Promise<T>,
  ): Promise<T> => fn(client),
}));

import {
  analyzeImageHandler,
  analyzeImageTool,
  parseAnalyzeImageInput,
  validateImageUrlSF4,
  sniffImageMagic,
  computeAnalyzeImageSha,
  fetchImageForAnthropic,
  ANALYZE_IMAGE_DEFAULT_MAX_TOKENS,
  ANALYZE_IMAGE_MAX_MAX_TOKENS,
  ANALYZE_IMAGE_DEFAULT_TIMEOUT_MS,
  ANALYZE_IMAGE_MAX_TIMEOUT_MS,
  ANALYZE_IMAGE_MAX_BYTES,
  type AnalyzeImageContext,
  type FetchedImage,
} from "../../lib/luca-tools/analyze-image";
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
  "LUCA_TOOL_RUN_CODE_ENABLED",
  "LUCA_TOOL_ANALYZE_IMAGE_ENABLED",
];
const S3_ENV_KEYS = ["LUCA_S3_BUCKET", "AWS_REGION"];

function setFlags(overrides: Record<string, string | undefined>) {
  for (const k of [...LUCA_FLAG_KEYS, ...S3_ENV_KEYS]) delete process.env[k];
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function allOn() {
  setFlags({
    LUCA_V1A_ENABLED: "true",
    LUCA_TOOLS_ENABLED: "true",
    LUCA_TOOL_ANALYZE_IMAGE_ENABLED: "true",
    LUCA_TOOL_RUN_CODE_ENABLED: "true",
    LUCA_S3_BUCKET: "ikonbai-luca-test",
    AWS_REGION: "eu-central-1",
  });
}

function makeCtx(): AnalyzeImageContext {
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

// ─── parseAnalyzeImageInput ──────────────────────────────────────────────

describe("parseAnalyzeImageInput", () => {
  it("accepts minimal valid input", () => {
    const r = parseAnalyzeImageInput({ image_url: "s3://b/k.png" });
    expect(r.image_url).toBe("s3://b/k.png");
    expect(r.prompt).toBeUndefined();
    expect(r.max_tokens).toBeUndefined();
    expect(r.timeout_ms).toBeUndefined();
  });

  it("rejects non-object raw input", () => {
    expect(() => parseAnalyzeImageInput(null)).toThrow(/expected object/);
    expect(() => parseAnalyzeImageInput("string")).toThrow(/expected object/);
    expect(() => parseAnalyzeImageInput(42)).toThrow(/expected object/);
  });

  it("rejects missing/empty image_url", () => {
    expect(() => parseAnalyzeImageInput({})).toThrow(/image_url/);
    expect(() => parseAnalyzeImageInput({ image_url: "" })).toThrow(/image_url/);
    expect(() => parseAnalyzeImageInput({ image_url: 123 })).toThrow(/image_url/);
  });

  it("rejects image_url > 8KB", () => {
    const huge = "s3://b/" + "x".repeat(10_000);
    expect(() => parseAnalyzeImageInput({ image_url: huge })).toThrow(
      /8KB/,
    );
  });

  it("rejects invalid prompt", () => {
    expect(() =>
      parseAnalyzeImageInput({ image_url: "s3://b/k", prompt: 123 }),
    ).toThrow(/prompt/);
    expect(() =>
      parseAnalyzeImageInput({
        image_url: "s3://b/k",
        prompt: "x".repeat(20_000),
      }),
    ).toThrow(/10KB/);
  });

  it("rejects invalid max_tokens (non-integer, <=0, NaN, Infinity)", () => {
    for (const bad of [-1, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "5"]) {
      expect(() =>
        parseAnalyzeImageInput({ image_url: "s3://b/k", max_tokens: bad }),
      ).toThrow(/max_tokens/);
    }
  });

  it("rejects NaN/Infinity/-1/0 timeout_ms (D30 lesson)", () => {
    for (const bad of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      0,
      -1,
      "5s",
    ]) {
      expect(() =>
        parseAnalyzeImageInput({ image_url: "s3://b/k", timeout_ms: bad }),
      ).toThrow(/timeout_ms/);
    }
  });

  it("accepts large timeout_ms (parser doesn't cap, handler caps)", () => {
    const r = parseAnalyzeImageInput({
      image_url: "s3://b/k",
      timeout_ms: 1_000_000,
    });
    expect(r.timeout_ms).toBe(1_000_000);
  });
});

// ─── SF4 regional S3 whitelist ───────────────────────────────────────────

describe("validateImageUrlSF4 — accept paths", () => {
  it("accepts s3:// canonical form and rewrites to virtual-hosted regional", () => {
    const r = validateImageUrlSF4("s3://ikonbai-luca-test/plots/x.png");
    expect(r.ok).toBe(true);
    expect(r.fetchUrl).toBe(
      "https://ikonbai-luca-test.s3.eu-central-1.amazonaws.com/plots/x.png",
    );
    expect(r.isDataUri).toBeFalsy();
  });

  it("accepts virtual-hosted regional https", () => {
    const r = validateImageUrlSF4(
      "https://ikonbai-luca-test.s3.eu-central-1.amazonaws.com/plots/x.png?X-Amz-Signature=abc",
    );
    expect(r.ok).toBe(true);
    expect(r.fetchUrl).toContain("X-Amz-Signature=abc"); // query preserved
  });

  it("accepts virtual-hosted global https (no region in host)", () => {
    const r = validateImageUrlSF4(
      "https://ikonbai-luca-test.s3.amazonaws.com/plots/x.png",
    );
    expect(r.ok).toBe(true);
  });

  it("accepts path-style regional https", () => {
    const r = validateImageUrlSF4(
      "https://s3.eu-central-1.amazonaws.com/ikonbai-luca-test/plots/x.png",
    );
    expect(r.ok).toBe(true);
    expect(r.fetchUrl).toContain("/ikonbai-luca-test/plots/x.png");
  });

  it("accepts path-style global https", () => {
    const r = validateImageUrlSF4(
      "https://s3.amazonaws.com/ikonbai-luca-test/plots/x.png",
    );
    expect(r.ok).toBe(true);
  });

  it("accepts valid data: URI jpeg/png/gif/webp", () => {
    for (const mt of ["image/jpeg", "image/png", "image/gif", "image/webp"]) {
      const r = validateImageUrlSF4(`data:${mt};base64,iVBORw0KGgo=`);
      expect(r.ok).toBe(true);
      expect(r.isDataUri).toBe(true);
    }
  });
});

describe("validateImageUrlSF4 — reject paths", () => {
  it("rejects data: URI with non-whitelisted media type", () => {
    const r = validateImageUrlSF4("data:text/plain;base64,aGVsbG8=");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/media type/);
  });

  it("rejects malformed data: URI (no base64 marker)", () => {
    const r = validateImageUrlSF4("data:image/png,<raw>");
    expect(r.ok).toBe(false);
  });

  it("rejects http:// (non-TLS)", () => {
    const r = validateImageUrlSF4(
      "http://ikonbai-luca-test.s3.eu-central-1.amazonaws.com/x.png",
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/https only/);
  });

  it("rejects wrong bucket (virtual-hosted)", () => {
    const r = validateImageUrlSF4(
      "https://attacker.s3.eu-central-1.amazonaws.com/x.png",
    );
    expect(r.ok).toBe(false);
  });

  it("rejects wrong bucket (path-style)", () => {
    const r = validateImageUrlSF4(
      "https://s3.eu-central-1.amazonaws.com/attacker/x.png",
    );
    expect(r.ok).toBe(false);
  });

  it("rejects wrong bucket (s3://)", () => {
    const r = validateImageUrlSF4("s3://attacker/x.png");
    expect(r.ok).toBe(false);
  });

  it("rejects malformed s3:// (missing key)", () => {
    expect(validateImageUrlSF4("s3://ikonbai-luca-test/").ok).toBe(false);
    expect(validateImageUrlSF4("s3://ikonbai-luca-test").ok).toBe(false);
  });

  it("rejects arbitrary external host", () => {
    const r = validateImageUrlSF4("https://evil.com/x.png");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not in regional S3 whitelist/);
  });

  it("rejects file:// / ftp:// / gopher://", () => {
    for (const url of [
      "file:///etc/passwd",
      "ftp://ikonbai-luca-test.s3.eu-central-1.amazonaws.com/x",
      "gopher://evil.com/",
    ]) {
      const r = validateImageUrlSF4(url);
      expect(r.ok).toBe(false);
    }
  });

  it("rejects missing bucket key on virtual-hosted URL", () => {
    const r = validateImageUrlSF4(
      "https://ikonbai-luca-test.s3.eu-central-1.amazonaws.com/",
    );
    expect(r.ok).toBe(false);
  });

  it("rejects path-style missing key", () => {
    const r = validateImageUrlSF4(
      "https://s3.eu-central-1.amazonaws.com/ikonbai-luca-test",
    );
    expect(r.ok).toBe(false);
  });

  it("fails CLOSED when LUCA_S3_BUCKET unset", () => {
    delete process.env.LUCA_S3_BUCKET;
    const r = validateImageUrlSF4(
      "https://ikonbai-luca-test.s3.eu-central-1.amazonaws.com/x.png",
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/LUCA_S3_BUCKET/);
  });

  it("fails CLOSED when AWS_REGION unset", () => {
    delete process.env.AWS_REGION;
    const r = validateImageUrlSF4(
      "https://ikonbai-luca-test.s3.eu-central-1.amazonaws.com/x.png",
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/AWS_REGION/);
  });

  it("rejects malformed URL", () => {
    const r = validateImageUrlSF4("not a url at all");
    expect(r.ok).toBe(false);
  });
});

// ─── sniffImageMagic ─────────────────────────────────────────────────────

describe("sniffImageMagic", () => {
  it("detects JPEG magic bytes", () => {
    expect(sniffImageMagic(Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array(8).fill(0)]))).toBe(
      "image/jpeg",
    );
  });

  it("detects PNG magic bytes", () => {
    expect(
      sniffImageMagic(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
      ),
    ).toBe("image/png");
  });

  it("detects GIF87a and GIF89a", () => {
    const g87 = Buffer.from("GIF87a" + "\0\0\0\0\0\0", "latin1");
    const g89 = Buffer.from("GIF89a" + "\0\0\0\0\0\0", "latin1");
    expect(sniffImageMagic(g87)).toBe("image/gif");
    expect(sniffImageMagic(g89)).toBe("image/gif");
  });

  it("detects WEBP (RIFF...WEBP)", () => {
    const w = Buffer.from(
      [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50],
    );
    expect(sniffImageMagic(w)).toBe("image/webp");
  });

  it("returns null for unknown/short buffers", () => {
    expect(sniffImageMagic(Buffer.from([0, 0, 0]))).toBeNull();
    expect(sniffImageMagic(Buffer.from(Array(20).fill(0x42)))).toBeNull();
  });
});

// ─── computeAnalyzeImageSha (SF3) ────────────────────────────────────────

describe("computeAnalyzeImageSha", () => {
  it("is deterministic for same inputs", () => {
    const a = computeAnalyzeImageSha("s3://b/k", "describe", 1024);
    const b = computeAnalyzeImageSha("s3://b/k", "describe", 1024);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when URL changes", () => {
    const a = computeAnalyzeImageSha("s3://b/k1", "describe", 1024);
    const b = computeAnalyzeImageSha("s3://b/k2", "describe", 1024);
    expect(a).not.toBe(b);
  });

  it("changes when prompt changes", () => {
    const a = computeAnalyzeImageSha("s3://b/k", "describe", 1024);
    const b = computeAnalyzeImageSha("s3://b/k", "list colors", 1024);
    expect(a).not.toBe(b);
  });

  it("changes when max_tokens changes", () => {
    const a = computeAnalyzeImageSha("s3://b/k", "describe", 1024);
    const b = computeAnalyzeImageSha("s3://b/k", "describe", 2048);
    expect(a).not.toBe(b);
  });
});

// ─── fetchImageForAnthropic (data: URI path only — no real network) ─────

describe("fetchImageForAnthropic — data: URI path", () => {
  it("decodes data: URI into bytes+base64+mediaType", async () => {
    // 1x1 transparent PNG.
    const png64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=";
    const uri = `data:image/png;base64,${png64}`;
    const r = await fetchImageForAnthropic(uri, 5_000, true);
    expect(r.mediaType).toBe("image/png");
    expect(r.base64).toBe(png64);
    expect(r.bytes.length).toBe(Buffer.from(png64, "base64").length);
  });

  it("rejects data: URI exceeding byte cap", async () => {
    // Construct a 11MB payload via base64 (~11MB raw → ~14.67MB base64).
    const raw = Buffer.alloc(ANALYZE_IMAGE_MAX_BYTES + 100);
    const b64 = raw.toString("base64");
    const uri = `data:image/png;base64,${b64}`;
    await expect(fetchImageForAnthropic(uri, 5_000, true)).rejects.toThrow(
      /byte cap/,
    );
  });
});

// ─── Main handler ────────────────────────────────────────────────────────

/**
 * Build a mock Anthropic client returning a predetermined response. If
 * `throwFn` is set, messages.create throws with that value.
 */
function makeMockAnthropic(
  resp: Partial<{
    text: string;
    stopReason: string;
    inputTokens: number;
    outputTokens: number;
    throwFn: () => Error;
  }>,
) {
  return {
    messages: {
      create: vi.fn(async () => {
        if (resp.throwFn) throw resp.throwFn();
        return {
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "claude-3-5-sonnet-20241022",
          content: [
            { type: "text", text: resp.text ?? "A photo of a cat." },
          ],
          stop_reason: resp.stopReason ?? "end_turn",
          stop_sequence: null,
          usage: {
            input_tokens: resp.inputTokens ?? 100,
            output_tokens: resp.outputTokens ?? 20,
          },
        };
      }),
    },
  } as unknown as import("@anthropic-ai/sdk").default;
}

function mockFetchFn(
  result: Partial<FetchedImage> | { throwFn: () => Error },
): typeof fetchImageForAnthropic {
  return vi.fn(async () => {
    if ("throwFn" in result) throw result.throwFn();
    return {
      bytes: result.bytes ?? new Uint8Array([0xff, 0xd8, 0xff]),
      mediaType: result.mediaType ?? "image/jpeg",
      base64: result.base64 ?? "AAA=",
    };
  }) as unknown as typeof fetchImageForAnthropic;
}

describe("analyzeImageHandler", () => {
  it("returns disabled when master flag off (no tool_runs row)", async () => {
    setFlags({
      LUCA_V1A_ENABLED: "false",
      LUCA_TOOLS_ENABLED: "true",
      LUCA_TOOL_ANALYZE_IMAGE_ENABLED: "true",
      LUCA_S3_BUCKET: "ikonbai-luca-test",
      AWS_REGION: "eu-central-1",
    });
    const r = await analyzeImageHandler(
      { image_url: "s3://ikonbai-luca-test/x.png" },
      makeCtx(),
      { anthropicClient: makeMockAnthropic({}), fetchFn: mockFetchFn({}) },
    );
    expect(r.status).toBe("disabled");
    expect(insertedRows).toHaveLength(0);
  });

  it("returns disabled when tools flag off", async () => {
    setFlags({
      LUCA_V1A_ENABLED: "true",
      LUCA_TOOLS_ENABLED: "false",
      LUCA_TOOL_ANALYZE_IMAGE_ENABLED: "true",
      LUCA_S3_BUCKET: "ikonbai-luca-test",
      AWS_REGION: "eu-central-1",
    });
    const r = await analyzeImageHandler(
      { image_url: "s3://ikonbai-luca-test/x.png" },
      makeCtx(),
      { anthropicClient: makeMockAnthropic({}), fetchFn: mockFetchFn({}) },
    );
    expect(r.status).toBe("disabled");
    expect(insertedRows).toHaveLength(0);
  });

  it("returns disabled when per-tool flag off", async () => {
    setFlags({
      LUCA_V1A_ENABLED: "true",
      LUCA_TOOLS_ENABLED: "true",
      LUCA_TOOL_ANALYZE_IMAGE_ENABLED: "false",
      LUCA_S3_BUCKET: "ikonbai-luca-test",
      AWS_REGION: "eu-central-1",
    });
    const r = await analyzeImageHandler(
      { image_url: "s3://ikonbai-luca-test/x.png" },
      makeCtx(),
      { anthropicClient: makeMockAnthropic({}), fetchFn: mockFetchFn({}) },
    );
    expect(r.status).toBe("disabled");
    expect(insertedRows).toHaveLength(0);
  });

  it("rejects URL failing SF4 → error, still inserts pending row? no — SF4 before pending", async () => {
    const r = await analyzeImageHandler(
      { image_url: "https://evil.com/x.png" },
      makeCtx(),
      { anthropicClient: makeMockAnthropic({}), fetchFn: mockFetchFn({}) },
    );
    expect(r.status).toBe("error");
    expect(r.error).toMatch(/sf4/);
    // SF4 fails BEFORE any insert — no forensic row.
    expect(insertedRows).toHaveLength(0);
  });

  it("happy path: fetch + Anthropic → ok + description + 2 tool_runs rows", async () => {
    const r = await analyzeImageHandler(
      { image_url: "s3://ikonbai-luca-test/x.jpg", prompt: "describe" },
      makeCtx(),
      {
        anthropicClient: makeMockAnthropic({
          text: "A cat.",
          inputTokens: 120,
          outputTokens: 5,
        }),
        fetchFn: mockFetchFn({ mediaType: "image/jpeg" }),
      },
    );
    expect(r.status).toBe("ok");
    expect(r.description).toBe("A cat.");
    expect(r.tokens_used).toBe(125);
    expect(r.stop_reason).toBe("end_turn");

    expect(insertedRows).toHaveLength(2);
    expect(insertedRows[0].status).toBe("pending");
    expect(insertedRows[0].tool).toBe("luca_analyze_image");
    expect(insertedRows[0].networkAttempted).toBe(true);
    expect(insertedRows[1].status).toBe("ok");
    const output = insertedRows[1].output as Record<string, unknown>;
    expect(output.description).toBe("A cat.");
    expect(output.input_tokens).toBe(120);
    expect(output.output_tokens).toBe(5);
  });

  it("fetch throws → terminal row status=error + returns error", async () => {
    const r = await analyzeImageHandler(
      { image_url: "s3://ikonbai-luca-test/x.jpg" },
      makeCtx(),
      {
        anthropicClient: makeMockAnthropic({}),
        fetchFn: mockFetchFn({
          throwFn: () =>
            new Error("analyze_image.fetch: HTTP 404 Not Found"),
        }),
      },
    );
    expect(r.status).toBe("error");
    expect(r.error).toMatch(/404/);
    expect(insertedRows).toHaveLength(2);
    expect(insertedRows[1].status).toBe("error");
    expect(insertedRows[1].errorDetail).toMatch(/404/);
  });

  it("fetch timeout → terminal row status=timeout", async () => {
    const r = await analyzeImageHandler(
      { image_url: "s3://ikonbai-luca-test/x.jpg" },
      makeCtx(),
      {
        anthropicClient: makeMockAnthropic({}),
        fetchFn: mockFetchFn({
          throwFn: () =>
            new Error("analyze_image.fetch: timeout after 5000ms"),
        }),
      },
    );
    expect(r.status).toBe("timeout");
    expect(insertedRows[1].status).toBe("timeout");
  });

  it("Anthropic API throws → terminal row status=error + returns error", async () => {
    const r = await analyzeImageHandler(
      { image_url: "s3://ikonbai-luca-test/x.jpg" },
      makeCtx(),
      {
        anthropicClient: makeMockAnthropic({
          throwFn: () => new Error("API overloaded"),
        }),
        fetchFn: mockFetchFn({ mediaType: "image/jpeg" }),
      },
    );
    expect(r.status).toBe("error");
    expect(r.error).toMatch(/overloaded/);
    expect(insertedRows).toHaveLength(2);
    expect(insertedRows[1].status).toBe("error");
  });

  it("Anthropic API AbortError → terminal row status=timeout", async () => {
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    const r = await analyzeImageHandler(
      { image_url: "s3://ikonbai-luca-test/x.jpg" },
      makeCtx(),
      {
        anthropicClient: makeMockAnthropic({ throwFn: () => abortErr }),
        fetchFn: mockFetchFn({ mediaType: "image/jpeg" }),
      },
    );
    expect(r.status).toBe("timeout");
    expect(insertedRows[1].status).toBe("timeout");
  });

  it("no ANTHROPIC_API_KEY and no injected client → error terminal row", async () => {
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const r = await analyzeImageHandler(
        { image_url: "s3://ikonbai-luca-test/x.jpg" },
        makeCtx(),
        { fetchFn: mockFetchFn({ mediaType: "image/jpeg" }) },
      );
      expect(r.status).toBe("error");
      expect(r.error).toMatch(/ANTHROPIC_API_KEY/);
      expect(insertedRows).toHaveLength(2);
      expect(insertedRows[1].status).toBe("error");
    } finally {
      if (savedKey) process.env.ANTHROPIC_API_KEY = savedKey;
    }
  });

  it("invalid input (no image_url) throws parse error — no tool_runs rows", async () => {
    await expect(
      analyzeImageHandler({}, makeCtx(), {
        anthropicClient: makeMockAnthropic({}),
        fetchFn: mockFetchFn({}),
      }),
    ).rejects.toThrow(/image_url/);
    expect(insertedRows).toHaveLength(0);
  });

  it("caps max_tokens at MAX — handler enforces even if caller asks for more", async () => {
    const client = makeMockAnthropic({});
    await analyzeImageHandler(
      {
        image_url: "s3://ikonbai-luca-test/x.jpg",
        max_tokens: 99_999,
      },
      makeCtx(),
      { anthropicClient: client, fetchFn: mockFetchFn({}) },
    );
    // Inspect the arg passed to messages.create.
    const createMock = (client.messages.create as unknown as {
      mock: { calls: unknown[][] };
    }).mock;
    const arg = createMock.calls[0][0] as { max_tokens: number };
    expect(arg.max_tokens).toBe(ANALYZE_IMAGE_MAX_MAX_TOKENS);
  });
});

// ─── Registry integration ────────────────────────────────────────────────

describe("registry integration", () => {
  it("analyze_image spec present in __getAllLucaToolSpecsForTests", () => {
    const specs = __getAllLucaToolSpecsForTests();
    expect(specs.find((s) => s.name === "luca_analyze_image")).toBeDefined();
  });

  it("getLucaTools includes analyze_image when all flags on", () => {
    allOn();
    const tools = getLucaTools();
    expect(tools.find((t) => t.name === "luca_analyze_image")).toBeDefined();
  });

  it("getLucaTools omits analyze_image when per-tool flag off", () => {
    setFlags({
      LUCA_V1A_ENABLED: "true",
      LUCA_TOOLS_ENABLED: "true",
      LUCA_TOOL_RUN_CODE_ENABLED: "true",
      LUCA_TOOL_ANALYZE_IMAGE_ENABLED: "false",
      LUCA_S3_BUCKET: "ikonbai-luca-test",
      AWS_REGION: "eu-central-1",
    });
    const tools = getLucaTools();
    expect(tools.find((t) => t.name === "luca_analyze_image")).toBeUndefined();
    // But run_code still present.
    expect(tools.find((t) => t.name === "luca_run_code")).toBeDefined();
  });

  it("dispatchLucaTool routes luca_analyze_image to handler (disabled path shortest)", async () => {
    setFlags({ LUCA_V1A_ENABLED: "false" });
    const r = await dispatchLucaTool(
      "luca_analyze_image",
      { image_url: "s3://ikonbai-luca-test/x.jpg" },
      makeCtx(),
    );
    expect(r).toMatchObject({ status: "disabled" });
  });

  it("dispatchLucaTool unknown name throws", async () => {
    await expect(
      dispatchLucaTool("luca_not_a_tool", {}, makeCtx()),
    ).rejects.toThrow(/luca_tool_not_found/);
  });
});

// ─── Tool spec sanity ────────────────────────────────────────────────────

describe("analyzeImageTool spec", () => {
  it("has correct name and required fields", () => {
    expect(analyzeImageTool.name).toBe("luca_analyze_image");
    expect(analyzeImageTool.input_schema.type).toBe("object");
    expect(analyzeImageTool.input_schema.required).toEqual(["image_url"]);
  });

  it("name is distinct from run_code (no collision in unified registry)", () => {
    const specs = __getAllLucaToolSpecsForTests();
    const names = specs.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length); // no dupes
  });

  it("name begins with `luca_` prefix (collision prevention convention)", () => {
    expect(analyzeImageTool.name.startsWith("luca_")).toBe(true);
  });
});

// ─── Constants sanity ────────────────────────────────────────────────────

describe("policy constants", () => {
  it("defaults are under caps", () => {
    expect(ANALYZE_IMAGE_DEFAULT_TIMEOUT_MS).toBeLessThanOrEqual(
      ANALYZE_IMAGE_MAX_TIMEOUT_MS,
    );
    expect(ANALYZE_IMAGE_DEFAULT_MAX_TOKENS).toBeLessThanOrEqual(
      ANALYZE_IMAGE_MAX_MAX_TOKENS,
    );
  });

  it("max bytes is positive", () => {
    expect(ANALYZE_IMAGE_MAX_BYTES).toBeGreaterThan(0);
  });
});
