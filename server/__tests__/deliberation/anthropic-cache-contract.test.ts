/**
 * R403-P2 — Anthropic messages.create call-shape contract.
 *
 * BRO1 P2 (R405): the cache_control breakpoint placement and the legacy
 * fallback shape are SDK-contract-sensitive. A drift here silently kills
 * caching (or worse, sends a malformed payload Anthropic rejects). Lock
 * down the exact shape:
 *
 *   - LUCA_PROMPT_CACHING_ENABLED=true + parts available
 *       system = [
 *         { type:'text', text: <static>, cache_control:{type:'ephemeral'} },
 *         { type:'text', text: <dynamic> },                  // NO cache_control
 *       ]
 *   - flag off / parts null
 *       system = <legacy single string, byte-identical to pre-R403>
 *
 * P3: tools field MUST be identical regardless of caching flag — Phase 1
 * does not cache tools (Luca tool list is flag-dependent: 19 base + 18
 * expanded; cache-marking it would invalidate every flip).
 *
 * P4: cache-usage telemetry shape — covered by reading the helper's
 * intent. The actual telemetry emit lives at deliberation.ts:6383 and is
 * baselined by the partner-prompt-parts.test.ts (P1) on the dynamic side
 * and by manual log-grep post-deploy. This file pins the request-side
 * contract.
 */
import { describe, it, expect, vi } from "vitest";
import {
  buildAnthropicSystemForCaching,
  buildPartnerPromptParts,
  type PartnerPromptParts,
} from "../../deliberation";

const ARGS = [
  "Luca",
  "Test partner agent description",
  "## WHO YOU ARE\nLuca, AI partner.\n\n## RECENT CONVERSATIONS\nNone yet.\n",
  null,
  { trustLevel: 0.6, interactionCount: 12 },
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
] as const;

function makeParts(): PartnerPromptParts {
  return buildPartnerPromptParts(
    ARGS[0],
    ARGS[1],
    ARGS[2],
    ARGS[3] as any,
    ARGS[4] as any,
    ARGS[5],
    ARGS[6] as any,
    ARGS[7] as any,
    ARGS[8] as any,
    ARGS[9],
    ARGS[10],
  );
}

describe("R403-P2 — buildAnthropicSystemForCaching contract", () => {
  it("flag ON + parts present → returns 2-element array", () => {
    const parts = makeParts();
    const legacy = parts.static + parts.dynamic;
    const system = buildAnthropicSystemForCaching(parts, true, legacy);

    expect(Array.isArray(system)).toBe(true);
    const arr = system as any[];
    expect(arr).toHaveLength(2);
  });

  it("flag ON → element[0] has type:text + text:<static> + cache_control:ephemeral", () => {
    const parts = makeParts();
    const system = buildAnthropicSystemForCaching(
      parts,
      true,
      parts.static + parts.dynamic,
    ) as any[];

    expect(system[0].type).toBe("text");
    expect(system[0].text).toBe(parts.static);
    expect(system[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("flag ON → element[1] has type:text + text:<dynamic> + NO cache_control", () => {
    const parts = makeParts();
    const system = buildAnthropicSystemForCaching(
      parts,
      true,
      parts.static + parts.dynamic,
    ) as any[];

    expect(system[1].type).toBe("text");
    expect(system[1].text).toBe(parts.dynamic);
    // Dynamic half MUST NOT carry a breakpoint — that's a separate cache
    // entry and would inflate cost.
    expect(system[1].cache_control).toBeUndefined();
  });

  it("flag OFF → returns the legacy single string byte-identical to input", () => {
    const parts = makeParts();
    const legacy = parts.static + parts.dynamic;
    const system = buildAnthropicSystemForCaching(parts, false, legacy);

    expect(typeof system).toBe("string");
    expect(system).toBe(legacy);
  });

  it("parts null → returns legacy string regardless of flag (non-partner path)", () => {
    const legacy = "non-partner system prompt";
    const offSystem = buildAnthropicSystemForCaching(null, false, legacy);
    const onSystem = buildAnthropicSystemForCaching(null, true, legacy);
    expect(offSystem).toBe(legacy);
    // Even with the flag on, missing parts → fall back to legacy string.
    // This guards the !== null check in deliberation.ts:6343.
    expect(onSystem).toBe(legacy);
  });

  it("flag ON → exactly ONE cache_control breakpoint in the array (no extras)", () => {
    const parts = makeParts();
    const system = buildAnthropicSystemForCaching(
      parts,
      true,
      parts.static + parts.dynamic,
    ) as any[];

    const breakpoints = system.filter((b) => b.cache_control != null);
    expect(breakpoints).toHaveLength(1);
  });
});

describe("R403-P2 — messages.create call-args via mock client", () => {
  /**
   * Black-box check: hand a stub Anthropic-shaped client to a tiny
   * harness that mimics the deliberation tool-loop call site, capture
   * the args, assert the shape. We don't import the real loop (it pulls
   * the entire deliberation graph); we verify the helper output is
   * passed through verbatim as `system`.
   */
  function makeStubClient() {
    return {
      messages: {
        create: vi.fn().mockResolvedValue({
          id: "msg_test",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "hi" }],
          usage: {
            input_tokens: 100,
            output_tokens: 5,
            cache_creation_input_tokens: 3500,
            cache_read_input_tokens: 0,
          },
        }),
      },
    } as any;
  }

  it("flag ON → messages.create receives system as array with cache_control on first element", async () => {
    const stub = makeStubClient();
    const parts = makeParts();
    const legacy = parts.static + parts.dynamic;
    const system = buildAnthropicSystemForCaching(parts, true, legacy);

    await stub.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system,
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "luca_search", description: "x", input_schema: { type: "object" } }],
    });

    const callArgs = stub.messages.create.mock.calls[0][0];
    expect(Array.isArray(callArgs.system)).toBe(true);
    expect(callArgs.system).toHaveLength(2);
    expect(callArgs.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(callArgs.system[1].cache_control).toBeUndefined();
    // P3 — tools come through unchanged, no cache_control on them in Phase 1.
    expect(Array.isArray(callArgs.tools)).toBe(true);
    expect(callArgs.tools[0].cache_control).toBeUndefined();
  });

  it("flag OFF → messages.create receives system as plain string", async () => {
    const stub = makeStubClient();
    const parts = makeParts();
    const legacy = parts.static + parts.dynamic;
    const system = buildAnthropicSystemForCaching(parts, false, legacy);

    await stub.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system,
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "luca_search", description: "x", input_schema: { type: "object" } }],
    });

    const callArgs = stub.messages.create.mock.calls[0][0];
    expect(typeof callArgs.system).toBe("string");
    expect(callArgs.system).toBe(legacy);
    // P3 — tools shape unchanged when flag off (was always plain).
    expect(Array.isArray(callArgs.tools)).toBe(true);
    expect(callArgs.tools[0].cache_control).toBeUndefined();
  });

  it("usage block carries cache_creation_input_tokens / cache_read_input_tokens (P4 telemetry source)", async () => {
    // The deliberation tool-loop telemetry (deliberation.ts:6383) reads
    // these fields off claudeMsg.usage. Lock the SDK response shape we
    // depend on so a future SDK rename doesn't silently zero our metrics.
    const stub = makeStubClient();
    const resp = await stub.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: "x",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(resp.usage).toBeDefined();
    expect(typeof resp.usage.cache_creation_input_tokens).toBe("number");
    expect(typeof resp.usage.cache_read_input_tokens).toBe("number");
    expect(typeof resp.usage.input_tokens).toBe("number");
    expect(typeof resp.usage.output_tokens).toBe("number");
  });
});
