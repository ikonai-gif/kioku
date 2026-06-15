/**
 * KHMB runner — PR-bench-1: baseline R@k/MRR + six-axis ablation.
 *
 * Usage:
 *   node --import tsx scripts/bench/run.ts <snapshot.csv> <vectors.csv>
 *
 * Output: a table of R@5 / R@10 / MRR for the full six-axis scorer, plus an
 * ablation row per axis (that axis turned OFF) so we can read each axis's
 * marginal contribution. Pure cosine (all axes off) is the floor.
 *
 * No network, no DB — operates entirely on the local snapshot. The data files
 * are NOT in the repo; pass their paths in.
 */
import { loadSnapshot, loadVectors } from "./loader";
import { scoreCandidates, ALL_AXES_ON, type AxisToggles } from "./scorer";
import { buildGoldQueries, aggregate } from "./metrics";

function main() {
  const [snapshotPath, vectorsPath] = process.argv.slice(2);
  if (!snapshotPath || !vectorsPath) {
    console.error("usage: run.ts <snapshot.csv> <vectors.csv>");
    process.exit(1);
  }

  const rows = loadSnapshot(snapshotPath);
  const vectors = loadVectors(vectorsPath);
  const now = Date.now();

  const withVec = rows.filter((r) => vectors.has(r.id));
  console.log(`loaded ${rows.length} rows, ${vectors.size} vectors, ${withVec.length} usable`);

  const queries = buildGoldQueries(rows, vectors, { simThreshold: 0.82, maxQueries: 50 });
  console.log(`built ${queries.length} gold queries (leave-one-out clusters)\n`);

  const run = (toggles: AxisToggles) =>
    aggregate(queries, (q) => scoreCandidates(q.queryId, rows, vectors, toggles, now));

  const full = run(ALL_AXES_ON);
  const floor = run({ t: false, p: false, v: false, i: false, c: false, tau: false });

  const pad = (s: string, n: number) => s.padEnd(n);
  const fmt = (x: number) => x.toFixed(4);

  console.log(pad("config", 18) + pad("R@5", 9) + pad("R@10", 9) + "MRR");
  console.log("-".repeat(45));
  console.log(pad("six-axis (full)", 18) + pad(fmt(full.recallAt5), 9) + pad(fmt(full.recallAt10), 9) + fmt(full.mrr));
  console.log(pad("cosine-only", 18) + pad(fmt(floor.recallAt5), 9) + pad(fmt(floor.recallAt10), 9) + fmt(floor.mrr));
  console.log("-".repeat(45));

  // Ablation: turn each axis OFF, measure the drop vs full.
  const axes: (keyof AxisToggles)[] = ["t", "p", "v", "i", "c", "tau"];
  for (const ax of axes) {
    const toggles: AxisToggles = { ...ALL_AXES_ON, [ax]: false };
    const r = run(toggles);
    const delta = full.recallAt5 - r.recallAt5;
    console.log(pad(`-${ax}`, 18) + pad(fmt(r.recallAt5), 9) + pad(fmt(r.recallAt10), 9) + fmt(r.mrr) + `   d_R@5=${delta >= 0 ? "+" : ""}${fmt(delta)}`);
  }
  console.log(`\nqueries evaluated: ${full.queriesEvaluated}`);
}

main();
