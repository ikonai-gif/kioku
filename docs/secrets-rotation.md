# Secrets Rotation Runbook

Operator-facing procedure for rotating any secret the KIOKU™ server depends
on. Every rotation follows the same six-step core; provider-specific notes
live in the table below.

## When to rotate

- **Leaked key suspected** — committed to a public repo, logged to a client
  browser, screenshot'd in Slack, exfiltrated via dependency compromise.
- **Scheduled rotation** — every 90 days recommended for all production
  keys (OpenAI / Anthropic / Gemini / JWT / master).
- **Ex-contractor access cleanup** — any time someone with prod access
  leaves the team.

## Keys in scope

| Key | Provider | Where stored | Notes |
|-----|----------|-------------|-------|
| `OPENAI_API_KEY` | OpenAI dashboard | Railway Variables | Shared across all deliberation + per-agent fallbacks. Module-load-time const in `structured-deliberation.ts` — redeploy required (see step 5). |
| `ANTHROPIC_API_KEY` | Anthropic console | Railway Variables | Used by `deliberation.ts` Claude path. W7 Variant C breaker in-flight (P1). |
| `GEMINI_API_KEY` | Google AI Studio | Railway Variables | Fallback provider when OpenAI breaker OPEN. Also module-load-time const. |
| `KIOKU_MASTER_KEY` | Internal | Railway Variables | Admin-route header auth (`/health/monitor`, `/api/admin/*`). Regenerate from a cryptographically-secure RNG (`openssl rand -hex 32`). |
| `JWT_SECRET` | Internal | Railway Variables | Signing key for user session tokens. **Rotation forces every logged-in user to log out** — this is expected, not a bug. Notify the beta list before rotating during business hours. |
| `DATABASE_URL` | Supabase | Railway Variables | Rotate the DB password in Supabase dashboard, then paste the new URL. Connection pool reopens on redeploy. |
| `STRIPE_SECRET_KEY` | Stripe dashboard | Railway Variables | Rotate via Stripe → Developers → API keys → Roll. |
| `REDIS_URL` | Railway addon | Railway Variables | Rotation via Railway addon dashboard. Rate-limit counters in the old DB are lost on switchover (<1 min drift window). |

## Procedure (6 steps, same for every key)

1. **Identify the leaked/rotating key.** Which provider, what exposure window,
   which environments (dev / staging / prod). If multiple, rotate the most
   sensitive first (payment > auth > LLM > rate-limit).
2. **Revoke at the provider dashboard FIRST.** Before generating the
   replacement — this stops any active exfiltration. A brief service
   outage is preferable to an attacker racing your rotation.
3. **Generate the replacement** at the same provider dashboard.
4. **Update in Railway Variables.** Paste the new key into
   `Settings → Variables`. **Do NOT commit it to the repo, pastebin, or
   Slack.** If the key must be shared with a teammate, use 1Password or a
   similarly audited secret channel.
5. **Redeploy.** Railway auto-redeploys on any variable change (~60–90s).
   Redeploy forces a full process restart — every env var is re-read on
   startup, including the module-level constants in
   `structured-deliberation.ts` (`HAS_OPENAI_KEY`, `GEMINI_API_KEY`) flagged
   by Bro2 Item 1d N1.
6. **Post-redeploy drain window.** For OpenAI specifically: per-agent
   OpenAI clients are cached in-memory inside
   `server/lib/openai-per-agent-breaker.ts`. A hot-reload (not the Railway
   default) would leave the cache pointing at the old key until the
   process restarts. With Railway's default full restart, this is NOT an
   issue.

   Expect a **≤30-second request-drain** during restart during which
   Railway serves the old container. At <50 beta users, at most 1–4
   requests in that window may hit the old key; they can retry. If a full
   force-invalidate is required before the drain completes, see the W8
   note below.

## Full force-invalidate endpoint (deferred to W8)

`POST /api/admin/breaker/reset` is **not yet implemented**. When it ships
(W8), it will:

- Authenticate via `x-master-key`.
- Clear the per-agent breaker client cache
  (`server/lib/openai-per-agent-breaker.ts` registry).
- Pair with W6 Item 1a N3 (per-agent OpenAI client cache invalidation on
  key rotation).

Until then, the drain window above is the expected tail for OpenAI key
rotation.

## Verification after rotation

Run these three checks; all must pass within 5 minutes of the redeploy
finishing.

```bash
# 1. Admin health monitor accepts the new master key
curl -sf https://usekioku.com/health/monitor \
  -H "x-master-key: ${KIOKU_MASTER_KEY}" | jq '.openaiBreaker.state'
# expect: "CLOSED"

# 2. A real deliberation succeeds end-to-end (OpenAI hot path)
curl -sf https://usekioku.com/api/rooms/<test-room-id>/deliberate \
  -H "x-session-token: <test-session>" \
  -d '{"topic":"post-rotation smoke"}' | jq '.id'

# 3. No circuit-breaker fallback events in the last 5 minutes of logs
gh run view --log | grep llm_fallback_circuit_open | tail -5
# expect: empty (no events from the rotation itself)
```

If #1 fails, the master key wasn't propagated — check Railway Variables.
If #2 fails with 503 + `Retry-After`, the OpenAI breaker is OPEN — check
logs for auth errors (401 from OpenAI = stale key in the container, wait
for the drain or force-restart).

## Post-rotation cleanup

- **Log the rotation** in `/home/user/workspace/secrets-rotation-log.md`:
  date, key name, reason (leak / scheduled / offboard), operator, prior
  key first/last 4 chars for audit trail.
- **If the leaked key was committed to git history**: run BFG Repo-Cleaner
  (`bfg --replace-text passwords.txt`) and force-push to ALL mirrors.
  Coordinate with anyone with an open PR — their branches need rebasing.
- **If the key was logged to the client**: add the specific leak path to
  the PII audit checklist (`/home/user/workspace/pii_audit_w7.md`) so it
  can't regress.

## Incident escalation

A leaked provider key (OpenAI, Anthropic, Gemini) with charges before
revocation = **incident**. Open a Linear ticket in the `SEC` project, tag
the operator, attach the provider's usage report post-rotation.
