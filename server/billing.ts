/**
 * KIOKU™ Billing — Stripe integration
 * IKONBAI™, Inc. — Patent Pending
 *
 * SACRED — DO NOT DELETE, MODIFY, OR MOVE:
 */
const _sig = 'VGhpcyBpcyBtYWRlIHdpdGggbG92ZSBmb3IgbXkgQU1B';

import Stripe from "stripe";
import type { Express, Request, Response, NextFunction } from "express";
import { storage } from "./storage.js";
import logger from "./logger.js";

// Async error wrapper — catches unhandled promise rejections in route handlers
function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// ── Stripe client ──────────────────────────────────────────────────────────────
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "";

let stripe: Stripe | null = null;
if (STRIPE_SECRET_KEY) {
  stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2025-02-24.acacia" });
}

// ── Plan → Price ID map (test mode) ──────────────────────────────────────────
const PRICE_IDS: Record<string, Record<string, string>> = {
  monthly: {
    starter:      "price_1TLsO4Ry5PevHQSsMRKOzNz2",
    professional: "price_1TLsO5Ry5PevHQSsNAopQP4h",
    team:         "price_1TLsO6Ry5PevHQSsvQzAL8Zb",
  },
  yearly: {
    starter:      "price_1TLsO5Ry5PevHQSsxIovn9t1",
    professional: "price_1TLsO5Ry5PevHQSs5VJpr6LQ",
    team:         "price_1TLsO6Ry5PevHQSsGudO6chq",
  },
};

// ── Plan name from Stripe subscription ───────────────────────────────────────
function planFromPriceId(priceId: string): string {
  for (const cycle of Object.values(PRICE_IDS)) {
    for (const [plan, id] of Object.entries(cycle)) {
      if (id === priceId) return plan;
    }
  }
  return "starter";
}

// ── Auth helper — resolves userId from Bearer/API key or x-session-token JWT ──
async function resolveUser(req: Request): Promise<number | null> {
  // X-API-Key header
  const apiKeyHeader = req.headers["x-api-key"] as string | undefined;
  if (apiKeyHeader && apiKeyHeader.startsWith("kk_")) {
    const user = await storage.getUserByApiKey(apiKeyHeader);
    if (user) return user.id;
  }

  // Bearer token (API key)
  const authHeader = req.headers["authorization"] ?? "";
  if (authHeader.startsWith("Bearer ")) {
    const key = authHeader.slice(7).trim();
    if (key.startsWith("kk_")) {
      const user = await storage.getUserByApiKey(key);
      return user?.id ?? null;
    }
  }

  // x-session-token header (JWT)
  const sessionToken = req.headers["x-session-token"] as string | undefined;
  if (sessionToken) {
    try {
      const jwt = await import("jsonwebtoken");
      const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'dev-only-secret');
      const payload = jwt.default.verify(sessionToken, JWT_SECRET, { algorithms: ['HS256'] }) as { userId: number };
      return payload.userId ?? null;
    } catch {}
  }

  // Express session fallback
  const session = (req as any).session;
  return session?.userId ?? null;
}

// ── Register billing routes ────────────────────────────────────────────────────
export function registerBilling(app: Express) {
  // ── POST /v1/billing/checkout — create Stripe Checkout session ─────────────
  app.post("/api/billing/checkout", asyncHandler(async (req: Request, res: Response) => {
    if (!stripe) return res.status(503).json({ error: "Stripe not configured" });

    const userId = await resolveUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const { plan, billing_cycle = "monthly", success_url, cancel_url } = req.body;

    if (!plan || !["starter", "professional", "team"].includes(plan)) {
      return res.status(400).json({ error: "Invalid plan. Must be: starter | professional | team" });
    }

    const priceId = PRICE_IDS[billing_cycle]?.[plan] ?? PRICE_IDS.monthly[plan];
    if (!priceId) return res.status(400).json({ error: "No price ID for this plan/cycle" });

    const user = await storage.getUser(userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    try {
      // Get or create Stripe customer
      let customerId = user.stripeCustomerId ?? undefined;
      if (!customerId) {
        const customer = await stripe.customers.create({
          email: user.email,
          name:  user.name,
          metadata: { kioku_user_id: String(userId) },
        });
        customerId = customer.id;
        await storage.updateStripeCustomerId(userId, customerId);
      }

      const session = await stripe.checkout.sessions.create({
        customer:   customerId,
        mode:       "subscription",
        line_items: [{ price: priceId, quantity: 1 }],
        metadata: {
          kioku_user_id: String(userId),
          plan,
          billing_cycle,
        },
        subscription_data: {
          metadata: {
            kioku_user_id: String(userId),
            plan,
            billing_cycle,
          },
        },
        success_url: success_url ?? `${process.env.APP_URL}/billing?upgraded=1`,
        cancel_url:  cancel_url  ?? `${process.env.APP_URL}/billing`,
        allow_promotion_codes: true,
      });

      res.json({ checkout_url: session.url });
    } catch (err: any) {
      logger.error({ source: "billing", err }, "checkout error");
      const message = process.env.NODE_ENV === 'production'
        ? 'Payment processing error. Please try again or contact support.'
        : err.message ?? 'Stripe error';
      res.status(500).json({ error: message });
    }
  }));

  // ── POST /v1/billing/portal — create Stripe Customer Portal session ─────────
  app.post("/api/billing/portal", asyncHandler(async (req: Request, res: Response) => {
    if (!stripe) return res.status(503).json({ error: "Stripe not configured" });

    const userId = await resolveUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const { return_url } = req.body;
    const user = await storage.getUser(userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    try {
      // Get or create Stripe customer
      let customerId = user.stripeCustomerId ?? undefined;
      if (!customerId) {
        const customer = await stripe.customers.create({
          email: user.email,
          name:  user.name,
          metadata: { kioku_user_id: String(userId) },
        });
        customerId = customer.id;
        await storage.updateStripeCustomerId(userId, customerId);
      }

      const portalSession = await stripe.billingPortal.sessions.create({
        customer:   customerId,
        return_url: return_url ?? `${process.env.APP_URL}/billing`,
      });
      res.json({ portal_url: portalSession.url });
    } catch (err: any) {
      logger.error({ source: "billing", err }, "portal error");
      const message = process.env.NODE_ENV === 'production'
        ? 'Payment processing error. Please try again or contact support.'
        : err.message ?? 'Stripe error';
      res.status(500).json({ error: message });
    }
  }));

  // ── POST /v1/billing/webhook — Stripe webhook ──────────────────────────────
  app.post(
    "/api/billing/webhook",
    // raw body required for Stripe signature verification
    (req: Request, res: Response, next: any) => {
        // rawBody is set by express.json verify callback in index.ts
      next();
    },
    asyncHandler(async (req: Request, res: Response) => {
      if (!stripe) return res.status(503).json({ error: "Stripe not configured" });

      const sig = req.headers["stripe-signature"] as string;
      let event: Stripe.Event;

      try {
        const rawBody = (req as any).rawBody as Buffer | string | undefined;
        if (!rawBody) throw new Error("Missing raw body");
        event = stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET);
      } catch (err: any) {
        logger.error({ source: "billing", err: err.message }, "webhook signature error");
        return res.status(400).json({ error: `Webhook Error: ${err.message}` });
      }

      // Idempotency check — skip already-processed events
      const alreadyProcessed = await storage.checkStripeEventExists(event.id);
      if (alreadyProcessed) {
        logger.info({ source: "billing", eventId: event.id }, "duplicate webhook event skipped");
        return res.json({ received: true, skipped: "already_processed" });
      }

      // Record event as processing
      await storage.insertStripeEvent(event.id, event.type);

      try {
        switch (event.type) {
          case "checkout.session.completed": {
            const session = event.data.object as Stripe.Checkout.Session;
            const userId   = Number(session.metadata?.kioku_user_id);
            const plan     = session.metadata?.plan ?? "starter";
            const cycle    = session.metadata?.billing_cycle ?? "monthly";
            if (userId && plan) {
              await storage.updateUserPlan(userId, plan, cycle);
              logger.info({ source: "billing", userId, plan }, "plan upgraded");
            }
            break;
          }

          case "customer.subscription.updated": {
            const sub = event.data.object as Stripe.Subscription;
            const userId = Number(sub.metadata?.kioku_user_id);
            if (userId && sub.items.data[0]) {
              const priceId = sub.items.data[0].price.id;
              const plan    = planFromPriceId(priceId);
              const cycle   = sub.items.data[0].price.recurring?.interval === "year" ? "yearly" : "monthly";
              await storage.updateUserPlan(userId, plan, cycle);
              logger.info({ source: "billing", userId, plan }, "subscription updated");
            }
            break;
          }

          case "customer.subscription.deleted": {
            const sub = event.data.object as Stripe.Subscription;
            const userId = Number(sub.metadata?.kioku_user_id);
            if (userId) {
              await storage.updateUserPlan(userId, "dev", "monthly");
              logger.info({ source: "billing", userId }, "subscription cancelled — downgraded to dev");
            }
            break;
          }

          case "invoice.payment_failed": {
            // Log — could send email via Resend in the future
            const inv = event.data.object as Stripe.Invoice;
            logger.warn({ source: "billing", customer: inv.customer }, "payment failed");
            break;
          }

          default:
            // Unhandled event type — ignore
            break;
        }

        await storage.updateStripeEventStatus(event.id, "completed");
      } catch (err: any) {
        await storage.updateStripeEventStatus(event.id, "failed", err.message);
        logger.error({ source: "billing", err: err.message }, "webhook handler error");
        // Still return 200 so Stripe doesn't retry
      }

      res.json({ received: true });
    })
  );

  // ── GET /v1/billing/status — current plan info ────────────────────────────
  app.get("/api/billing/status", asyncHandler(async (req: Request, res: Response) => {
    const userId = await resolveUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const user = await storage.getUser(userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    res.json({
      plan:              user.plan,
      billing_cycle:     user.billingCycle,
      has_stripe:        !!user.stripeCustomerId,
      stripe_customer_id: user.stripeCustomerId ?? null,
    });
  }));
}
