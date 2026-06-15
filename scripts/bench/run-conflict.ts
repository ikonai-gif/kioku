import { loadSnapshot, loadVectors } from "./loader";
import { runConflicts, sweepImportance } from "./conflict";

function main() {
  const [snapshotPath, vectorsPath] = process.argv.slice(2);
  if (!snapshotPath || !vectorsPath) {
    console.error("usage: run-conflict.js <snapshot.csv> <vectors.csv>");
    process.exit(1);
  }
  const rows = loadSnapshot(snapshotPath);
  const vectors = loadVectors(vectorsPath);
  const bases = rows.filter((r) => vectors.has(r.id) && r.content.length > 30).slice(0, 100);

  console.log("axis conflicts — which side the six-axis formula favors\n");
  for (const c of runConflicts(bases, vectors)) {
    const favored = c.aWinRate >= 0.5 ? "A" : "B";
    console.log(`${c.name}`);
    console.log(`  ${c.description}`);
    console.log(`  A wins ${(c.aWinRate * 100).toFixed(0)}% -> favors ${favored}  (${c.trials} trials)\n`);
  }

  console.log("importance threshold sweep (gap -> A win rate)");
  for (const s of sweepImportance(bases, vectors)) {
    console.log(`  gap ${s.gap.toFixed(2)} -> ${(s.winRate * 100).toFixed(0)}%`);
  }
}

main();
