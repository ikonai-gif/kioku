/**
 * [#171 / BRO2-319] Patent-room routing policy — pure helper tests.
 * Verifies: normal rooms are never gated (no-op); patent rooms allow ONLY local
 * providers and block every cloud provider (→ caller ABSTAINs, no fallback).
 */
import { describe, it, expect } from "vitest";
import { isLocalProvider, patentRoomBlocks } from "../../server/lib/patent-routing";

describe("isLocalProvider", () => {
  it("true for local / ollama", () => {
    expect(isLocalProvider("local")).toBe(true);
    expect(isLocalProvider("ollama")).toBe(true);
  });
  it("false for cloud providers and empty", () => {
    for (const p of ["openrouter", "openai", "anthropic", "gemini", null, undefined]) {
      expect(isLocalProvider(p as any)).toBe(false);
    }
  });
});

describe("patentRoomBlocks", () => {
  it("never blocks in a normal room (gate is inert)", () => {
    for (const p of ["openrouter", "openai", "anthropic", "gemini", "local", "ollama", null]) {
      expect(patentRoomBlocks(false, p as any)).toBe(false);
    }
  });

  it("in a patent room, allows ONLY local/ollama", () => {
    expect(patentRoomBlocks(true, "local")).toBe(false);
    expect(patentRoomBlocks(true, "ollama")).toBe(false);
  });

  it("in a patent room, blocks every cloud provider (and unknown/empty)", () => {
    for (const p of ["openrouter", "openai", "anthropic", "gemini", "", null, undefined]) {
      expect(patentRoomBlocks(true, p as any)).toBe(true);
    }
  });
});
