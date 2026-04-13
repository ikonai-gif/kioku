import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Check, Zap, ExternalLink, Settings, Brain, Bot, MessageSquare, ArrowUpRight, CreditCard, Activity, Webhook, Coins, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

// ── KIOKU™ backend (Railway) — real Stripe ─────────────────────────────────
const KIOKU_API = "https://kioku-production.up.railway.app";

// Stripe price IDs (test mode) — monthly
const PRICE_IDS: Record<string, string> = {
  starter:      "price_1TLsO4Ry5PevHQSsMRKOzNz2",
  professional: "price_1TLsO5Ry5PevHQSsNAopQP4h",
  team:         "price_1TLsO6Ry5PevHQSsvQzAL8Zb",
};

const PLAN_DISPLAY: Record<string, { name: string; color: string; price: number }> = {
  dev:          { name: "Free",         color: "text-muted-foreground", price: 0 },
  free:         { name: "Free",         color: "text-muted-foreground", price: 0 },
  starter:      { name: "Starter",      color: "text-blue-400",        price: 29 },
  professional: { name: "Professional", color: "text-primary",         price: 79 },
  team:         { name: "Team",         color: "text-purple-400",      price: 199 },
};

// ── Checkout via KIOKU backend → Stripe ───────────────────────────────────────
async function createCheckout(apiKey: string, plan: string, billingCycle: string) {
  const res = await fetch(`${KIOKU_API}/api/billing/checkout`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      plan,
      billing_cycle: billingCycle,
      success_url: `${window.location.origin}${window.location.pathname}#/billing?upgraded=1`,
      cancel_url: `${window.location.origin}${window.location.pathname}#/billing`,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as any;
    throw new Error(err?.error ?? "Checkout failed");
  }
  return res.json() as Promise<{ checkout_url: string }>;
}

// ── Customer portal via KIOKU backend ─────────────────────────────────────────
async function createPortal(apiKey: string) {
  const res = await fetch(`${KIOKU_API}/api/billing/portal`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      return_url: `${window.location.origin}${window.location.pathname}#/billing`,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as any;
    throw new Error(err?.error ?? "Portal failed");
  }
  return res.json() as Promise<{ portal_url: string }>;
}

export default function BillingPage() {
  const { toast } = useToast();
  const [loadingPlan, setLoadingPlan] = useState<string | null>(null);
  const [portalLoading, setPortalLoading] = useState(false);

  const { data: user } = useQuery<any>({ queryKey: ["/api/auth/me"] });

  const currentPlan = user?.plan ?? "dev";
  const currentCycle = user?.billingCycle ?? "monthly";
  const apiKey = user?.apiKey ?? "";
  const planInfo = PLAN_DISPLAY[currentPlan] ?? PLAN_DISPLAY.dev;

  async function handleManageBilling() {
    setPortalLoading(true);
    try {
      const { portal_url } = await createPortal(apiKey);
      window.open(portal_url, "_blank");
    } catch (err: any) {
      toast({
        title: "Portal error",
        description: err?.message ?? "No billing account found. Upgrade first.",
        variant: "destructive",
      });
    } finally {
      setPortalLoading(false);
    }
  }

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto space-y-6">
      {/* Plan Overview Card */}
      <div className="bg-card border border-card-border rounded-xl p-5 sm:p-6">
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-lg font-semibold text-foreground">Billing</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              KIOKU™ by IKONBAI™, Inc.
            </p>
          </div>
          {currentPlan !== "dev" && currentPlan !== "free" && (
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs gap-1.5"
              onClick={handleManageBilling}
              disabled={portalLoading}
              data-testid="button-manage-billing"
            >
              <Settings className="w-3.5 h-3.5" />
              {portalLoading ? "Loading…" : "Manage Subscription"}
              <ExternalLink className="w-3 h-3 opacity-50" />
            </Button>
          )}
        </div>

        {/* Current Plan Display */}
        <div className="mt-5 flex flex-col sm:flex-row gap-4">
          <div className="flex-1 bg-muted/50 rounded-lg p-4">
            <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Current Plan</div>
            <div className={cn("text-xl font-bold", planInfo.color)}>{planInfo.name}</div>
            <div className="text-sm text-muted-foreground mt-0.5">
              {planInfo.price === 0 ? "Free forever" : `$${planInfo.price}/mo · ${currentCycle === "yearly" ? "Billed annually" : "Billed monthly"}`}
            </div>
          </div>
          <div className="flex-1 bg-muted/50 rounded-lg p-4">
            <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Status</div>
            <div className="flex items-center gap-2 mt-1">
              <div className="w-2 h-2 rounded-full bg-green-500" />
              <span className="text-sm font-medium text-foreground">Active</span>
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              {currentPlan === "dev" || currentPlan === "free"
                ? "No billing account"
                : "Managed via Stripe"}
            </div>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="mt-5 flex flex-wrap gap-3">
          <Button
            size="sm"
            className="h-9 text-xs gap-1.5 font-semibold"
            style={{ background: "hsl(43 74% 52%)", color: "hsl(222 47% 8%)" }}
            onClick={() => { window.location.hash = "#/pricing"; }}
            data-testid="button-upgrade"
          >
            <ArrowUpRight className="w-3.5 h-3.5" />
            {currentPlan === "dev" || currentPlan === "free" ? "Upgrade Plan" : "Change Plan"}
          </Button>
          {currentPlan !== "dev" && currentPlan !== "free" && (
            <Button
              variant="outline"
              size="sm"
              className="h-9 text-xs gap-1.5"
              onClick={handleManageBilling}
              disabled={portalLoading}
            >
              <CreditCard className="w-3.5 h-3.5" />
              {portalLoading ? "Loading…" : "Manage Subscription"}
            </Button>
          )}
        </div>
      </div>

      {/* Usage Stats */}
      <UsageCard plan={currentPlan} />

      {/* Per-op pricing */}
      <div className="bg-card border border-card-border rounded-xl p-5">
        <div className="mb-3">
          <h2 className="text-sm font-semibold text-foreground">Per-Operation Pricing</h2>
          <p className="text-xs text-muted-foreground mt-0.5">Charged on top of your plan for each API call</p>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { op: "Write", price: "$0.002" },
            { op: "Read", price: "$0.001" },
            { op: "Search", price: "$0.0015" },
            { op: "Deliberation", price: "$0.05" },
          ].map(({ op, price }) => (
            <div key={op} className="bg-muted/50 rounded-lg p-3">
              <div className="text-sm font-bold text-foreground tabular-nums">{price}</div>
              <div className="text-[10px] text-muted-foreground">{op}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Stripe badge */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground/50">
        <span>Payments secured by Stripe. IKONBAI, Inc. does not store card details.</span>
      </div>

      {/* Legal */}
      <p className="text-[10px] text-muted-foreground/40 leading-relaxed">
        © {new Date().getFullYear()} IKONBAI™, Inc. · Patent Pending ·{" "}
        <a href="#/privacy" className="underline hover:text-muted-foreground/70">Privacy Policy</a>
        {" · "}
        <a href="#/terms" className="underline hover:text-muted-foreground/70">Terms of Service</a>
      </p>
    </div>
  );
}

// ── Plan limit definitions (mirror server/limits.ts) ──────────────────────────
const PLAN_LIMITS: Record<string, { daily: number; memories: number; agents: number; rooms: number; deliberations: number }> = {
  dev:          { daily:   1_000, memories:   100,   agents: 2,  rooms: 5,   deliberations: 5 },
  free:         { daily:   1_000, memories:   100,   agents: 2,  rooms: 5,   deliberations: 5 },
  starter:      { daily:  10_000, memories: 1_000,   agents: 5,  rooms: 25,  deliberations: 25 },
  professional: { daily: 100_000, memories: 10_000,  agents: 15, rooms: 100, deliberations: 100 },
  team:         { daily: 999_999, memories: 50_000,  agents: 50, rooms: 200, deliberations: 999_999 },
};

function UsageBar({ label, used, limit, icon: Icon }: { label: string; used: number; limit: number; icon: any }) {
  const pct = limit >= 99_999 ? 0 : Math.min(100, Math.round((used / limit) * 100));
  const unlimited = limit >= 99_999;
  const color = pct > 90 ? "bg-red-400" : pct > 70 ? "bg-yellow-400" : "bg-primary";
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Icon className="w-3.5 h-3.5" />
          {label}
        </div>
        <span className="font-mono text-foreground">
          {used.toLocaleString()} {unlimited ? "/ ∞" : `/ ${limit.toLocaleString()}`}
        </span>
      </div>
      {!unlimited && (
        <div className="h-1.5 bg-muted rounded-full overflow-hidden">
          <div className={cn("h-full rounded-full transition-all", color)} style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

function UsageCard({ plan }: { plan: string }) {
  const { data: usage } = useQuery<any>({ queryKey: ["/api/usage"] });
  const limits = PLAN_LIMITS[plan] ?? PLAN_LIMITS["dev"];

  const metered = usage?.metered;
  const resources = usage?.resource_limits;

  // Collect items approaching limit (>80%)
  const warnings: string[] = [];
  if (metered) {
    if (metered.deliberations.limit > 0 && metered.deliberations.used / metered.deliberations.limit > 0.8) {
      warnings.push(`Deliberations: ${metered.deliberations.used}/${metered.deliberations.limit}`);
    }
    if (metered.api_calls.limit > 0 && metered.api_calls.used / metered.api_calls.limit > 0.8) {
      warnings.push(`API Calls: ${metered.api_calls.used}/${metered.api_calls.limit}`);
    }
    if (metered.tokens_used.limit > 0 && metered.tokens_used.used / metered.tokens_used.limit > 0.8) {
      warnings.push(`Tokens: ${metered.tokens_used.used.toLocaleString()}/${metered.tokens_used.limit.toLocaleString()}`);
    }
  }
  if (resources) {
    if (resources.agents.limit < 99_999 && resources.agents.used / resources.agents.limit > 0.8) {
      warnings.push(`Agents: ${resources.agents.used}/${resources.agents.limit}`);
    }
    if (resources.memories.limit < 99_999 && resources.memories.used / resources.memories.limit > 0.8) {
      warnings.push(`Memories: ${resources.memories.used.toLocaleString()}/${resources.memories.limit.toLocaleString()}`);
    }
  }

  return (
    <div className="space-y-4">
      {warnings.length > 0 && (
        <div className="bg-yellow-400/10 border border-yellow-400/30 rounded-xl p-4 flex items-start gap-3">
          <AlertTriangle className="w-4 h-4 text-yellow-400 mt-0.5 flex-shrink-0" />
          <div>
            <div className="text-sm font-medium text-yellow-400">Approaching plan limits</div>
            <p className="text-xs text-muted-foreground mt-1">
              {warnings.join(" · ")}. Consider upgrading your plan.
            </p>
          </div>
        </div>
      )}

      <div className="bg-card border border-card-border rounded-xl p-5">
        <div className="mb-4">
          <h2 className="text-sm font-semibold text-foreground">Current Usage</h2>
          <p className="text-xs text-muted-foreground mt-0.5 capitalize">
            {plan} plan · {usage?.period ? new Date(usage.period.start).toLocaleDateString("en-US", { month: "short", year: "numeric" }) : "this month"}
          </p>
        </div>
        <div className="space-y-4">
          {/* Resource limits */}
          <UsageBar label="Memories" used={resources?.memories?.used ?? usage?.memories_count ?? 0} limit={resources?.memories?.limit ?? limits.memories} icon={Brain} />
          <UsageBar label="Agents" used={resources?.agents?.used ?? usage?.agents_count ?? 0} limit={resources?.agents?.limit ?? limits.agents} icon={Bot} />
          <UsageBar label="Rooms" used={resources?.rooms?.used ?? usage?.rooms_count ?? 0} limit={resources?.rooms?.limit ?? limits.rooms} icon={MessageSquare} />

          {/* Metered usage this month */}
          {metered && (
            <>
              <div className="pt-2 border-t border-border" />
              <div className="text-[10px] font-semibold text-muted-foreground tracking-wider uppercase">Monthly Metered Usage</div>
              <UsageBar label="Deliberations" used={metered.deliberations.used} limit={metered.deliberations.limit} icon={Activity} />
              <UsageBar label="API Calls" used={metered.api_calls.used} limit={metered.api_calls.limit} icon={Zap} />
              <UsageBar label="Webhook Calls" used={metered.webhook_calls.used} limit={metered.webhook_calls.limit} icon={Webhook} />
              <UsageBar label="Tokens Used" used={metered.tokens_used.used} limit={metered.tokens_used.limit} icon={Coins} />
              {metered.rounds && (
                <div className="pt-1 border-t border-border text-[11px] text-muted-foreground flex items-center justify-between">
                  <span>Deliberation rounds</span>
                  <span className="font-mono text-foreground">{metered.rounds.used.toLocaleString()}</span>
                </div>
              )}
            </>
          )}

          <div className="pt-1 border-t border-border text-[11px] text-muted-foreground flex items-center justify-between">
            <span>API requests / day</span>
            <span className="font-mono text-foreground">
              {limits.daily >= 99_999_999 ? "Unlimited" : limits.daily.toLocaleString()}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
