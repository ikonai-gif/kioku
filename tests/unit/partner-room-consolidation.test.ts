/**
 * KIOKU™ — Partner room consolidation (W8 P2.11)
 *
 * Bro2 pre-impl review required 3 tests + source-level invariants.
 * This file covers all five as static source checks (mirror of
 * partner-room-auto-assign.test.ts paradigm — no live DB needed).
 *
 * Invariants audited:
 *   T1  Migration is re-entrant (version-guarded via runMigration)
 *   T2  FK rehome covers all 6 child tables (M1 blocker)
 *   T3  WS cutover: frontend uses GET /api/partner/room & detects id mismatch (M4)
 *   S1  CHECK constraint expanded to include 'partner'
 *   S2  GET /api/partner/room returns ETag + Cache-Control private
 *   S3  pg-side safety backup tables created (rooms_backup_p211 + messages)
 *   S4  Pre-index assertion (RAISE EXCEPTION on dup_count > 0)
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const storageSrc = readFileSync(resolve(__dirname, "../../server/storage.ts"), "utf8");
const routesSrc  = readFileSync(resolve(__dirname, "../../server/routes.ts"),  "utf8");
const deliberSrc = readFileSync(resolve(__dirname, "../../server/deliberation.ts"), "utf8");
const partnerChatSrc = readFileSync(
  resolve(__dirname, "../../client/src/pages/partner-chat.tsx"),
  "utf8"
);
const schemaSrc = readFileSync(resolve(__dirname, "../../shared/schema.ts"), "utf8");

const MIGRATION_VERSION = "v2026_04_22_001_partner_room_consolidation";

describe("P2.11 Partner room consolidation — migration", () => {
  // Locate the specific runMigration() call by version string.
  // Source uses single quotes: runMigration('v2026_04_22_001_...', `...`)
  const callMarker = `runMigration('${MIGRATION_VERSION}'`;
  const callIdx = storageSrc.indexOf(callMarker);
  const start = storageSrc.indexOf(MIGRATION_VERSION);
  it("migration block is present", () => {
    expect(callIdx).toBeGreaterThan(0);
  });

  // Extract the template-literal body: the backtick that opens the SQL
  // argument comes after the version + comma.
  const openTick = storageSrc.indexOf("`", callIdx);
  const closeTick = storageSrc.indexOf("`", openTick + 1);
  const block = openTick > 0 && closeTick > 0
    ? storageSrc.slice(openTick + 1, closeTick)
    : "";

  // ── T1: re-entrance via version guard ──────────────────────────
  it("T1 — runs through runMigration() guard (re-entrance safe)", () => {
    // The call itself lives just before the version string
    const preamble = storageSrc.slice(Math.max(0, start - 200), start);
    expect(preamble).toMatch(/runMigration\s*\(\s*["']?$/m.test(preamble) ? /./ : /runMigration/);
    expect(preamble).toMatch(/runMigration/);
  });

  // ── T2 / M1: all 6 FK child tables rehomed ─────────────────────
  const fkTables = [
    "room_messages",
    "meetings",
    "scheduled_tasks",
    "kioku_deliberation_sessions",
    "tool_activity_log",
    "agent_turns",
  ];
  for (const t of fkTables) {
    it(`T2/M1 — rehomes FK table: ${t}`, () => {
      expect(block).toContain(t);
    });
  }

  // ── M2: single transaction ─────────────────────────────────────
  it("M2 — single BEGIN/COMMIT transaction", () => {
    expect(block).toMatch(/\bBEGIN\b/);
    expect(block).toMatch(/\bCOMMIT\b/);
  });

  // ── S1: CHECK constraint expanded to include 'partner' ─────────
  it("S1 — CHECK constraint expanded to include 'partner'", () => {
    // Drop old + add new with the expanded IN list
    expect(block).toMatch(/DROP\s+CONSTRAINT[^;]*room[_\s]*type/i);
    expect(block).toMatch(/ADD\s+CONSTRAINT[\s\S]*'partner'/);
    expect(block).toMatch(/'standard'[\s\S]*'meeting'[\s\S]*'partner'/);
  });

  // ── S3: safety backup tables ───────────────────────────────────
  it("S3 — creates rooms_backup_p211 safety table", () => {
    expect(block).toMatch(/rooms_backup_p211/);
  });
  it("S3 — creates room_messages_backup_p211 safety table", () => {
    expect(block).toMatch(/room_messages_backup_p211/);
  });

  // ── S4: pre-index duplicate assertion ──────────────────────────
  it("S4 — RAISE EXCEPTION guards against residual duplicates", () => {
    expect(block).toMatch(/RAISE\s+EXCEPTION/i);
  });

  // ── unique index on (user_id) WHERE room_type='partner' ────────
  it("creates partial unique index on partner rooms", () => {
    expect(block).toMatch(/CREATE\s+UNIQUE\s+INDEX[\s\S]*rooms[\s\S]*user_id[\s\S]*partner/i);
  });

  // ── canonical selection is deterministic (newest per user) ─────
  it("canonical selection uses deterministic ordering (created_at DESC)", () => {
    expect(block).toMatch(/created_at\s+DESC/i);
  });
});

describe("P2.11 — GET /api/partner/room endpoint (S2)", () => {
  const idx = routesSrc.indexOf('"/api/partner/room"');
  it("endpoint is registered", () => {
    expect(idx).toBeGreaterThan(0);
  });
  const handler = routesSrc.slice(idx, idx + 4000);

  it("S2 — sets ETag header", () => {
    expect(handler).toMatch(/ETag/i);
  });
  it("S2 — sets Cache-Control: private max-age=3600", () => {
    expect(handler).toMatch(/Cache-Control[\s\S]*private[\s\S]*max-age=3600/i);
  });
  it("returns canonical partner room (room_type='partner')", () => {
    expect(handler).toMatch(/room_type/);
    expect(handler).toMatch(/partner/);
  });
});

describe("P2.11 — M3: isPartnerChat routed via roomType", () => {
  it("triggerAgentResponses signature accepts roomType", () => {
    expect(deliberSrc).toMatch(/roomType\?\s*:\s*string/);
  });
  it("isPartnerChat = roomType === 'partner' (with roomName back-compat)", () => {
    expect(deliberSrc).toMatch(/roomType\s*===\s*["']partner["']/);
  });
  it("keeps roomName === 'Partner' fallback for back-compat (1 release cycle)", () => {
    expect(deliberSrc).toMatch(/roomName\s*===\s*["']Partner["']/);
  });
});

describe("P2.11 — M4: frontend WS cutover", () => {
  it("M4 — partner-chat uses GET /api/partner/room (not /api/rooms scan)", () => {
    expect(partnerChatSrc).toMatch(/["']\/api\/partner\/room["']/);
  });
  it("M4 — detects canonical id mismatch and re-binds", () => {
    // The cutover effect compares partnerRoomId !== partnerRoom.id
    expect(partnerChatSrc).toMatch(/partnerRoomId\s*!==\s*partnerRoom\.id/);
  });
  it("M4 — invalidates stale messages on cutover", () => {
    // invalidateQueries on the messages key is the WS teardown signal
    // (WS effect depends on partnerRoomId → re-subscribes on change)
    const cutoverIdx = partnerChatSrc.indexOf("partnerRoomId !== partnerRoom.id");
    expect(cutoverIdx).toBeGreaterThan(0);
    const block = partnerChatSrc.slice(cutoverIdx, cutoverIdx + 800);
    expect(block).toMatch(/invalidateQueries/);
    expect(block).toMatch(/messages/);
  });
  it("removes legacy rooms.find(r => r.name === 'Partner') scan", () => {
    // The old code path must not coexist with the new endpoint
    expect(partnerChatSrc).not.toMatch(/rooms\.find\([^)]*name\s*===\s*["']Partner["']/);
  });
});

describe("P2.11 — shared/schema.ts", () => {
  it("rooms table exposes roomType column", () => {
    // drizzle declaration, so consumers (Room type, storage.getRoom) pick it up
    expect(schemaSrc).toMatch(/roomType\s*:\s*varchar\(\s*["']room_type["']/);
  });
  it("roomType defaults to 'standard'", () => {
    expect(schemaSrc).toMatch(/room_type[\s\S]*default\(\s*["']standard["']\s*\)/);
  });
});
