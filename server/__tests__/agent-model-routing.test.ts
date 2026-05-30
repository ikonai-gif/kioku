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

describe("Kimi/OpenRouter routing", () => {
  it("isKimi discriminator triggers on moonshotai/ prefix, kimi- prefix, or llmProvider=openrouter", () => {
    const src = readFileSync(join(serverDir, "deliberation.ts"), "utf8");
    expect(src).toMatch(/const\s+isKimi\s*=/);
    expect(src).toMatch(/chatModel\.startsWith\("moonshotai\//);
    expect(src).toMatch(/chatModel\.startsWith\("kimi-"\)/);
    expect(src).toMatch(/llmProvider === "openrouter"/);
  });

  it("Kimi dispatch has privacy gate for K12-K17/K20 and patent keywords", () => {
    const src = readFileSync(join(serverDir, "deliberation.ts"), "utf8");
    expect(src).toMatch(/kimiBlockedByPrivacy/);
    expect(src).toMatch(/K\(1\[2-7\]\|20\)/);
    expect(src).toMatch(/patent\|.*provisional\|USPTO\|disclosure/i);
  });

  it("getOpenRouterClient uses OpenRouter baseURL and KIOKU headers", () => {
    const src = readFileSync(join(serverDir, "deliberation.ts"), "utf8");
    expect(src).toMatch(/function getOpenRouterClient/);
    expect(src).toMatch(/openrouter\.ai\/api\/v1/);
    expect(src).toMatch(/"X-Title":\s*"KIOKU"/);
    expect(src).toMatch(/"HTTP-Referer":\s*"https:\/\/usekioku\.com"/);
  });
});

describe("Chat-path: Claude via OpenRouter (anthropic/* slug fix)", () => {
  const src = readFileSync(join(serverDir, "deliberation.ts"), "utf8");

  it("Test F: there IS a chat-dispatch branch that routes provider=openrouter + model anthropic/* through OpenRouter", () => {
    // Locate a guarded `if` whose condition references llmProvider === "openrouter"
    // AND chatModel.startsWith("anthropic/"). This is the new branch.
    expect(src).toMatch(
      /\(agent\s+as\s+any\)\.llmProvider\s*===\s*"openrouter"[\s\S]{0,200}?chatModel\.startsWith\("anthropic\//,
    );
  });

  it("Test F-payload: the new branch calls OpenRouter with chatModel as-is (NOT moonshotai/kimi-k2.6)", () => {
    // Find the new branch block (between the openrouter+anthropic guard and
    // the existing isKimi block) and confirm it passes chatModel through.
    const newBranchStart = src.search(
      /\(agent\s+as\s+any\)\.llmProvider\s*===\s*"openrouter"[\s\S]{0,200}?chatModel\.startsWith\("anthropic\//,
    );
    expect(newBranchStart).toBeGreaterThan(-1);
    const kimiBranchStart = src.indexOf("if (!reply && isKimi && !kimiBlockedByPrivacy)");
    expect(kimiBranchStart).toBeGreaterThan(newBranchStart);
    const newBranchBody = src.slice(newBranchStart, kimiBranchStart);
    // Within the new branch, OpenRouter chat completions are invoked with
    // model: chatModel (not the kimi default).
    expect(newBranchBody).toMatch(/orClient\.chat\.completions\.create\(/);
    expect(newBranchBody).toMatch(/model:\s*chatModel,/);
    expect(newBranchBody).not.toMatch(/moonshotai\/kimi-k2\.6/);
  });

  it("Test G: Kimi default `moonshotai/kimi-k2.6` is no longer the catch-all fallback for unknown slugs", () => {
    // The old buggy default was: `: "moonshotai/kimi-k2.6"` at the end of the
    // ternary that resolves `kimiModel`. The fix replaces this with `: null`
    // so unknown OpenRouter slugs do NOT get silently routed to Kimi.
    // Strategy: locate the kimiModel ternary and assert the final `:` arm is
    // not the literal default we want to be rid of.
    const kimiModelTernary = src.match(
      /const\s+kimiModel\s*=\s*chatModel\.startsWith\("moonshotai\/[\s\S]{0,400}?;/,
    );
    expect(kimiModelTernary, "kimiModel ternary not found").toBeTruthy();
    expect(kimiModelTernary![0]).not.toMatch(/:\s*"moonshotai\/kimi-k2\.6"\s*\)?;?\s*$/);
    // And the final arm should now be `null` (skip-branch path).
    expect(kimiModelTernary![0]).toMatch(/:\s*null\b/);
  });

  it("Test H: new Claude-via-OpenRouter branch inherits the kimiBlockedByPrivacy gate (K12-K20 / patent)", () => {
    // The new branch must respect the existing patent-privacy gate so that
    // K12-K20 / USPTO content does NOT leak to OpenRouter even via Claude.
    const newBranchStart = src.search(
      /\(agent\s+as\s+any\)\.llmProvider\s*===\s*"openrouter"[\s\S]{0,200}?chatModel\.startsWith\("anthropic\//,
    );
    expect(newBranchStart).toBeGreaterThan(-1);
    // The condition expression includes !kimiBlockedByPrivacy.
    const conditionWindow = src.slice(Math.max(0, newBranchStart - 200), newBranchStart + 300);
    expect(conditionWindow).toMatch(/!kimiBlockedByPrivacy/);
  });

  it("Order: the new Claude-via-OR branch comes BEFORE the existing isKimi block (so isKimi cannot catch anthropic/* first)", () => {
    const newBranchStart = src.search(
      /\(agent\s+as\s+any\)\.llmProvider\s*===\s*"openrouter"[\s\S]{0,200}?chatModel\.startsWith\("anthropic\//,
    );
    const kimiBranchStart = src.indexOf("if (!reply && isKimi && !kimiBlockedByPrivacy)");
    expect(newBranchStart).toBeGreaterThan(-1);
    expect(kimiBranchStart).toBeGreaterThan(-1);
    expect(newBranchStart).toBeLessThan(kimiBranchStart);
  });
});


describe("PR #167b — structured-deliberation maxTokens bump (Kimi reasoning headroom)", () => {
  const src = readFileSync(join(serverDir, "structured-deliberation.ts"), "utf8");

  it("callLLM default maxTokens is 1024 (not 400) — Kimi K2.6 reasoning needs headroom", () => {
    // Locate the default-resolution line and assert 1024.
    const m = src.match(/const\s+maxTokens\s*=\s*options\?\.maxTokens\s*\?\?\s*(\d+)\s*;/);
    expect(m, "default maxTokens line not found").toBeTruthy();
    const defaultValue = parseInt(m![1], 10);
    expect(defaultValue).toBe(1024);
    expect(defaultValue).not.toBe(400);
  });

  it("structured-deliberation call site passes maxTokens 1024 (not 400)", () => {
    // The main round-dispatch call to callLLM lives inside withRetry(() => callLLM(...)).
    // Pin the literal we pass for maxTokens at that site to 1024.
    // Pattern: the comment block above the literal mentions reasoning-model headroom.
    const callSite = src.match(
      /withRetry\([\s\S]{0,400}?callLLM\([\s\S]{0,400}?maxTokens:\s*(\d+),/,
    );
    expect(callSite, "deliberation call-site maxTokens not found").toBeTruthy();
    const value = parseInt(callSite![1], 10);
    expect(value).toBe(1024);
    expect(value).not.toBe(400);
  });
});

describe("PR #168a — OpenRouter circuit-breaker timeoutMs bump (Kimi reasoning headroom)", () => {
  const orSrc = readFileSync(join(serverDir, "lib", "openrouter-client.ts"), "utf8");
  const oaSrc = readFileSync(join(serverDir, "lib", "openai-client.ts"), "utf8");

  it("OpenRouter breaker timeoutMs is 60_000 (not 30_000) — reasoning models need headroom", () => {
    // Locate the CircuitBreaker config and read the timeoutMs literal.
    const m = orSrc.match(
      /new\s+CircuitBreaker\(\{[^}]*?name:\s*"openrouter"[^}]*?timeoutMs:\s*([0-9_]+)/,
    );
    expect(m, "openrouter breaker timeoutMs not found").toBeTruthy();
    const literal = m![1].replace(/_/g, "");
    expect(parseInt(literal, 10)).toBe(60_000);
    expect(parseInt(literal, 10)).not.toBe(30_000);
  });

  it("OpenAI breaker timeoutMs stays at 30_000 — gpt-4o is non-reasoning, no bump needed", () => {
    // Defensive guard: an accidental bump on the OpenAI side would extend
    // failure-detection latency for the most-used provider with no benefit.
    const m = oaSrc.match(/timeoutMs:\s*([0-9_]+)/);
    expect(m, "openai breaker timeoutMs not found").toBeTruthy();
    const literal = m![1].replace(/_/g, "");
    expect(parseInt(literal, 10)).toBe(30_000);
  });

  it("OpenRouter and OpenAI breakers have ASYMMETRIC timeoutMs (60s vs 30s) by design", () => {
    const orM = orSrc.match(
      /new\s+CircuitBreaker\(\{[^}]*?name:\s*"openrouter"[^}]*?timeoutMs:\s*([0-9_]+)/,
    );
    const oaM = oaSrc.match(/timeoutMs:\s*([0-9_]+)/);
    const orVal = parseInt(orM![1].replace(/_/g, ""), 10);
    const oaVal = parseInt(oaM![1].replace(/_/g, ""), 10);
    expect(orVal).toBeGreaterThan(oaVal);
    expect(orVal - oaVal).toBeGreaterThanOrEqual(30_000);
  });
});

describe("PR #169 — OpenRouter content+reasoning fallback (reasoning-model recovery)", () => {
  const structSrc = readFileSync(join(serverDir, "structured-deliberation.ts"), "utf8");
  const chatSrc = readFileSync(join(serverDir, "deliberation.ts"), "utf8");

  it("Test J: structured-deliberation callOpenRouter falls back to message.reasoning when content is empty", () => {
    // Locate the post-completion handling in callOpenRouter and confirm it
    // checks message.reasoning / message.reasoning_content before returning "".
    // Pattern intentionally loose: we want to know the keys are referenced
    // anywhere in the body, not pin the exact ternary shape.
    const fnStart = structSrc.indexOf("async function callOpenRouter(");
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = structSrc.indexOf("\nasync function ", fnStart + 1);
    const body = structSrc.slice(fnStart, fnEnd > -1 ? fnEnd : fnStart + 4000);
    expect(body).toMatch(/msg\.reasoning\b/);
    expect(body).toMatch(/msg\.reasoning_content\b/);
    expect(body).toMatch(/openrouter_reasoning_fallback/); // log event present
  });

  it("Test K: chat-path Claude-via-OR branch also has the reasoning fallback", () => {
    // The new branch added in PR #166 (anthropic/* via OpenRouter) must also
    // handle empty-content with reasoning fallback for future reasoning-class
    // Anthropic slugs (e.g. claude-sonnet-thinking).
    const branchStart = chatSrc.search(
      /\(agent\s+as\s+any\)\.llmProvider\s*===\s*"openrouter"[\s\S]{0,200}?chatModel\.startsWith\("anthropic\//,
    );
    expect(branchStart).toBeGreaterThan(-1);
    const kimiStart = chatSrc.indexOf("if (!reply && isKimi && !kimiBlockedByPrivacy)");
    expect(kimiStart).toBeGreaterThan(branchStart);
    const claudeBody = chatSrc.slice(branchStart, kimiStart);
    expect(claudeBody).toMatch(/msg\.reasoning\b/);
    expect(claudeBody).toMatch(/Claude\/OR empty content/);
  });

  it("Test L: chat-path Kimi-OR branch has the reasoning fallback", () => {
    // The original Kimi branch must extract reasoning when content is empty.
    // This is the path that empirically failed in Pilot #4 — Ops-Agent (Kimi)
    // had message.content="" with non-empty message.reasoning.
    const kimiStart = chatSrc.indexOf("if (!reply && isKimi && !kimiBlockedByPrivacy)");
    expect(kimiStart).toBeGreaterThan(-1);
    // Find the matching close (heuristic: scan forward ~3000 chars — branch is ~120 lines).
    const kimiBody = chatSrc.slice(kimiStart, kimiStart + 4000);
    expect(kimiBody).toMatch(/msg\.reasoning\b/);
    expect(kimiBody).toMatch(/Kimi\/OR empty content/);
  });
});
