/**
 * R418 — WebSocket reconnect backoff schedule contract
 *
 * Asserts the math behaves correctly under all conditions, including
 * deterministic RNGs at the jitter extremes and very high attempt counts.
 */
import { describe, it, expect } from "vitest";
import { nextBackoffMs, BACKOFF_CONFIG } from "../../client/src/lib/ws-reconnect";

describe("nextBackoffMs — schedule shape", () => {
  // Deterministic RNGs at jitter extremes
  const rngLow = () => 0; // jitter multiplier = 1 - jitter
  const rngHigh = () => 0.9999; // jitter multiplier ≈ 1 + jitter

  it("attempt=0 produces ~baseMs (within jitter band)", () => {
    const min = BACKOFF_CONFIG.baseMs * (1 - BACKOFF_CONFIG.jitter);
    const max = BACKOFF_CONFIG.baseMs * (1 + BACKOFF_CONFIG.jitter);
    expect(nextBackoffMs(0, rngLow)).toBeCloseTo(min, -1);
    expect(nextBackoffMs(0, rngHigh)).toBeLessThanOrEqual(max);
    expect(nextBackoffMs(0, rngHigh)).toBeGreaterThan(BACKOFF_CONFIG.baseMs * 0.99);
  });

  it("doubles per attempt up to cap", () => {
    // mid-jitter: 1.0
    const rngMid = () => 0.5;
    const a0 = nextBackoffMs(0, rngMid);
    const a1 = nextBackoffMs(1, rngMid);
    const a2 = nextBackoffMs(2, rngMid);
    const a3 = nextBackoffMs(3, rngMid);
    expect(a1).toBeCloseTo(a0 * BACKOFF_CONFIG.factor, -1);
    expect(a2).toBeCloseTo(a0 * Math.pow(BACKOFF_CONFIG.factor, 2), -1);
    expect(a3).toBeCloseTo(a0 * Math.pow(BACKOFF_CONFIG.factor, 3), -1);
  });

  it("never exceeds capMs * (1 + jitter)", () => {
    const ceiling = BACKOFF_CONFIG.capMs * (1 + BACKOFF_CONFIG.jitter);
    for (let i = 0; i < 100; i++) {
      const v = nextBackoffMs(i, rngHigh);
      expect(v).toBeLessThanOrEqual(ceiling + 1);
    }
  });

  it("never below baseMs * (1 - jitter)", () => {
    const floor = BACKOFF_CONFIG.baseMs * (1 - BACKOFF_CONFIG.jitter);
    for (let i = 0; i < 100; i++) {
      const v = nextBackoffMs(i, rngLow);
      expect(v).toBeGreaterThanOrEqual(floor - 1);
    }
  });

  it("attempt=10 saturates at cap (with jitter)", () => {
    // 1000 * 2^10 = 1,024,000 — way past 30k cap; output is 30k * (1±0.2)
    const v = nextBackoffMs(10, () => 0.5);
    expect(v).toBeCloseTo(BACKOFF_CONFIG.capMs, -1);
  });

  it("negative or fractional attempt is treated as 0", () => {
    const v = nextBackoffMs(-5, () => 0.5);
    expect(v).toBeCloseTo(BACKOFF_CONFIG.baseMs, -1);
    const w = nextBackoffMs(0.7, () => 0.5);
    expect(w).toBeCloseTo(BACKOFF_CONFIG.baseMs, -1);
  });

  it("jitter spread is non-zero across calls (sanity)", () => {
    const samples = new Set<number>();
    for (let i = 0; i < 50; i++) samples.add(nextBackoffMs(3));
    // 50 random samples, jittered — should produce > 1 unique value
    expect(samples.size).toBeGreaterThan(1);
  });

  it("BACKOFF_CONFIG values are sane (no regressions)", () => {
    expect(BACKOFF_CONFIG.baseMs).toBeGreaterThan(0);
    expect(BACKOFF_CONFIG.capMs).toBeGreaterThan(BACKOFF_CONFIG.baseMs);
    expect(BACKOFF_CONFIG.factor).toBeGreaterThan(1);
    expect(BACKOFF_CONFIG.jitter).toBeGreaterThan(0);
    expect(BACKOFF_CONFIG.jitter).toBeLessThan(1);
  });
});
