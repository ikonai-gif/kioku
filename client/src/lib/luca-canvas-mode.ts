/**
 * Phase 6 PR-A (R-luca-computer-ui) — pure logic for the Luca Canvas mode
 * router. Kept framework-free so it can run under the default vitest
 * `environment: "node"` config without jsdom.
 *
 * Mode machine
 * ───────────
 *  - "auto" (default): canvas mirrors `hasComputerStep` from the activity
 *    poller. Whenever a long-running browser tool starts, layout slides into
 *    `computer`; once the last such step finishes (and the user hasn't pinned
 *    the layout open) it slides back to `chat`.
 *  - "chat": user explicitly forced chat layout. We honour it until they
 *    flip the toggle again. Activity poller is ignored.
 *  - "computer": user explicitly forced computer layout. Same idea — honoured
 *    until they flip back. Useful for "I want to see Luca's last run" review
 *    after the step finished.
 *
 * The override is persisted per-room (`localStorage["luca:layout:<roomId>"]`)
 * so reload doesn't surprise the user. We never persist "auto" — the absence
 * of a key IS auto.
 *
 * Auto-trigger (BRO1 R446 Q2)
 * ───────────────────────────
 * Only the long-running visual tools count: `luca_agent_browser` (10–60s
 * Stagehand-driven) and `browse_website` (3–10s Puppeteer-driven). Faster
 * tools (run_code, read_url, screenshot, …) finish in 0.5–5s; flipping the
 * layout for them would be screen flicker. The list lives in
 * COMPUTER_MODE_TOOLS so server tool-naming stays the source of truth.
 *
 * Responsive cap (BRO1 R446 Q1)
 * ─────────────────────────────
 * Below VIEWPORT_MIN_PX the computer layout collapses (the chat dock can't
 * shrink below ~280px; squeezing both columns into <900px wastes screen and
 * looks worse than the old sidebar). When the viewport is narrow we hard-pin
 * the resolved mode to "chat" regardless of override or auto signal — the
 * stored override is preserved so resizing back upgrades it again.
 */

export type LucaCanvasMode = "chat" | "computer";
export type LucaCanvasOverride = "auto" | LucaCanvasMode;

/** Tool names (matching `tool_activity_log.tool`) that flip canvas to computer. */
export const COMPUTER_MODE_TOOLS = ["luca_agent_browser", "browse_website"] as const;

/** Below this viewport width we forcibly stay in chat layout. */
export const VIEWPORT_MIN_PX = 900;

const LS_PREFIX = "luca:layout:";

function lsKey(roomId: number): string {
  return `${LS_PREFIX}${roomId}`;
}

/**
 * Read the user's stored override for a room. Defensive: localStorage can
 * throw in private browsing / SSR / disabled-storage configurations.
 */
export function readStoredOverride(
  roomId: number,
  storage: Pick<Storage, "getItem"> | null = typeof window !== "undefined" ? window.localStorage : null,
): LucaCanvasOverride {
  if (!storage) return "auto";
  try {
    const raw = storage.getItem(lsKey(roomId));
    if (raw === "chat" || raw === "computer") return raw;
    return "auto";
  } catch {
    return "auto";
  }
}

/**
 * Persist (or clear) an override. Storing "auto" wipes the key so a future
 * reader sees a clean slate.
 */
export function writeStoredOverride(
  roomId: number,
  override: LucaCanvasOverride,
  storage: Pick<Storage, "setItem" | "removeItem"> | null = typeof window !== "undefined" ? window.localStorage : null,
): void {
  if (!storage) return;
  try {
    if (override === "auto") {
      storage.removeItem(lsKey(roomId));
    } else {
      storage.setItem(lsKey(roomId), override);
    }
  } catch {
    /* best-effort — private mode etc. */
  }
}

/**
 * Decide the resolved mode given the override, the live activity signal,
 * and the current viewport width. Pure function; no side effects.
 */
export function resolveMode(input: {
  override: LucaCanvasOverride;
  hasComputerStep: boolean;
  viewportWidth: number;
}): LucaCanvasMode {
  if (input.viewportWidth < VIEWPORT_MIN_PX) return "chat";
  if (input.override === "chat") return "chat";
  if (input.override === "computer") return "computer";
  // override === "auto"
  return input.hasComputerStep ? "computer" : "chat";
}

/**
 * Helper for the activity poller: does this tool name trigger computer mode?
 * Centralised so the hook and the tests share the same predicate.
 */
export function isComputerModeTool(tool: string | null | undefined): boolean {
  if (!tool) return false;
  return (COMPUTER_MODE_TOOLS as readonly string[]).includes(tool);
}

/**
 * Reduce a poller payload to the boolean "should auto-flip on" signal.
 * `running` is the only status that counts as an active computer step.
 */
export function detectComputerStepRunning(
  rows: Array<{ tool?: string | null; status?: string | null }>,
): boolean {
  for (const r of rows) {
    if (r.status === "running" && isComputerModeTool(r.tool)) return true;
  }
  return false;
}

/**
 * Cycle the user-visible toggle. The button has three states (auto / chat /
 * computer) but we only let the user pick chat ↔ computer; "auto" is the
 * default they get on first visit and after clearing storage. The cycle
 * here is "if currently resolved chat → force computer; else → force chat".
 * Auto re-engagement is intentionally a separate UX (a small "сбросить"
 * link in the tooltip) and lives in the component, not here.
 */
export function nextOverrideForToggle(
  currentResolved: LucaCanvasMode,
): LucaCanvasOverride {
  return currentResolved === "computer" ? "chat" : "computer";
}

// ── Phase 6 PR-D (R-luca-computer-ui hot-fix) helpers ────────────────────

/**
 * BRO1 R450 Q-D5 — user explicit-override protection window. After the user
 * clicks the toggle pill, the stale-override downgrade guard MUST refuse
 * to fight their choice for this many ms.
 */
export const USER_OVERRIDE_GUARD_MS = 30_000;

/**
 * BRO1 R450 N3 — decide whether the stale-override downgrade should fire.
 *
 * Inputs:
 *   - `armed`: one-shot guard. False = already ran for this room hydration.
 *   - `override`: current resolved override. Only "computer" is downgrade-able.
 *   - `hasComputerStep`: true when the activity poller sees a running
 *     luca_agent_browser / browse_website step.
 *   - `userOverrodeAtMs`: timestamp of the last explicit setOverride call.
 *   - `userOverrodeMode`: mode the user explicitly chose (companion to the
 *     timestamp).
 *   - `nowMs`: injected clock for tests.
 *
 * Returns:
 *   - "downgrade": fire setOverride("auto") + writeStoredOverride("auto").
 *   - "disarm":   stop trying for this hydration cycle but DON'T touch override.
 *                 (user explicitly chose computer, or a step is running).
 *   - "wait":     keep the guard armed and re-check on next render.
 */
export type StaleOverrideDecision = "downgrade" | "disarm" | "wait";

export function decideStaleOverrideAction(input: {
  armed: boolean;
  override: LucaCanvasOverride;
  hasComputerStep: boolean;
  userOverrodeAtMs: number | null;
  userOverrodeMode: LucaCanvasOverride | null;
  nowMs: number;
}): StaleOverrideDecision {
  if (!input.armed) return "wait"; // no-op, guard already disarmed
  if (input.override !== "computer") return "wait"; // only computer is stale-able
  if (input.hasComputerStep) return "disarm"; // override is justified now

  const recentlyForced =
    input.userOverrodeAtMs !== null &&
    input.userOverrodeMode === "computer" &&
    input.nowMs - input.userOverrodeAtMs < USER_OVERRIDE_GUARD_MS;
  if (recentlyForced) return "wait"; // honour user, recheck next tick

  return "downgrade";
}

/**
 * BRO1 R450 — transition-ref decision for `onEnterComputerMode`. Returns
 * true iff the host should fire the callback right now.
 *
 *   prev=null   + curr=computer → true (initial mount lands in computer)
 *   prev=chat   + curr=computer → true (chat→computer transition)
 *   prev=comp   + curr=computer → false (no-op re-render)
 *   any         + curr=chat     → false (host owns chat→? collapse policy)
 */
export function shouldFireEnterComputer(
  prev: LucaCanvasMode | null,
  curr: LucaCanvasMode,
): boolean {
  return curr === "computer" && prev !== "computer";
}
