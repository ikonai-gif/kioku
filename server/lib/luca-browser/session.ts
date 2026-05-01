/**
 * Browserbase managed-Chromium session manager for Luca's `agent_browser` tool.
 *
 * Maintains a per-(userId, domain) Browserbase **context** so that cookies set
 * during one Luca turn (e.g. signing in to Vercel) survive into the next turn.
 * Each session is created against the saved context and disposed at the end of
 * the turn — Browserbase persists the context's storage (cookies, localStorage)
 * server-side. We only keep the contextId reference in memory.
 *
 * In-memory state caveats (BRO1 R395 P4 — TODO R-future):
 *
 *   The (userId, domain) → contextId Map is process-local. On Railway restart
 *   we lose the reference and the next call will mint a fresh context. The
 *   prior context still exists in Browserbase but becomes orphaned (no longer
 *   reachable from this code). On the free tier this is acceptable —
 *   Browserbase free tier limits are billed in *minutes* of session time, not
 *   stored contexts. If/when stored-context count becomes a problem we'll
 *   migrate to a `luca_browser_contexts` Postgres table keyed by
 *   (userId, domain) so the mapping survives restarts.
 *
 *   Reuse window is 30 minutes since last use — beyond that we mint a fresh
 *   context. This bounds the worst-case "stale stored cookies" surface and
 *   matches the typical Browserbase context-eviction behaviour.
 *
 * Three-level flag defense — this module does NOT check flags. The caller
 * (agent-browser.ts handler) gates on `LUCA_TOOL_AGENT_BROWSER_ENABLED` and
 * `LUCA_BROWSER_DISABLED` BEFORE calling `getOrCreate`. This module assumes
 * its caller has already validated env + allowlist.
 */
import Browserbase from "@browserbasehq/sdk";

export interface SessionKey {
  userId: number;
  /**
   * Lower-cased, www-stripped domain. Caller normalizes via the same
   * `cleanDomain` rule used in the allowlist match — keeps cookies scoped
   * to the same logical site whether the LLM types `vercel.com` or
   * `www.vercel.com`.
   */
  domain: string;
}

interface ManagedSession {
  /** Active Browserbase session id (one per turn — disposed afterwards). */
  sessionId: string;
  /** Persistent context id — reused across turns to retain cookies. */
  contextId: string;
  createdAt: number;
  lastUsedAt: number;
}

/** Reuse a stored context for up to 30 min of idle. After that, fresh. */
export const SESSION_REUSE_TTL_MS = 30 * 60 * 1000;

export interface SessionHandle {
  sessionId: string;
  /** CDP `wss://` URL — Stagehand connects through this. */
  connectUrl: string;
}

/**
 * Per-process manager. Constructed once at boot (or lazily on first use)
 * and shared across all Luca invocations. Operations are async-safe — the
 * Map is mutated synchronously around awaits, so a parallel `getOrCreate`
 * for the same key may briefly mint two contexts. That's a known soft
 * race — duplicate contexts are wasteful but not dangerous (each
 * still scoped to the same user, domain). Wrap in a per-key lock when /
 * if it becomes a real issue.
 */
export class BrowserbaseSessionManager {
  private bb: Browserbase;
  private projectId: string;
  private sessions = new Map<string, ManagedSession>();

  constructor(opts: { apiKey: string; projectId: string }) {
    this.bb = new Browserbase({ apiKey: opts.apiKey });
    this.projectId = opts.projectId;
  }

  private mapKey(key: SessionKey): string {
    return `${key.userId}:${key.domain.toLowerCase()}`;
  }

  /**
   * Get-or-create a Browserbase session bound to a persistent context for
   * (userId, domain). The returned `connectUrl` is the CDP WebSocket
   * endpoint Stagehand connects to.
   *
   * Cookie persistence: when the same (userId, domain) is requested again
   * within `SESSION_REUSE_TTL_MS`, we re-use the stored contextId — cookies
   * set in the prior turn carry over.
   */
  async getOrCreate(key: SessionKey): Promise<SessionHandle> {
    const mk = this.mapKey(key);
    const existing = this.sessions.get(mk);
    const now = Date.now();

    if (existing && now - existing.lastUsedAt < SESSION_REUSE_TTL_MS) {
      // Reuse stored context — fresh session bound to it.
      const session = await this.bb.sessions.create({
        projectId: this.projectId,
        browserSettings: {
          context: { id: existing.contextId, persist: true },
        },
      });
      existing.sessionId = session.id;
      existing.lastUsedAt = now;
      this.sessions.set(mk, existing);
      return { sessionId: session.id, connectUrl: session.connectUrl };
    }

    // Mint fresh context + first session against it.
    const ctx = await this.bb.contexts.create({ projectId: this.projectId });
    const session = await this.bb.sessions.create({
      projectId: this.projectId,
      browserSettings: { context: { id: ctx.id, persist: true } },
    });
    this.sessions.set(mk, {
      sessionId: session.id,
      contextId: ctx.id,
      createdAt: now,
      lastUsedAt: now,
    });
    return { sessionId: session.id, connectUrl: session.connectUrl };
  }

  /**
   * Best-effort release of the active session id for (userId, domain).
   * Called by the handler in `finally` after `stagehand.close()` so we don't
   * leak running sessions on exception paths. We deliberately KEEP the
   * contextId — that's the whole point of persistence.
   *
   * Browserbase cleans up RUNNING sessions automatically after their TTL
   * but explicit REQUEST_RELEASE shaves seconds off and frees the parallel-
   * session quota. Errors are swallowed — if the session is already gone
   * we don't care.
   */
  async releaseSession(key: SessionKey): Promise<void> {
    const mk = this.mapKey(key);
    const ms = this.sessions.get(mk);
    if (!ms) return;
    try {
      await this.bb.sessions.update(ms.sessionId, {
        projectId: this.projectId,
        status: "REQUEST_RELEASE",
      });
    } catch {
      // Already released / not running — ignore.
    }
  }

  /**
   * Hard reset — drops the stored mapping for (userId, domain) so the next
   * call mints a fresh context. The orphaned Browserbase context remains
   * server-side until Browserbase's own retention policy cleans it up.
   * Used by tests + future "Boss said forget my session" admin path.
   */
  forgetContext(key: SessionKey): void {
    this.sessions.delete(this.mapKey(key));
  }

  /** Test/debug helper. */
  __snapshot(): ReadonlyMap<string, ManagedSession> {
    return new Map(this.sessions);
  }
}
