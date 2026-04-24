/**
 * KIOKU™ Internal Jobs — dedicated alert webhook
 *
 * Step 3 (PR #68): decision was to NOT reuse KIOKU_ALERT_WEBHOOK_URL (which
 * carries Self-Monitoring drift/fabrication alerts) because:
 *   - Self-Monitoring alerts = "the product's behaviour drifted" (user-impact)
 *   - Job alerts              = "infrastructure / backup / maintenance" (ops)
 * Different on-call reactions → different channels.
 *
 * Falls back to the self-monitoring webhook on *critical* severity so failures
 * still surface loudly even if JOBS_WEBHOOK_URL is misconfigured. This avoids
 * the scenario where backup is silently broken for weeks.
 *
 * ENV:
 *   JOBS_WEBHOOK_URL      — primary destination (Discord / Slack / generic)
 *   JOBS_WEBHOOK_FORMAT   — 'discord' | 'slack' | 'generic' (default discord)
 *   KIOKU_ALERT_WEBHOOK_URL — critical-severity fallback if JOBS_WEBHOOK_URL empty
 */

import { sendAlert, type AlertPayload, type AlertResult, type AlertFormat } from "../self-monitoring/webhook";

export async function notifyJob(
  payload: AlertPayload,
): Promise<AlertResult> {
  const primary = process.env.JOBS_WEBHOOK_URL ?? "";
  const format = (() => {
    const raw = (process.env.JOBS_WEBHOOK_FORMAT ?? "discord").toLowerCase();
    if (raw === "slack" || raw === "discord" || raw === "generic") return raw as AlertFormat;
    return "discord" as AlertFormat;
  })();

  if (primary) {
    return sendAlert(payload, { webhookUrl: primary, format });
  }

  // Fallback: only escalate to self-monitoring channel if the failure is
  // critical. Quiet / info messages just drop silently to avoid polluting
  // the product-drift channel.
  if (payload.severity === "critical") {
    const fallback = process.env.KIOKU_ALERT_WEBHOOK_URL ?? "";
    if (fallback) {
      return sendAlert(
        { ...payload, title: `[FALLBACK — JOBS_WEBHOOK_URL unset] ${payload.title}` },
        { webhookUrl: fallback },
      );
    }
  }

  return { delivered: false, reason: "no_webhook_configured" };
}
