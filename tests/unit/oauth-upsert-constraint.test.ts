/**
 * Hot-fix regression test — Drive & Dropbox OAuth UPSERTs must match the
 * actual prod unique index on user_integrations.
 *
 * Background:
 *   Prod DB has a single 3-column UNIQUE index:
 *     CREATE UNIQUE INDEX user_integrations_user_provider_email_key
 *       ON user_integrations (user_id, provider, COALESCE(email, ''))
 *
 *   The Drizzle schema at shared/schema.ts:331 still declares the legacy
 *   2-column unique(user_id, provider), but no migration has converted that
 *   back in prod. The 3-column index won the migration race when Gmail
 *   multi-account support shipped.
 *
 *   ON CONFLICT inference in Postgres requires an EXACT column-set match
 *   against a unique constraint OR a non-partial unique index. A 2-column
 *   ON CONFLICT spec cannot resolve against a 3-column expression index,
 *   even if (user_id, provider) is a prefix of it. The callback throws:
 *     "there is no unique or exclusion constraint matching the
 *      ON CONFLICT specification"
 *
 *   This test pins the file to the 3-column form so a future "tidy-up"
 *   doesn't silently regress to the 2-column form and break OAuth again.
 *
 * Invariants:
 *   1) Every ON CONFLICT on user_integrations writes lists exactly
 *      `(user_id, provider, COALESCE(email, ''))`.
 *   2) The bare 2-column `ON CONFLICT (user_id, provider)` does not appear
 *      anywhere in cloud-integrations.ts.
 *   3) At least two such 3-column ON CONFLICT clauses exist — Drive (~line 984)
 *      and Dropbox (~line 1031). Gmail uses a manual check-then-update flow
 *      so it does not count.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(
  resolve(__dirname, "../../server/cloud-integrations.ts"),
  "utf8",
);

describe("OAuth UPSERT — ON CONFLICT must match prod 3-col unique index", () => {
  it("contains the 3-column ON CONFLICT form at least twice (Drive + Dropbox)", () => {
    const matches = source.match(
      /ON CONFLICT \(user_id, provider, COALESCE\(email, ''\)\)/g,
    );
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });

  it("does NOT contain the bare 2-column ON CONFLICT form (the bug we fixed)", () => {
    // Negative regex: an `ON CONFLICT (user_id, provider)` followed by a `)`
    // closing the conflict target — i.e. nothing after `provider` before the
    // closing paren. The fixed form has `, COALESCE(...)` between `provider`
    // and the closing paren, so it will not match.
    expect(source).not.toMatch(/ON CONFLICT \(user_id, provider\)\s/);
  });

  it("the conflict target shape exactly mirrors the prod unique index", () => {
    // Prod index def (from pg_indexes):
    //   CREATE UNIQUE INDEX user_integrations_user_provider_email_key
    //     ON public.user_integrations USING btree
    //     (user_id, provider, COALESCE(email, ''::text))
    //
    // Postgres ON CONFLICT matching is by column-list inference; the
    // expression in the index `COALESCE(email, ''::text)` matches the
    // ON CONFLICT expression `COALESCE(email, '')` because '' is coerced
    // to text in both. Verify the source uses the unquoted-cast form.
    const ok = /ON CONFLICT \(user_id, provider, COALESCE\(email, ''\)\)/.test(source);
    expect(ok).toBe(true);
  });
});
