// scripts/mint-drive-token.mjs
// Mint a fresh Google Drive (drive.file) refresh token by RE-USING the Drive
// OAuth client whose id+secret already live in the Railway prod env. Run it via
//   railway run -- node scripts/mint-drive-token.mjs
// so GOOGLE_DRIVE_CLIENT_ID / GOOGLE_DRIVE_CLIENT_SECRET are injected (the
// secret is never printed and never leaves the process).
//
// Flow: starts a loopback server on http://127.0.0.1:8765/oauth2callback (an
// authorized redirect URI on the Drive client), opens the browser; you sign in
// as kotkave@gmail.com and click Allow; the script exchanges the code for a
// refresh_token and writes GOOGLE_DRIVE_REFRESH_TOKEN back to Railway (same
// client => existing backup folder stays writable).

import http from "node:http";
import { URL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { google } from "googleapis";

const PORT = 8765;
const REDIRECT = `http://127.0.0.1:${PORT}/oauth2callback`;
const SCOPE = "https://www.googleapis.com/auth/drive.file";
const RAILWAY_SERVICE = "kioku";

const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error(
    "Missing GOOGLE_DRIVE_CLIENT_ID / GOOGLE_DRIVE_CLIENT_SECRET in env. " +
      "Run this through:  railway run -- node scripts/mint-drive-token.mjs",
  );
  process.exit(2);
}
console.log(`Re-using Drive client: ${clientId.slice(0, 24)}... (secret hidden)`);

const oauth2 = new google.auth.OAuth2(clientId, clientSecret, REDIRECT);
const authUrl = oauth2.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: [SCOPE],
});

function railwaySetRefreshToken(value) {
  const r = spawnSync(
    "railway",
    ["variables", "set", "GOOGLE_DRIVE_REFRESH_TOKEN", "--stdin", "--service", RAILWAY_SERVICE],
    { input: value, encoding: "utf8" },
  );
  if (r.status !== 0) {
    throw new Error(`railway set failed: ${(r.stderr || r.stdout || "").trim()}`);
  }
}

const server = http.createServer(async (req, res) => {
  if (!req.url || !req.url.startsWith("/oauth2callback")) {
    res.writeHead(404);
    res.end();
    return;
  }
  const u = new URL(req.url, REDIRECT);
  const code = u.searchParams.get("code");
  const err = u.searchParams.get("error");
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end("<h2>OK ✅ Можно закрыть вкладку и вернуться в терминал.</h2>");
  server.close();
  if (err || !code) {
    console.error(`OAuth callback error: ${err || "no code"}`);
    process.exit(1);
  }
  try {
    const { tokens } = await oauth2.getToken(code);
    const rt = tokens.refresh_token;
    if (!rt) {
      console.error(
        "No refresh_token returned. Revoke prior access at " +
          "https://myaccount.google.com/permissions and re-run.",
      );
      process.exit(1);
    }
    console.log(`Got refresh_token (length ${rt.length}). Writing to Railway...`);
    railwaySetRefreshToken(rt);
    console.log("DONE: GOOGLE_DRIVE_REFRESH_TOKEN updated; redeploy triggered.");
    process.exit(0);
  } catch (e) {
    console.error("Exchange/Railway failed:", e?.message || e);
    process.exit(1);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("\n=== OPENING BROWSER — sign in as kotkave@gmail.com and click Allow ===");
  console.log("If it didn't open, paste this URL into the browser:\n");
  console.log(authUrl + "\n");
  spawn("open", [authUrl]);
});
