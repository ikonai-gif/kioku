/**
 * Tests for lib/jobs/missed-by-both.ts — parsing, categorization, recommendation.
 */

import { describe, it, expect } from "vitest";
import {
  parseEntries,
  bucket,
  categorize,
  recommendation,
  runMissedByBothReview,
} from "../../lib/jobs/missed-by-both";

const SAMPLE_MD = `# Missed-by-both journal

2026-01-01 | CI job failing 10 merges, missing @vitest/coverage-v8 dep | caught by: BRO3 | context: GitHub Actions blind spot
2026-01-02 | integration test testPool starves under 50-way concurrent POST burst | caught by: BRO3 | context: concurrency
2026-01-03 | Luca's memory store contained phantom tool assertions | caught by: BRO3 | context: memory hygiene blind spot

## 2026-02-15 — Memory extraction drops explicit dislikes

**Category**: memory-hygiene / llm-behavior

Agent never persisted user's style preference as a dislike.

## 2026-03-01 — TypeScript error in partner-chat.tsx survived 2 weeks

ArtifactCategory "media" type mismatch, both agents called it "pre-existing".
`;

describe("missed-by-both · categorize", () => {
  it("hits ci-tooling on the coverage-v8 line", () => {
    expect(categorize("CI job failing 10 merges, missing @vitest/coverage-v8")).toBe("ci-tooling");
  });
  it("hits concurrency on pool starvation", () => {
    expect(categorize("testPool starves under 50-way concurrent POST burst")).toBe("concurrency");
  });
  it("hits memory-hygiene", () => {
    expect(categorize("Luca's memory store phantom tool hygiene _identity")).toBe("memory-hygiene");
  });
  it("hits ts-errors on TS/TypeScript wording", () => {
    expect(categorize("ArtifactCategory TypeScript mismatch")).toBe("ts-errors");
  });
  it("falls back to uncategorized when no keyword matches", () => {
    expect(categorize("some ordinary sentence")).toBe("uncategorized");
  });
});

describe("missed-by-both · parseEntries", () => {
  it("finds pipe-format lines + H2 section entries", () => {
    const entries = parseEntries(SAMPLE_MD);
    // 3 pipe + 2 H2 = 5
    expect(entries).toHaveLength(5);
    expect(entries[0].date).toBe("2026-01-01");
    expect(entries[3].date).toBe("2026-02-15");
    expect(entries[4].date).toBe("2026-03-01");
  });

  it("tracks line number", () => {
    const entries = parseEntries(SAMPLE_MD);
    expect(entries[0].line).toBeGreaterThanOrEqual(1);
    expect(entries[0].line).toBeLessThan(entries[1].line);
  });

  it("returns [] for content without entries", () => {
    expect(parseEntries("# Heading only\n\nNothing here.\n")).toEqual([]);
  });
});

describe("missed-by-both · bucket", () => {
  it("groups entries by category and sorts by count desc", () => {
    const entries = parseEntries(SAMPLE_MD);
    const buckets = bucket(entries);
    const counts = Object.fromEntries(buckets.map((b) => [b.category, b.count]));
    // ci-tooling = 1, concurrency = 1, memory-hygiene = 2 (one pipe + one H2), ts-errors = 1
    expect(counts["memory-hygiene"]).toBe(2);
    expect(buckets[0].category).toBe("memory-hygiene");
  });

  it("includes up to 2 samples per bucket", () => {
    const entries = parseEntries(SAMPLE_MD);
    const buckets = bucket(entries);
    for (const b of buckets) {
      expect(b.samples.length).toBeLessThanOrEqual(2);
    }
  });
});

describe("missed-by-both · recommendation", () => {
  it("systematic when top bucket ≥ 5", () => {
    expect(recommendation([{ category: "ci-tooling", count: 7, samples: [] }])).toMatch(/Systematic blind spot/);
  });
  it("anecdotal when top bucket in 2-4", () => {
    expect(recommendation([{ category: "ci-tooling", count: 3, samples: [] }])).toMatch(/Anecdotal/);
  });
  it("all-good when top bucket ≤ 1", () => {
    expect(recommendation([{ category: "ci-tooling", count: 1, samples: [] }])).toMatch(/catching more than suspected/);
  });
  it("handles empty", () => {
    expect(recommendation([])).toMatch(/No entries/);
  });
});

describe("missed-by-both · runMissedByBothReview", () => {
  it("posts info-severity summary with total + top buckets", async () => {
    const notified: any[] = [];
    const result = await runMissedByBothReview({
      mdContentOverride: SAMPLE_MD,
      notify: async (p) => {
        notified.push(p);
        return { delivered: true, status: 204 };
      },
    });
    expect(notified).toHaveLength(1);
    expect(notified[0].severity).toBe("info");
    expect(notified[0].title).toMatch(/annual review/);
    expect(notified[0].detail).toMatch(/Total entries: 5/);
    expect(result.total).toBe(5);
    expect((result.buckets as any[]).length).toBeGreaterThan(0);
  });

  it("alerts critical if explicit file path cannot be read", async () => {
    // Explicit path miss is operator error — must surface as critical.
    const notified: any[] = [];
    await expect(
      runMissedByBothReview({
        mdPathOverride: "/no/such/path/nope.md",
        notify: async (p) => {
          notified.push(p);
          return { delivered: true, status: 204 };
        },
      }),
    ).rejects.toThrow();
    expect(notified).toHaveLength(1);
    expect(notified[0].severity).toBe("critical");
  });

  it("falls back to inline snapshot when implicit cwd docs path misses (prod bundle)", async () => {
    // Step 3 follow-up: simulate production by chdir'ing to a dir where
    // docs/missed_by_both.md does NOT exist. Implicit miss should silently
    // fall through to MISSED_BY_BOTH_CONTENT — no critical notify, no throw.
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmp = mkdtempSync(join(tmpdir(), "mbb-test-"));
    const origCwd = process.cwd();
    try {
      process.chdir(tmp);
      const notified: any[] = [];
      const result = await runMissedByBothReview({
        notify: async (p) => {
          notified.push(p);
          return { delivered: true, status: 204 };
        },
      });
      expect(notified).toHaveLength(1);
      expect(notified[0].severity).toBe("info");
      expect(notified[0].title).toMatch(/annual review/);
      // Inline content contains real entries — parse must find > 0.
      expect((result.total as number)).toBeGreaterThan(0);
    } finally {
      process.chdir(origCwd);
    }
  });
});

describe("missed-by-both · inline content snapshot", () => {
  it("inlined MISSED_BY_BOTH_CONTENT matches the canonical markdown on disk", async () => {
    // Guard against drift: CI should fail if someone edits docs/ without
    // rerunning scripts/gen-missed-by-both-content.mjs.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { MISSED_BY_BOTH_CONTENT } = await import("../../lib/jobs/missed-by-both-content");
    const diskPath = join(process.cwd(), "docs/missed_by_both.md");
    let onDisk: string;
    try {
      onDisk = readFileSync(diskPath, "utf8");
    } catch {
      // Only enforce in environments where the markdown is checked out.
      return;
    }
    expect(MISSED_BY_BOTH_CONTENT).toBe(onDisk);
  });
});
