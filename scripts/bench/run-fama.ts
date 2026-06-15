import { loadSnapshot, loadVectors } from "./loader";
import { runFama } from "./fama";

function main() {
  const [snapshotPath, vectorsPath] = process.argv.slice(2);
  if (!snapshotPath || !vectorsPath) {
    console.error("usage: run-fama.js <snapshot.csv> <vectors.csv>");
    process.exit(1);
  }
  const rows = loadSnapshot(snapshotPath);
  const vectors = loadVectors(vectorsPath);
  const bases = rows.filter((r) => vectors.has(r.id) && r.content.length > 30).slice(0, 100);

  const { kioku, baseline } = runFama(bases, vectors, 1.0);

  console.log("FAMA-K — forgetting-aware accuracy (valid gold vs stale distractor)\n");
  console.log("system            R@5_valid  stale@5   FAMA-K");
  console.log("-".repeat(48));
  const fmt = (x: number) => x.toFixed(4);
  console.log(`KIOKU (decay on)  ${fmt(kioku.recallValid).padEnd(11)}${fmt(kioku.staleRateAt5).padEnd(10)}${fmt(kioku.famaK)}`);
  console.log(`baseline (no fgt) ${fmt(baseline.recallValid).padEnd(11)}${fmt(baseline.staleRateAt5).padEnd(10)}${fmt(baseline.famaK)}`);
  console.log("-".repeat(48));
  console.log(`\nstale@5 = fraction of top-5 slots holding invalidated memory (lower is better).`);
  console.log(`FAMA-K gap: ${fmt(kioku.famaK - baseline.famaK)} (KIOKU forgetting keeps stale facts out of the top).`);
}

main();
