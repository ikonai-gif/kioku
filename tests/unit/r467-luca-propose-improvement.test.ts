/**
 * R467 — luca_propose_improvement unit tests.
 *
 * Coverage:
 *   - validateProposalInput:
 *       missing_title (null, non-object, missing, empty, whitespace, non-string)
 *       title_too_long (>200)
 *       missing_body (missing, empty, whitespace)
 *       body_too_long (>8000)
 *       invalid_category (missing, unknown, non-string)
 *       invalid_chars (NUL in title, NUL in body)
 *       happy path (trims title, preserves body markdown)
 *   - createProposal:
 *       happy path with mock dbImpl returning row
 *       db_error when dbImpl throws
 *       db_error when dbImpl returns []
 *       agentId=null pass-through
 *       validation errors short-circuit before DB call
 */
import { describe, it, expect, vi } from "vitest";
import {
  validateProposalInput,
  createProposal,
} from "../../server/lib/luca-tools/propose-improvement";

const baseGood = {
  title: "Add luca_recall_context tool",
  body: "Grounded in server/deliberation.ts sha=abc123. Currently...",
  category: "tool" as const,
};

describe("validateProposalInput — title", () => {
  it("rejects null / non-object", () => {
    expect(validateProposalInput(null).ok).toBe(false);
    expect(validateProposalInput(undefined).ok).toBe(false);
    expect(validateProposalInput("string").ok).toBe(false);
    expect(validateProposalInput(42).ok).toBe(false);
  });

  it("rejects missing title", () => {
    const r = validateProposalInput({ body: "x", category: "tool" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("missing_title");
  });

  it("rejects empty / whitespace title", () => {
    for (const t of ["", "   ", "\t\n  "]) {
      const r = validateProposalInput({ title: t, body: "ok", category: "tool" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe("missing_title");
    }
  });

  it("rejects non-string title", () => {
    const r = validateProposalInput({ title: 42, body: "ok", category: "tool" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("missing_title");
  });

  it("rejects title > 200 chars (after trim)", () => {
    const t = "a".repeat(201);
    const r = validateProposalInput({ title: t, body: "ok", category: "tool" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("title_too_long");
  });

  it("accepts exactly 200-char title", () => {
    const t = "a".repeat(200);
    const r = validateProposalInput({ title: t, body: "ok", category: "tool" });
    expect(r.ok).toBe(true);
  });

  it("trims surrounding whitespace from title", () => {
    const r = validateProposalInput({ title: "  hello  ", body: "ok", category: "tool" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.title).toBe("hello");
  });
});

describe("validateProposalInput — body", () => {
  it("rejects missing body", () => {
    const r = validateProposalInput({ title: "t", category: "tool" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("missing_body");
  });

  it("rejects empty / whitespace body", () => {
    for (const b of ["", "   ", "\n\n\n"]) {
      const r = validateProposalInput({ title: "t", body: b, category: "tool" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe("missing_body");
    }
  });

  it("rejects body > 8000 chars", () => {
    const b = "x".repeat(8001);
    const r = validateProposalInput({ title: "t", body: b, category: "tool" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("body_too_long");
  });

  it("accepts exactly 8000-char body", () => {
    const b = "x".repeat(8000);
    const r = validateProposalInput({ title: "t", body: b, category: "tool" });
    expect(r.ok).toBe(true);
  });

  it("preserves markdown indentation in body (does NOT trim)", () => {
    const body = "  - item\n  - item2\n```js\ncode\n```";
    const r = validateProposalInput({ title: "t", body, category: "tool" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.body).toBe(body);
  });
});

describe("validateProposalInput — category", () => {
  it("accepts all five valid categories", () => {
    for (const c of ["tool", "prompt", "memory", "process", "other"]) {
      const r = validateProposalInput({ title: "t", body: "b", category: c });
      expect(r.ok).toBe(true);
    }
  });

  it("rejects unknown category", () => {
    const r = validateProposalInput({ title: "t", body: "b", category: "feature" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("invalid_category");
  });

  it("rejects missing / non-string category", () => {
    expect(validateProposalInput({ title: "t", body: "b" }).ok).toBe(false);
    expect(validateProposalInput({ title: "t", body: "b", category: 1 }).ok).toBe(false);
  });
});

describe("validateProposalInput — invalid_chars", () => {
  it("rejects NUL in title", () => {
    const r = validateProposalInput({ title: "ab\0c", body: "ok", category: "tool" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("invalid_chars");
  });

  it("rejects NUL in body", () => {
    const r = validateProposalInput({ title: "t", body: "ok\0bad", category: "tool" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("invalid_chars");
  });
});

// --- createProposal ---

function mockDbInsertReturning(returnedRows: any[]) {
  const returning = vi.fn(async () => returnedRows);
  const values = vi.fn(() => ({ returning }));
  const insert = vi.fn(() => ({ values }));
  return { insert, _values: values, _returning: returning };
}

function mockDbInsertThrows(message: string) {
  const insert = vi.fn(() => {
    throw new Error(message);
  });
  return { insert };
}

describe("createProposal", () => {
  it("happy path returns ok with proposal_id", async () => {
    const created = new Date("2026-05-04T20:00:00Z");
    const dbImpl = mockDbInsertReturning([
      { id: 42, title: baseGood.title, category: baseGood.category, createdAt: created },
    ]);
    const result = await createProposal({
      userId: 1,
      agentId: 7,
      input: baseGood,
      dbImpl: dbImpl as any,
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.proposal_id).toBe(42);
      expect(result.title).toBe(baseGood.title);
      expect(result.category).toBe("tool");
      expect(result.created_at).toBe(created.toISOString());
    }
    expect(dbImpl.insert).toHaveBeenCalledTimes(1);
  });

  it("validation error short-circuits before DB call", async () => {
    const dbImpl = mockDbInsertReturning([]);
    const result = await createProposal({
      userId: 1,
      agentId: null,
      input: { title: "", body: "", category: "tool" },
      dbImpl: dbImpl as any,
    });
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error).toBe("missing_title");
    expect(dbImpl.insert).not.toHaveBeenCalled();
  });

  it("agentId=null is passed through unchanged", async () => {
    const created = new Date();
    const dbImpl = mockDbInsertReturning([
      { id: 1, title: baseGood.title, category: "tool", createdAt: created },
    ]);
    const result = await createProposal({
      userId: 1,
      agentId: null,
      input: baseGood,
      dbImpl: dbImpl as any,
    });
    expect(result.status).toBe("ok");
    expect(dbImpl._values).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: null, userId: 1 }),
    );
  });

  it("returns db_error when DB throws", async () => {
    const dbImpl = mockDbInsertThrows("connection refused");
    const result = await createProposal({
      userId: 1,
      agentId: 1,
      input: baseGood,
      dbImpl: dbImpl as any,
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toBe("db_error");
      expect(result.error_detail).toContain("connection refused");
    }
  });

  it("returns db_error when no row is returned", async () => {
    const dbImpl = mockDbInsertReturning([]);
    const result = await createProposal({
      userId: 1,
      agentId: 1,
      input: baseGood,
      dbImpl: dbImpl as any,
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toBe("db_error");
      expect(result.error_detail).toBe("no_returning_row");
    }
  });

  it("error_detail is truncated to 240 chars on DB error", async () => {
    const long = "x".repeat(500);
    const dbImpl = mockDbInsertThrows(long);
    const result = await createProposal({
      userId: 1,
      agentId: 1,
      input: baseGood,
      dbImpl: dbImpl as any,
    });
    expect(result.status).toBe("error");
    if (result.status === "error" && result.error_detail) {
      expect(result.error_detail.length).toBeLessThanOrEqual(240);
    }
  });
});
