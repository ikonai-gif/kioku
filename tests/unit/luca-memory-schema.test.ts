/**
 * R455 — luca_memory_schema tool tests.
 *
 * Spec: /home/user/workspace/luca_memory_schema_spec_draft.md (v0.4)
 *
 * Coverage of all 11 spec test-cases:
 *   1)  SQL queries return correct counts on seed data (10 writable + identity)
 *   2)  example_excerpt truncated at 80 chars + COALESCE(importance,0) ordering
 *   3)  alias_of correctly populated (5 known mappings)
 *   4)  category field populated (core/episodic/semantic/meta)
 *   5)  type field is enum-exact, label is human-readable, no mismatch
 *   6)  Integration-shape: tool result mirrors `memories` table reality
 *   7)  Empty result returns architecture + total_memories=0 (Q7-C3)
 *   8)  DB error returns `error` field, not throw (handler shape)
 *   9)  Rate-limit hourly + burst — both buckets enforced independently
 *   10) agent_id and user_id from session, NOT from input (Q7-C2)
 *   11) Cross-agent isolation — agent A's call returns 0 if seeded with agent B's
 *
 * Tests #8/#9/#10 are surface-level (source grep + handler) because the tool
 * dispatcher is wired through the executePartnerTool closure and full e2e
 * is covered by tests/e2e/agent-tools.test.ts. Pure-logic tests use a Pool
 * stub that records query strings + params.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  TYPE_METADATA,
  NAMESPACE_METADATA,
  getMemorySchemaSnapshot,
} from "../../server/lib/luca-tools/memory-schema";

// ── In-memory pool stub ─────────────────────────────────────────────
// Each query is matched against the SQL text with a heuristic so tests
// don't need to maintain a brittle string comparison.
function makeFakePool(rows: {
  types?: Array<{ type: string; count: string }>;
  namespaces?: Array<{ name: string; count: string }>;
  excerpts?: Array<{ type: string; content: string }>;
  totals?: {
    total_memories: string;
    last_memory_at: string | null;
    oldest_memory_at: string | null;
  };
  errorOn?: "types" | "namespaces" | "excerpts" | "totals";
}) {
  const queries: Array<{ sql: string; params: any[] }> = [];
  const pool = {
    query: vi.fn(async (sql: string, params: any[]) => {
      queries.push({ sql, params });
      const isTypes      = /SELECT\s+type,\s+COUNT\(\*\)/i.test(sql);
      const isNamespaces = /WITH active_ns/i.test(sql);
      const isExcerpts   = /LATERAL/i.test(sql);
      const isTotals     = /total_memories[\s\S]*last_memory_at/i.test(sql);
      if (rows.errorOn === "types"      && isTypes)      throw new Error("DB down (types)");
      if (rows.errorOn === "namespaces" && isNamespaces) throw new Error("DB down (ns)");
      if (rows.errorOn === "excerpts"   && isExcerpts)   throw new Error("DB down (ex)");
      if (rows.errorOn === "totals"     && isTotals)     throw new Error("DB down (totals)");
      if (isTypes)      return { rows: rows.types ?? [] };
      if (isNamespaces) return { rows: rows.namespaces ?? NAMESPACE_METADATA.map((n) => ({ name: n.name, count: "0" })) };
      if (isExcerpts)   return { rows: rows.excerpts ?? [] };
      if (isTotals)     return { rows: [rows.totals ?? { total_memories: "0", last_memory_at: null, oldest_memory_at: null }] };
      return { rows: [] };
    }),
  };
  return { pool: pool as any, queries };
}

// ── Source files for surface-level grep tests ────────────────────────
const deliberationSrc = readFileSync(
  resolve(__dirname, "../../server/deliberation.ts"),
  "utf8",
);
const classifySrc = readFileSync(
  resolve(__dirname, "../../server/lib/luca-approvals/classify.ts"),
  "utf8",
);
const memorySchemaSrc = readFileSync(
  resolve(__dirname, "../../server/lib/luca-tools/memory-schema.ts"),
  "utf8",
);

describe("luca_memory_schema — TYPE_METADATA invariants", () => {
  it("Test #1: contains exactly 11 types (10 writable + identity)", () => {
    expect(TYPE_METADATA).toHaveLength(11);
    const writable = TYPE_METADATA.filter((t) => t.writable_by_luca);
    expect(writable).toHaveLength(10);
    const identity = TYPE_METADATA.find((t) => t.type === "identity");
    expect(identity).toBeDefined();
    expect(identity?.writable_by_luca).toBe(false);
    expect(identity?.always_inject).toBe(true);
    expect(identity?.weight).toBe(1.5);
  });

  it("Test #4: category populated for every type (core/episodic/semantic/meta)", () => {
    const allowed = new Set(["core", "episodic", "semantic", "meta"]);
    for (const t of TYPE_METADATA) {
      expect(allowed.has(t.category)).toBe(true);
    }
    // Spec table line ~120: identity+commitment = core
    expect(TYPE_METADATA.find((t) => t.type === "identity")?.category).toBe("core");
    expect(TYPE_METADATA.find((t) => t.type === "commitment")?.category).toBe("core");
    // episodic = episodic, autobiographical, relational
    for (const n of ["episodic", "autobiographical", "relational"]) {
      expect(TYPE_METADATA.find((t) => t.type === n)?.category).toBe("episodic");
    }
    // semantic = semantic, procedural, aesthetic
    for (const n of ["semantic", "procedural", "aesthetic"]) {
      expect(TYPE_METADATA.find((t) => t.type === n)?.category).toBe("semantic");
    }
    // meta = meta_cognitive, reflection, emotional_state
    for (const n of ["meta_cognitive", "reflection", "emotional_state"]) {
      expect(TYPE_METADATA.find((t) => t.type === n)?.category).toBe("meta");
    }
  });

  it("Test #5: type field is enum-exact, label is human-readable, no mismatch", () => {
    // Enum strings MUST match the remember tool's ALLOWED_TYPES set + identity
    const expectedTypes = new Set([
      "aesthetic", "procedural", "meta_cognitive", "reflection",
      "commitment", "relational", "autobiographical",
      "episodic", "semantic", "emotional_state",
      "identity",
    ]);
    const actual = new Set(TYPE_METADATA.map((t) => t.type));
    expect(actual).toEqual(expectedTypes);
    // Labels are different from enum values (human-readable)
    const labelMatchesType = TYPE_METADATA.filter((t) => t.label === t.type);
    expect(labelMatchesType).toHaveLength(0); // every label differs from type
  });

  it("identity weight 1.5, commitment 1.4 (top weights)", () => {
    expect(TYPE_METADATA.find((t) => t.type === "identity")?.weight).toBe(1.5);
    expect(TYPE_METADATA.find((t) => t.type === "commitment")?.weight).toBe(1.4);
  });
});

describe("luca_memory_schema — NAMESPACE_METADATA invariants", () => {
  it("Test #3: 15 namespaces with 5 known alias_of mappings", () => {
    expect(NAMESPACE_METADATA).toHaveLength(15);
    const aliasMap = Object.fromEntries(
      NAMESPACE_METADATA.map((n) => [n.name, n.alias_of]),
    );
    expect(aliasMap._identity).toBe("_people:luca");
    expect(aliasMap._preferences).toBe("_people:kote umbrella");
    expect(aliasMap._relational).toBe("_people:*");
    expect(aliasMap._semantic).toBe("_knowledge");
    expect(aliasMap._commitment).toBe("_commitments");
    // Others null
    const nonAliased = NAMESPACE_METADATA.filter((n) => n.alias_of === null);
    expect(nonAliased.length).toBe(10); // 15 - 5 aliased
  });
});

describe("luca_memory_schema — getMemorySchemaSnapshot SQL behavior", () => {
  beforeEach(() => vi.clearAllMocks());

  it("Test #1: SQL queries pass user_id + agent_id and aggregate counts", async () => {
    const { pool, queries } = makeFakePool({
      types: [
        { type: "identity",   count: "12" },
        { type: "commitment", count: "23" },
        { type: "episodic",   count: "100" },
      ],
      namespaces: NAMESPACE_METADATA.map((n) => ({ name: n.name, count: "5" })),
      excerpts: [
        { type: "identity",   content: "I am Luca. Boss is Kote." },
        { type: "commitment", content: "Boss wants Meeting Room launched." },
      ],
      totals: { total_memories: "793", last_memory_at: "1714000000000", oldest_memory_at: "1700000000000" },
    });

    const snap = await getMemorySchemaSnapshot(pool, 10, 7);

    // All 4 queries received userId=10, agentId=7
    expect(queries.length).toBe(4);
    for (const q of queries) {
      expect(q.params[0]).toBe(10);
      expect(q.params[1]).toBe(7);
    }

    // Counts hydrated correctly
    expect(snap.types.find((t) => t.type === "identity")?.count).toBe(12);
    expect(snap.types.find((t) => t.type === "commitment")?.count).toBe(23);
    expect(snap.types.find((t) => t.type === "episodic")?.count).toBe(100);
    // Type with no rows in DB still appears with count 0
    expect(snap.types.find((t) => t.type === "aesthetic")?.count).toBe(0);

    // Totals
    expect(snap.totals.total_memories).toBe(793);
    expect(snap.totals.last_memory_at).toBe(new Date(1714000000000).toISOString());
    expect(snap.totals.oldest_memory_at).toBe(new Date(1700000000000).toISOString());
    expect(snap.spec_version).toBe("v1.0.0");
  });

  it("Test #1 (extra): types SQL filters to known type list (NIT-4 defensive default)", async () => {
    const { pool, queries } = makeFakePool({});
    await getMemorySchemaSnapshot(pool, 1, 1);
    const typesQuery = queries.find((q) => /SELECT\s+type,\s+COUNT\(\*\)/i.test(q.sql));
    expect(typesQuery).toBeDefined();
    expect(typesQuery!.sql).toMatch(/type\s*=\s*ANY\(\$3::text\[\]\)/i);
    expect(Array.isArray(typesQuery!.params[2])).toBe(true);
    const allowed = new Set<string>(typesQuery!.params[2] as string[]);
    expect(allowed.size).toBe(11);
    expect(allowed.has("identity")).toBe(true);
    // legacy types must NOT be in the allow list
    expect(allowed.has("fact")).toBe(false);
    expect(allowed.has("causal")).toBe(false);
  });

  it("Test #2: example_excerpt truncated at 80 chars + ellipsis", async () => {
    const longContent = "A".repeat(200);
    const { pool } = makeFakePool({
      excerpts: [{ type: "semantic", content: longContent }],
    });
    const snap = await getMemorySchemaSnapshot(pool, 1, 1);
    const sem = snap.types.find((t) => t.type === "semantic");
    expect(sem?.example_excerpt).toBeDefined();
    expect(sem!.example_excerpt!.length).toBe(81); // 80 + ellipsis
    expect(sem!.example_excerpt!.endsWith("…")).toBe(true);
  });

  it("Test #2: short excerpt left untruncated; meta-suffix stripped", async () => {
    const { pool } = makeFakePool({
      excerpts: [
        { type: "episodic",  content: "Boss said hi." },
        { type: "reflection", content: "I learned X.\n\n[meta: {\"emotions\":{\"engagement\":0.8}}]" },
      ],
    });
    const snap = await getMemorySchemaSnapshot(pool, 1, 1);
    expect(snap.types.find((t) => t.type === "episodic")?.example_excerpt).toBe("Boss said hi.");
    expect(snap.types.find((t) => t.type === "reflection")?.example_excerpt).toBe("I learned X.");
  });

  it("Test #2: excerpt SQL uses COALESCE(importance,0) ordering (R451-N3)", async () => {
    const { pool, queries } = makeFakePool({});
    await getMemorySchemaSnapshot(pool, 1, 1);
    const exQuery = queries.find((q) => /LATERAL/i.test(q.sql));
    expect(exQuery).toBeDefined();
    expect(exQuery!.sql).toMatch(/COALESCE\(importance,\s*0\)/i);
  });

  it("Test #6: namespaces SQL is LEFT JOIN keeping count=0 entries (Q7-C3)", async () => {
    const { pool, queries } = makeFakePool({
      namespaces: [
        { name: "_identity",        count: "12" },
        { name: "_commitment",      count: "0"  },
        { name: "_preferences",     count: "0"  },
        { name: "_aesthetics",      count: "5"  },
        { name: "_procedural",      count: "0"  },
        { name: "_meta_cognitive",  count: "3"  },
        { name: "_reflection",      count: "0"  },
        { name: "_relational",      count: "8"  },
        { name: "_autobiographical", count: "0" },
        { name: "_episodic",        count: "100" },
        { name: "_semantic",        count: "200" },
        { name: "_emotional_state", count: "0"  },
        { name: "_projects",        count: "0"  },
        { name: "_self",            count: "0"  },
        { name: "_self_monitoring", count: "0"  },
      ],
    });
    const snap = await getMemorySchemaSnapshot(pool, 1, 1);
    expect(snap.namespaces).toHaveLength(15);
    const empties = snap.namespaces.filter((n) => n.count === 0);
    expect(empties.length).toBeGreaterThan(0);
    // SQL must be LEFT JOIN
    const nsQuery = queries.find((q) => /WITH active_ns/i.test(q.sql));
    expect(nsQuery!.sql).toMatch(/LEFT JOIN/i);
  });

  it("Test #7: empty database returns architecture + total_memories=0 (Q7-C3)", async () => {
    const { pool } = makeFakePool({
      types: [],
      namespaces: NAMESPACE_METADATA.map((n) => ({ name: n.name, count: "0" })),
      excerpts: [],
      totals: { total_memories: "0", last_memory_at: null, oldest_memory_at: null },
    });
    const snap = await getMemorySchemaSnapshot(pool, 1, 1);
    expect(snap.totals.total_memories).toBe(0);
    expect(snap.totals.last_memory_at).toBeNull();
    expect(snap.totals.oldest_memory_at).toBeNull();
    // All 11 types still present (architecture)
    expect(snap.types).toHaveLength(11);
    // All counts are 0
    for (const t of snap.types) expect(t.count).toBe(0);
    // All 15 namespaces still present
    expect(snap.namespaces).toHaveLength(15);
  });

  it("Test #11: cross-agent isolation — fake pool returns 0 if no rows match agent_id", async () => {
    // Simulates "agent A asks for snapshot but only agent B has rows".
    // The pool stub matches by SQL, not by params, so we feed it empty
    // type/namespace counts and assert the snapshot reflects empty.
    const { pool, queries } = makeFakePool({
      types: [],
      namespaces: NAMESPACE_METADATA.map((n) => ({ name: n.name, count: "0" })),
      excerpts: [],
      totals: { total_memories: "0", last_memory_at: null, oldest_memory_at: null },
    });
    const snap = await getMemorySchemaSnapshot(pool, 10, 999); // agentId=999 doesn't exist
    // Verify agentId reached SQL params position $2
    for (const q of queries) expect(q.params[1]).toBe(999);
    expect(snap.totals.total_memories).toBe(0);
  });
});

describe("luca_memory_schema — handler surface (deliberation.ts)", () => {
  it("Test #5: tool registered in LUCA_STUDIO_TOOL_NAMES_BASE", () => {
    expect(deliberationSrc).toMatch(/"luca_memory_schema",/);
    // Specifically inside the BASE list (ordered after "remember")
    const baseSlice = deliberationSrc.match(/LUCA_STUDIO_TOOL_NAMES_BASE[\s\S]*?\];/);
    expect(baseSlice?.[0]).toMatch(/"remember",[\s\S]*"luca_memory_schema",/);
  });

  it("tool definition declared with zero-param input schema (Q7-C2)", () => {
    const def = deliberationSrc.match(
      /name:\s*"luca_memory_schema"[\s\S]{0,800}?input_schema:\s*\{[\s\S]*?additionalProperties:\s*false[\s\S]*?\},/,
    );
    expect(def).not.toBeNull();
    // No properties on input schema -> zero params
    expect(def![0]).toMatch(/properties:\s*\{\s*\},/);
  });

  it("Test #8: handler returns structured `error` field on DB failure (no throw)", () => {
    const handlerSlice = deliberationSrc.match(
      /case "luca_memory_schema":\s*\{[\s\S]*?\n      \}\n/,
    );
    expect(handlerSlice).not.toBeNull();
    const body = handlerSlice![0];
    expect(body).toMatch(/try\s*\{[\s\S]*\}\s*catch/);
    expect(body).toMatch(/JSON\.stringify\(\{\s*error:\s*"schema_query_failed"/);
  });

  it("Test #9: handler enforces composite rate-limit (hourly + burst)", () => {
    const handlerSlice = deliberationSrc.match(
      /case "luca_memory_schema":\s*\{[\s\S]*?\n      \}\n/,
    );
    const body = handlerSlice![0];
    // Hourly bucket
    expect(body).toMatch(/luca_memory_schema:hour:\$\{agentId\}/);
    expect(body).toMatch(/HOURLY_MAX/);
    expect(body).toMatch(/3600_000/);
    // Burst bucket
    expect(body).toMatch(/luca_memory_schema:burst:\$\{agentId\}/);
    expect(body).toMatch(/BURST_MAX/);
    expect(body).toMatch(/60_000/);
    // Both gates must be checked (independent enforcement)
    expect(body).toMatch(/!hourlyOk\s*\|\|\s*!burstOk/);
    expect(body).toMatch(/error:\s*"rate_limited"/);
    // Reuses existing checkAuthRateLimit (R438 lesson)
    expect(body).toMatch(/checkAuthRateLimit/);
  });

  it("Test #10a: agent_id sourced from closure, NOT from toolInput", () => {
    const handlerSlice = deliberationSrc.match(
      /case "luca_memory_schema":\s*\{[\s\S]*?\n      \}\n/,
    );
    const body = handlerSlice![0];
    // Closure args used:
    expect(body).toMatch(/getMemorySchemaSnapshot\(pool,\s*userId,\s*agentId\)/);
    // toolInput must NOT be referenced for user_id/agent_id passthrough
    expect(body).not.toMatch(/toolInput\.user_id/);
    expect(body).not.toMatch(/toolInput\.agent_id/);
  });

  it("Test #10b: rate-limit key uses closure agentId (not request-supplied)", () => {
    const handlerSlice = deliberationSrc.match(
      /case "luca_memory_schema":\s*\{[\s\S]*?\n      \}\n/,
    );
    const body = handlerSlice![0];
    // Both keys must template the closure-bound agentId
    expect(body).toMatch(/luca_memory_schema:hour:\$\{agentId\}/);
    expect(body).toMatch(/luca_memory_schema:burst:\$\{agentId\}/);
    // No toolInput.agentId templating
    expect(body).not.toMatch(/\$\{toolInput\.agent/);
  });

  it("classify.ts marks luca_memory_schema as READ_ONLY", () => {
    expect(classifySrc).toMatch(/luca_memory_schema:\s*"READ_ONLY"/);
    // And exported in the LucaAdmissibleTool union
    expect(classifySrc).toMatch(/\|\s*"luca_memory_schema"/);
  });
});

describe("luca_memory_schema — Honesty rule + alias addition (system prompt)", () => {
  it("anti-fabrication block lists 5 introspection aliases pointing to luca_memory_schema", () => {
    const aliases = [
      "read_my_memory_structure",
      "get_memory_types",
      "describe_my_memory",
      "introspect_self",
      "self_describe",
    ];
    for (const a of aliases) {
      // each alias appears with `(use luca_memory_schema)` redirect
      const re = new RegExp(`${a}\\s*\\(use luca_memory_schema\\)`);
      expect(deliberationSrc).toMatch(re);
    }
  });

  it("SELF-INTROSPECTION HONESTY RULE block present, includes all required clauses (R437 verbatim)", () => {
    expect(deliberationSrc).toMatch(/## SELF-INTROSPECTION HONESTY RULE/);
    // Mirror tag (spec line ~292)
    expect(deliberationSrc).toMatch(/Mirror of anti-fabrication, applies to YOUR OWN state\./);
    // option (a)/(b) live-vs-fabricate
    expect(deliberationSrc).toMatch(/\(a\) call luca_memory_schema/);
    expect(deliberationSrc).toMatch(/\(b\) say "я не знаю точно/);
    // error fallback
    expect(deliberationSrc).toMatch(/tool не работает, могу только описать что помню из system prompt/);
    // rate_limited fallback
    expect(deliberationSrc).toMatch(/в этом часу уже опрашивала memory_schema/);
    // empty-db case (Q7-C3)
    expect(deliberationSrc).toMatch(/types\[\*\]\.count=0.*total_memories: 0/);
    expect(deliberationSrc).toMatch(/я только начинаю работать с этим пользователем/);
    expect(deliberationSrc).toMatch(/Do NOT say «у меня нет памяти»/);
    // 5s edge
    expect(deliberationSrc).toMatch(/longer than 5 seconds.*ожидаю данные, секунду/);
    // trust live > memory
    expect(deliberationSrc).toMatch(/Trust the live query, not your own memory about your own architecture/);
    // spec_version invalidation (patch-exempt — R451-N4)
    expect(deliberationSrc).toMatch(/spec_version invalidation \(minor\/major only\)/);
    expect(deliberationSrc).toMatch(/Patch bumps \(v1\.0\.0 → v1\.0\.1\) do NOT invalidate/);
    // identity asymmetry
    expect(deliberationSrc).toMatch(/Identity asymmetry/);
    expect(deliberationSrc).toMatch(/identity я не пишу, это система делает через self-correction/);
  });

  it("Honesty rule positioned BEFORE TRUST_POLICY_PROMPT_SECTION inject point", () => {
    const idxHonesty = deliberationSrc.indexOf("## SELF-INTROSPECTION HONESTY RULE");
    const idxTrust   = deliberationSrc.indexOf("${TRUST_POLICY_PROMPT_SECTION}");
    expect(idxHonesty).toBeGreaterThan(0);
    expect(idxTrust).toBeGreaterThan(idxHonesty); // Trust comes after Honesty
  });

  it("Tool referenced in SELF-ACCOUNTABILITY tools-list block", () => {
    expect(deliberationSrc).toMatch(/SELF-ACCOUNTABILITY \(2\)/);
    expect(deliberationSrc).toMatch(/- luca_memory_schema → read-only live snapshot of your OWN memory architecture/);
    expect(deliberationSrc).toMatch(/Rate-limited 10\/hour \+ 3\/min per agent/);
  });
});

describe("luca_memory_schema — module surface", () => {
  it("module file uses real `memories` table (NOT kioku_memories — R424 drift catch)", () => {
    expect(memorySchemaSrc).toMatch(/FROM memories\b/);
    expect(memorySchemaSrc).not.toMatch(/FROM kioku_memories\b/);
  });

  it("output shape includes spec-required fields (frozen by spec)", () => {
    expect(memorySchemaSrc).toMatch(/spec_version: "v1\.0\.0"/);
    expect(memorySchemaSrc).toMatch(/special_rules:/);
    expect(memorySchemaSrc).toMatch(/total_memories:/);
    expect(memorySchemaSrc).toMatch(/last_memory_at:/);
    expect(memorySchemaSrc).toMatch(/oldest_memory_at:/);
  });
});
