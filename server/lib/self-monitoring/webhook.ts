/**
 * KIOKU™ Self-Monitoring — Alerter
 *
 * Sends drift/fabrication alerts to an external webhook. Supports three
 * formats so the user can point at Slack, Discord, or any generic webhook
 * that accepts JSON.
 *
 * ENV:
 *   KIOKU_ALERT_WEBHOOK_URL     — target URL. If unset, alerter is a no-op.
 *   KIOKU_ALERT_WEBHOOK_FORMAT  — 'slack' | 'discord' | 'generic' (default)
 *
 * Never throws on webhook failure (we don't want self-monitoring to break
 * the rest of the system). Returns a result object the caller can log.
 *
 * Rate-limit: callers should batch alerts before calling sendAlert(). This
 * module does not dedupe by itself.
 */

import logger from "../../logger";

export type AlertSeverity = "info" | "warn" | "critical";

export type AlertPayload = {
  severity: AlertSeverity;
  title: string;
  detail: string;
  context?: Record<string, unknown>;
};

export type AlertResult =
  | { delivered: true; status: number }
  | { delivered: false; reason: "no_webhook_configured" | "network_error" | "non_2xx"; detail?: string };

export type AlertFormat = "slack" | "discord" | "generic";

// ── Format adapters ──────────────────────────────────────────────────────────

function toSlackBody(p: AlertPayload): unknown {
  const emoji =
    p.severity === "critical" ? ":red_circle:" :
    p.severity === "warn"     ? ":warning:" :
                                ":information_source:";
  const lines: string[] = [
    `${emoji} *[KIOKU · ${p.severity.toUpperCase()}]* ${p.title}`,
    p.detail,
  ];
  if (p.context) lines.push("```" + JSON.stringify(p.context, null, 2) + "```");
  return { text: lines.join("\n") };
}

// Discord embed field limits (docs.discord.com):
//   field.name  ≤ 256 chars
//   field.value ≤ 1024 chars
//   embed.title ≤ 256, description ≤ 4096, up to 25 fields.
// BRO1 M-7: enforce explicitly; we had no slice() so any oversized drift
// context would 400 silently.
const DISCORD_FIELD_NAME_MAX = 256;
const DISCORD_FIELD_VALUE_MAX = 1024;
const DISCORD_TITLE_MAX = 256;
const DISCORD_DESCRIPTION_MAX = 4096;
const DISCORD_FIELDS_MAX = 25;

function toDiscordBody(p: AlertPayload): unknown {
  const color =
    p.severity === "critical" ? 0xe74c3c :
    p.severity === "warn"     ? 0xf1c40f :
                                0x3498db;
  const title = `[KIOKU · ${p.severity.toUpperCase()}] ${p.title}`.slice(
    0,
    DISCORD_TITLE_MAX,
  );
  const description = String(p.detail ?? "").slice(0, DISCORD_DESCRIPTION_MAX);
  const fields = p.context
    ? Object.entries(p.context)
        .slice(0, DISCORD_FIELDS_MAX)
        .map(([name, value]) => ({
          name: String(name).slice(0, DISCORD_FIELD_NAME_MAX),
          value: ("```" + JSON.stringify(value) + "```").slice(
            0,
            DISCORD_FIELD_VALUE_MAX,
          ),
          inline: false,
        }))
    : [];
  return {
    embeds: [
      {
        title,
        description,
        color,
        fields,
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

function toGenericBody(p: AlertPayload): unknown {
  return {
    source: "kioku",
    severity: p.severity,
    title: p.title,
    detail: p.detail,
    context: p.context ?? {},
    sent_at: new Date().toISOString(),
  };
}

function buildBody(format: AlertFormat, p: AlertPayload): unknown {
  switch (format) {
    case "slack":   return toSlackBody(p);
    case "discord": return toDiscordBody(p);
    case "generic":
    default:        return toGenericBody(p);
  }
}

// ── Sender ───────────────────────────────────────────────────────────────────

/**
 * Resolve format from ENV, defaulting to generic. Invalid values fall back
 * to generic and log a warning (but don't throw).
 */
function resolveFormat(): AlertFormat {
  const raw = (process.env.KIOKU_ALERT_WEBHOOK_FORMAT ?? "").toLowerCase();
  if (raw === "slack" || raw === "discord" || raw === "generic") return raw;
  if (raw !== "") {
    logger.warn(
      { component: "self-monitoring", event: "unknown_webhook_format", raw },
      "[self-monitoring] KIOKU_ALERT_WEBHOOK_FORMAT invalid, falling back to generic",
    );
  }
  return "generic";
}

export async function sendAlert(
  payload: AlertPayload,
  opts: { webhookUrl?: string; format?: AlertFormat; timeoutMs?: number } = {},
): Promise<AlertResult> {
  const url = opts.webhookUrl ?? process.env.KIOKU_ALERT_WEBHOOK_URL ?? "";
  if (!url) return { delivered: false, reason: "no_webhook_configured" };

  const format = opts.format ?? resolveFormat();
  const body = buildBody(format, payload);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5000);

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      // M-7: include probe/alert context so ops can correlate a non-2xx with
      // which drift event tripped the webhook limit.
      logger.warn(
        {
          component: "self-monitoring",
          event: "webhook_non_2xx",
          status: resp.status,
          body: txt.slice(0, 200),
          format,
          severity: payload.severity,
          title: payload.title,
        },
        "[self-monitoring] webhook returned non-2xx",
      );
      return { delivered: false, reason: "non_2xx", detail: `status=${resp.status}` };
    }
    return { delivered: true, status: resp.status };
  } catch (err: any) {
    logger.warn(
      {
        component: "self-monitoring",
        event: "webhook_network_error",
        err: err?.message,
        format,
        severity: payload.severity,
        title: payload.title,
      },
      "[self-monitoring] webhook network error",
    );
    return { delivered: false, reason: "network_error", detail: err?.message };
  } finally {
    clearTimeout(timer);
  }
}
