/**
 * KHMB axis runner — PR-bench-2: per-axis decisiveness (A1..A6).
 *
 * Usage: node run-axes.js <snapshot.csv> <vectors.csv>
 *
 * For each axis, builds controlled pairs identical except on that axis and
 * reports the win rate (fraction of pairs where the preferred member ranks
 * first). 0.5 = no effect; 1.0 = fully decisive. This is where KIOKU's unique
 * axes (p, v, tau) are expected to shine — competitors have no such signal.
 */
import { loadSnapshot, loadVectors } from "./loader";
import { runAxis, type Axis } from "./axes";

function main() {
  const [snapshotPath, vectorsPath] = process.argv.slice(2);
  if (!snapshotPath || !vectorsPath) {
    console.error("usage: run-axes.js <snapshot.csv> <vectors.csv>");
    process.exit(1);
  }

  const rows = loadSnapshot(snapshotPath);
  const vectors = loadVectors(vectorsPath);
  const bases = rows.filter((r) => vectors.has(r.id) && r.content.length > 30).slice(0, 100);

  console.log(`axis decisiveness (100 controlled pairs each)\n`);
  console.log("axis  meaning              winRate   verdict");
  console.log("-".repeat(52));

  const meaning: Record<Axis, string> = {
    t: "recency (newer)", p: "provenance", v: "verified",
    i: "importance", c: "confidence", tau: "decay/strength",
  };
  const order: Axis[] = ["t", "p", "v", "i", "c", "tau"];

  for (const ax of order) {
    const r = runAxis(ax, bases, vectors, 100);
    const verdict = r.winRate >= 0.99 ? "decisive"
      : r.winRate >= 0.6 ? "works"
      : r.winRate <= 0.4 ? "INVERTED"
      : "weak";
    const label = `A${order.indexOf(ax) + 1} ${ax}`.padEnd(6);
    console.log(`${label}${meaning[ax].padEnd(21)}${r.winRate.toFixed(4)}    ${verdict}  (${r.pairs} pairs)`);
  }
}

main();
