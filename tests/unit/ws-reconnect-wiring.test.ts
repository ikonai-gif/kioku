/**
 * R418 — wiring invariants
 *
 * Static-source guards: both WS-using pages must use `nextBackoffMs`
 * from `@/lib/ws-reconnect` for their reconnect timer. If anyone ever
 * reverts to a fixed `setTimeout(connect, 3000)`, this fails.
 *
 * Phase 6 PR-C (R-luca-computer-ui) — partner-chat's inline WS effect
 * was collapsed into the shared `useKiokuWebSocket()` hook. The R418
 * invariants (backoff import + `reconnectAttempt = 0` reset + no fixed
 * timeout) now live in the hook. We still assert that partner-chat
 * consumes the shared hook — which transitively enforces R418.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const repoRoot = join(__dirname, "..", "..");

const partnerChat = readFileSync(
  join(repoRoot, "client", "src", "pages", "partner-chat.tsx"),
  "utf8",
);
const roomDetail = readFileSync(
  join(repoRoot, "client", "src", "pages", "room-detail.tsx"),
  "utf8",
);
const kiokuWsHook = readFileSync(
  join(repoRoot, "client", "src", "hooks", "useKiokuWebSocket.ts"),
  "utf8",
);

describe("R418 — WS reconnect wiring", () => {
  it("shared useKiokuWebSocket hook imports nextBackoffMs from @/lib/ws-reconnect", () => {
    expect(kiokuWsHook).toMatch(
      /import\s*\{\s*nextBackoffMs\s*\}\s*from\s*["']@\/lib\/ws-reconnect["']/,
    );
  });

  it("partner-chat consumes shared useKiokuWebSocket hook (R418 via hook)", () => {
    expect(partnerChat).toMatch(
      /import\s*\{[^}]*useKiokuWebSocket[^}]*\}\s*from\s*["']@\/hooks\/useKiokuWebSocket["']/,
    );
  });

  it("room-detail imports nextBackoffMs from @/lib/ws-reconnect", () => {
    expect(roomDetail).toMatch(
      /import\s*\{\s*nextBackoffMs\s*\}\s*from\s*["']@\/lib\/ws-reconnect["']/,
    );
  });

  it("shared hook does not use a fixed reconnect timeout (regression guard)", () => {
    expect(kiokuWsHook).not.toMatch(/setTimeout\([^,]+,\s*3000\s*\)/);
    expect(kiokuWsHook).toMatch(/nextBackoffMs\s*\(/);
  });

  it("room-detail does not use a fixed reconnect timeout (regression guard)", () => {
    expect(roomDetail).not.toMatch(/setTimeout\(\s*connect\s*,\s*3000\s*\)/);
    expect(roomDetail).toMatch(/setTimeout\(\s*connect\s*,\s*\w+\s*\)/);
  });

  it("shared hook resets reconnectAttempt on ws open", () => {
    expect(kiokuWsHook).toMatch(/reconnectAttempt\s*=\s*0/);
  });

  it("room-detail resets reconnectAttempt on ws.onopen", () => {
    expect(roomDetail).toMatch(/reconnectAttempt\s*=\s*0/);
  });
});
