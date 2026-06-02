-- =====================================================================
-- KIOKU namespace consolidation migration  (PR-1: stop drift)
-- Author: BRO2 | Frozen: 2026-06-02 | Source of truth: shared/namespaces.json
-- RUN BY: BOSS ONLY.  read-only dry-run first, then the transaction.
--
-- Safety properties:
--   * Idempotent: re-running is a no-op (guards on namespace_legacy IS NULL
--     + WHERE matches only legacy names, which no longer exist after run).
--   * Two-layer rollback: per-row namespace_legacy column + full backup table.
--   * No DELETE. No schema-destructive op. Only ADD COLUMN + UPDATE.
--   * Entity-suffix namespaces (_relational:, knowledge:, _series_bible:)
--     are NEVER touched by suffix-strip (they carry identity).
--
-- Schema facts confirmed read-only on prod Neon 2026-06-02:
--   memories: PK(id) only. NO FK. NO unique on namespace.
--   indexes: (user_id,namespace), (user_id,namespace,provenance) — plain btree.
--   => UPDATE namespace is index-safe and constraint-safe.
-- =====================================================================

\set ON_ERROR_STOP on
\pset pager off

-- ---------------------------------------------------------------------
-- SECTION A — DRY RUN (read-only). Run this ALONE first, eyeball counts.
-- ---------------------------------------------------------------------
\echo '--- A1. exact legacy -> canonical (rows that will move) ---'
SELECT namespace AS from_ns,
       CASE namespace
         WHEN '_reflection' THEN '_reflections'
         WHEN '_commitments' THEN '_commitment'
         WHEN '_knowledge_Art History' THEN 'knowledge:art_history'
         WHEN 'research' THEN 'knowledge:research'
         WHEN 'strategy' THEN 'knowledge:strategy'
         WHEN 'finance' THEN 'knowledge:finance'
         WHEN 'legal' THEN 'knowledge:legal'
         WHEN 'operations' THEN 'knowledge:operations'
         WHEN 'product' THEN 'knowledge:product'
         WHEN 'client_feedback' THEN 'knowledge:client_feedback'
         WHEN 'client_preferences' THEN 'knowledge:client_preferences'
         WHEN 'agent_coordination' THEN 'knowledge:agent_coordination'
         WHEN 'marketing_strategy' THEN 'knowledge:marketing_strategy'
         WHEN 'launch_campaign' THEN 'knowledge:launch_campaign'
         WHEN 'beta_launch' THEN 'knowledge:beta_launch'
         WHEN 'production_status' THEN 'knowledge:production_status'
         WHEN '_relational:boss_alter' THEN '_relational:boss'
         WHEN '_series_bible:IKONBAI Confidential' THEN '_series_bible:ikonbai_confidential'
         WHEN '_series_bible:Meta-coder' THEN '_series_bible:meta_coder'
       END AS to_ns,
       count(*) AS n
FROM memories
WHERE namespace IN ('_reflection','_commitments','_knowledge_Art History','research','strategy',
  'finance','legal','operations','product','client_feedback','client_preferences','agent_coordination',
  'marketing_strategy','launch_campaign','beta_launch','production_status','_relational:boss_alter',
  '_series_bible:IKONBAI Confidential','_series_bible:Meta-coder')
GROUP BY namespace ORDER BY n DESC;

\echo '--- A2. suffix-strip (tag suffixes -> base) ---'
SELECT namespace AS from_ns,
       CASE
         WHEN namespace LIKE '_reflection:%'      THEN '_reflections'
         WHEN namespace LIKE '_commitment:%'      THEN '_commitment'
         WHEN namespace LIKE '_autobiographical:%' THEN '_autobiographical'
         WHEN namespace LIKE '_procedural:%'      THEN '_procedural'
         WHEN namespace LIKE '_emotional_state:%' THEN '_emotional_state'
         WHEN namespace LIKE '_meta_cognitive:%'  THEN '_meta_cognitive'
       END AS to_ns,
       count(*) AS n
FROM memories
WHERE namespace LIKE '_reflection:%' OR namespace LIKE '_commitment:%'
   OR namespace LIKE '_autobiographical:%' OR namespace LIKE '_procedural:%'
   OR namespace LIKE '_emotional_state:%' OR namespace LIKE '_meta_cognitive:%'
GROUP BY namespace ORDER BY n DESC;

\echo '--- A3. total rows that will be touched ---'
SELECT count(*) AS will_touch FROM memories
WHERE namespace IN ('_reflection','_commitments','_knowledge_Art History','research','strategy',
  'finance','legal','operations','product','client_feedback','client_preferences','agent_coordination',
  'marketing_strategy','launch_campaign','beta_launch','production_status','_relational:boss_alter',
  '_series_bible:IKONBAI Confidential','_series_bible:Meta-coder')
   OR namespace LIKE '_reflection:%' OR namespace LIKE '_commitment:%'
   OR namespace LIKE '_autobiographical:%' OR namespace LIKE '_procedural:%'
   OR namespace LIKE '_emotional_state:%' OR namespace LIKE '_meta_cognitive:%';

-- STOP HERE on the first pass. If A1-A3 look right, run SECTION B.

-- ---------------------------------------------------------------------
-- SECTION B — MIGRATION (transactional). Run after dry-run looks correct.
-- ---------------------------------------------------------------------
BEGIN;

-- B0. per-row rollback column (idempotent)
ALTER TABLE memories ADD COLUMN IF NOT EXISTS namespace_legacy text;

-- B1. full backup table (idempotent: only insert ids not already backed up)
CREATE TABLE IF NOT EXISTS memories_namespace_backup_20260602 (
  id          integer PRIMARY KEY,
  namespace   text,
  backed_up_at bigint
);
INSERT INTO memories_namespace_backup_20260602 (id, namespace, backed_up_at)
SELECT m.id, m.namespace, (extract(epoch from now())*1000)::bigint
FROM memories m
WHERE (m.namespace IN ('_reflection','_commitments','_knowledge_Art History','research','strategy',
        'finance','legal','operations','product','client_feedback','client_preferences','agent_coordination',
        'marketing_strategy','launch_campaign','beta_launch','production_status','_relational:boss_alter',
        '_series_bible:IKONBAI Confidential','_series_bible:Meta-coder')
   OR m.namespace LIKE '_reflection:%' OR m.namespace LIKE '_commitment:%'
   OR m.namespace LIKE '_autobiographical:%' OR m.namespace LIKE '_procedural:%'
   OR m.namespace LIKE '_emotional_state:%' OR m.namespace LIKE '_meta_cognitive:%')
  AND NOT EXISTS (SELECT 1 FROM memories_namespace_backup_20260602 b WHERE b.id = m.id);

-- B2. exact maps (guard: namespace_legacy IS NULL => not yet migrated)
UPDATE memories SET namespace_legacy = namespace, namespace = m.to_ns
FROM (VALUES
  ('_reflection','_reflections'),
  ('_commitments','_commitment'),
  ('_knowledge_Art History','knowledge:art_history'),
  ('research','knowledge:research'),
  ('strategy','knowledge:strategy'),
  ('finance','knowledge:finance'),
  ('legal','knowledge:legal'),
  ('operations','knowledge:operations'),
  ('product','knowledge:product'),
  ('client_feedback','knowledge:client_feedback'),
  ('client_preferences','knowledge:client_preferences'),
  ('agent_coordination','knowledge:agent_coordination'),
  ('marketing_strategy','knowledge:marketing_strategy'),
  ('launch_campaign','knowledge:launch_campaign'),
  ('beta_launch','knowledge:beta_launch'),
  ('production_status','knowledge:production_status'),
  ('_relational:boss_alter','_relational:boss'),
  ('_series_bible:IKONBAI Confidential','_series_bible:ikonbai_confidential'),
  ('_series_bible:Meta-coder','_series_bible:meta_coder')
) AS m(from_ns, to_ns)
WHERE memories.namespace = m.from_ns AND memories.namespace_legacy IS NULL;

-- B3. suffix-strip (tag suffixes only; entity-suffixes excluded by construction)
UPDATE memories SET namespace_legacy = namespace, namespace = '_reflections'
  WHERE namespace LIKE '_reflection:%' AND namespace_legacy IS NULL;
UPDATE memories SET namespace_legacy = namespace, namespace = '_commitment'
  WHERE namespace LIKE '_commitment:%' AND namespace_legacy IS NULL;
UPDATE memories SET namespace_legacy = namespace, namespace = '_autobiographical'
  WHERE namespace LIKE '_autobiographical:%' AND namespace_legacy IS NULL;
UPDATE memories SET namespace_legacy = namespace, namespace = '_procedural'
  WHERE namespace LIKE '_procedural:%' AND namespace_legacy IS NULL;
UPDATE memories SET namespace_legacy = namespace, namespace = '_emotional_state'
  WHERE namespace LIKE '_emotional_state:%' AND namespace_legacy IS NULL;
UPDATE memories SET namespace_legacy = namespace, namespace = '_meta_cognitive'
  WHERE namespace LIKE '_meta_cognitive:%' AND namespace_legacy IS NULL;

-- B4. post-migration verification (still inside txn — review before COMMIT)
\echo '--- B4a. any legacy names still present? (expect 0 rows) ---'
SELECT namespace, count(*) FROM memories
WHERE namespace IN ('_reflection','_commitments','_knowledge_Art History','research','strategy',
  'finance','legal','operations','product','client_feedback','client_preferences','agent_coordination',
  'marketing_strategy','launch_campaign','beta_launch','production_status','_relational:boss_alter',
  '_series_bible:IKONBAI Confidential','_series_bible:Meta-coder')
   OR namespace LIKE '_reflection:%' OR namespace LIKE '_commitment:%'
   OR namespace LIKE '_autobiographical:%' OR namespace LIKE '_procedural:%'
   OR namespace LIKE '_emotional_state:%' OR namespace LIKE '_meta_cognitive:%'
GROUP BY namespace;

\echo '--- B4b. migrated row count (namespace_legacy populated) ---'
SELECT count(*) AS migrated FROM memories WHERE namespace_legacy IS NOT NULL;

\echo '--- B4c. namespace count after (sanity: should be smaller) ---'
SELECT count(DISTINCT namespace) AS distinct_namespaces FROM memories;

-- If B4a is empty and counts look right:
COMMIT;
-- else: ROLLBACK;

-- ---------------------------------------------------------------------
-- ROLLBACK (after COMMIT) — restore original namespaces:
--   UPDATE memories SET namespace = namespace_legacy, namespace_legacy = NULL
--   WHERE namespace_legacy IS NOT NULL;
-- backup table memories_namespace_backup_20260602 is the second safety net.
-- ---------------------------------------------------------------------
