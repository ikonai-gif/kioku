#!/usr/bin/env node
/**
 * Regenerates server/lib/jobs/missed-by-both-content.ts from the canonical
 * docs/missed_by_both.md. Run whenever the markdown changes.
 *
 *   node scripts/gen-missed-by-both-content.mjs
 *
 * CI guard: the generated file is committed. If the markdown and the
 * generated .ts drift, a precommit / CI check (future) can rerun this
 * script and fail on diff.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const SRC = path.join(repoRoot, "docs/missed_by_both.md");
const OUT = path.join(repoRoot, "server/lib/jobs/missed-by-both-content.ts");

const md = fs.readFileSync(SRC, "utf8");
// Order matters: escape backslash first, then backtick, then ${ interpolation.
const escaped = md
  .replace(/\\/g, "\\\\")
  .replace(/`/g, "\\`")
  .replace(/\$\{/g, "\\${");

const out =
`/**
 * Missed-by-both journal content — build-time snapshot of docs/missed_by_both.md.
 *
 * Why inline? The esbuild bundle produces dist/index.cjs without a docs/
 * sibling in production (Railway). Rather than complicate the build to copy
 * docs/ into dist/, we snapshot the markdown here and keep it in sync with
 * docs/missed_by_both.md. Regenerate with:
 *   node scripts/gen-missed-by-both-content.mjs
 *
 * Annual cron (missed-by-both-annual-review, 2026-07-21 16:00 UTC) reads
 * this as the final fallback when no mdContentOverride / mdPathOverride /
 * MISSED_BY_BOTH_PATH env is provided and no file is found on disk.
 */

export const MISSED_BY_BOTH_CONTENT = \`${escaped}\`;
`;

fs.writeFileSync(OUT, out);
console.log(`wrote ${OUT} (${out.length} bytes)`);
