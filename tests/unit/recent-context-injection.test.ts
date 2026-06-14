/**
 * R474 — 30d PROJECT_CONTEXT injection (smoke).
 *
 * Verifies:
 *   1) buildRecentContextBlock formats 3 fake memories with the expected
 *      header and content lines.
 *   2) Empty result → empty string (no header leak, no throw).
 *   3) SQL filters match spec: types in (commitment, procedural, semantic,
 *      episodic, reflection), namespace _projects, 720h window,
 *      importance >= 0.85, limit 15.
 *   4) buildPartnerPrompt renders the block AHEAD of "## CORE IDENTITY" so
 *      recent context is closest to the user message.
 */

import { describe, it, expect } from "vitest";
import {
  buildPartnerPrompt,
  buildRecentContextBlock,
} from "../../server/deliberation.js";

function makeFakePool(rows: any[]) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  return {
    query: async (sql: string, params: any[]) => {
      calls.push({ sql, params });
      return { rows };
    },
    _calls: calls,
  };
}

describe("R474 — buildRecentContextBlock", () => {
  it("renders header + 3 content lines for 3 memories", async () => {
    const pool = makeFakePool([
      { id: 1, type: "commitment", namespace: "_projects", importance: 0.95, content: "Ship Luca memory modernization PR by Friday", created_at: Date.now() },
      { id: 2, type: "procedural", namespace: "_projects", importance: 0.90, content: "Always run preflight SELECT before DELETE on Supabase", created_at: Date.now() },
      { id: 3, type: "commitment", namespace: "_projects", importance: 0.85, content: "Reply to BRO1 in Meeting Room within 4 hours of tag", created_at: Date.now() },
    ]);
    const block = await buildRecentContextBlock(pool, 10, 16);
    expect(block).toContain("[PROJECT_CONTEXT — last 30d]");
    expect(block).toContain("Ship Luca memory modernization PR by Friday");
    expect(block).toContain("Always run preflight SELECT before DELETE on Supabase");
    expect(block).toContain("Reply to BRO1 in Meeting Room within 4 hours of tag");
    expect(block).toContain("(importance: 0.95, type: commitment)");
  });

  it("returns '' on zero rows (no header leak, no throw)", async () => {
    const pool = makeFakePool([]);
    const block = await buildRecentContextBlock(pool, 10, 16);
    expect(block).toBe("");
  });

  it("SQL binds spec filters: types, namespace, importance, 48h, limit", async () => {
    const pool = makeFakePool([]);
    await buildRecentContextBlock(pool, 10, 16);
    expect(pool._calls).toHaveLength(1);
    const { sql, params } = pool._calls[0];
    expect(sql).toMatch(/FROM\s+memories/);
    expect(sql).toMatch(/namespace\s*=\s*\$3/);
    expect(sql).toMatch(/type\s*=\s*ANY\(\$4::text\[\]\)/);
    expect(sql).toMatch(/importance\s*>=\s*\$5/);
    expect(sql).toMatch(/created_at\s*>=\s*\$6/);
    expect(sql).toMatch(/LIMIT\s+\$7/);
    // params: [userId, agentId, NAMESPACE, TYPES, IMPORTANCE_MIN, sinceMs, LIMIT]
    expect(params[0]).toBe(10);
    expect(params[1]).toBe(16);
    expect(params[2]).toBe("_projects");
    expect(params[3]).toEqual(["commitment", "procedural", "semantic", "episodic", "reflection"]);
    expect(params[4]).toBe(0.85);
    // sinceMs ≈ now - 720h (allow 5s drift for slow CI)
    const expected = Date.now() - 720 * 3600 * 1000;
    expect(Math.abs(params[5] - expected)).toBeLessThan(5000);
    expect(params[6]).toBe(15);
  });
});

describe("R474 — buildPartnerPrompt ordering", () => {
  it("renders recentContextBlock AHEAD of coreIdentityBlock in the dynamic half", () => {
    const recent = "[PROJECT_CONTEXT — last 30d]\n- fresh project note (importance: 0.90, type: commitment)\n";
    const core = "## CORE IDENTITY (ground truth every turn — overrides any retrieved memory)\nagent_id=16 | name=Luca\n";
    const prompt = buildPartnerPrompt(
      "Luca",
      "",
      "## WHO YOU ARE\nYou are Luca.\n",
      null,
      null,
      undefined,
      [],
      [],
      [],
      "",
      core,
      recent,
    );
    const recentIdx = prompt.indexOf("[PROJECT_CONTEXT — last 30d]");
    const coreIdx = prompt.indexOf("## CORE IDENTITY");
    expect(recentIdx).toBeGreaterThan(-1);
    expect(coreIdx).toBeGreaterThan(-1);
    expect(recentIdx).toBeLessThan(coreIdx);
    expect(prompt).toContain("fresh project note");
  });

  it("omits the block cleanly when not provided (no undefined leak)", () => {
    const prompt = buildPartnerPrompt("Luca", "", "## WHO YOU ARE\nYou are Luca.\n");
    expect(prompt).not.toContain("undefined");
    expect(prompt).not.toContain("[PROJECT_CONTEXT");
  });
});
