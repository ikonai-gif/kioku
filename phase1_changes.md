# Phase 1 — Security Hardening (8 Fixes)

## F1-1: Redact Response Body Logging
**File:** `server/index.ts`
- Added `redactBody()` function that strips sensitive fields (`apiKey`, `token`, `jwt`, `secret`, `password`, `key`, `embedding`, `webhookSecret`) from log output
- Arrays are logged as `[Array(N)]` instead of full contents
- Applied to the response logging middleware

## F1-2: crypto.timingSafeEqual() for All Secret Comparisons
**Files:** `server/index.ts`, `server/health.ts`, `server/mcp.ts`, `server/routes.ts`
- Added `safeCompare()` utility function using `crypto.timingSafeEqual()` to prevent timing attacks
- Exported from `server/index.ts`, imported in all files that compare secrets
- Replaced all `=== masterKey` and `!== masterKey` comparisons (7 instances across 4 files)

## F1-3: SSL Verification for PostgreSQL
**Files:** `server/storage.ts`, `drizzle.config.ts`
- Changed from `rejectUnauthorized: false` to `rejectUnauthorized: true`
- Neon.tech URLs always use verified SSL (valid public CA certs)
- Production always uses verified SSL
- Local development without SSL markers connects without SSL

## F1-4: Rate Limit Auth & Waitlist Endpoints
**Files:** `server/ratelimit.ts`, `server/routes.ts`
- Removed auth/waitlist endpoints from rate limit skip list
- Added `checkAuthRateLimit()` function with per-key windowed rate limiting
- Applied per-endpoint limits:
  - `/api/auth/magic-link` & `/api/auth/request-magic-link`: 5 per email per hour
  - `/api/auth/verify` & `/api/auth/verify-magic-link`: 10 per IP per 15 minutes
  - `/api/waitlist`: 3 per IP per hour
- Cleanup interval removes expired entries every 5 minutes

## F1-5: MCP Input Validation (Zod Schemas)
**File:** `server/mcp.ts`
- Added Zod schemas: `mcpStoreMemorySchema`, `mcpSearchMemorySchema`, `mcpListMemoriesSchema`
- All MCP tool arguments validated with `.parse()` before processing
- ZodError caught and returned as JSON-RPC -32602 (Invalid params)

## F1-6: AI Model Allowlist Validation
**File:** `server/validation.ts`
- `deliberateSchema.model` now validates against exact allowlist of supported models
- Matches models from `structured-deliberation.ts`: OpenAI (gpt-5.4-mini, gpt-5.4, gpt-5.4-nano, gpt-4.1-mini, gpt-4.1, gpt-4o-mini, gpt-4o) and Gemini (gemini-2.0-flash, gemini-2.5-flash, gemini-2.5-pro, gemini-3.1-pro)
- `debateRounds` capped at 5 (was 10)

## F1-7: Prompt Injection Defenses
**Files:** `server/deliberation.ts`, `server/structured-deliberation.ts`
- Added `sanitizeForPrompt()` function that strips:
  - "IGNORE/FORGET/DISREGARD ALL PREVIOUS INSTRUCTIONS" patterns
  - "SYSTEM:/ASSISTANT:/USER:" role injection attempts
  - OpenAI special tokens (`<|...|>`)
  - Hard length cap at 50,000 characters
- Applied to: memory content, agent descriptions, topics, chat messages, prior positions
- Added `=== BEGIN/END USER-PROVIDED CONTEXT ===` boundary markers around untrusted content

## F1-8: JWT Algorithm Pinning
**Files:** `server/routes.ts`, `server/ws.ts`, `server/ratelimit.ts`, `server/billing.ts`
- Added `{ algorithms: ['HS256'] }` to all 7 `jwt.verify()` calls
- Prevents algorithm confusion attacks (e.g., `none` algorithm, RS256→HS256 key confusion)

## Verification
- `npx tsc --noEmit` — compiles with no new errors (pre-existing TS2802 iterable warnings only)
- `_sig` in `server/billing.ts` line 7 — untouched
