/**
 * Cloud Storage Integrations — Google Drive & Dropbox
 * Shared helpers used by both routes.ts (HTTP endpoints) and deliberation.ts (Luca tools).
 */

import { pool } from "./storage";
import logger from "./logger";

/** Escape non-ASCII chars for HTTP headers (Dropbox-API-Arg requirement) */
function asciiSafe(s: string): string {
  return s.replace(/[\u0080-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

// ── Environment ──────────────────────────────────────────────────
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI ||
  (process.env.APP_URL ? `${process.env.APP_URL}/api/integrations/google/callback` : "");
const GMAIL_REDIRECT_URI = process.env.GMAIL_REDIRECT_URI ||
  (process.env.APP_URL ? `${process.env.APP_URL}/api/integrations/gmail/callback` : "");

const DROPBOX_APP_KEY = process.env.DROPBOX_APP_KEY || "";
const DROPBOX_APP_SECRET = process.env.DROPBOX_APP_SECRET || "";
const DROPBOX_REDIRECT_URI = process.env.DROPBOX_REDIRECT_URI ||
  (process.env.APP_URL ? `${process.env.APP_URL}/api/integrations/dropbox/callback` : "");

// ── Token helpers ────────────────────────────────────────────────

interface Integration {
  id: number;
  access_token: string;
  refresh_token: string | null;
  token_expiry: number | null;
  email: string | null;
  provider: string;
}

async function getIntegration(userId: number, provider: string): Promise<Integration | null> {
  const { rows } = await pool.query(
    `SELECT id, access_token, refresh_token, token_expiry, email, provider
     FROM user_integrations WHERE user_id = $1 AND provider = $2`,
    [userId, provider],
  );
  return rows[0] || null;
}

async function refreshGoogleToken(integration: Integration): Promise<string> {
  if (!integration.refresh_token) throw new Error("No refresh token available");
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: integration.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Google token refresh failed: ${resp.status} ${err}`);
  }
  const data = await resp.json() as any;
  const newToken = data.access_token;
  const expiry = Date.now() + (data.expires_in || 3600) * 1000;
  await pool.query(
    `UPDATE user_integrations SET access_token = $1, token_expiry = $2, updated_at = $3 WHERE id = $4`,
    [newToken, expiry, Date.now(), integration.id],
  );
  return newToken;
}

async function getGoogleToken(userId: number): Promise<string> {
  const integration = await getIntegration(userId, "google_drive");
  if (!integration) throw new Error("Google Drive not connected");
  // Refresh if expired or expiring in the next 5 minutes
  if (integration.token_expiry && integration.token_expiry < Date.now() + 5 * 60 * 1000) {
    return refreshGoogleToken(integration);
  }
  return integration.access_token;
}

async function refreshDropboxToken(integration: Integration): Promise<string> {
  if (!integration.refresh_token) throw new Error("No refresh token available");
  const resp = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: DROPBOX_APP_KEY,
      client_secret: DROPBOX_APP_SECRET,
      refresh_token: integration.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Dropbox token refresh failed: ${resp.status} ${err}`);
  }
  const data = await resp.json() as any;
  const newToken = data.access_token;
  const expiry = Date.now() + (data.expires_in || 14400) * 1000;
  await pool.query(
    `UPDATE user_integrations SET access_token = $1, token_expiry = $2, updated_at = $3 WHERE id = $4`,
    [newToken, expiry, Date.now(), integration.id],
  );
  return newToken;
}

async function getDropboxToken(userId: number): Promise<string> {
  const integration = await getIntegration(userId, "dropbox");
  if (!integration) throw new Error("Dropbox not connected");
  if (integration.token_expiry && integration.token_expiry < Date.now() + 5 * 60 * 1000) {
    return refreshDropboxToken(integration);
  }
  return integration.access_token;
}

// ── Google Drive Search ──────────────────────────────────────────

export async function searchGoogleDrive(userId: number, query: string): Promise<any[]> {
  const token = await getGoogleToken(userId);
  const q = encodeURIComponent(`name contains '${query.replace(/'/g, "\\'")}'`);
  const fields = encodeURIComponent("files(id,name,mimeType,modifiedTime,size)");
  const resp = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&pageSize=10`,
    {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Google Drive search failed: ${resp.status} ${err}`);
  }
  const data = await resp.json() as any;
  return (data.files || []).map((f: any) => ({
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    modifiedTime: f.modifiedTime,
    size: f.size,
    provider: "google_drive",
  }));
}

// ── Google Drive Read ────────────────────────────────────────────

export async function readGoogleDriveFile(userId: number, fileId: string): Promise<{ fileName: string; text: string; truncated: boolean; charCount: number }> {
  const token = await getGoogleToken(userId);
  const headers = { Authorization: `Bearer ${token}` };

  // First get file metadata
  const metaResp = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?fields=name,mimeType,size`,
    { headers, signal: AbortSignal.timeout(10000) },
  );
  if (!metaResp.ok) throw new Error(`Failed to get file metadata: ${metaResp.status}`);
  const meta = await metaResp.json() as any;
  const fileName = meta.name || "Untitled";
  const mimeType = meta.mimeType || "";

  let text = "";

  if (mimeType === "application/vnd.google-apps.document") {
    // Google Docs → export as plain text
    const resp = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`,
      { headers, signal: AbortSignal.timeout(20000) },
    );
    if (!resp.ok) throw new Error(`Export failed: ${resp.status}`);
    text = await resp.text();
  } else if (mimeType === "application/vnd.google-apps.spreadsheet") {
    // Google Sheets → export as CSV
    const resp = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/csv`,
      { headers, signal: AbortSignal.timeout(20000) },
    );
    if (!resp.ok) throw new Error(`Export failed: ${resp.status}`);
    text = await resp.text();
  } else if (mimeType === "application/pdf") {
    // PDF → download and parse
    const resp = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      { headers, signal: AbortSignal.timeout(20000) },
    );
    if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
    const buffer = Buffer.from(await resp.arrayBuffer());
    try {
      const pdfParse = require("pdf-parse");
      const result = await pdfParse(buffer);
      text = result.text || "";
    } catch {
      text = "Could not parse PDF content.";
    }
  } else if (mimeType.startsWith("text/") || mimeType === "application/json") {
    // Text files → download as text
    const resp = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      { headers, signal: AbortSignal.timeout(15000) },
    );
    if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
    text = await resp.text();
  } else {
    // Try download as text, fallback to unsupported
    try {
      const resp = await fetch(
        `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
        { headers, signal: AbortSignal.timeout(15000) },
      );
      if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
      text = await resp.text();
    } catch {
      text = `Unsupported file type: ${mimeType}`;
    }
  }

  const truncated = text.length > 8000;
  text = text.slice(0, 8000);

  return { fileName, text, truncated, charCount: text.length };
}

// ── Dropbox Search ───────────────────────────────────────────────

export async function searchDropbox(userId: number, query: string): Promise<any[]> {
  const token = await getDropboxToken(userId);
  const resp = await fetch("https://api.dropboxapi.com/2/files/search_v2", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      options: { max_results: 10 },
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Dropbox search failed: ${resp.status} ${err}`);
  }
  const data = await resp.json() as any;
  return (data.matches || []).map((m: any) => {
    const meta = m.metadata?.metadata || m.metadata || {};
    return {
      id: meta.id || meta.path_lower || "",
      name: meta.name || "",
      path: meta.path_lower || meta.path_display || "",
      mimeType: "",
      modifiedTime: meta.server_modified || meta.client_modified || "",
      size: meta.size || 0,
      provider: "dropbox",
    };
  });
}

// ── Dropbox Read ─────────────────────────────────────────────────

export async function readDropboxFile(userId: number, path: string): Promise<{ fileName: string; text: string; truncated: boolean; charCount: number }> {
  const token = await getDropboxToken(userId);
  const resp = await fetch("https://content.dropboxapi.com/2/files/download", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Dropbox-API-Arg": asciiSafe(JSON.stringify({ path })),
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Dropbox download failed: ${resp.status} ${err}`);
  }

  const apiResult = resp.headers.get("dropbox-api-result");
  let fileName = "Untitled";
  if (apiResult) {
    try {
      const parsed = JSON.parse(apiResult);
      fileName = parsed.name || fileName;
    } catch { /* ignore */ }
  }

  const buffer = Buffer.from(await resp.arrayBuffer());
  let text = "";
  const lowerName = fileName.toLowerCase();

  if (lowerName.endsWith(".pdf")) {
    try {
      const pdfParse = require("pdf-parse");
      const result = await pdfParse(buffer);
      text = result.text || "";
    } catch {
      text = "Could not parse PDF content.";
    }
  } else if (lowerName.endsWith(".docx")) {
    try {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({ buffer });
      text = result.value;
    } catch {
      text = "Could not parse DOCX content.";
    }
  } else {
    text = buffer.toString("utf-8");
  }

  const truncated = text.length > 8000;
  text = text.slice(0, 8000);

  return { fileName, text, truncated, charCount: text.length };
}

// ── Integration status helper ────────────────────────────────────

export async function getIntegrationStatus(userId: number): Promise<{
  google_drive: { connected: boolean; email?: string };
  dropbox: { connected: boolean; email?: string };
}> {
  const { rows } = await pool.query(
    `SELECT provider, email FROM user_integrations WHERE user_id = $1`,
    [userId],
  );
  const gd = rows.find((r: any) => r.provider === "google_drive");
  const db = rows.find((r: any) => r.provider === "dropbox");
  const gmails = rows.filter((r: any) => r.provider === "gmail").map((r: any) => r.email).filter(Boolean);
  return {
    google_drive: { connected: !!gd, email: gd?.email || undefined },
    dropbox: { connected: !!db, email: db?.email || undefined },
    gmail: { connected: gmails.length > 0, email: gmails[0], emails: gmails, count: gmails.length } as any,
  } as any;
}

// ── OAuth URL builders ───────────────────────────────────────────

export function buildGmailOAuthUrl(userId: number): string {
  if (!GOOGLE_CLIENT_ID || !GMAIL_REDIRECT_URI) {
    throw new Error("Gmail OAuth not configured (missing GOOGLE_CLIENT_ID or redirect URI)");
  }
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GMAIL_REDIRECT_URI,
    response_type: "code",
    scope: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/userinfo.email",
    ].join(" "),
    access_type: "offline",
    prompt: "consent select_account",
    include_granted_scopes: "true",
    state: String(userId),
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeGmailCode(code: string, userId: number): Promise<{ email: string }> {
  const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: GMAIL_REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenResp.ok) {
    const err = await tokenResp.text();
    throw new Error(`Gmail token exchange failed: ${tokenResp.status} ${err}`);
  }
  const tokens = await tokenResp.json() as any;

  const userResp = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const userInfo = userResp.ok ? (await userResp.json() as any) : {};
  const email = (userInfo.email || "").toLowerCase();
  if (!email) throw new Error("Gmail OAuth: could not determine account email");
  const expiry = Date.now() + (tokens.expires_in || 3600) * 1000;
  const now = Date.now();

  // Upsert keyed on (user_id, provider, email) — allows multiple Gmail accounts.
  // We do a manual check-then-update/insert because the uniqueness is enforced by
  // a partial index on COALESCE(email,''), not a classic constraint.
  const existing = await pool.query(
    `SELECT id FROM user_integrations WHERE user_id = $1 AND provider = 'gmail' AND email = $2`,
    [userId, email]
  );
  if (existing.rows[0]) {
    await pool.query(
      `UPDATE user_integrations
       SET access_token = $1,
           refresh_token = COALESCE($2, refresh_token),
           token_expiry = $3,
           updated_at = $4
       WHERE id = $5`,
      [tokens.access_token, tokens.refresh_token || null, expiry, now, existing.rows[0].id]
    );
  } else {
    await pool.query(
      `INSERT INTO user_integrations (user_id, provider, access_token, refresh_token, token_expiry, email, created_at, updated_at)
       VALUES ($1, 'gmail', $2, $3, $4, $5, $6, $6)`,
      [userId, tokens.access_token, tokens.refresh_token || null, expiry, email, now]
    );
  }

  logger.info({ source: "cloud-integrations", userId, provider: "gmail", email }, "Gmail connected");
  return { email };
}

// ── Gmail: list all connected accounts for a user ───────────────
export async function listGmailAccounts(userId: number): Promise<Array<{
  id: number;
  email: string;
  createdAt: number;
  tokenExpiry: number | null;
  hasRefreshToken: boolean;
  expired: boolean;
}>> {
  const { rows } = await pool.query(
    `SELECT id, email, created_at, token_expiry, (refresh_token IS NOT NULL) AS has_refresh
       FROM user_integrations WHERE user_id = $1 AND provider = 'gmail' ORDER BY created_at ASC`,
    [userId]
  );
  const now = Date.now();
  return rows.map((r: any) => {
    const expiry = r.token_expiry ? Number(r.token_expiry) : null;
    return {
      id: r.id,
      email: r.email,
      createdAt: Number(r.created_at),
      tokenExpiry: expiry,
      hasRefreshToken: !!r.has_refresh,
      expired: !!expiry && expiry < now,
    };
  });
}

async function refreshGmailToken(integration: Integration): Promise<string> {
  if (!integration.refresh_token) throw new Error("No Gmail refresh token available");
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: integration.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Gmail token refresh failed: ${resp.status} ${err}`);
  }
  const data = await resp.json() as any;
  const newToken = data.access_token;
  const expiry = Date.now() + (data.expires_in || 3600) * 1000;
  await pool.query(
    `UPDATE user_integrations SET access_token = $1, token_expiry = $2, updated_at = $3 WHERE id = $4`,
    [newToken, expiry, Date.now(), integration.id]
  );
  return newToken;
}

async function getGmailTokenForAccount(integrationId: number): Promise<{ token: string; email: string }> {
  const { rows } = await pool.query(
    `SELECT id, access_token, refresh_token, token_expiry, email, provider FROM user_integrations WHERE id = $1`,
    [integrationId]
  );
  const i = rows[0] as Integration | undefined;
  if (!i) throw new Error("Gmail account not found");
  if (i.token_expiry && i.token_expiry < Date.now() + 5 * 60 * 1000) {
    const t = await refreshGmailToken(i);
    return { token: t, email: i.email || "" };
  }
  return { token: i.access_token, email: i.email || "" };
}

/** Per-account diagnostic returned alongside search results. */
export interface GmailAccountStatus {
  email: string;
  ok: boolean;
  messages_found: number;
  error?: string;
  needs_reconnect?: boolean;
}

// ── Gmail: search across all connected accounts ─────────────────
// Returns up to `perAccountLimit` messages per connected account.
export async function searchGmailAll(userId: number, query: string, perAccountLimit = 10): Promise<{
  messages: Array<{
    account: string;
    id: string;
    threadId: string;
    subject: string;
    from: string;
    date: string;
    snippet: string;
  }>;
  accountStatuses: GmailAccountStatus[];
}> {
  const accounts = await listGmailAccounts(userId);
  if (accounts.length === 0) return { messages: [], accountStatuses: [] };
  const results: any[] = [];
  const statuses: GmailAccountStatus[] = [];

  for (const acct of accounts) {
    const accountEmail = acct.email;
    try {
      // Try to get a valid token (may refresh). A refresh failure here
      // means the OAuth was revoked or the refresh token is stale —
      // user must reconnect.
      let token: string;
      let email: string;
      try {
        const t = await getGmailTokenForAccount(acct.id);
        token = t.token;
        email = t.email;
      } catch (tokenErr: any) {
        const msg = tokenErr?.message || String(tokenErr);
        logger.warn({ source: "gmail-search", account: accountEmail, err: msg }, "Gmail token unavailable");
        statuses.push({
          email: accountEmail,
          ok: false,
          messages_found: 0,
          error: `token refresh failed: ${msg.slice(0, 200)}`,
          needs_reconnect: true,
        });
        continue;
      }

      const q = encodeURIComponent(query);
      const listResp = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=${perAccountLimit}`,
        { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) }
      );

      if (!listResp.ok) {
        // CRITICAL: don't silently swallow. If auth failed, report it so the
        // caller (Luca) can tell the user to reconnect instead of lying that
        // "the inbox is empty".
        const errBody = await listResp.text().catch(() => "");
        const needsReconnect = listResp.status === 401 || listResp.status === 403;
        logger.warn({
          source: "gmail-search",
          account: accountEmail,
          status: listResp.status,
          body: errBody.slice(0, 300),
        }, "Gmail list API failed");
        statuses.push({
          email: accountEmail,
          ok: false,
          messages_found: 0,
          error: `Gmail API ${listResp.status}: ${errBody.slice(0, 200)}`,
          needs_reconnect: needsReconnect,
        });
        continue;
      }

      const listData = await listResp.json() as any;
      const messages = listData.messages || [];

      // Fetch metadata for each message in parallel (bounded)
      const metas = await Promise.all(messages.slice(0, perAccountLimit).map(async (m: any) => {
        try {
          const r = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
            { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) }
          );
          if (!r.ok) return null;
          const d = await r.json() as any;
          const hdrs = (d.payload?.headers || []) as Array<{ name: string; value: string }>;
          const getH = (n: string) => hdrs.find(h => h.name.toLowerCase() === n.toLowerCase())?.value || "";
          return {
            account: email,
            id: d.id,
            threadId: d.threadId,
            subject: getH("Subject"),
            from: getH("From"),
            date: getH("Date"),
            snippet: d.snippet || "",
          };
        } catch { return null; }
      }));
      let found = 0;
      for (const m of metas) if (m) { results.push(m); found++; }
      statuses.push({ email: accountEmail, ok: true, messages_found: found });
    } catch (e: any) {
      const msg = e?.message || String(e);
      logger.warn({ source: "gmail-search", account: accountEmail, err: msg }, "Gmail search failed for account");
      statuses.push({ email: accountEmail, ok: false, messages_found: 0, error: msg.slice(0, 200) });
    }
  }
  return { messages: results, accountStatuses: statuses };
}

// ── Gmail: read full message body ────────────────────────────────
function decodeBase64Url(data: string): string {
  const b = data.replace(/-/g, "+").replace(/_/g, "/");
  try { return Buffer.from(b, "base64").toString("utf-8"); } catch { return ""; }
}

function extractBody(payload: any): string {
  if (!payload) return "";
  if (payload.body?.data) return decodeBase64Url(payload.body.data);
  const parts = payload.parts || [];
  // Prefer text/plain over text/html
  const plain = parts.find((p: any) => p.mimeType === "text/plain");
  if (plain?.body?.data) return decodeBase64Url(plain.body.data);
  for (const p of parts) {
    const nested = extractBody(p);
    if (nested) return nested;
  }
  const html = parts.find((p: any) => p.mimeType === "text/html");
  if (html?.body?.data) {
    const raw = decodeBase64Url(html.body.data);
    return raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
  return "";
}

export async function readGmailMessage(userId: number, accountEmail: string, messageId: string): Promise<{
  account: string;
  subject: string;
  from: string;
  to: string;
  date: string;
  body: string;
  truncated: boolean;
}> {
  const accounts = await listGmailAccounts(userId);
  const acct = accounts.find(a => a.email.toLowerCase() === accountEmail.toLowerCase());
  if (!acct) throw new Error(`Gmail account ${accountEmail} not connected`);
  const { token } = await getGmailTokenForAccount(acct.id);
  const r = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`,
    { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) }
  );
  if (!r.ok) throw new Error(`Gmail message fetch failed: ${r.status}`);
  const d = await r.json() as any;
  const hdrs = (d.payload?.headers || []) as Array<{ name: string; value: string }>;
  const getH = (n: string) => hdrs.find(h => h.name.toLowerCase() === n.toLowerCase())?.value || "";
  let body = extractBody(d.payload);
  const truncated = body.length > 12000;
  body = body.slice(0, 12000);
  return {
    account: accountEmail,
    subject: getH("Subject"),
    from: getH("From"),
    to: getH("To"),
    date: getH("Date"),
    body,
    truncated,
  };
}

// ── Gmail: modify labels (mark read/unread, archive, etc.) ────────────────
export async function modifyGmailMessage(
  userId: number,
  accountEmail: string,
  messageId: string,
  opts: { addLabels?: string[]; removeLabels?: string[] }
): Promise<{ ok: true }> {
  const accounts = await listGmailAccounts(userId);
  const acct = accounts.find(a => a.email.toLowerCase() === accountEmail.toLowerCase());
  if (!acct) throw new Error(`Gmail account ${accountEmail} not connected`);
  const { token } = await getGmailTokenForAccount(acct.id);
  const body: any = {};
  if (opts.addLabels && opts.addLabels.length) body.addLabelIds = opts.addLabels;
  if (opts.removeLabels && opts.removeLabels.length) body.removeLabelIds = opts.removeLabels;
  const r = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    }
  );
  if (!r.ok) {
    const errBody = await r.text().catch(() => "");
    throw new Error(`Gmail modify failed: ${r.status} ${errBody.slice(0, 200)}`);
  }
  return { ok: true };
}

// ── Gmail: fetch full thread (all messages in conversation) ──────────────
export async function getGmailThread(
  userId: number,
  accountEmail: string,
  threadId: string,
): Promise<{
  thread_id: string;
  account: string;
  messages: Array<{
    id: string;
    from: string;
    to: string;
    subject: string;
    date: string;
    body: string;
    snippet: string;
  }>;
}> {
  const accounts = await listGmailAccounts(userId);
  const acct = accounts.find(a => a.email.toLowerCase() === accountEmail.toLowerCase());
  if (!acct) throw new Error(`Gmail account ${accountEmail} not connected`);
  const { token } = await getGmailTokenForAccount(acct.id);
  const r = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=full`,
    { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) }
  );
  if (!r.ok) throw new Error(`Gmail thread fetch failed: ${r.status}`);
  const d = await r.json() as any;
  const messages = (d.messages || []).map((m: any) => {
    const hdrs = (m.payload?.headers || []) as Array<{ name: string; value: string }>;
    const getH = (n: string) => hdrs.find(h => h.name.toLowerCase() === n.toLowerCase())?.value || "";
    return {
      id: m.id,
      from: getH("From"),
      to: getH("To"),
      subject: getH("Subject"),
      date: getH("Date"),
      body: extractBody(m.payload).slice(0, 8000),
      snippet: m.snippet || "",
    };
  });
  return { thread_id: threadId, account: accountEmail, messages };
}

// ── Gmail: send a reply within a thread ──────────────────────────────────
export async function sendGmailReply(
  userId: number,
  accountEmail: string,
  inReplyToMessageId: string,
  bodyText: string,
): Promise<{ ok: true; sent_id: string; thread_id: string }> {
  const accounts = await listGmailAccounts(userId);
  const acct = accounts.find(a => a.email.toLowerCase() === accountEmail.toLowerCase());
  if (!acct) throw new Error(`Gmail account ${accountEmail} not connected`);
  const { token } = await getGmailTokenForAccount(acct.id);

  // Fetch original to get headers (Subject, From→To swap, Message-ID, References, In-Reply-To)
  const origR = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${inReplyToMessageId}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Message-ID&metadataHeaders=References&metadataHeaders=In-Reply-To`,
    { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) }
  );
  if (!origR.ok) throw new Error(`Failed to fetch original message: ${origR.status}`);
  const orig = await origR.json() as any;
  const threadId = orig.threadId as string;
  const hdrs = (orig.payload?.headers || []) as Array<{ name: string; value: string }>;
  const getH = (n: string) => hdrs.find(h => h.name.toLowerCase() === n.toLowerCase())?.value || "";
  const origSubject = getH("Subject");
  const origFrom = getH("From");
  const origMsgId = getH("Message-ID");
  const origRefs = getH("References");

  const replySubject = origSubject.toLowerCase().startsWith("re:") ? origSubject : `Re: ${origSubject}`;
  // Build references chain
  const refs = [origRefs, origMsgId].filter(Boolean).join(" ").trim();

  // Compose RFC 2822 message
  const lines = [
    `From: ${accountEmail}`,
    `To: ${origFrom}`,
    `Subject: ${replySubject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
  ];
  if (origMsgId) lines.push(`In-Reply-To: ${origMsgId}`);
  if (refs) lines.push(`References: ${refs}`);
  lines.push("");
  lines.push(bodyText);
  const raw = lines.join("\r\n");

  // Base64url encode
  const encoded = Buffer.from(raw, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const sendR = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/send`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ raw: encoded, threadId }),
      signal: AbortSignal.timeout(20000),
    }
  );
  if (!sendR.ok) {
    const errBody = await sendR.text().catch(() => "");
    throw new Error(`Gmail send failed: ${sendR.status} ${errBody.slice(0, 300)}`);
  }
  const sent = await sendR.json() as any;
  return { ok: true, sent_id: sent.id, thread_id: sent.threadId };
}

// ── Gmail: send a brand-new message ──────────────────────────────────────
export async function sendGmailNew(
  userId: number,
  accountEmail: string,
  to: string,
  subject: string,
  bodyText: string,
  cc?: string,
  bcc?: string,
): Promise<{ ok: true; sent_id: string; thread_id: string }> {
  const accounts = await listGmailAccounts(userId);
  const acct = accounts.find(a => a.email.toLowerCase() === accountEmail.toLowerCase());
  if (!acct) throw new Error(`Gmail account ${accountEmail} not connected`);
  const { token } = await getGmailTokenForAccount(acct.id);

  const lines = [
    `From: ${accountEmail}`,
    `To: ${to}`,
  ];
  if (cc) lines.push(`Cc: ${cc}`);
  if (bcc) lines.push(`Bcc: ${bcc}`);
  lines.push(
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    bodyText
  );
  const raw = lines.join("\r\n");
  const encoded = Buffer.from(raw, "utf8").toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const sendR = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/send`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ raw: encoded }),
      signal: AbortSignal.timeout(20000),
    }
  );
  if (!sendR.ok) {
    const errBody = await sendR.text().catch(() => "");
    throw new Error(`Gmail send failed: ${sendR.status} ${errBody.slice(0, 300)}`);
  }
  const sent = await sendR.json() as any;
  return { ok: true, sent_id: sent.id, thread_id: sent.threadId };
}

export function buildGoogleOAuthUrl(userId: number): string {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_REDIRECT_URI) {
    throw new Error("Google OAuth not configured (missing GOOGLE_CLIENT_ID or redirect URI)");
  }
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/userinfo.email",
    access_type: "offline",
    prompt: "consent",
    state: String(userId),
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export function buildDropboxOAuthUrl(userId: number): string {
  if (!DROPBOX_APP_KEY || !DROPBOX_REDIRECT_URI) {
    throw new Error("Dropbox OAuth not configured (missing DROPBOX_APP_KEY or redirect URI)");
  }
  const params = new URLSearchParams({
    client_id: DROPBOX_APP_KEY,
    redirect_uri: DROPBOX_REDIRECT_URI,
    response_type: "code",
    token_access_type: "offline",
    state: String(userId),
  });
  return `https://www.dropbox.com/oauth2/authorize?${params.toString()}`;
}

// ── OAuth token exchange ─────────────────────────────────────────

export async function exchangeGoogleCode(code: string, userId: number): Promise<{ email: string }> {
  // Exchange code for tokens
  const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: GOOGLE_REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenResp.ok) {
    const err = await tokenResp.text();
    throw new Error(`Google token exchange failed: ${tokenResp.status} ${err}`);
  }
  const tokens = await tokenResp.json() as any;

  // Get user email
  const userResp = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const userInfo = userResp.ok ? (await userResp.json() as any) : {};
  const email = userInfo.email || "";
  const expiry = Date.now() + (tokens.expires_in || 3600) * 1000;
  const now = Date.now();

  // Upsert into user_integrations
  await pool.query(
    `INSERT INTO user_integrations (user_id, provider, access_token, refresh_token, token_expiry, email, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (user_id, provider)
     DO UPDATE SET access_token = $3, refresh_token = COALESCE($4, user_integrations.refresh_token), token_expiry = $5, email = $6, updated_at = $8`,
    [userId, "google_drive", tokens.access_token, tokens.refresh_token || null, expiry, email, now, now],
  );

  logger.info({ source: "cloud-integrations", userId, provider: "google_drive", email }, "Google Drive connected");
  return { email };
}

export async function exchangeDropboxCode(code: string, userId: number): Promise<{ email: string }> {
  const tokenResp = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: DROPBOX_APP_KEY,
      client_secret: DROPBOX_APP_SECRET,
      redirect_uri: DROPBOX_REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenResp.ok) {
    const err = await tokenResp.text();
    throw new Error(`Dropbox token exchange failed: ${tokenResp.status} ${err}`);
  }
  const tokens = await tokenResp.json() as any;
  const email = tokens.account_id || "";
  const expiry = Date.now() + (tokens.expires_in || 14400) * 1000;
  const now = Date.now();

  // Try to get actual email from Dropbox
  let actualEmail = email;
  try {
    const acctResp = await fetch("https://api.dropboxapi.com/2/users/get_current_account", {
      method: "POST",
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (acctResp.ok) {
      const acct = await acctResp.json() as any;
      actualEmail = acct.email || email;
    }
  } catch { /* best-effort */ }

  // Upsert
  await pool.query(
    `INSERT INTO user_integrations (user_id, provider, access_token, refresh_token, token_expiry, email, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (user_id, provider)
     DO UPDATE SET access_token = $3, refresh_token = COALESCE($4, user_integrations.refresh_token), token_expiry = $5, email = $6, updated_at = $8`,
    [userId, "dropbox", tokens.access_token, tokens.refresh_token || null, expiry, actualEmail, now, now],
  );

  logger.info({ source: "cloud-integrations", userId, provider: "dropbox", email: actualEmail }, "Dropbox connected");
  return { email: actualEmail };
}
