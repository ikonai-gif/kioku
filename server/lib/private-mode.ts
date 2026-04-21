/**
 * KIOKU Private Mode — invite-only access gate.
 *
 * Configure via env:
 *   PRIVATE_MODE=true                        # enable gate
 *   ALLOWED_EMAILS="a@x.com,b@y.com"         # comma-separated allowlist (case-insensitive)
 *
 * When PRIVATE_MODE=true:
 *   - magic-link requests for emails NOT in ALLOWED_EMAILS return 403
 *   - /api/demo/chat + /api/auth/demo return 404
 *   - landing page served is the "private beta" gate, not the marketing page
 *
 * When PRIVATE_MODE=false (default), all endpoints behave as before.
 */

export const PRIVATE_MODE = process.env.PRIVATE_MODE === "true";

const ALLOWED_EMAILS = new Set(
  (process.env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

/** True iff email is allowed under private mode. If private mode off, always true. */
export function isEmailAllowed(email: string | null | undefined): boolean {
  if (!PRIVATE_MODE) return true;
  if (!email) return false;
  return ALLOWED_EMAILS.has(email.trim().toLowerCase());
}

/** For ops visibility (/health/monitor). */
export function getPrivateModeStatus() {
  return {
    enabled: PRIVATE_MODE,
    allowlistSize: ALLOWED_EMAILS.size,
  };
}
