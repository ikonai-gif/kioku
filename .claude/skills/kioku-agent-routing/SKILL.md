---
name: kioku-agent-routing
description: The provider routing invariants for multi-agent deliberation (Variant A, no silent fallback, heterogeneity) and the patent-room policy. Use when touching deliberation routing, provider selection, ABSTAIN behavior, or patent handling.
---

# KIOKU — agent routing invariants

## Variant A — provider-first
- An agent's configured `provider` + `model` is honored. Shared-key agents carry
  `{ provider, apiKey: null }` so the provider is never lost downstream.
- **No silent fallback.** If a provider/model cannot serve, the agent **ABSTAINs**
  — it is NEVER silently swapped to another model (no Claude→gpt-4o, no
  Claude→Kimi). `models_used` must reflect the real models. A live deliberation
  should show the distinct real models (e.g. claude-sonnet-4.6, kimi-k2.6, gpt-4o).

## Heterogeneity warning (observability only)
If ≥3 configured agents share one `provider+model`, log a `warn` (consensus-theater
risk). It **never blocks**. Pure helper: `server/lib/heterogeneity.ts`
`assessRoomHeterogeneity()`.

## Patent rooms (POLICY — gate before provider selection)
Patent content = an **immutable, BOSS-set `patent_room` flag** on the room. Never
keyword auto-detection (false pos/neg; classifying = already exposing). When
`patent_room === true`, before normal routing:
- provider = OpenRouter / any aggregator → **hard block** → ABSTAIN.
- model = `claude-*` / `gpt-*` → allowed **only** with signed **ZDR + no-training**
  contract; else ABSTAIN.
- provider = local / hyperspace / ollama → **always allowed**.
- anything else → ABSTAIN.
ABSTAIN here = `reason: PATENT_PROVIDER_BLOCKED`, audit level CRITICAL, agent
excluded from consensus, no fallback / no substitution.

### Current effective state
No ZDR contract + no local model yet (jurisdiction US). So **patent rooms ABSTAIN**
until BOSS either signs a no-retention/no-training contract OR stands up a local
model. Full spec: `KIOKU_PATENT_ROOM_POLICY.pdf` / Notion `[BRO2-319]`.
