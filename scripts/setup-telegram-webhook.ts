#!/usr/bin/env tsx
/**
 * PR-A.5 — One-shot script to register our webhook URL with Telegram.
 *
 * Telegram Bot API supports either polling (getUpdates) or webhook delivery;
 * we use webhook because it's instant and survives free-tier sleep cycles
 * (Telegram retries until 2xx). This script flips the bot from "no webhook"
 * (or a stale one) to point at PUBLIC_URL/api/telegram/webhook with our
 * shared-secret token in the X-Telegram-Bot-Api-Secret-Token header.
 *
 * Usage:
 *   PUBLIC_URL=https://app.ikonbai.com \
 *   TELEGRAM_BOT_TOKEN=123:abc \
 *   TELEGRAM_WEBHOOK_SECRET=$(openssl rand -hex 32) \
 *   tsx scripts/setup-telegram-webhook.ts
 *
 * Optional:
 *   --delete  : delete the current webhook (useful for rollback / local dev).
 *   --info    : print getWebhookInfo and exit.
 *
 * Why this is a script and not an /api/admin endpoint: rotating
 * TELEGRAM_WEBHOOK_SECRET is an out-of-band ops task — it requires reading
 * the new secret from Railway env vars BEFORE deploying. Doing it via HTTP
 * would race the deploy. Run this AFTER setting the env in Railway and
 * AFTER the new server is live.
 *
 * IMPORTANT: the secret token gets sent in the
 * X-Telegram-Bot-Api-Secret-Token header by Telegram on every webhook hit.
 * Our verifyTelegramSecret() in server/lib/telegram-inbound.ts compares it
 * to TELEGRAM_WEBHOOK_SECRET. They MUST match exactly.
 */

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const PUBLIC_URL = process.env.PUBLIC_URL || process.env.APP_URL;

const args = process.argv.slice(2);
const wantDelete = args.includes("--delete");
const wantInfo = args.includes("--info");

function fail(msg: string): never {
  console.error(`[setup-telegram-webhook] ${msg}`);
  process.exit(1);
}

if (!BOT_TOKEN) fail("TELEGRAM_BOT_TOKEN env var required");

const apiBase = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function main() {
  if (wantInfo) {
    const r = await fetch(`${apiBase}/getWebhookInfo`);
    const j = await r.json();
    console.log(JSON.stringify(j, null, 2));
    return;
  }

  if (wantDelete) {
    // drop_pending_updates=true so a backlog from a previous deploy doesn't
    // spam the new server; safe because we only allow-list BOSS and dropped
    // updates would fail allowlist anyway.
    const r = await fetch(`${apiBase}/deleteWebhook?drop_pending_updates=true`, { method: "POST" });
    const j = await r.json();
    if (!j.ok) fail(`deleteWebhook failed: ${JSON.stringify(j)}`);
    console.log("[setup-telegram-webhook] webhook deleted ✓");
    return;
  }

  // Default path: setWebhook
  if (!PUBLIC_URL) fail("PUBLIC_URL env var required (e.g. https://app.ikonbai.com)");
  if (!WEBHOOK_SECRET) fail("TELEGRAM_WEBHOOK_SECRET env var required");
  if (!/^[A-Za-z0-9_\-]{1,256}$/.test(WEBHOOK_SECRET)) {
    fail("TELEGRAM_WEBHOOK_SECRET must be 1-256 chars of [A-Za-z0-9_-] per Telegram spec");
  }

  const url = `${PUBLIC_URL.replace(/\/$/, "")}/api/telegram/webhook`;
  const params = new URLSearchParams({
    url,
    secret_token: WEBHOOK_SECRET,
    // Only the message-update kinds we actually act on.
    allowed_updates: JSON.stringify(["message"]),
    drop_pending_updates: "true",
  });

  const r = await fetch(`${apiBase}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const j = await r.json();
  if (!j.ok) fail(`setWebhook failed: ${JSON.stringify(j)}`);

  console.log(`[setup-telegram-webhook] webhook set ✓ → ${url}`);
  // Echo current state so ops can sanity-check.
  const info = await (await fetch(`${apiBase}/getWebhookInfo`)).json();
  console.log("[setup-telegram-webhook] current info:", JSON.stringify(info.result, null, 2));
}

main().catch((err) => {
  console.error("[setup-telegram-webhook] crashed:", err);
  process.exit(1);
});
