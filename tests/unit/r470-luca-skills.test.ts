/**
 * R470 — luca_list_skills + luca_get_skill unit tests.
 *
 * Coverage:
 *   - validateListSkillsInput:
 *       null / undefined / non-object → ok with category=null
 *       category missing → null
 *       category empty / whitespace → null
 *       category non-string → null (defensive)
 *       category > 32 chars → category_too_long
 *       category with NUL → invalid_chars
 *       happy path (trims category)
 *   - listSkills:
 *       happy path with mock dbImpl returning rows (no filter, with filter)
 *       db_error when dbImpl throws
 *       prompt_template is NEVER returned in summaries
 *       row cap of 200 is passed to .limit()
 *   - validateGetSkillInput:
 *       null / non-object / missing → missing_name
 *       empty / whitespace name → missing_name
 *       non-string name → missing_name
 *       name > 64 chars → name_too_long
 *       NUL in name → invalid_chars
 *       happy path (trims name)
 *   - getSkill:
 *       happy path returns full prompt_template
 *       not_found when dbImpl returns []
 *       db_error when dbImpl throws
 *       validation errors short-circuit before DB
 */
import { describe, it, expect, vi } from "vitest";
import {
  validateListSkillsInput,
  listSkills,
} from "../../server/lib/luca-tools/list-skills";
import {
  validateGetSkillInput,
  getSkill,
} from "../../server/lib/luca-tools/get-skill";

// ─── validateListSkillsInput ──────────────────────────────────────────

describe("validateListSkillsInput", () => {
  it("returns ok with category=null for null / undefined / non-object", () => {
    for (const v of [null, undefined, "x", 42, true]) {
      const r = validateListSkillsInput(v);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.category).toBeNull();
    }
  });

  it("treats missing / null category as no filter", () => {
    expect(validateListSkillsInput({}).ok).toBe(true);
    const r = validateListSkillsInput({ category: null });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.category).toBeNull();
  });

  it("treats empty / whitespace category as no filter", () => {
    for (const c of ["", "   ", "\t\n"]) {
      const r = validateListSkillsInput({ category: c });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.category).toBeNull();
    }
  });

  it("treats non-string category as no filter (defensive)", () => {
    const r = validateListSkillsInput({ category: 42 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.category).toBeNull();
  });

  it("rejects category > 32 chars", () => {
    const c = "a".repeat(33);
    const r = validateListSkillsInput({ category: c });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("category_too_long");
  });

  it("accepts exactly 32-char category", () => {
    const c = "a".repeat(32);
    const r = validateListSkillsInput({ category: c });
    expect(r.ok).toBe(true);
  });

  it("rejects NUL in category", () => {
    const r = validateListSkillsInput({ category: "ab\0c" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("invalid_chars");
  });

  it("trims surrounding whitespace from category", () => {
    const r = validateListSkillsInput({ category: "  outreach  " });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.category).toBe("outreach");
  });
});

// ─── listSkills ───────────────────────────────────────────────────────

function mockDbSelectChain(rows: any[]) {
  const limit = vi.fn(async () => rows);
  const orderBy = vi.fn(() => ({ limit }));
  const where = vi.fn(() => ({ orderBy }));
  // The chain we build allows BOTH .where() and .orderBy() to follow .from().
  const fromChain = {
    where,
    orderBy,
  };
  const from = vi.fn(() => fromChain);
  const select = vi.fn(() => ({ from }));
  return { select, _from: from, _where: where, _orderBy: orderBy, _limit: limit };
}

describe("listSkills", () => {
  it("happy path returns ok with summaries (no category filter)", async () => {
    const dbImpl = mockDbSelectChain([
      { name: "brief_boss", category: "comms", description: "How to brief Boss" },
      { name: "triage_telegram", category: "comms", description: "Triage TG alert" },
    ]);
    const result = await listSkills({ input: {}, dbImpl: dbImpl as any });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.count).toBe(2);
      expect(result.skills).toHaveLength(2);
      expect(result.skills[0].name).toBe("brief_boss");
      // prompt_template MUST NOT leak into summaries
      expect((result.skills[0] as any).prompt_template).toBeUndefined();
    }
    // No category filter → .where() should NOT be called
    expect(dbImpl._where).not.toHaveBeenCalled();
    expect(dbImpl._limit).toHaveBeenCalledWith(200);
  });

  it("with category filter calls .where() once", async () => {
    const dbImpl = mockDbSelectChain([
      { name: "brief_boss", category: "comms", description: "How to brief Boss" },
    ]);
    const result = await listSkills({
      input: { category: "comms" },
      dbImpl: dbImpl as any,
    });
    expect(result.status).toBe("ok");
    expect(dbImpl._where).toHaveBeenCalledTimes(1);
    expect(dbImpl._limit).toHaveBeenCalledWith(200);
  });

  it("validation error short-circuits before DB call", async () => {
    const dbImpl = mockDbSelectChain([]);
    const result = await listSkills({
      input: { category: "x".repeat(33) },
      dbImpl: dbImpl as any,
    });
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error).toBe("category_too_long");
    expect(dbImpl.select).not.toHaveBeenCalled();
  });

  it("returns db_error when DB throws", async () => {
    const dbImpl = {
      select: vi.fn(() => {
        throw new Error("connection refused");
      }),
    };
    const result = await listSkills({ input: {}, dbImpl: dbImpl as any });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toBe("db_error");
      expect(result.error_detail).toContain("connection refused");
    }
  });

  it("returns empty list when DB returns 0 rows", async () => {
    const dbImpl = mockDbSelectChain([]);
    const result = await listSkills({ input: {}, dbImpl: dbImpl as any });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.count).toBe(0);
      expect(result.skills).toEqual([]);
    }
  });
});

// ─── validateGetSkillInput ────────────────────────────────────────────

describe("validateGetSkillInput", () => {
  it("rejects null / non-object", () => {
    for (const v of [null, undefined, "string", 42]) {
      const r = validateGetSkillInput(v);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe("missing_name");
    }
  });

  it("rejects missing name", () => {
    const r = validateGetSkillInput({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("missing_name");
  });

  it("rejects empty / whitespace name", () => {
    for (const n of ["", "   ", "\t\n"]) {
      const r = validateGetSkillInput({ name: n });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe("missing_name");
    }
  });

  it("rejects non-string name", () => {
    const r = validateGetSkillInput({ name: 42 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("missing_name");
  });

  it("rejects name > 64 chars (after trim)", () => {
    const n = "a".repeat(65);
    const r = validateGetSkillInput({ name: n });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("name_too_long");
  });

  it("accepts exactly 64-char name", () => {
    const n = "a".repeat(64);
    const r = validateGetSkillInput({ name: n });
    expect(r.ok).toBe(true);
  });

  it("rejects NUL in name", () => {
    const r = validateGetSkillInput({ name: "ab\0c" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("invalid_chars");
  });

  it("trims surrounding whitespace from name", () => {
    const r = validateGetSkillInput({ name: "  brief_boss  " });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.name).toBe("brief_boss");
  });
});

// ─── getSkill ─────────────────────────────────────────────────────────

function mockDbSelectOne(rows: any[]) {
  const limit = vi.fn(async () => rows);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { select, _where: where, _limit: limit };
}

describe("getSkill", () => {
  it("happy path returns full skill including prompt_template", async () => {
    const created = new Date("2026-05-04T20:00:00Z");
    const dbImpl = mockDbSelectOne([
      {
        name: "brief_boss",
        category: "comms",
        description: "How to brief Boss",
        promptTemplate: "Step 1: be concise. Step 2: cite sources.",
        createdAt: created,
      },
    ]);
    const result = await getSkill({
      input: { name: "brief_boss" },
      dbImpl: dbImpl as any,
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.name).toBe("brief_boss");
      expect(result.category).toBe("comms");
      expect(result.description).toBe("How to brief Boss");
      expect(result.prompt_template).toContain("be concise");
      expect(result.created_at).toBe(created.toISOString());
    }
    expect(dbImpl._limit).toHaveBeenCalledWith(1);
  });

  it("returns not_found when 0 rows", async () => {
    const dbImpl = mockDbSelectOne([]);
    const result = await getSkill({
      input: { name: "nonexistent" },
      dbImpl: dbImpl as any,
    });
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error).toBe("not_found");
  });

  it("validation error short-circuits before DB call", async () => {
    const dbImpl = mockDbSelectOne([]);
    const result = await getSkill({
      input: { name: "" },
      dbImpl: dbImpl as any,
    });
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error).toBe("missing_name");
    expect(dbImpl.select).not.toHaveBeenCalled();
  });

  it("returns db_error when DB throws", async () => {
    const dbImpl = {
      select: vi.fn(() => {
        throw new Error("query timeout");
      }),
    };
    const result = await getSkill({
      input: { name: "brief_boss" },
      dbImpl: dbImpl as any,
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toBe("db_error");
      expect(result.error_detail).toContain("query timeout");
    }
  });

  it("error_detail truncated to 240 chars", async () => {
    const long = "x".repeat(500);
    const dbImpl = {
      select: vi.fn(() => {
        throw new Error(long);
      }),
    };
    const result = await getSkill({
      input: { name: "brief_boss" },
      dbImpl: dbImpl as any,
    });
    expect(result.status).toBe("error");
    if (result.status === "error" && result.error_detail) {
      expect(result.error_detail.length).toBeLessThanOrEqual(240);
    }
  });
});
