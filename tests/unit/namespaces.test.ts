// tests/unit/namespaces.test.ts
// PR-1 namespace enforcement: validator behavior + .ts <-> .json consistency.
import { readFileSync } from "fs";
import path from "path";
import {
  CANONICAL,
  CANONICAL_NAMES,
  LEGACY_ALIASES,
  SUFFIX_STRIP,
  PERSON_SLUGS,
  normalizeNamespace,
  isSensitiveNamespace,
  slugify,
} from "@shared/namespaces";

describe("normalizeNamespace", () => {
  it("accepts canonical names unchanged", () => {
    for (const n of ["_reflections", "_commitment", "_aesthetics", "_relational", "decisions", "default"]) {
      const d = normalizeNamespace(n);
      expect(d.ok).toBe(true);
      expect(d.namespace).toBe(n);
      expect(d.mapped).toBe(false);
    }
  });

  it("maps explicit legacy aliases", () => {
    expect(normalizeNamespace("_reflection")).toMatchObject({ ok: true, namespace: "_reflections", mapped: true });
    expect(normalizeNamespace("_commitments")).toMatchObject({ ok: true, namespace: "_commitment", mapped: true });
    expect(normalizeNamespace("research")).toMatchObject({ ok: true, namespace: "knowledge:research", mapped: true });
    expect(normalizeNamespace("_knowledge_Art History")).toMatchObject({ ok: true, namespace: "knowledge:art_history", mapped: true });
    expect(normalizeNamespace("_relational:boss_alter")).toMatchObject({ ok: true, namespace: "_relational:boss", mapped: true });
    expect(normalizeNamespace("_series_bible:Meta-coder")).toMatchObject({ ok: true, namespace: "_series_bible:meta_coder", mapped: true });
  });

  it("strips tag-style colon suffixes to base", () => {
    expect(normalizeNamespace("_reflection:p2_10")).toMatchObject({ ok: true, namespace: "_reflections", mapped: true });
    expect(normalizeNamespace("_commitment:open")).toMatchObject({ ok: true, namespace: "_commitment", mapped: true });
    expect(normalizeNamespace("_meta_cognitive:relationship")).toMatchObject({ ok: true, namespace: "_meta_cognitive", mapped: true });
    expect(normalizeNamespace("_autobiographical:shiplog")).toMatchObject({ ok: true, namespace: "_autobiographical", mapped: true });
  });

  it("accepts valid knowledge: shards and normalizes messy ones", () => {
    expect(normalizeNamespace("knowledge:art_history")).toMatchObject({ ok: true, namespace: "knowledge:art_history", mapped: false });
    expect(normalizeNamespace("knowledge:Art History")).toMatchObject({ ok: true, namespace: "knowledge:art_history", mapped: true });
  });

  it("accepts registered _relational person-slugs, rejects unregistered", () => {
    expect(normalizeNamespace("_relational:kote")).toMatchObject({ ok: true, namespace: "_relational:kote" });
    expect(normalizeNamespace("_relational:bro2")).toMatchObject({ ok: true, namespace: "_relational:bro2" });
    const bad = normalizeNamespace("_relational:some_random_person");
    expect(bad.ok).toBe(false);
    expect(bad.reason).toMatch(/unregistered person-slug/);
  });

  it("slugifies freeform _series_bible suffixes (NOT in alias map)", () => {
    expect(normalizeNamespace("_series_bible:New Show!")).toMatchObject({ ok: true, namespace: "_series_bible:new_show", mapped: true });
  });

  it("rejects unknown namespaces", () => {
    const d = normalizeNamespace("totally_made_up");
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/unknown namespace/);
  });

  it("treats empty/null as pass-through null (no coercion)", () => {
    expect(normalizeNamespace("")).toMatchObject({ ok: true, namespace: null });
    expect(normalizeNamespace(null)).toMatchObject({ ok: true, namespace: null });
    expect(normalizeNamespace(undefined)).toMatchObject({ ok: true, namespace: null });
  });

  it("never strips entity prefixes via suffix rules", () => {
    // _relational:kote must remain scoped, NOT collapse to _relational
    expect(normalizeNamespace("_relational:kote").namespace).toBe("_relational:kote");
  });
});

describe("isSensitiveNamespace", () => {
  it("flags medical + system + human relational", () => {
    expect(isSensitiveNamespace("_health")).toBe(true);
    expect(isSensitiveNamespace("_allergies")).toBe(true);
    expect(isSensitiveNamespace("_relational:kote")).toBe(true);
    expect(isSensitiveNamespace("_relational:nicole")).toBe(true);
  });
  it("does NOT flag internal-agent relational or ordinary namespaces", () => {
    expect(isSensitiveNamespace("_relational:bro2")).toBe(false);
    expect(isSensitiveNamespace("_aesthetics")).toBe(false);
    expect(isSensitiveNamespace(null)).toBe(false);
  });
});

describe("slugify", () => {
  it("lowercases, replaces non-alnum with _, trims", () => {
    expect(slugify("IKONBAI Confidential")).toBe("ikonbai_confidential");
    expect(slugify("Meta-coder")).toBe("meta_coder");
    expect(slugify("  Art   History  ")).toBe("art_history");
  });
});

describe("namespaces.ts <-> namespaces.json consistency", () => {
  const json = JSON.parse(readFileSync(path.resolve(process.cwd(), "shared/namespaces.json"), "utf8"));

  it("canonical name sets match exactly", () => {
    const jsonNames = new Set<string>(json.canonical.map((c: any) => c.name));
    const tsNames = new Set<string>(CANONICAL.map((c) => c.name));
    expect([...tsNames].sort()).toEqual([...jsonNames].sort());
    expect(CANONICAL_NAMES.size).toBe(CANONICAL.length);
  });

  it("legacy aliases match exactly", () => {
    const jsonAliases: Record<string, string> = {};
    for (const [k, v] of Object.entries(json.legacy_aliases)) {
      if (k.startsWith("_comment")) continue;
      jsonAliases[k] = v as string;
    }
    expect(LEGACY_ALIASES).toEqual(jsonAliases);
  });

  it("suffix strip rules match exactly", () => {
    const jsonStrip: Record<string, string> = {};
    for (const [k, v] of Object.entries(json.suffix_strip_rules)) {
      if (k.startsWith("_comment")) continue;
      jsonStrip[k] = v as string;
    }
    const tsStrip: Record<string, string> = {};
    for (const { prefix, base } of SUFFIX_STRIP) tsStrip[prefix] = base;
    expect(tsStrip).toEqual(jsonStrip);
  });

  it("person-slug registry matches", () => {
    expect([...PERSON_SLUGS.pii].sort()).toEqual([...json.person_slugs.pii].sort());
    expect([...PERSON_SLUGS.internal].sort()).toEqual([...json.person_slugs.internal_agents].sort());
  });
});
