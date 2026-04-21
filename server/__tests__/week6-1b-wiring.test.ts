/**
 * Tests for W6 1b wiring — breaker visibility in monitor endpoints.
 *
 * Coverage:
 *   1. getMonitorSummary includes both openaiBreaker and agentBreakers fields
 *   2. agentBreakers reflects live per-agent registry state (custom-key agent
 *      registered → total goes up; shared-key delegation → not tracked)
 *   3. CircuitOpenError carries both `name === "CircuitOpenError"` AND
 *      `code === "CIRCUIT_OPEN"` so consumers can detect without instanceof
 *      (important because deliberation.ts / routes.ts use both checks).
 *
 * Deliberation-level tool-loop behaviour is exercised indirectly via the
 * breaker primitives (openai-client.test.ts, openai-per-agent-breaker.test.ts).
 * A full tool-loop wire test would require a running server + DB which is out
 * of scope for this unit test file.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// The per-agent breaker module calls `new OpenAI({apiKey})`; give it a stub.
vi.mock("openai", () => {
  function FakeOpenAI(this: any, _opts?: { apiKey?: string }) {
    this.chat = { completions: { create: vi.fn() } };
  }
  return { default: FakeOpenAI };
});

// monitor.ts transitively imports ./storage which pulls in pg — mock the pool
// so the test doesn't try to connect to a real DB.
vi.mock("pg", () => {
  function MockPool(this: any) {
    this.query = vi.fn();
    this.on = vi.fn();
    this.end = vi.fn().mockResolvedValue(undefined);
    this.connect = vi.fn();
  }
  return { Pool: MockPool };
});
vi.mock("drizzle-orm/node-postgres", () => ({ drizzle: vi.fn(() => ({})) }));

import {
  withAgentBreaker,
  __resetAllAgentBreakersForTest,
  __getAgentBreakerMapSizeForTest,
} from "../lib/openai-per-agent-breaker";
import {
  __resetOpenAIBreakerForTest,
  __setOpenAIClientForTest,
  CircuitOpenError,
} from "../lib/openai-client";
import { getMonitorSummary } from "../monitor";

beforeEach(() => {
  __resetAllAgentBreakersForTest();
  __resetOpenAIBreakerForTest();
});

describe("W6 1b — monitor exposes agentBreakers alongside openaiBreaker", () => {
  it("getMonitorSummary has both openaiBreaker and agentBreakers fields", () => {
    const summary = getMonitorSummary();
    expect(summary).toHaveProperty("openaiBreaker");
    expect(summary).toHaveProperty("agentBreakers");
    expect(summary.agentBreakers).toEqual({ total: 0, open: 0 });
  });

  it("registering a custom-key agent increments agentBreakers.total", async () => {
    const customAgent = { id: 42, llmApiKey: "sk-agent-42", llmProvider: "openai" };
    // Issue one successful call → creates the per-agent breaker + client
    const stubResponse = { choices: [{ message: { content: "ok" } }] };
    await withAgentBreaker(customAgent as any, async () => stubResponse as any);
    expect(__getAgentBreakerMapSizeForTest()).toBe(1);

    const summary = getMonitorSummary();
    expect(summary.agentBreakers.total).toBe(1);
    expect(summary.agentBreakers.open).toBe(0);
  });

  it("shared-key agents do NOT appear in agentBreakers.total", async () => {
    __setOpenAIClientForTest({
      chat: { completions: { create: vi.fn().mockResolvedValue({ choices: [{ message: { content: "ok" } }] }) } },
    } as any);
    const sharedAgent = { id: 99, llmApiKey: null, llmProvider: null };
    await withAgentBreaker(sharedAgent as any, (c) => c.chat.completions.create({} as any));

    const summary = getMonitorSummary();
    expect(summary.agentBreakers.total).toBe(0);
  });
});

describe("W6 1b — CircuitOpenError cross-module identity", () => {
  it("carries name=CircuitOpenError AND code=CIRCUIT_OPEN", () => {
    const err = new CircuitOpenError("x", 5000);
    expect(err.name).toBe("CircuitOpenError");
    expect((err as any).code).toBe("CIRCUIT_OPEN");
    expect(err).toBeInstanceOf(CircuitOpenError);
  });
});
