/**
 * Missed-by-both journal content — build-time snapshot of docs/missed_by_both.md.
 *
 * Why inline? The esbuild bundle produces dist/index.cjs without a docs/
 * sibling in production (Railway). Rather than complicate the build to copy
 * docs/ into dist/, we snapshot the markdown here and keep it in sync with
 * docs/missed_by_both.md. Regenerate with:
 *   node scripts/gen-missed-by-both-content.mjs
 *
 * Annual cron (missed-by-both-annual-review, 2026-07-21 16:00 UTC) reads
 * this as the final fallback when no mdContentOverride / mdPathOverride /
 * MISSED_BY_BOTH_PATH env is provided and no file is found on disk.
 */

export const MISSED_BY_BOTH_CONTENT = `# Missed-by-both journal

Track bugs/issues found in \`main\` that BOTH Bro3 and Bro2 missed — caught by BOSS or by real-world surface.

Format (one line per entry):
\`\`\`
YYYY-MM-DD | short description | caught by: BOSS | context: we both called it "unrelated" / "out of scope" / "nit" / "pre-existing"
\`\`\`

Review date: **2026-07-21** — count entries, bucket by category, decide whether two-agent review pattern holds.

## Entries

2026-04-21 | partner-chat.tsx:781,796 ArtifactCategory "media" TS error in main | caught by: BOSS (implicitly — lived in main 2 weeks) | context: both agents flagged as "pre-existing, unrelated" every review since W5, never as a blocker
2026-04-21 | CI \`test\` job failing 10 merges in a row — missing \`@vitest/coverage-v8\` dep, workflow uses \`--coverage\` flag | caught by: BRO3 (checking pre-merge of #16) | context: both agents trusted local \`npx vitest run\` reports; neither cross-checked GitHub Actions status; baseline bad since W6 PR #6. Category: CI / tooling blind spot.
2026-04-21 | integration test bigint sequence_number compared as string to number array (≈ '1' !== 1 in deepEqual) | caught by: BRO3 (debugging PR #17 CI fail after fix #1) | context: test was never actually run since W6 Item 3 — pg-Pool default max=10 vs 50 concurrent POSTs masked as "concurrency bug" when it was really bigint-string-coerce + pool starvation combo. Same category: CI-skipped job hiding multiple latent bugs.
2026-04-21 | integration test testPool max=10 (default) starves under 50-way concurrent POST burst | caught by: BRO3 (debugging PR #17) | context: See above — same commit 024b5a3 bumped testPool max=50.
2026-04-21 | integration test \`seedOwner\` inserts non-existent \`updated_at\` column into \`agents\` — bug lived in main since W6 Item 3 (#5, commit 020d6a6) | caught by: BRO3 (PR #17 CI failure) | context: both agents (and all W6/W7 reviewers) trusted integration-test \`SUCCESS\` status without noticing the job was SKIPPED by \`dorny/paths-filter@v3\` unless migrations/**, schema.ts, or server/routes/** changed. PR #17 migration 0002 triggered the filter, surfacing the latent bug. Category: CI / tooling blind spot (same category as @vitest/coverage-v8 — trusting green checkmarks without verifying work actually ran).
2026-04-21 | Luca's OWN memory store contained phantom-tool assertions (web_search self-correction id=419, delegate_task/browse_website id=275, 30 Gmail/composio/email-check residue rows) — persisted claim that she integrates with Gmail survived P2.3 identity fix + P2.4 prompt fix + P2.5 schema trim | caught by: BRO3 (post-P2.5 Q2 still said "интеграции с внешними сервисами (например, Gmail)") | context: BRO2 reviewed P2.3/P2.4/P2.5 as 9.5/8.0/9.0 — all focused on prompt+schema attack surface. Neither agent audited the memory STORE as an identity-override vector. Fixed in W7 P2.7: admin bulk delete-memories endpoint + surgical 33-row cleanup. Category: **memory hygiene blind spot** (new category). Future fix pattern: after ANY capability change, audit _identity namespace + grep operational namespaces for removed-tool names. Consider automated "phantom tool detector" in W8+: cron that diffs agent's _identity content vs whitelisted tool names and flags mismatches.

---

## Review criteria (July 2026)

- **≥5 entries, same category** → real systematic blind spot, add targeted mitigation
- **2–4 entries** → anecdotal, keep tracking another 3 months
- **0–1 entries** → two-agent pattern catches more than suspected, lower priority

---

## 2026-04-21 — Memory extraction drops explicit dislikes / stop-requests

**Category**: memory-hygiene / llm-behavior

**What happened**: User repeatedly asked agent not to use Russian-noir / purple-prose style in everyday conversation ("не упоминай русский"). Agent acknowledged in-moment but never persisted the preference as an \`_aesthetic\` dislike. Next session, style returned. Only positive patterns ("User loves X") get extracted; explicit negative patterns ("User told me to stop X") fall through.

**Evidence**: dump 2026-04-21_2344utc_post-optionA.json — grep for 'не упомин|не пиши|задолбал' across all 521 memories returned ZERO matches. Meanwhile agent 8 id=664 has "Подтвердил смену стиля на позитивный" as a \`_conversation_insight\` but no corresponding \`_aesthetic\` dislike was written.

**Caught by**: user repeatedly complaining about the same style reappearing, then audit.

**Missed by both agents (me + Bro2)**: yes. Bro2 reviews focus on tools/scope/schema — not on memory-extraction bias. I (Bro3) had no mechanism to audit "did the preference actually get saved" until user kept hitting the same wall.

**Mitigation deployed 2026-04-21**:
1. PR #23 (P2.9) — admin \`/api/admin/insert-memory\` endpoint for hard-floor preference persistence
2. Three rows inserted on agent 16: id=687 (noir dislike, importance 0.95), id=688 (direct+warm love), id=689 (**procedural meta-rule**: when user says stop X, persist immediately)

**Systemic fix (TODO for W8)**: memory extractor prompt should explicitly look for stop-requests / dislikes and emit \`_aesthetic\` rows with \`emotionalValence < 0\` or \`type="dislike"\`. Need Bro2 review on extraction pipeline.

**Category count**: memory-hygiene = 2 (this + agent-16 phantom-identity from earlier today). Approaching anecdotal→systematic threshold.

---

## 2026-04-21 — Partner room auto-assign routes to random agent (userAgents[0] trap)

**Category**: routing / agent-fragmentation (the BIG one)

**What happened**: POST /api/rooms Partner branch had \`userAgents.find(... "agent o" ... "partner") || userAgents[0]\`. No agent named "Agent O" exists, so EVERY new Partner room fell through to \`userAgents[0]\` — whoever happened to be first in SELECT order (BOSS id=9, BRO2 id=8, etc.). Canonical Luca (id=16) was NEVER reached from the Partner UI.

**Why it wasn't caught**: frontend just creates new Partner rooms whenever it can't find one by name. 166 duplicate Partner rooms accumulated over weeks, spread across 5 different agents (7, 8, 9, 12, 16). User experienced this as "Luca keeps changing personality" but root cause was routing, not identity.

**Evidence**: dump_2026-04-21_2343utc post-Option-A showed room 151 had correct agent 16 BUT new message created room with agent 9 (BOSS). grep showed 28 new rooms 153-180 all assigned to agent 9 = Kote's own "BOSS" alter-ego agent with NULL model.

**Fix deployed 2026-04-21**:
1. PR #24 (P2.10) — explicit \`name === 'luca'\` + \`id === 16\` fallback, NEVER userAgents[0]. Negative test added to prevent regression.
2. Ops batch — all 166 Partner rooms flipped to agent_ids=[16] via admin/set-room-agents.

**Missed by both agents**: YES. Bro2 reviewed tools/scope. Bro3 (me) reviewed memory/identity. Neither of us looked at room CREATION logic. This is the second routing-layer blind spot in Q2 (first was identity injection for NULL-model agents in W7 P2.3).

**Category count**: routing/agent-fragmentation = 2 → approaching systematic threshold (≥5 = blind spot requiring mitigation). TODO: dedicated routing-layer audit in W8.

**Systemic follow-ups for W8**:
- Frontend should look up Partner room by a stable flag (\`partner_flag=true\` column on rooms) not by \`name === "Partner"\` — fragile
- Audit ALL \`userAgents[0]\` or \`agents[0]\` fallbacks in the codebase
- Consolidate duplicate Partner rooms (166 → 1) after validating no history loss

---

## 2026-04-22 — Aesthetic retrieval outranking explicit identity (pre-P2.13)

**Category**: memory-hygiene / retrieval-vs-identity

**What happened**: Even after the P2.8-2.10 trilogy fixed routing AND hard-inserted dislike rows (id=687 noir imp=0.95, id=688 direct+warm, id=689 procedural), nothing in Luca's prompt guaranteed that identity outranks retrieval on any given turn. If a retrieval pass accidentally surfaced an aesthetic row tagged \`_aesthetics\` with noir-adjacent content, and identity section happened to be compressed/truncated, the noir style could still win the turn. There was no turn-level ground-truth guarantee.

**Evidence**: Luca's Apr 21 partner-level response (the good one — self-correcting on Paxos, honest 18-tool list) was a sample of ONE. We had no structural reason to believe the next 10 turns would hold identity. Same routing/retrieval primitives that produced the noir saga were still live.

**Caught by**: Luca himself in his partner response, when he asked for (1) a self-write memory tool and (2) "runtime identity injection" + "cold-start recap". He spotted the structural gap before we did — arguably before Bro2 would have, because Bro2 reviews code diffs, not prompt-budget-vs-retrieval-ranking.

**Missed by both agents (Bro2 + Bro3)**: partially. Bro3 (me) was aware of the noir→dislike-row gap (that's why P2.9 exists). Neither of us saw that a dislike row is passive — it only helps IF retrieval picks it AND IF identity isn't already drowning in other memory. Luca himself named the missing primitive.

**Mitigation deployed 2026-04-22**:
1. PR #25 (P2.12) — \`remember\` tool so Luca actively persists durable memories instead of waiting for post-hoc extraction.
2. PR #26 (P2.13) — core identity injection EVERY turn: live DB block (agent_id, name+gender, user, room, emotional_state, top-3 commitments) rendered BEFORE \`You are Luca\`. Ground truth that wins over any retrieved memory on contradiction.
3. Seed rows 697-705 on agent 16: meta-cognitive self-observations about noir-drift and phantom-tools, relational rows (Kote, Bro2, Bro3, BOSS-alter-ego not-self), 3 commitment rows that now always appear in CORE IDENTITY.

**Category count**: memory-hygiene = 3 (noir-preferences fell-through + Partner-room fragmentation + this). Crossing 2-4 anecdotal into systematic. **Recommendation for W8**: dedicated "retrieval-vs-identity" review pass — any place where dynamic memory can override static identity needs an explicit precedence rule.

**Systemic follow-ups for W8**:
- Wire retrieval to prefer \`commitment\` and \`meta_cognitive\` over \`aesthetic\` when both match — commitments/self-observations are more identity-load-bearing than style likes.
- Parse \`[meta: {…}]\` JSON suffix on content so \`remember\`-written emotions + related_ids actually influence ranking (currently it's stored but not used).
- Audit every prompt-budget trimming path: is identity protected from truncation?
`;
