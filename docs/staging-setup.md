# Railway Staging Environment Setup

## Steps (user performs in Railway dashboard)

1. Railway Project "KIOKU" → Create New Environment → Name: `staging`
2. Clone environment variables from production
3. Create a new Postgres service in staging env (managed Railway Postgres, ~$5/mo)
   - Copy DATABASE_URL from the new Postgres into staging env vars
4. Provision Redis add-on in staging env (managed Railway Redis, ~$5/mo)
   - Auto-sets REDIS_URL env var
5. Connect GitHub repo → staging env → branch: `staging`
6. Set env vars specific to staging:
   - `NODE_ENV=staging`
   - `OPENAI_API_KEY` — separate (lower quota) key for staging
7. Provision Redis in production env too (same $5-10/mo) — required for BullMQ
8. Note down BOTH REDIS_URLs (prod + staging) for the agent

## Smoke test script (after deploy)

See `scripts/smoke-staging.sh` — runs basic API checks against staging.

## Git workflow

- Feature branches: `meeting-room/week2-*` etc.
- Staging: branch `staging` auto-deploys to staging env
- Production: merge `staging` → `main`, `main` auto-deploys to prod
