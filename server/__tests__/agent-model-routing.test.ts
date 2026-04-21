/**
 * W7 P2.3 — Agent model routing (split-brain fix)
 *
 * The `agents` table had three overlapping fields: `model` (legacy),
 * `llm_model` (canonical), `llm_provider`. Luca's row had them disagreeing
 * (model=gpt-5.4-mini, llm_model=claude-sonnet-4-6, llm_provider=openai).
 *
 * W7 P2.3 makes the triple `llm_model + llm_provider + llm_api_key` canonical
 * and sunsets `model`. Tests:
 *
 *   1. Source-pin — `deliberation.ts` + `structured-deliberation.ts` read
 *      `llmModel` only; the legacy `|| agent.model` OR branch is GONE from
 *      model-selection sites.
 *   2. Source-pin — the PATCH /api/agents/:id compat shim still accepts
 *      body.model but routes it into llmModel (not into the `model` column).
 *   3. Source-pin — the migration file exists and performs both steps:
 *      COPY model→llm_model WHERE llm_model IS NULL, then NULL model.
 *   4. Provider-inference behaviour — asserted via the source that the
 *      `isGemini`/`isClaude` discriminators consult llmModel prefix OR
 *      llmProvider, with no model-column dependency.
 *
 * Source-pin (grep live code for required primitives) is the right
 * granularity here: the actual dispatch function pulls ~40 modules at
 * import time, and stubbing every one for a single provider-selection
 * assertion would be net-negative. Behavioural coverage of the dispatch
 * lives in the existing e2e-breaker-integration and per-agent-breaker
 * suites, which exercise the full path end-to-end.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const serverDir = join(__dirname, "..");
const migrationsDir = join(__dirname, "..", "..", "migrations");

describe("W7 P2.3 — routing reads only llmModel (legacy `model` fallback removed)", () => {
  it("deliberation.ts model-selection line reads `llmModel`, NOT `|| agent.model`", () => {
    const src = readFileSync(join(serverDir, "deliberation.ts"), "utf8");
    // The canonical line. Match the whole statement up to ;.
    const line = src.match(/const\s+chatModel\s*=\s*\(agent\s+as\s+any\)\.llmModel[^\n;]*;/);
    expect(line, "chatModel assignment not found").toBeTruthy();
    const stmt = line![0];
    // Must read llmModel.
    expect(stmt).toMatch(/llmModel/);
    // Must NOT fall back to the legacy `model` column.
    expect(stmt).not.toMatch(/\|\|\s*\(agent\s+as\s+any\)\.model\b/);
  });

  it("structured-deliberation.ts model-selection line reads `llmModel`, NOT `|| agent.model`", () => {
    const src = readFileSync(join(serverDir, "structured-deliberation.ts"), "utf8");
    const line = src.match(/const\s+agentModel\s*=\s*agent\.llmModel[^\n;]*;/);
    expect(line, "agentModel assignment not found").toBeTruthy();
    const stmt = line![0];
    expect(stmt).toMatch(/llmModel/);
    expect(stmt).not.toMatch(/\|\|\s*agent\.model\b/);
  });

  it("structured-deliberation.ts modelsUsed aggregation reads llmModel only", () => {
    const src = readFileSync(join(serverDir, "structured-deliberation.ts"), "utf8");
    const block = src.match(/session\.modelsUsed\s*=\s*Array\.from\([^\n]*\)/);
    expect(block, "modelsUsed aggregation not found").toBeTruthy();
    expect(block![0]).toMatch(/a\.llmModel/);
    expect(block![0]).not.toMatch(/a\.model\b/);
  });

  it("deliberation.ts error-log detail reads llmModel only", () => {
    const src = readFileSync(join(serverDir, "deliberation.ts"), "utf8");
    const errLogIdx = src.indexOf('operation: "deliberation-error"');
    expect(errLogIdx).toBeGreaterThan(-1);
    const window = src.slice(errLogIdx, errLogIdx + 500);
    expect(window).toMatch(/llmModel/);
    // The `|| (agent as any).model` legacy fallback must be gone from this
    // specific detail line.
    const detailLine = window.match(/detail:\s*`Model:[^`]*`[^;]*/);
    expect(detailLine).toBeTruthy();
    expect(detailLine![0]).not.toMatch(/\|\|\s*\(agent\s+as\s+any\)\.model\b/);
  });
});

describe("W7 P2.3 — provider inference uses llmModel prefix OR llmProvider, no `agent.model`", () => {
  const src = readFileSync(join(serverDir, "deliberation.ts"), "utf8");

  it("isGemini discriminator uses chatModel prefix + llmProvider", () => {
    const m = src.match(/const\s+isGemini\s*=\s*chatModel\.startsWith[^\n;]*;/);
    expect(m, "isGemini line not found").toBeTruthy();
    expect(m![0]).toMatch(/chatModel\.startsWith\("gemini-"\)/);
    expect(m![0]).toMatch(/llmProvider.*===.*"gemini"/);
  });

  it("isClaude discriminator uses chatModel prefix + llmProvider", () => {
    const m = src.match(/const\s+isClaude\s*=\s*chatModel\.startsWith[^\n;]*;/);
    expect(m, "isClaude line not found").toBeTruthy();
    expect(m![0]).toMatch(/chatModel\.startsWith\("claude-"\)/);
    expect(m![0]).toMatch(/llmProvider.*===.*"anthropic"/);
  });
});

describe("W7 P2.3 — PATCH /api/agents/:id compat shim routes body.model into llmModel", () => {
  const src = readFileSync(join(serverDir, "routes.ts"), "utf8");

  it("accepts body.model as a compat shim and writes llmModel (not model column)", () => {
    const patchIdx = src.indexOf('app.patch("/api/agents/:id"');
    expect(patchIdx, "agents PATCH endpoint not found").toBeGreaterThan(-1);
    // Window wide enough to cover the update-building block.
    const window = src.slice(patchIdx, patchIdx + 2500);
    // Must have the shim: when llmModel is absent but model is, write llmModel.
    expect(window).toMatch(/else\s+if\s*\(\s*model\s*!==\s*undefined\s*\)\s*updates\.llmModel\s*=\s*model/);
    // Must NOT directly write `updates.model = model` — that would perpetuate the split-brain.
    expect(window).not.toMatch(/if\s*\(\s*model\s*!==\s*undefined\s*\)\s*updates\.model\s*=\s*model/);
  });
});

describe("W7 P2.3 — migration 0002 unifies model→llm_model + nulls legacy column", () => {
  const upPath = join(migrationsDir, "0002_unify_agent_model_fields.sql");
  const downPath = join(migrationsDir, "0002_unify_agent_model_fields_down.sql");

  it("UP migration exists and performs both backfill + null-out steps", () => {
    const up = readFileSync(upPath, "utf8");
    // Step 1: COPY model → llm_model WHERE llm_model IS NULL AND model IS NOT NULL
    expect(up).toMatch(/UPDATE\s+agents\s+SET\s+llm_model\s*=\s*model[\s\S]*WHERE\s+llm_model\s+IS\s+NULL[\s\S]*AND\s+model\s+IS\s+NOT\s+NULL/i);
    // Step 2: UPDATE agents SET model = NULL
    expect(up).toMatch(/UPDATE\s+agents\s+SET\s+model\s*=\s*NULL/i);
    // Wrapped in a transaction (idempotent + atomic).
    expect(up).toMatch(/BEGIN;[\s\S]*COMMIT;/);
  });

  it("DOWN migration exists and mirrors llm_model back into model for rollback", () => {
    const down = readFileSync(downPath, "utf8");
    expect(down).toMatch(/UPDATE\s+agents\s+SET\s+model\s*=\s*llm_model[\s\S]*WHERE\s+model\s+IS\s+NULL[\s\S]*AND\s+llm_model\s+IS\s+NOT\s+NULL/i);
    expect(down).toMatch(/BEGIN;[\s\S]*COMMIT;/);
  });
});

describe("W7 P2.3 — client factories resolve per-agent key only when llm_provider matches", () => {
  const src = readFileSync(join(serverDir, "deliberation.ts"), "utf8");

  it("getAnthropicClient gates per-agent key on llmProvider === 'anthropic', falls back to shared env", () => {
    const fn = src.match(/function\s+getAnthropicClient\([\s\S]*?\n\}/);
    expect(fn, "getAnthropicClient not found").toBeTruthy();
    const body = fn![0];
    // Per-agent branch gated on llmProvider === "anthropic".
    expect(body).toMatch(/agent\.llmApiKey\s*&&\s*agent\.llmProvider\s*===\s*"anthropic"/);
    // Fallback to shared ANTHROPIC_API_KEY.
    expect(body).toMatch(/ANTHROPIC_API_KEY/);
  });

  it("getOpenAIClient gates per-agent key on llmProvider === 'openai', falls back to shared", () => {
    const fn = src.match(/function\s+getOpenAIClient\([\s\S]*?\n\}/);
    expect(fn, "getOpenAIClient not found").toBeTruthy();
    const body = fn![0];
    expect(body).toMatch(/agent\.llmApiKey\s*&&\s*agent\.llmProvider\s*===\s*"openai"/);
    expect(body).toMatch(/return\s+openai/);
  });

  it("getGeminiKey gates per-agent key on llmProvider === 'gemini', falls back to shared", () => {
    const fn = src.match(/function\s+getGeminiKey\([\s\S]*?\n\}/);
    expect(fn, "getGeminiKey not found").toBeTruthy();
    const body = fn![0];
    expect(body).toMatch(/agent\.llmApiKey\s*&&\s*agent\.llmProvider\s*===\s*"gemini"/);
    expect(body).toMatch(/GEMINI_API_KEY/);
  });
});
