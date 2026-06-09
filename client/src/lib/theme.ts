/**
 * Theme persistence helpers (Brick PR-A, LUCA-053).
 * Pure functions so they're testable without React/DOM.
 */
export const THEME_KEY = "kioku-theme";

/** Resolve initial dark/light from a persisted value. Default: dark. */
export function resolveInitialTheme(stored: string | null): boolean {
  if (stored === "light") return false;
  if (stored === "dark") return true;
  return true; // default dark
}

/** Serialize the theme for storage. */
export function themeToStored(dark: boolean): "dark" | "light" {
  return dark ? "dark" : "light";
}
