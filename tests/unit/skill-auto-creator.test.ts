/**
 * [LUCA-089] Skills PR1 — auto-skill detector unit tests.
 * Deterministic: pool fully mocked, env injected, master flag default OFF.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { __poolQuery } = vi.hoisted(() => ({ __poolQuery: vi.fn() }));

vi.mock("../../server/storage", () => ({ pool: { query: __poolQuery } }));
// [LUCA-091] creator now routes luca_skills ops through withService -- mock it
// transparently so the same query spy observes the calls.
vi.mock("../../server/lib/rls", () => ({
  withService: (fn: (c: { query: typeof __poolQuery }) => unknown) => fn({ query: __poolQuery }),
  withRLS: (_userId: number, fn: (c: { query: typeof __poolQuery }) => unknown) => fn({ query: __poolQuery }),
}));
vi.mock("../../server/logger", () => {
  const l = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logger: l, default: l };
});

import {
  checkToolPatternForSkillCreation,
  skillsAutoCreateEnabled,
  skillAutoThreshold,
} from "../../server/skill-auto-creator";

const ON = { LUCA_SKILLS_AUTO_CREATE: "true" } as NodeJS.ProcessEnv;

beforeEach(() => {
  __poolQuery.mockReset();
});

describe("skill auto-creator flags", () => {
  it("master flag defaults OFF and parses strictly", () => {
    expect(skillsAutoCreateEnabled({} as any)).toBe(false);
    expect(skillsAutoCreateEnabled({ LUCA_SKILLS_AUTO_CREATE: "1" } as any)).toBe(false);
    expect(skillsAutoCreateEnabled({ LUCA_SKILLS_AUTO_CREATE: "true" } as any)).toBe(true);
  });

  it("threshold defaults to 5 and rejects junk", () => {
    expect(skillAutoThreshold({} as any)).toBe(5);
    expect(skillAutoThreshold({ LUCA_SKILL_AUTO_THRESHOLD: "3" } as any)).toBe(3);
    expect(skillAutoThreshold({ LUCA_SKILL_AUTO_THRESHOLD: "-2" } as any)).toBe(5);
    expect(skillAutoThreshold({ LUCA_SKILL_AUTO_THRESHOLD: "abc" } as any)).toBe(5);
  });
});

describe("checkToolPatternForSkillCreation (LUCA-089)", () => {
  it("flag OFF (default) → pure no-op, zero queries", async () => {
    await checkToolPatternForSkillCreation({ userId: 10, agentId: 16, tool: "generate_image" }, {} as any);
    expect(__poolQuery).not.toHaveBeenCalled();
  });

  it("missing context (cron/system paths) → no-op even with flag on", async () => {
    await checkToolPatternForSkillCreation({ userId: null, agentId: 16, tool: "x" }, ON);
    await checkToolPatternForSkillCreation({ userId: 10, agentId: null, tool: "x" }, ON);
    await checkToolPatternForSkillCreation({ userId: 10, agentId: 16, tool: null }, ON);
    expect(__poolQuery).not.toHaveBeenCalled();
  });

  it("below threshold → counts but does not insert", async () => {
    __poolQuery.mockResolvedValueOnce({ rows: [{ cnt: 4 }] });
    await checkToolPatternForSkillCreation({ userId: 10, agentId: 16, tool: "generate_image" }, ON);
    expect(__poolQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = __poolQuery.mock.calls[0];
    expect(String(sql)).toContain("tool_activity_log");
    expect(params[0]).toBe(10);
    expect(params[2]).toBe("generate_image");
    // window bound is BIGINT ms compared against Date.now()-derived value
    expect(typeof params[3]).toBe("number");
  });

  it("at threshold + no existing skill → inserts auto_created pending row", async () => {
    __poolQuery
      .mockResolvedValueOnce({ rows: [{ cnt: 5 }] })   // count
      .mockResolvedValueOnce({ rows: [] })              // existing check
      .mockResolvedValueOnce({ rows: [] });             // insert
    await checkToolPatternForSkillCreation({ userId: 10, agentId: 16, tool: "generate_image" }, ON);
    expect(__poolQuery).toHaveBeenCalledTimes(3);
    const existsSql = String(__poolQuery.mock.calls[1][0]);
    expect(existsSql).toContain("tool_sequence::jsonb @>");
    const [insertSql, insertParams] = __poolQuery.mock.calls[2];
    expect(String(insertSql)).toContain("INSERT INTO luca_skills");
    expect(String(insertSql)).toContain("ON CONFLICT (user_id, name) DO NOTHING");
    expect(insertParams[2]).toBe("auto_generate_image");
    expect(insertParams[5]).toBe(JSON.stringify(["generate_image"]));
    expect(insertParams[6]).toBe(5);
  });

  it("existing skill for the pattern → skips insert", async () => {
    __poolQuery
      .mockResolvedValueOnce({ rows: [{ cnt: 9 }] })
      .mockResolvedValueOnce({ rows: [{ id: 7 }] });
    await checkToolPatternForSkillCreation({ userId: 10, agentId: 16, tool: "generate_image" }, ON);
    expect(__poolQuery).toHaveBeenCalledTimes(2);
  });

  it("skill name is sliced to the VARCHAR(64) budget", async () => {
    const longTool = "t".repeat(80);
    __poolQuery
      .mockResolvedValueOnce({ rows: [{ cnt: 6 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    await checkToolPatternForSkillCreation({ userId: 10, agentId: 16, tool: longTool }, ON);
    const name = __poolQuery.mock.calls[2][1][2];
    expect(name.length).toBe(64);
    expect(name.startsWith("auto_t")).toBe(true);
  });

  it("pool failure is swallowed as non-fatal", async () => {
    __poolQuery.mockRejectedValue(new Error("db down"));
    await expect(
      checkToolPatternForSkillCreation({ userId: 10, agentId: 16, tool: "x" }, ON),
    ).resolves.toBeUndefined();
  });
});
