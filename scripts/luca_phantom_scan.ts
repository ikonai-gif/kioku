/**
 * A5 phantom-tool scan — pre-flight before flipping LUCA_DEV_SCOPE_ENABLED.
 *
 * REPORT-ONLY: never mutates `_identity` memory. Prints the PhantomReport JSON
 * and exits non-zero when status !== "CLEAN", so a pre-flight check / CI can
 * gate the flag flip on a clean result.
 *
 *   tsx scripts/luca_phantom_scan.ts
 */
import { runPhantomScan } from "../server/lib/self-monitoring/phantom-detector";

async function main(): Promise<void> {
  const report = await runPhantomScan();
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== "CLEAN") {
    console.error(`[A5] status=${report.status} — DO NOT flip LUCA_DEV_SCOPE_ENABLED until CLEAN`);
    process.exit(1);
  }
  console.error("[A5] status=CLEAN");
}

main().catch((e) => {
  console.error("[A5] scan failed:", e);
  process.exit(2);
});
