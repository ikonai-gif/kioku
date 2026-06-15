import { loadSnapshot, loadVectors } from "./loader";
import { runContrast } from "./contrast";

function main() {
  const [snapshotPath, vectorsPath] = process.argv.slice(2);
  if (!snapshotPath || !vectorsPath) {
    console.error("usage: run-contrast.js <snapshot.csv> <vectors.csv>");
    process.exit(1);
  }
  const rows = loadSnapshot(snapshotPath);
  const vectors = loadVectors(vectorsPath);
  const bases = rows.filter((r) => vectors.has(r.id) && r.content.length > 30).slice(0, 100);
  runContrast(bases, vectors, 100);
}

main();
