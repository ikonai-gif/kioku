# Google OAuth Re-Authorization Guide

## What is `invalid_grant`?

When the server attempts to refresh a Google access token and receives an
`invalid_grant` error, it means the stored refresh token is no longer valid.
This happens when:

- The Google account password was changed after the OAuth grant was issued.
- The user revoked app access in [Google Account → Security → Third-party apps](https://myaccount.google.com/permissions).
- The OAuth consent screen was changed to "Testing" mode and the test-user list was modified.
- The refresh token was unused for more than 6 months (Google rotates long-idle tokens).
- More than 50 refresh tokens were issued for the same user+app combination (Google silently revokes the oldest).
- The Google Cloud project credentials (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`) were rotated without re-authorizing users.

**As of the fix in this PR**, when `invalid_grant` is detected the server:
1. Immediately clears the stale tokens from the `user_integrations` table.
2. Throws an `InvalidGrantError` with `needsReconnect: true`.
3. Returns HTTP 401 (drive-read) or includes `needs_reconnect: true` in the JSON body (drive-search) so the client can prompt for re-authorization.
4. Logs a `WARN`-level event with `integrationId` and `errCode` for operator visibility.

---

## Manual Steps for BOSS — Re-authorizing the Google OAuth App

Follow these steps **in order**. Do not skip step 1 — skipping it can leave
the old token active while you generate a new one, which may cause a new
`invalid_grant` immediately.

### Step 1 — Revoke the existing OAuth grant (Google side)

1. Sign in to the Google account that was connected to kioku.
2. Go to [https://myaccount.google.com/permissions](https://myaccount.google.com/permissions).
3. Find "kioku" (or your app name) in the list of third-party apps.
4. Click **Remove access** → **OK**.

This invalidates all existing refresh tokens for that account+app pair.

### Step 2 — Verify your Google Cloud Console credentials

> **Only needed if credentials were rotated or this is a fresh environment.**

1. Open [Google Cloud Console](https://console.cloud.google.com/) → **APIs & Services → Credentials**.
2. Find the OAuth 2.0 Client ID used by kioku (type: "Web application").
3. Confirm **Authorized redirect URIs** includes **both**:
   - `https://<your-railway-domain>/api/integrations/google/callback`
   - `https://<your-railway-domain>/api/integrations/gmail/callback`
4. Note the **Client ID** and **Client Secret** — compare with the Railway env vars below.

### Step 3 — Ensure Railway env vars are correct

In the Railway dashboard → your kioku service → **Variables**, verify:

| Variable | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | OAuth 2.0 Client ID from Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | OAuth 2.0 Client Secret from Google Cloud Console |
| `GOOGLE_REDIRECT_URI` | `https://<your-railway-domain>/api/integrations/google/callback` |
| `GMAIL_REDIRECT_URI` | `https://<your-railway-domain>/api/integrations/gmail/callback` |
| `APP_URL` | `https://<your-railway-domain>` |

If `GOOGLE_REDIRECT_URI` / `GMAIL_REDIRECT_URI` are **not set**, they are
automatically derived from `APP_URL`. Either approach works, but the derived
URIs must match exactly what is registered in Google Cloud Console.

### Step 4 — Re-authorize via the kioku OAuth flow

1. Log in to kioku as the affected user.
2. Navigate to **Settings → Integrations** (or `/partner`).
3. Click **Connect Google Drive** (and/or **Connect Gmail** if Gmail is also broken).
4. Complete the Google consent screen — make sure to **allow all requested permissions**.
5. You will be redirected back to kioku with `integration=google_drive&status=connected`.

> **Important:** Google will only issue a new `refresh_token` when you
> complete the full consent screen. If you skip or dismiss the consent page,
> only a short-lived `access_token` is returned and the integration will break
> again in 1 hour. The kioku OAuth URL includes `access_type=offline&prompt=consent`
> to force the consent screen to always appear.

### Step 5 — Verify the fix

After reconnecting, perform a quick smoke test:

```bash
# Replace <session-token> and <your-domain> with real values
curl -sf https://<your-domain>/api/partner/drive-search \
  -H "Content-Type: application/json" \
  -H "Cookie: session=<session-token>" \
  -d '{"query":"test"}' | jq .
# Expect: [] or a list of files — NOT {"error":"...invalid_grant..."}
```

If the response still contains `needs_reconnect: true`, repeat from Step 1.

---

## For Operators: Required Google API Scopes

Ensure the following APIs are **enabled** in Google Cloud Console →
**APIs & Services → Library** for your project:

| API | Required for |
|---|---|
| Google Drive API | Drive file search & read |
| Gmail API | Gmail search, read, and send |
| Google OAuth2 API (or People API) | Fetching user email after auth |

---

## Common Errors Quick Reference

| Error | Cause | Fix |
|---|---|---|
| `invalid_grant` | Refresh token revoked / expired / rotated | Follow this guide from Step 1 |
| `invalid_client` | Wrong `GOOGLE_CLIENT_SECRET` | Update Railway env var, redeploy |
| `redirect_uri_mismatch` | Redirect URI not registered in Google Cloud | Add URI in Google Cloud Console → Credentials |
| `access_denied` | User denied consent or app not approved | Re-connect; if app is in Testing mode, add user to test list |
| HTTP 403 on API call | API not enabled in project | Enable the API in Google Cloud Console → Library |
