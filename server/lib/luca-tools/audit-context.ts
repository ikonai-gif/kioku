/**
 * Audit context — [BRO2-A15 / LUCA-076] CRON-1 PR1.
 *
 * AsyncLocalStorage carrying (source, jobId) so recordLucaAudit can tag
 * rows produced by scheduled runs without threading parameters through
 * every dispatcher call site. Default when no context is active:
 * source='user', jobId=null — identical to pre-PR behavior.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface AuditContext {
  source: "user" | "cron";
  jobId: string | null;
}

// LAZY init: constructing an AsyncLocalStorage enables async_hooks process-wide,
// which perturbs async timing for every consumer of this module graph (observed:
// it surfaces a latent teardown race in meetings-context-concurrency integration
// test). The hook is only needed once a scheduled job actually runs, so we defer
// construction to the first runWithAuditContext call (cron-only path).
let als: AsyncLocalStorage<AuditContext> | null = null;

/** Run `fn` with the given audit context active for all awaited work inside. */
export function runWithAuditContext<T>(ctx: AuditContext, fn: () => Promise<T>): Promise<T> {
  if (!als) als = new AsyncLocalStorage<AuditContext>();
  return als.run(ctx, fn);
}

/** Current context, or the default user context when none is active (or ALS never initialized). */
export function currentAuditContext(): AuditContext {
  return als?.getStore() ?? { source: "user", jobId: null };
}
