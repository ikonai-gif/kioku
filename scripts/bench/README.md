# KHMB — KIOKU Honest Memory Benchmark

Offline benchmark for KIOKU's six-axis memory retrieval. Measures not just
*can it find the fact* (baseline R@k, where every modern system saturates) but
*does it pick the trustworthy memory* — the axes competitors don't have.

## The six axes

Every memory row carries six retrieval signals, all already columns in the
`memories` table:

| Axis | Column(s) | Meaning |
|------|-----------|---------|
| `t`   | `created_at`, `last_accessed_at` | recency |
| `p`   | `provenance` | `user_told` > `tool_observed` > `luca_inferred` |
| `v`   | `verified`, `last_verified_at` | confirmed by Boss |
| `i`   | `importance` | salience |
| `c`   | `confidence` | certainty (decayed) |
| `tau` | `strength`, `decay_rate`, `reinforcements` | forgetting curve |

## What it measures

- **Baseline R@5 / R@10 / MRR** (`run.ts`) — leave-one-out retrieval over a real
  production snapshot. Parity with SOTA; the entry ticket.
- **Per-axis decisiveness** (`run-axes.ts`) — controlled pairs identical on every
  axis except one; win rate shows whether that axis actually steers ranking.
- **Head-to-head vs cosine-only baseline** (`run-contrast.ts`) — on the three
  KIOKU-unique axes (`p`, `v`, `tau`), KIOKU breaks ties toward the trustworthy
  memory where a cosine-only retriever can only flip a coin (~0.5).

## Running

The benchmark is fully offline — no network, no embedding API. Queries are
existing rows (leave-one-out), so every query already carries a real embedding.

It needs a local snapshot of production memory, exported separately (NOT in the
repo — it contains real user content):

```
# snapshot.csv  — id,content,type,namespace,importance,confidence,strength,
#                  decay_rate,provenance,verified,created_at,last_accessed_at,access_count
# vectors.csv   — id,"[v1,v2,...]"  (1536-dim embedding per row)

# compile (Mini: tsx/esbuild are broken under arm64, so go via tsc → CommonJS)
node_modules/.bin/tsc -p scripts/bench/tsconfig.bench.json   # -> /tmp/bench-dist
cd /tmp/bench-dist && echo '{"type":"commonjs"}' > package.json

node run.js          <snapshot.csv> <vectors.csv>   # baseline + ablation
node run-axes.js     <snapshot.csv> <vectors.csv>   # per-axis decisiveness
node run-contrast.js <snapshot.csv> <vectors.csv>   # KIOKU vs baseline
```

## Scorer

`scorer.ts` mirrors the production composite score in
`server/memory-injection.ts`: base cosine similarity modulated by the six axes,
with each axis individually toggleable for ablation. Keep the two in sync — if
production weighting changes, update `scorer.ts` and re-baseline.
