/**
 * KIOKU™ Internal Jobs — Annual Missed-by-both Journal Review
 *
 * Step 3 (PR #68). Replaces Computer cron f679415b.
 *
 * Runs once a year on 2026-07-21 at 16:00 UTC (configurable). Reads
 * docs/missed_by_both.md, counts entries, buckets by category, applies
 * the review criteria from the file itself:
 *
 *   - ≥5 entries in one category → systematic blind spot, mitigation needed
 *   - 2-4 entries                → anecdotal, keep tracking
 *   - 0-1 entries                → two-agent review stronger than expected
 *
 * Sends a Discord summary via jobs webhook.
 *
 * ENV:
 *   MISSED_BY_BOTH_PATH   override path (default docs/missed_by_both.md)
 *   JOBS_WEBHOOK_URL      see jobs-webhook.ts
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { notifyJob } from "./jobs-webhook";

export const MISSED_BY_BOTH_JOB_ID = "missed-by-both-annual-review";

export type Entry = {
  line: number;
  date?: string;
  text: string;
  category: string;
};

/**
 * Lightweight categorizer — matches a loose set of keywords. Extend as the
 * journal grows. Returns "uncategorized" if nothing matches so the bucket
 * count is never misleading.
 */
const CATEGORY_RULES: Array<{ id: string; keywords: RegExp }> = [
  { id: "ci-tooling",       keywords: /\b(ci|tooling|workflow|dorny|paths-filter|vitest|coverage|github actions)\b/i },
  { id: "ts-errors",        keywords: /\b(ts error|typescript|tsc|type error|ArtifactCategory)\b/i },
  { id: "memory-hygiene",   keywords: /\b(memory|phantom|hygiene|_identity|namespace)\b/i },
  { id: "auth",             keywords: /\b(auth|jwt|cookie|session|login|oauth)\b/i },
  { id: "concurrency",      keywords: /\b(concurrency|concurrent|race|lock|atomic|pool|starv)\b/i },
  { id: "websocket",        keywords: /\b(ws|websocket|socket|realtime)\b/i },
  { id: "migration",        keywords: /\b(migration|schema|0008|0009|drizzle)\b/i },
  { id: "llm-behavior",     keywords: /\b(llm|prompt|fabrication|drift|aesthetic|style)\b/i },
];

export function categorize(text: string): string {
  for (const rule of CATEGORY_RULES) {
    if (rule.keywords.test(text)) return rule.id;
  }
  return "uncategorized";
}

const ENTRY_LINE_RE = /^(\d{4}-\d{2}-\d{2})\s*\|/;
const TABLE_HEADER_RE = /^---+\s*##\s+Entries/i;

/**
 * Parse the file: collect every line that starts with `YYYY-MM-DD |` (the
 * standard pipe-delimited form). Also picks up H2-section entries that begin
 * with a date header (`## 2026-04-21 — ...`).
 */
export function parseEntries(md: string): Entry[] {
  const lines = md.split(/\r?\n/);
  const entries: Entry[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNum = i + 1;
    const pipe = ENTRY_LINE_RE.exec(raw);
    if (pipe) {
      entries.push({
        line: lineNum,
        date: pipe[1],
        text: raw,
        category: categorize(raw),
      });
      continue;
    }
    // H2 entry: `## 2026-04-21 — title` — include the next non-blank lines
    // for category detection (up to first blank) so **Category** line is
    // picked up.
    const h2 = /^##\s+(\d{4}-\d{2}-\d{2})\s*[—–-]\s*(.+)$/.exec(raw);
    if (h2) {
      let combined = raw;
      for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
        if (!lines[j].trim()) break;
        combined += " " + lines[j];
      }
      entries.push({
        line: lineNum,
        date: h2[1],
        text: `## ${h2[2]}`,
        category: categorize(combined),
      });
    }
  }
  return entries;
}

export type Bucket = { category: string; count: number; samples: string[] };

export function bucket(entries: Entry[]): Bucket[] {
  const byCat = new Map<string, Entry[]>();
  for (const e of entries) {
    const arr = byCat.get(e.category) ?? [];
    arr.push(e);
    byCat.set(e.category, arr);
  }
  const out: Bucket[] = [];
  for (const [category, arr] of byCat) {
    out.push({
      category,
      count: arr.length,
      samples: arr.slice(0, 2).map((e) => (e.text.length > 140 ? e.text.slice(0, 140) + "…" : e.text)),
    });
  }
  out.sort((a, b) => b.count - a.count);
  return out;
}

export function recommendation(buckets: Bucket[]): string {
  if (buckets.length === 0) return "No entries — nothing to review.";
  const top = buckets[0];
  if (top.count >= 5) {
    return `Systematic blind spot detected in "${top.category}" (${top.count} entries). Action: design targeted mitigation.`;
  }
  if (top.count >= 2) {
    return `Anecdotal signal in "${top.category}" (${top.count} entries). Keep tracking another quarter.`;
  }
  return `All categories ≤1 entry. Two-agent review pattern catching more than suspected.`;
}

export type RunMissedByBothOpts = {
  mdPathOverride?: string;
  notify?: typeof notifyJob;
  /** For tests: provide content directly. */
  mdContentOverride?: string;
};

export async function runMissedByBothReview(
  opts: RunMissedByBothOpts = {},
): Promise<Record<string, unknown>> {
  const notify = opts.notify ?? notifyJob;

  let content: string;
  if (opts.mdContentOverride !== undefined) {
    content = opts.mdContentOverride;
  } else {
    const fallbackPath = path.resolve(process.cwd(), "docs/missed_by_both.md");
    const mdPath = opts.mdPathOverride
      ?? process.env.MISSED_BY_BOTH_PATH
      ?? fallbackPath;
    try {
      content = await fs.readFile(mdPath, "utf8");
    } catch (err: any) {
      await notify({
        severity: "critical",
        title: "Missed-by-both review — file not found",
        detail: `${err?.code ?? "error"}: ${err?.message ?? err}`,
        context: { mdPath },
      });
      throw err;
    }
  }

  const entries = parseEntries(content);
  const buckets = bucket(entries);
  const rec = recommendation(buckets);

  const topFour = buckets.slice(0, 4)
    .map((b) => `• ${b.category}: ${b.count}`)
    .join("\n");

  await notify({
    severity: "info",
    title: "Missed-by-both journal — annual review",
    detail: [
      `Total entries: ${entries.length}`,
      `Top categories:`,
      topFour || "(none)",
      ``,
      `Recommendation: ${rec}`,
    ].join("\n"),
    context: { total: entries.length, top_buckets: buckets.slice(0, 4) },
  });

  return {
    total: entries.length,
    buckets,
    recommendation: rec,
  };
}
