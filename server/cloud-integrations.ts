/**
 * Cloud Storage Integrations — Google Drive & Dropbox
 * Shared helpers used by both routes.ts (HTTP endpoints) and deliberation.ts (Luca tools).
 */

import { pool } from "./storage";
import logger from "./logger";

/** Escape non-ASCII chars for HTTP headers (Dropbox-API-Arg requirement) */
function asciiSafe(s: string): string {
  return s.replace(/[\u0080-\uffff]/g, (c) => `\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

// ── Environment ──────────────────────────────────────────────────
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI ||
  (process.env.APP_URL ? `${process.env.APP_URL}/api/integrations/google/callback` : "");

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
  return {
    google_drive: { connected: !!gd, email: gd?.email || undefined },
    dropbox: { connected: !!db, email: db?.email || undefined },
  };
}

// ── OAuth URL builders ───────────────────────────────────────────

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
