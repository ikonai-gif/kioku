/**
 * Phase 6 PR-D (R-luca-computer-ui hot-fix) — pure-logic tests for the
 * stale-override downgrade decision and the enter-computer transition.
 *
 * BRO1 R450:
 *   - N3: stale-override downgrade is one-shot (driven by `armed`) and only
 *     fires when override="computer" but no computer step is running.
 *   - Q-D5: 30s user-explicit-override guard window — if the user just clicked
 *     the toggle, we MUST honour their choice and not downgrade.
 *   - shouldFireEnterComputer: prev=null|chat → curr=computer fires once;
 *     prev=computer is a no-op; curr=chat never fires.
 */

import { describe, expect, it } from "vitest";

import {
  USER_OVERRIDE_GUARD_MS,
  decideStaleOverrideAction,
  shouldFireEnterComputer,
} from "@/lib/luca-canvas-mode";

const NOW = 1_700_000_000_000;

describe("decideStaleOverrideAction (BRO1 R450 N3 + Q-D5)", () => {
  it("returns 'wait' when guard is already disarmed", () => {
    expect(
      decideStaleOverrideAction({
        armed: false,
        override: "computer",
        hasComputerStep: false,
        userOverrodeAtMs: null,
        userOverrodeMode: null,
        nowMs: NOW,
      }),
    ).toBe("wait");
  });

  it("returns 'wait' when override is not computer (auto / chat are not stale-able)", () => {
    expect(
      decideStaleOverrideAction({
        armed: true,
        override: "auto",
        hasComputerStep: false,
        userOverrodeAtMs: null,
        userOverrodeMode: null,
        nowMs: NOW,
      }),
    ).toBe("wait");

    expect(
      decideStaleOverrideAction({
        armed: true,
        override: "chat",
        hasComputerStep: false,
        userOverrodeAtMs: null,
        userOverrodeMode: null,
        nowMs: NOW,
      }),
    ).toBe("wait");
  });

  it("returns 'disarm' when a computer step is currently running (override is justified)", () => {
    expect(
      decideStaleOverrideAction({
        armed: true,
        override: "computer",
        hasComputerStep: true,
        userOverrodeAtMs: null,
        userOverrodeMode: null,
        nowMs: NOW,
      }),
    ).toBe("disarm");
  });

  it("returns 'downgrade' when armed + override=computer + no step + no recent user override", () => {
    expect(
      decideStaleOverrideAction({
        armed: true,
        override: "computer",
        hasComputerStep: false,
        userOverrodeAtMs: null,
        userOverrodeMode: null,
        nowMs: NOW,
      }),
    ).toBe("downgrade");
  });

  it("returns 'downgrade' when the last user override was OUTSIDE the 30s guard window", () => {
    expect(
      decideStaleOverrideAction({
        armed: true,
        override: "computer",
        hasComputerStep: false,
        userOverrodeAtMs: NOW - USER_OVERRIDE_GUARD_MS - 1,
        userOverrodeMode: "computer",
        nowMs: NOW,
      }),
    ).toBe("downgrade");
  });

  it("returns 'wait' when the user EXPLICITLY chose computer within the 30s guard window (Q-D5)", () => {
    expect(
      decideStaleOverrideAction({
        armed: true,
        override: "computer",
        hasComputerStep: false,
        userOverrodeAtMs: NOW - 5_000, // 5s ago, well inside guard
        userOverrodeMode: "computer",
        nowMs: NOW,
      }),
    ).toBe("wait");
  });

  it("returns 'wait' at the exact boundary minus 1ms (still inside guard)", () => {
    expect(
      decideStaleOverrideAction({
        armed: true,
        override: "computer",
        hasComputerStep: false,
        userOverrodeAtMs: NOW - (USER_OVERRIDE_GUARD_MS - 1),
        userOverrodeMode: "computer",
        nowMs: NOW,
      }),
    ).toBe("wait");
  });

  it("downgrades when userOverrodeMode is not 'computer' even within the window", () => {
    // User chose chat 5s ago → not protecting a computer override, downgrade ok.
    expect(
      decideStaleOverrideAction({
        armed: true,
        override: "computer",
        hasComputerStep: false,
        userOverrodeAtMs: NOW - 5_000,
        userOverrodeMode: "chat",
        nowMs: NOW,
      }),
    ).toBe("downgrade");
  });

  it("guard requires both timestamp AND mode set; null timestamp → not protected", () => {
    expect(
      decideStaleOverrideAction({
        armed: true,
        override: "computer",
        hasComputerStep: false,
        userOverrodeAtMs: null,
        userOverrodeMode: "computer",
        nowMs: NOW,
      }),
    ).toBe("downgrade");
  });

  it("disarm wins over the user-override guard when a step is actually running", () => {
    // User just clicked computer 1s ago AND a step is running → disarm (not wait).
    expect(
      decideStaleOverrideAction({
        armed: true,
        override: "computer",
        hasComputerStep: true,
        userOverrodeAtMs: NOW - 1_000,
        userOverrodeMode: "computer",
        nowMs: NOW,
      }),
    ).toBe("disarm");
  });
});

describe("shouldFireEnterComputer (BRO1 R450 transition-ref)", () => {
  it("fires on initial mount when curr=computer (prev=null)", () => {
    expect(shouldFireEnterComputer(null, "computer")).toBe(true);
  });

  it("fires on chat → computer transition", () => {
    expect(shouldFireEnterComputer("chat", "computer")).toBe(true);
  });

  it("does NOT fire on computer → computer (no-op render)", () => {
    expect(shouldFireEnterComputer("computer", "computer")).toBe(false);
  });

  it("never fires when curr=chat (host owns chat→? collapse)", () => {
    expect(shouldFireEnterComputer(null, "chat")).toBe(false);
    expect(shouldFireEnterComputer("chat", "chat")).toBe(false);
    expect(shouldFireEnterComputer("computer", "chat")).toBe(false);
  });
});
