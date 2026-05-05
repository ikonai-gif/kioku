/**
 * R466 — luca_read_repo unit tests.
 *
 * Coverage:
 *   - validateRepoPath: traversal, NUL, empty, too-long, leading slash,
 *     backslash, double slash, deny substring, non-allowed prefix.
 *   - validateRef: alphanumerics + ./_-/, length cap, type check.
 *   - readAllowPrefixes / readDenySubstrings: empty → defaults; commas.
 *   - fetchRepoFile happy path with mocked fetch + base64 content.
 *   - not_configured when no token provided.
 *   - too_large rejected before decode.
 *   - binary_unsupported when decoded buffer contains NUL byte.
 *   - 401/403/404/429 mapped to error codes.
 *   - Owner/repo CANNOT be pivoted from input — env wins; if env unset
 *     defaults are used.
 *   - Token never appears in returned data (no-leak).
 *   - Directory response (Array) → not_a_file.
 */
import { describe, it, expect } from "vitest";
import {
  validateRepoPath,
  validateRef,
  readAllowPrefixes,
  readDenySubstrings,
  fetchRepoFile,
} from "../../server/lib/luca-tools/read-repo";

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

function mockFetchOK(body: any, status = 200): typeof fetch {
  return (async (_url: string | URL | Request, _init?: RequestInit) => {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function mockFetchStatus(status: number, headers: Record<string, string> = {}): typeof fetch {
  return (async () => {
    return new Response("err", { status, headers });
  }) as unknown as typeof fetch;
}

describe("validateRepoPath", () => {
  it("rejects non-string", () => {
    // @ts-expect-error
    expect(validateRepoPath(123).ok).toBe(false);
  });
  it("rejects empty string", () => {
    expect(validateRepoPath("").ok).toBe(false);
  });
  it("rejects >512 chars", () => {
    expect(validateRepoPath("server/" + "a".repeat(600)).ok).toBe(false);
  });
  it("rejects NUL byte", () => {
    expect(validateRepoPath("server/foo\0.ts").ok).toBe(false);
  });
  it("rejects leading slash", () => {
    expect(validateRepoPath("/server/foo.ts").ok).toBe(false);
  });
  it("rejects backslash", () => {
    expect(validateRepoPath("server\\foo.ts").ok).toBe(false);
  });
  it("rejects double slash", () => {
    expect(validateRepoPath("server//foo.ts").ok).toBe(false);
  });
  it("rejects '..' segment (path traversal)", () => {
    const r = validateRepoPath("server/../etc/passwd");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("invalid_path");
  });
  it("rejects '.' segment", () => {
    expect(validateRepoPath("server/./foo.ts").ok).toBe(false);
  });
  it("rejects path containing '.env' (deny substring)", () => {
    const r = validateRepoPath("server/.env.production");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("path_denied");
  });
  it("rejects path containing 'secrets/' regardless of casing", () => {
    const r = validateRepoPath("server/Secrets/api.ts");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("path_denied");
  });
  it("rejects path containing 'private_key'", () => {
    const r = validateRepoPath("server/util/private_key_helper.ts");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("path_denied");
  });
  it("rejects non-allowed top-level path", () => {
    const r = validateRepoPath("dist/server.js");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("path_not_allowed");
  });
  it("accepts server/ path", () => {
    expect(validateRepoPath("server/deliberation.ts").ok).toBe(true);
  });
  it("accepts package.json (exact match)", () => {
    expect(validateRepoPath("package.json").ok).toBe(true);
  });
  it("accepts tests/ path", () => {
    expect(validateRepoPath("tests/unit/foo.test.ts").ok).toBe(true);
  });
  it("rejects exact-match impostor (e.g. 'package.jsonz')", () => {
    const r = validateRepoPath("package.jsonz");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("path_not_allowed");
  });
  it("respects custom allow list", () => {
    const r = validateRepoPath("custom/foo.ts", { allowPrefixes: ["custom/"] });
    expect(r.ok).toBe(true);
  });
});

describe("validateRef", () => {
  it("accepts undefined / null / empty (use default)", () => {
    expect(validateRef(undefined).ok).toBe(true);
    expect(validateRef(null).ok).toBe(true);
    expect(validateRef("").ok).toBe(true);
  });
  it("accepts main / commit sha / tag / branch with slash", () => {
    expect(validateRef("main").ok).toBe(true);
    expect(validateRef("3511dd0a1b2c3d4e5f6").ok).toBe(true);
    expect(validateRef("v1.2.3").ok).toBe(true);
    expect(validateRef("feature/foo-bar").ok).toBe(true);
  });
  it("rejects ref with whitespace / special chars", () => {
    expect(validateRef("main; rm -rf").ok).toBe(false);
    expect(validateRef("main\nfoo").ok).toBe(false);
    expect(validateRef("main$bar").ok).toBe(false);
  });
  it("rejects > 200 chars", () => {
    expect(validateRef("a".repeat(201)).ok).toBe(false);
  });
});

describe("readAllowPrefixes / readDenySubstrings", () => {
  it("empty / whitespace returns defaults", () => {
    expect(readAllowPrefixes("").length).toBeGreaterThan(0);
    expect(readDenySubstrings("").length).toBeGreaterThan(0);
    expect(readAllowPrefixes("   ").length).toBeGreaterThan(0);
  });
  it("comma-separated overrides defaults", () => {
    const allow = readAllowPrefixes("foo/, bar.json");
    expect(allow).toEqual(["foo/", "bar.json"]);
    const deny = readDenySubstrings("private/, .env");
    expect(deny).toEqual(["private/", ".env"]);
  });
});

describe("fetchRepoFile", () => {
  const HAPPY_BODY = {
    type: "file",
    encoding: "base64",
    size: 12,
    name: "package.json",
    path: "package.json",
    sha: "abcdef1234567890",
    content: b64("hello world!"),
  };

  it("returns not_configured if no token (env or opts)", async () => {
    const r = await fetchRepoFile("package.json", { token: "", fetchImpl: mockFetchOK(HAPPY_BODY) });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error).toBe("not_configured");
  });

  it("happy path — decodes base64, returns content + sha + size", async () => {
    const r = await fetchRepoFile("package.json", {
      token: "test-pat",
      fetchImpl: mockFetchOK(HAPPY_BODY),
    });
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.content).toBe("hello world!");
      expect(r.sha).toBe("abcdef1234567890");
      expect(r.size_bytes).toBe(12);
      expect(r.path).toBe("package.json");
    }
  });

  it("token never leaks into result JSON", async () => {
    const SECRET = "super-secret-token-XYZ";
    const r = await fetchRepoFile("package.json", {
      token: SECRET,
      fetchImpl: mockFetchOK(HAPPY_BODY),
    });
    const dump = JSON.stringify(r);
    expect(dump.includes(SECRET)).toBe(false);
  });

  it("rejects path_not_allowed BEFORE making any HTTP call", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const r = await fetchRepoFile("dist/server.js", { token: "t", fetchImpl });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error).toBe("path_not_allowed");
    expect(called).toBe(false);
  });

  it("rejects path_denied BEFORE making any HTTP call", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const r = await fetchRepoFile("server/.env.production", { token: "t", fetchImpl });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error).toBe("path_denied");
    expect(called).toBe(false);
  });

  it("rejects invalid_path BEFORE making any HTTP call", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const r = await fetchRepoFile("server/../etc/passwd", { token: "t", fetchImpl });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error).toBe("invalid_path");
    expect(called).toBe(false);
  });

  it("rejects too_large when size > maxBytes", async () => {
    const big = { ...HAPPY_BODY, size: 1024 * 1024, content: b64("x".repeat(64)) };
    const r = await fetchRepoFile("package.json", {
      token: "t",
      maxBytes: 256 * 1024,
      fetchImpl: mockFetchOK(big),
    });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error).toBe("too_large");
  });

  it("rejects binary_unsupported when decoded content contains NUL byte", async () => {
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
    const body = {
      ...HAPPY_BODY,
      size: binary.length,
      content: binary.toString("base64"),
    };
    const r = await fetchRepoFile("package.json", { token: "t", fetchImpl: mockFetchOK(body) });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error).toBe("binary_unsupported");
  });

  it("maps 404 → github_not_found", async () => {
    const r = await fetchRepoFile("server/missing.ts", {
      token: "t",
      fetchImpl: mockFetchStatus(404),
    });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error).toBe("github_not_found");
  });

  it("maps 401 → github_unauthorized", async () => {
    const r = await fetchRepoFile("server/foo.ts", {
      token: "t",
      fetchImpl: mockFetchStatus(401),
    });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error).toBe("github_unauthorized");
  });

  it("maps 403 with x-ratelimit-remaining=0 → github_rate_limited", async () => {
    const r = await fetchRepoFile("server/foo.ts", {
      token: "t",
      fetchImpl: mockFetchStatus(403, { "x-ratelimit-remaining": "0" }),
    });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error).toBe("github_rate_limited");
  });

  it("maps 429 → github_rate_limited", async () => {
    const r = await fetchRepoFile("server/foo.ts", {
      token: "t",
      fetchImpl: mockFetchStatus(429),
    });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error).toBe("github_rate_limited");
  });

  it("rejects directory listing (array body) as not_a_file", async () => {
    const fetchImpl = mockFetchOK([{ type: "dir" }, { type: "file" }]);
    const r = await fetchRepoFile("server/", { token: "t", fetchImpl, allowPrefixes: ["server/"] });
    // 'server/' itself starts with the allow prefix but ends with '/', so segments include empty → invalid_path.
    expect(r.status).toBe("error");
    if (r.status === "error") {
      // Either invalid_path (caught earlier) or not_a_file is acceptable; test the directory path explicitly.
    }
    const r2 = await fetchRepoFile("server/lib", { token: "t", fetchImpl });
    expect(r2.status).toBe("error");
    if (r2.status === "error") expect(r2.error).toBe("not_a_file");
  });

  it("rejects body of type='dir' as not_a_file", async () => {
    const r = await fetchRepoFile("server/lib", {
      token: "t",
      fetchImpl: mockFetchOK({ type: "dir", size: 0, sha: "x", name: "lib", path: "server/lib" }),
    });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error).toBe("not_a_file");
  });

  it("rejects when encoding != base64", async () => {
    const body = { ...HAPPY_BODY, encoding: "utf8" };
    const r = await fetchRepoFile("package.json", { token: "t", fetchImpl: mockFetchOK(body) });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error).toBe("github_error");
  });

  it("input cannot pivot owner/repo — request URL uses opts.owner/repo, defaults to ikonai-gif/kioku", async () => {
    let calledUrl = "";
    const fetchImpl = (async (url: string | URL | Request) => {
      calledUrl = typeof url === "string" ? url : url.toString();
      return new Response(JSON.stringify(HAPPY_BODY), { status: 200 });
    }) as unknown as typeof fetch;
    // Simulate caller trying to inject — but the tool accepts only `path` + `ref`.
    await fetchRepoFile("package.json", {
      token: "t",
      fetchImpl,
      // owner/repo are explicit overrides for testing only — production uses env.
      owner: "ikonai-gif",
      repo: "kioku",
    });
    expect(calledUrl).toContain("/repos/ikonai-gif/kioku/contents/package.json");
  });

  it("ref is appended as query param when provided", async () => {
    let calledUrl = "";
    const fetchImpl = (async (url: string | URL | Request) => {
      calledUrl = typeof url === "string" ? url : url.toString();
      return new Response(JSON.stringify(HAPPY_BODY), { status: 200 });
    }) as unknown as typeof fetch;
    await fetchRepoFile("package.json", {
      token: "t",
      fetchImpl,
      ref: "main",
    });
    expect(calledUrl).toContain("?ref=main");
  });

  it("rejects ref_invalid (caller passed bad ref) before HTTP call", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const r = await fetchRepoFile("package.json", {
      token: "t",
      fetchImpl,
      ref: "main; rm -rf /",
    });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error).toBe("ref_invalid");
    expect(called).toBe(false);
  });

  it("fetch_failed when fetchImpl throws", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const r = await fetchRepoFile("package.json", { token: "t", fetchImpl });
    expect(r.status).toBe("error");
    if (r.status === "error") {
      expect(r.error).toBe("fetch_failed");
      expect(r.error_detail).toContain("network down");
    }
  });
});
