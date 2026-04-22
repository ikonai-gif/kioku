/**
 * Luca V1a Day -1 — TRUST registry unit tests.
 *
 * Pins the dispatcher contract:
 *   - per-sourceType verifier wins over default,
 *   - missing verifier → default (UNKNOWN out of the box on Day -1),
 *   - thrown verifier → fail-closed SUSPECT,
 *   - overwrite warns but succeeds (for re-registration in tests).
 *
 * Day 3 will add canary + attack-signature verifiers on top of this.
 */
import { describe, expect, it, vi } from "vitest";
import {
  DefaultTrustRegistry,
  unknownVerifier,
  getTrustRegistry,
  __setTrustRegistryForTests,
  type TrustVerifier,
  type TrustSample,
} from "../../lib/luca/trust-registry";

function sample(sourceType: string, content = "hello"): TrustSample {
  return { sourceType, content };
}

describe("luca/trust-registry — DefaultTrustRegistry", () => {
  it("returns UNKNOWN from unknownVerifier when no verifier is registered", async () => {
    const reg = new DefaultTrustRegistry();
    const r = await reg.verify(sample("brave_search"));
    expect(r.verdict).toBe("UNKNOWN");
    expect(r.signal).toBe("no_verifier_registered");
    expect(r.verifierName).toBe("__unknown_default__");
  });

  it("dispatches to per-sourceType verifier when registered", async () => {
    const reg = new DefaultTrustRegistry();
    const v: TrustVerifier = {
      name: "brave_test",
      verify: vi.fn(async () => ({
        verdict: "VERIFIED" as const,
        signal: "canary_ok",
        detail: "ok",
        verifierName: "brave_test",
      })),
    };
    reg.register("brave_search", v);
    const r = await reg.verify(sample("brave_search"));
    expect(r.verdict).toBe("VERIFIED");
    expect(v.verify).toHaveBeenCalledOnce();
  });

  it("falls back to custom default when setDefault() was called", async () => {
    const reg = new DefaultTrustRegistry();
    reg.setDefault({
      name: "suspect_default",
      verify: async () => ({
        verdict: "SUSPECT",
        signal: "conservative_default",
        detail: "policy",
        verifierName: "suspect_default",
      }),
    });
    const r = await reg.verify(sample("unregistered_source"));
    expect(r.verdict).toBe("SUSPECT");
    expect(r.verifierName).toBe("suspect_default");
  });

  it("fails CLOSED (SUSPECT) when a verifier throws", async () => {
    const reg = new DefaultTrustRegistry();
    reg.register("read_url", {
      name: "buggy",
      verify: async () => {
        throw new Error("boom");
      },
    });
    const r = await reg.verify(sample("read_url"));
    expect(r.verdict).toBe("SUSPECT");
    expect(r.signal).toBe("verifier_error");
    expect(r.detail).toContain("boom");
    expect(r.verifierName).toBe("buggy");
  });

  it("overwrite of a registered verifier warns but replaces", async () => {
    const reg = new DefaultTrustRegistry();
    const v1: TrustVerifier = {
      name: "first",
      verify: async () => ({ verdict: "VERIFIED", signal: "x", detail: "", verifierName: "first" }),
    };
    const v2: TrustVerifier = {
      name: "second",
      verify: async () => ({ verdict: "SUSPECT", signal: "y", detail: "", verifierName: "second" }),
    };
    reg.register("brave_search", v1);
    reg.register("brave_search", v2);
    const r = await reg.verify(sample("brave_search"));
    expect(r.verifierName).toBe("second");
  });

  it("listRegistered returns sorted source types", () => {
    const reg = new DefaultTrustRegistry();
    const stub: TrustVerifier = {
      name: "s",
      verify: async () => ({ verdict: "UNKNOWN", signal: "", detail: "", verifierName: "s" }),
    };
    reg.register("read_url", stub);
    reg.register("brave_search", stub);
    reg.register("run_code_stdout", stub);
    expect(reg.listRegistered()).toEqual(["brave_search", "read_url", "run_code_stdout"]);
  });

  it("passes sample.meta through untouched to the verifier", async () => {
    const reg = new DefaultTrustRegistry();
    const seen: TrustSample[] = [];
    reg.register("brave_search", {
      name: "capture",
      verify: async (s) => {
        seen.push(s);
        return { verdict: "VERIFIED", signal: "ok", detail: "", verifierName: "capture" };
      },
    });
    await reg.verify({ sourceType: "brave_search", content: "x", meta: { slot: 42 } });
    expect(seen[0].meta).toEqual({ slot: 42 });
  });

  it("unknownVerifier itself returns UNKNOWN with stub signal", async () => {
    const r = await unknownVerifier.verify(sample("anything"));
    expect(r.verdict).toBe("UNKNOWN");
    expect(r.signal).toBe("no_verifier_registered");
  });
});

describe("luca/trust-registry — singleton", () => {
  it("getTrustRegistry returns the same instance across calls", () => {
    __setTrustRegistryForTests(null);
    const a = getTrustRegistry();
    const b = getTrustRegistry();
    expect(a).toBe(b);
    __setTrustRegistryForTests(null);
  });

  it("__setTrustRegistryForTests replaces the singleton", () => {
    const custom = new DefaultTrustRegistry();
    __setTrustRegistryForTests(custom);
    expect(getTrustRegistry()).toBe(custom);
    __setTrustRegistryForTests(null);
  });
});
