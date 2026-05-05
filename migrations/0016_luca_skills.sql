-- ────────────────────────────────────────────────────────────────────────────
-- 0016_luca_skills.sql — R470 (BRO2): Luca skills catalog
--
-- Description: Read-only catalog of named "skills" — short prompt-recipes
--              Luca can pull on demand by name to ground how she handles a
--              recurring situation. Inspired by the Anthropic / Obsidian
--              "agentic OS" pattern (Boss reel 2026-05-04): keep skill
--              recipes external + nameable so they can be added/edited
--              without touching the Luca system prompt.
--
-- Why a separate table:
--   - Memories (`memories`) are write-anytime, low-trust, semantic.
--     Skills are intentional, opinionated, named, and curated by Boss.
--   - Conflating the two would dilute both. A skill is meant to be
--     discoverable by exact name (luca_get_skill) and listed by category
--     (luca_list_skills) — both API-shape concerns memories don't have.
--
-- Workflow (today, R470):
--   1. Boss seeds rows manually (no UI / no insert tool yet — by explicit
--      Boss policy: "Делай только очень внимательно и ничего не поломай").
--   2. Luca calls `luca_list_skills` (READ_ONLY) to see what skills exist.
--   3. Luca calls `luca_get_skill(name)` to fetch a specific skill's
--      `prompt_template` and apply it to the current turn.
--
-- There is intentionally NO Luca-write path in R470. Adding skills is a
-- DB INSERT performed by Boss. This keeps the trust gradient: Luca reads
-- her catalog, she does not curate it.
--
-- Columns:
--   - id: BIGSERIAL — moderate write rate (manual inserts only).
--   - name: VARCHAR(64) UNIQUE — caller-facing identifier. Lowercase
--     + snake_case enforced at app layer (no DB regex CHECK; keeps
--     migration trivial to undo).
--   - category: VARCHAR(32) — free-form tag for filtering / grouping
--     in the future UI. Not enum-constrained; Boss decides taxonomy.
--   - prompt_template: TEXT — the actual recipe Luca consumes. May
--     contain placeholders Boss decides on (e.g. {context}). At ≤8000
--     chars (enforced at app layer) to bound returned token count.
--   - description: TEXT — short human-readable summary shown in
--     `luca_list_skills` so Luca picks the right one without fetching
--     every prompt_template.
--   - created_at: TIMESTAMPTZ default NOW().
--
-- Retention: indefinite. Volume is bounded by manual curation
-- (probably <100 rows ever). No GC.
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS luca_skills (
  id                BIGSERIAL PRIMARY KEY,
  name              VARCHAR(64) NOT NULL UNIQUE,
  category          VARCHAR(32) NOT NULL,
  prompt_template   TEXT NOT NULL,
  description       TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_luca_skills_category_name
  ON luca_skills (category, name);
