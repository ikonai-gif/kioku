/**
 * R418 — wiring invariants
 *
 * Static-source guards: both WS-using pages must use `nextBackoffMs`
 * from `@/lib/ws-reconnect` for their reconnect timer. If anyone ever
 * reverts to a fixed `setTimeout(connect, 3000)`, this fails.
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

describe("R418 — WS reconnect wiring", () => {
  it("partner-chat imports nextBackoffMs from @/lib/ws-reconnect", () => {
    expect(partnerChat).toMatch(
      /import\s*\{\s*nextBackoffMs\s*\}\s*from\s*["']@\/lib\/ws-reconnect["']/,
    );
  });

  it("room-detail imports nextBackoffMs from @/lib/ws-reconnect", () => {
    expect(roomDetail).toMatch(
      /import\s*\{\s*nextBackoffMs\s*\}\s*from\s*["']@\/lib\/ws-reconnect["']/,
    );
  });

  it("partner-chat does not use a fixed reconnect timeout (regression guard)", () => {
    // No setTimeout(connect, 3000) — must call nextBackoffMs() somewhere
    expect(partnerChat).not.toMatch(/setTimeout\(\s*connect\s*,\s*3000\s*\)/);
    expect(partnerChat).toMatch(/setTimeout\(\s*connect\s*,\s*\w+\s*\)/);
  });

  it("room-detail does not use a fixed reconnect timeout (regression guard)", () => {
    expect(roomDetail).not.toMatch(/setTimeout\(\s*connect\s*,\s*3000\s*\)/);
    expect(roomDetail).toMatch(/setTimeout\(\s*connect\s*,\s*\w+\s*\)/);
  });

  it("partner-chat resets reconnectAttempt on ws.onopen", () => {
    expect(partnerChat).toMatch(/reconnectAttempt\s*=\s*0/);
  });

  it("room-detail resets reconnectAttempt on ws.onopen", () => {
    expect(roomDetail).toMatch(/reconnectAttempt\s*=\s*0/);
  });
});
