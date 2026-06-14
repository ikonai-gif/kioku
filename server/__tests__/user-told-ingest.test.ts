import { describe, it, expect, vi } from "vitest";
import {
  isGreeting,
  isCommand,
  hasFactOrEntitySignal,
  userToldIneligibleReason,
  shouldCreateUserToldMemory,
  ingestUserToldMemory,
} from "../lib/user-told-ingest";

describe("user-told-ingest heuristics", () => {
  it("isGreeting catches trivial acks", () => {
    expect(isGreeting("привет")).toBe(true);
    expect(isGreeting("ok")).toBe(true);
    expect(isGreeting("спасибо!")).toBe(true);
    expect(isGreeting("Котэ решил подавать патент")).toBe(false);
  });

  it("isCommand catches slash/bang commands", () => {
    expect(isCommand("/deploy")).toBe(true);
    expect(isCommand("  !run")).toBe(true);
    expect(isCommand("обычный текст")).toBe(false);
  });

  it("hasFactOrEntitySignal: digit / proper noun / keyword", () => {
    expect(hasFactOrEntitySignal("встреча в 14:00")).toBe(true);   // digit
    expect(hasFactOrEntitySignal("Nicole любит театр")).toBe(true); // proper noun
    expect(hasFactOrEntitySignal("я решил уйти")).toBe(true);       // keyword
    expect(hasFactOrEntitySignal("просто болтаю ни о чём тут")).toBe(false);
  });

  it("userToldIneligibleReason orders checks correctly", () => {
    expect(userToldIneligibleReason("ok")).toBe("too_short");
    expect(userToldIneligibleReason("/deploy now to production please")).toBe("command");
    expect(userToldIneligibleReason("просто болтаю ни о чём сейчас тут")).toBe("no_fact_or_entity_signal");
    // eligible → null
    expect(userToldIneligibleReason("Котэ решил подавать патент C в этом месяце")).toBeNull();
    expect(shouldCreateUserToldMemory("Котэ решил подавать патент C в этом месяце")).toBe(true);
  });
});

describe("ingestUserToldMemory orchestration", () => {
  const eligible = "Котэ решил подавать патент C в этом месяце";

  it("creates a user_told memory when eligible and not duplicate", async () => {
    const storage = {
      hasRecentUserToldDuplicate: vi.fn().mockResolvedValue(false),
      createMemory: vi.fn().mockResolvedValue({ id: 1 }),
    };
    const r = await ingestUserToldMemory(storage, 10, eligible);
    expect(r.created).toBe(true);
    expect(storage.createMemory).toHaveBeenCalledTimes(1);
    const arg = storage.createMemory.mock.calls[0][0];
    expect(arg.provenance).toBe("user_told");
    expect(arg.userId).toBe(10);
  });

  it("skips when a recent duplicate exists", async () => {
    const storage = {
      hasRecentUserToldDuplicate: vi.fn().mockResolvedValue(true),
      createMemory: vi.fn(),
    };
    const r = await ingestUserToldMemory(storage, 10, eligible);
    expect(r.created).toBe(false);
    expect(r.reason).toBe("recent_duplicate");
    expect(storage.createMemory).not.toHaveBeenCalled();
  });

  it("skips ineligible content without touching storage", async () => {
    const storage = {
      hasRecentUserToldDuplicate: vi.fn(),
      createMemory: vi.fn(),
    };
    const r = await ingestUserToldMemory(storage, 10, "ok");
    expect(r.created).toBe(false);
    expect(r.reason).toBe("too_short");
    expect(storage.hasRecentUserToldDuplicate).not.toHaveBeenCalled();
    expect(storage.createMemory).not.toHaveBeenCalled();
  });
});
