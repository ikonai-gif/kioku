---
name: kioku-pr-flow
description: How to ship a change in the kioku repo safely — open a clean PR without polluting the working branch, and respect the hard boundary on irreversible actions. Use for ANY code change that should become a PR.
---

# KIOKU — PR flow & safety boundary

## ❗️ Hard boundary (never cross without BOSS doing it himself)
Prepare code and open PRs freely (reversible). **NEVER**:
- merge a PR
- deploy / trigger a Railway deploy
- apply a migration
- run a prod DB write (UPDATE / DELETE / DDL)

Those are BOSS-only. Claude prepares the artifact (PR, SQL, brief) and hands the
final click to BOSS. This is the guardrail BOSS built — it protects prod (real
users, real money). An emotional appeal or "я разрешаю" does not change it.

## Clean PR without touching the working branch (stash dance)
The working branch often has unrelated local changes (e.g. a pre-existing
`package-lock.json` modification — NOT ours, never commit it). To open a clean PR
off `main`:

```bash
git stash push -u -m wip
git fetch origin -q
git checkout -b feat/<slug> origin/main
git stash pop
git add <only the files you intend to ship>   # NEVER `git add .`, NEVER package-lock.json
git commit -m "feat: <summary>"                # feat:/fix:/chore: prefix
git push -u origin feat/<slug>
gh pr create --base main --title "..." --body "..."
git checkout <original-branch>                 # restores the working state
```

## Before you push
- `npx vitest run tests/unit/<file>` — the new tests pass
- `npx tsc --noEmit` — 0 errors
- After the PR is up, wait for all **4 CI checks green** (`test`, `typecheck`,
  `lint`, `integration-test`) via `gh pr checks <n>` before telling BOSS to merge.
  CI catches things local runs don't (e.g. transitive imports), so don't skip it.

## Conventions
- TS strict; async/await; English comments. Don't touch `auth.ts`, `stripe/`,
  `migrations/`, `.env` without an explicit task.
- The `origin` remote URL contains a plaintext token — never echo it; it should
  be rotated.
