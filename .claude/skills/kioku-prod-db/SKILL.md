---
name: kioku-prod-db
description: Where the KIOKU production database actually is and how to query it safely. Use whenever a task involves inspecting or changing prod data, or when "the database" / agent config / rooms / deliberations come up.
---

# KIOKU — production database

## ⚠️ The real prod DB is Neon, not Railway Postgres
- The app's production data lives in **Neon**, database **`neondb`**.
- The Railway service tile **`kioku-postgres` is EMPTY and unused** — querying it
  for app tables returns nothing. Don't be fooled by it.
- Connection string: Railway → project **happy-luck** → service **`kioku`** →
  **Variables** → **`DATABASE_URL`** (host contains `neon`). **Never** hardcode,
  commit, or paste this value into the repo or chat — it grants write access.

## Tables (user-facing app data)
`agents`, `rooms`, `users`, `kioku_deliberation_sessions`, `memories`.

`agents` columns: `id`, `name`, `user_id`, `llm_provider`, `llm_model`, `enabled`.

## Safe inspection (read-only)
```bash
printf 'DB url: '; read -rs U; echo            # silent paste, stays out of history
psql "$U" -c "SELECT id, name FROM rooms ORDER BY id"
```
Read-only `SELECT` is fine for inspection.

## ❗️ Writes are BOSS-only
NEVER run `UPDATE` / `DELETE` / migrations against prod. Prepare a guarded,
idempotent SQL script (BEGIN … COMMIT, explicit WHERE), hand it to BOSS, and let
BOSS run `psql "$U" -f script.sql`. Same boundary as kioku-pr-flow.
