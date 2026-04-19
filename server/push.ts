// @ts-ignore
import webpush from "web-push";
import { pool } from "./storage";
import logger from "./logger";

// VAPID keys for web push
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "BK9sHXdDeLmWTWX6qEfw7dA4RR-R77zZ0mHpFKigtJeiF0i3KNHb-Rlx_xwiY4tjTg4PQ6pZgFqh6vGG-WGn5NQ";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "Cezlj7tiR6UFZs0Szs5XFG8H9Q_cAWE9bmTkTdwulF0";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:support@usekioku.com";

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

export { VAPID_PUBLIC_KEY };

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  category?: string;
}

/** Save a push subscription for a user */
export async function savePushSubscription(
  userId: number,
  endpoint: string,
  p256dh: string,
  auth: string,
  categories?: string[]
): Promise<void> {
  const cats = JSON.stringify(categories || ["daily_brief", "task_complete", "agent_alert"]);
  await pool.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, categories, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (endpoint) DO UPDATE SET
       user_id = EXCLUDED.user_id,
       p256dh = EXCLUDED.p256dh,
       auth = EXCLUDED.auth,
       categories = EXCLUDED.categories`,
    [userId, endpoint, p256dh, auth, cats, Date.now()]
  );
}

/** Remove a push subscription by endpoint */
export async function removePushSubscription(endpoint: string): Promise<void> {
  await pool.query("DELETE FROM push_subscriptions WHERE endpoint = $1", [endpoint]);
}

/** Get all push subscriptions for a user */
export async function getUserSubscriptions(userId: number): Promise<any[]> {
  const result = await pool.query(
    "SELECT * FROM push_subscriptions WHERE user_id = $1",
    [userId]
  );
  return result.rows;
}

/** Send push notification to all subscriptions for a user */
export async function sendPushNotification(
  userId: number,
  payload: PushPayload
): Promise<{ sent: number; failed: number }> {
  const subs = await getUserSubscriptions(userId);
  let sent = 0;
  let failed = 0;

  for (const sub of subs) {
    // Check if subscription has this category enabled
    const categories: string[] = JSON.parse(sub.categories || "[]");
    if (payload.category && categories.length > 0 && !categories.includes(payload.category)) {
      continue;
    }

    const pushSubscription = {
      endpoint: sub.endpoint,
      keys: {
        p256dh: sub.p256dh,
        auth: sub.auth,
      },
    };

    try {
      await webpush.sendNotification(pushSubscription, JSON.stringify(payload));
      sent++;
    } catch (err: any) {
      failed++;
      logger.warn({ source: "push", endpoint: sub.endpoint, status: err.statusCode }, "push notification failed");
      // Remove expired/invalid subscriptions (410 Gone or 404 Not Found)
      if (err.statusCode === 410 || err.statusCode === 404) {
        await removePushSubscription(sub.endpoint);
        logger.info({ source: "push", endpoint: sub.endpoint }, "removed stale subscription");
      }
    }
  }

  return { sent, failed };
}

/** Update notification categories for a subscription */
export async function updateSubscriptionCategories(
  endpoint: string,
  categories: string[]
): Promise<void> {
  await pool.query(
    "UPDATE push_subscriptions SET categories = $1 WHERE endpoint = $2",
    [JSON.stringify(categories), endpoint]
  );
}
