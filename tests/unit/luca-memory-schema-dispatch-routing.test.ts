/**
 * R457 regression — `luca_memory_schema` MUST route through the main
 * deliberation switch, NOT through the V1a `dispatchLucaTool()` registry.
 *
 * Why this test exists: in R455 the tool was registered in
 * LUCA_STUDIO_TOOL_NAMES_BASE and a handler was added at deliberation.ts
 * :5711, but the early-route at :1650 (`if toolName.startsWith("luca_")`)
 * stole every `luca_*` call into the V1a registry where there is no case
 * for memory_schema → it threw `luca_tool_not_found`. Boss noticed when
 * Luca couldn't actually answer "что у тебя в памяти".
 *
 * Static-source assertions are sufficient and cheaper than spinning up
 * the full executePartnerTool stack: we prove (a) the early-route guard
 * exempts `luca_memory_schema`, (b) the V1a registry has no case for it
 * (so the exemption is required, not redundant), and (c) the main switch
 * handler is still present.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const deliberationSource = readFileSync(
  resolve(__dirname, "../../server/deliberation.ts"),
  "utf8",
);
const registrySource = readFileSync(
  resolve(__dirname, "../../server/lib/luca-tools/registry.ts"),
  "utf8",
);

describe("R457 — luca_memory_schema dispatch routing", () => {
  it("early-route guard exempts luca_memory_schema", () => {
    // The exemption set must be present and contain memory_schema. Both
    // forms (literal in Set or check helper) should satisfy.
    expect(deliberationSource).toMatch(
      /ROUTES_THROUGH_MAIN_SWITCH[\s\S]{0,200}luca_memory_schema/,
    );
    // And the early-route condition must reference the exemption set.
    expect(deliberationSource).toMatch(
      /toolName\.startsWith\(["']luca_["']\)\s*&&\s*!ROUTES_THROUGH_MAIN_SWITCH/,
    );
  });

  it("V1a registry does NOT define a case for luca_memory_schema", () => {
    // If someone later adds a case in registry.ts, the exemption is no
    // longer required and this test should fail loud so the dual-route
    // ambiguity gets resolved (one or the other, not both).
    expect(registrySource).not.toMatch(/case\s+["']luca_memory_schema["']/);
  });

  it("main switch in deliberation.ts has the handler case", () => {
    expect(deliberationSource).toMatch(/case\s+["']luca_memory_schema["']\s*:/);
  });

  it("handler reads userId/agentId from closure, not toolInput (R454 NIT-2)", () => {
    // Locate the handler block and assert it does NOT pull agent_id from
    // any input shape. This is a static repeat of the R455 NIT-2 invariant
    // — keep it next to the routing test so a future refactor that moves
    // the handler can't accidentally regress the closure-only contract.
    // The action-label switch at :1463 also matches the case literal, so
    // skip past it and find the handler block (indented body with `{`).
    const handlerMarker = 'case "luca_memory_schema": {';
    const handlerStart = deliberationSource.indexOf(handlerMarker);
    expect(handlerStart).toBeGreaterThan(0);
    const handlerEnd = deliberationSource.indexOf('case "send_telegram_message": {', handlerStart);
    const block = deliberationSource.slice(handlerStart, handlerEnd > 0 ? handlerEnd : handlerStart + 4000);
    expect(block).not.toMatch(/toolInput\.agent_id/);
    expect(block).not.toMatch(/toolInput\.user_id/);
    // Rate-limit key composes the closure agentId.
    expect(block).toMatch(/luca_memory_schema:hour:\$\{agentId\}/);
    expect(block).toMatch(/luca_memory_schema:burst:\$\{agentId\}/);
  });
});
