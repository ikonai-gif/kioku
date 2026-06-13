/**
 * [BRO2 / UI V2] Centralized feature-flag reader for the front-end.
 *
 * All UI feature flags live here so we have ONE place to grep. Flags are
 * read from Vite env at build time. Each flag defaults to OFF — flipping
 * requires VITE_FLAG=true at build/deploy.
 */

function readBoolFlag(value: string | boolean | undefined): boolean {
  if (value === true) return true;
  if (typeof value !== "string") return false;
  return value.trim().toLowerCase() === "true";
}

/**
 * UI V2 — canvas + right-rail prototype (route `/v2`).
 * When false, the route 302s back to `/`. Flag-off = byte-for-byte legacy UI.
 */
export const UI_V2_CANVAS_ENABLED: boolean = readBoolFlag(
  import.meta.env.VITE_UI_V2_CANVAS_ENABLED,
);
