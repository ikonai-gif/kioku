/**
 * Luca V1a Day -1 — env placeholder unit tests.
 *
 * Just confirms the inventory reads what process.env says and master-switch
 * defaults to OFF. Real feature-level gating (throwing
 * LucaFeatureDisabledError when a tool runs with a specific var missing)
 * lands in the tool PRs.
 */
import { describe, expect, it } from "vitest";
import {
  readLucaEnv,
  isLucaEnabled,
  LucaFeatureDisabledError,
} from "../../lib/luca/env";

function withEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => T,
): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(overrides)) saved[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const k of Object.keys(overrides)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

describe("luca/env", () => {
  it("master flag defaults to false when LUCA_V1A_ENABLED is unset", () => {
    withEnv({ LUCA_V1A_ENABLED: undefined }, () => {
      expect(isLucaEnabled()).toBe(false);
    });
  });

  it("master flag only trips on exact 'true' (not '1', 'yes', 'TRUE')", () => {
    withEnv({ LUCA_V1A_ENABLED: "true" }, () => {
      expect(isLucaEnabled()).toBe(true);
    });
    withEnv({ LUCA_V1A_ENABLED: "1" }, () => {
      expect(isLucaEnabled()).toBe(false);
    });
    withEnv({ LUCA_V1A_ENABLED: "TRUE" }, () => {
      expect(isLucaEnabled()).toBe(false);
    });
    withEnv({ LUCA_V1A_ENABLED: "yes" }, () => {
      expect(isLucaEnabled()).toBe(false);
    });
  });

  it("readLucaEnv returns null for every missing value (no accidental empty-string)", () => {
    withEnv(
      {
        LUCA_V1A_ENABLED: undefined,
        LUCA_S3_BUCKET: undefined,
        AWS_REGION: undefined,
        LUCA_DRIVE_ROOT_FOLDER: undefined,
        BRAVE_SEARCH_API_KEY: undefined,
      },
      () => {
        const e = readLucaEnv();
        expect(e.LUCA_V1A_ENABLED).toBe(false);
        expect(e.LUCA_S3_BUCKET).toBeNull();
        expect(e.AWS_REGION).toBeNull();
        expect(e.LUCA_DRIVE_ROOT_FOLDER).toBeNull();
        expect(e.BRAVE_SEARCH_API_KEY).toBeNull();
      },
    );
  });

  it("LucaFeatureDisabledError carries reason and prefixes message", () => {
    const err = new LucaFeatureDisabledError("LUCA_DRIVE_ROOT_FOLDER is unset");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("LucaFeatureDisabledError");
    expect(err.reason).toBe("LUCA_DRIVE_ROOT_FOLDER is unset");
    expect(err.message).toBe("luca_feature_disabled: LUCA_DRIVE_ROOT_FOLDER is unset");
  });
});
