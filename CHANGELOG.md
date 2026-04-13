# KIOKU™ Changelog

## v1.0.0-beta (2026-04-13)

### Security
- **CRITICAL**: Added ownership verification (IDOR protection) on all resource mutations
- **CRITICAL**: Removed demo-session authentication backdoor
- **CRITICAL**: Removed hardcoded secrets from client bundle and MCP endpoint
- **CRITICAL**: API keys now stored as SHA-256 hashes (breaking: existing keys invalidated)
- **HIGH**: JWT_SECRET required in production (crash on startup if missing)
- **HIGH**: WebSocket connections now require authentication
- **HIGH**: Upgraded drizzle-orm to 0.45.2 (SQL injection vulnerability fix)
- **HIGH**: Agent tokens (kat_*) now stored as SHA-256 hashes
- **MEDIUM**: Unknown /api/* routes now return JSON 404 instead of SPA HTML
- **MEDIUM**: Rate limiter now fails closed on error (was fail-open)

### GDPR Compliance
- Added `DELETE /api/memories/purge` endpoint (Art. 17 — Right to Erasure)
- Added `GET /api/memories/export` endpoint (Art. 20 — Data Portability)

### API Hardening
- Zod schema validation on all POST/PATCH request bodies
- asyncHandler wrapper on all 48 async route handlers
- Stripe error messages masked in production

### Legal Documents (not in codebase)
- Terms of Service v1.0
- Privacy Policy v1.0
- Data Processing Agreement (DPA) v1.0 with EU SCCs

### Breaking Changes
- All existing API keys are invalidated (now SHA-256 hashed)
- All existing agent tokens (kat_*) are invalidated (now SHA-256 hashed)
- `demo-session` authentication no longer works
- Hardcoded master key removed from client — use env var only
- JWT_SECRET env var is now REQUIRED in production
- WebSocket connections require valid session or API key
