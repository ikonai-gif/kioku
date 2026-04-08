import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Check, Zap, ExternalLink, Settings, Brain, Bot, MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";

// ── KIOKU™ backend (Railway) — real Stripe ─────────────────────────────────
const KIOKU_API = "https://kioku-production.up.railway.app";

// Stripe price IDs (test mode) — monthly
const PRICE_IDS: Record<string, string> = {
  starter:  "price_1TJVhRRy5PevHQSskLkwUrZM",
  team:     "price_1TJVhSRy5PevHQSstibtGqmq",
  business: "price_1TJVhSRy5PevHQSsxafV0Z9M",
};

const PLANS = [
  {
    id: "dev",
    name: "DEV",
    monthlyPrice: 0,
    yearlyPrice: 0,
    color: "text-muted-foreground",
    features: ["20 req/min", "1,000 memories", "Hybrid search", "Auto-deduplication"],
  },
  {
    id: "starter",
    name: "STARTER",
    monthlyPrice: 9,
    yearlyPrice: 86,
    color: "text-blue-400",
    features: ["60 req/min", "10,000 memories", "Redis cache", "Usage analytics"],
  },
  {
    id: "team",
    name: "TEAM",
    monthlyPrice: 49,
    yearlyPrice: 470,
    color: "text-yellow-400",
    popular: true,
    features: ["200 req/min", "100,000 memories", "Deliberation Room", "Multi-agent namespaces"],
  },
  {
    id: "business",
    name: "BUSINESS",
    monthlyPrice: 199,
    yearlyPrice: 1910,
    color: "text-purple-400",
    features: ["600 req/min", "Unlimited memories", "Priority support", "SLA 99.9%"],
  },
];

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
  const [cycle, setCycle] = useState<"monthly" | "yearly">("monthly");
  const [loadingPlan, setLoadingPlan] = useState<string | null>(null);
  const [portalLoading, setPortalLoading] = useState(false);

  const { data: user } = useQuery<any>({ queryKey: ["/api/auth/me"] });

  // Fallback downgrade (DEV plan — no Stripe needed)
  const downgradeMutation = useMutation({
    mutationFn: ({ plan, billingCycle }: { plan: string; billingCycle: string }) =>
      apiRequest("PATCH", "/api/billing/plan", { plan, billingCycle }).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      toast({ title: "Plan updated to DEV" });
    },
    onError: () => toast({ title: "Update failed", variant: "destructive" }),
  });

  const currentPlan = user?.plan ?? "dev";
  const currentCycle = user?.billingCycle ?? "monthly";
  // API key is stored in user.apiKey or we use master key for demo
  const apiKey = user?.apiKey ?? "kioku_master_ikonbai_2026_secret";

  const savings = (plan: typeof PLANS[0]) => {
    if (plan.monthlyPrice === 0) return null;
    return (plan.monthlyPrice * 12) - plan.yearlyPrice;
  };

  async function handleUpgrade(planId: string) {
    if (planId === "dev") {
      downgradeMutation.mutate({ plan: "dev", billingCycle: cycle });
      return;
    }
    setLoadingPlan(planId);
    try {
      const { checkout_url } = await createCheckout(apiKey, planId, cycle);
      // Redirect to Stripe Checkout
      window.location.href = checkout_url;
    } catch (err: any) {
      toast({
        title: "Checkout error",
        description: err?.message ?? "Could not open payment page",
        variant: "destructive",
      });
      setLoadingPlan(null);
    }
  }

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
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-lg font-semibold text-foreground">Billing</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            KIOKU™ by IKONBAI™, Inc. &nbsp;·&nbsp; Current plan:{" "}
            <span className="font-semibold text-foreground capitalize">{currentPlan}</span>
            {" · "}{currentCycle === "yearly" ? "Billed annually" : "Billed monthly"}
          </p>
        </div>
        {currentPlan !== "dev" && (
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs gap-1.5"
            onClick={handleManageBilling}
            disabled={portalLoading}
            data-testid="button-manage-billing"
          >
            <Settings className="w-3.5 h-3.5" />
            {portalLoading ? "Loading…" : "Manage Billing"}
            <ExternalLink className="w-3 h-3 opacity-50" />
          </Button>
        )}
      </div>

      {/* Billing cycle toggle */}
      <div className="flex items-center gap-1 bg-muted p-1 rounded-lg w-fit">
        <button
          className={cn(
            "px-4 py-1.5 rounded-md text-sm font-medium transition-all",
            cycle === "monthly" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
          )}
          onClick={() => setCycle("monthly")}
          data-testid="button-billing-monthly"
        >
          Monthly
        </button>
        <button
          className={cn(
            "px-4 py-1.5 rounded-md text-sm font-medium transition-all flex items-center gap-1.5",
            cycle === "yearly" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
          )}
          onClick={() => setCycle("yearly")}
          data-testid="button-billing-yearly"
        >
          Yearly
          <span className="text-[10px] text-green-400 font-semibold">-20%</span>
        </button>
      </div>

      {/* Plans grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {PLANS.map(plan => {
          const isActive = currentPlan === plan.id;
          const price = cycle === "yearly" ? plan.yearlyPrice : plan.monthlyPrice;
          const saved = savings(plan);
          const isLoading = loadingPlan === plan.id;

          return (
            <div
              key={plan.id}
              className={cn(
                "bg-card border rounded-xl p-5 flex flex-col transition-all",
                isActive ? "border-primary gold-glow" : "border-card-border hover:border-muted-foreground/30",
                plan.popular && !isActive && "border-yellow-400/30"
              )}
              data-testid={`card-plan-${plan.id}`}
            >
              {plan.popular && (
                <div className="flex items-center gap-1 text-[10px] text-yellow-400 font-semibold mb-2">
                  <Zap className="w-3 h-3" /> Most Popular
                </div>
              )}

              <div className={cn("text-xs font-bold tracking-widest mb-1", plan.color)}>{plan.name}</div>

              <div className="mb-4">
                {plan.monthlyPrice === 0 ? (
                  <div className="text-2xl font-bold text-foreground">Free</div>
                ) : (
                  <>
                    <div className="text-2xl font-bold text-foreground tabular-nums">
                      ${price}
                      <span className="text-sm font-normal text-muted-foreground">/{cycle === "yearly" ? "yr" : "mo"}</span>
                    </div>
                    {cycle === "yearly" ? (
                      saved ? <div className="text-[10px] text-green-400 font-medium mt-0.5">Save ${saved}/yr</div> : null
                    ) : (
                      <div className="text-[10px] text-muted-foreground mt-0.5">${plan.yearlyPrice}/yr billed annually</div>
                    )}
                  </>
                )}
              </div>

              <ul className="space-y-1.5 flex-1 mb-4">
                {plan.features.map(f => (
                  <li key={f} className="flex items-start gap-1.5 text-xs text-muted-foreground">
                    <Check className="w-3 h-3 text-green-400 mt-0.5 flex-shrink-0" />
                    {f}
                  </li>
                ))}
              </ul>

              {isActive ? (
                <div className="text-center text-xs font-medium text-primary py-2">Current Plan</div>
              ) : (
                <Button
                  size="sm"
                  className="w-full h-8 text-xs gap-1"
                  variant={plan.id === "dev" ? "outline" : "default"}
                  style={plan.id !== "dev" ? { background: "hsl(43 74% 52%)", color: "hsl(222 47% 8%)" } : {}}
                  onClick={() => handleUpgrade(plan.id)}
                  disabled={isLoading || downgradeMutation.isPending}
                  data-testid={`button-select-plan-${plan.id}`}
                >
                  {isLoading ? "Opening…" : plan.monthlyPrice === 0 ? "Downgrade" : (
                    <>{`Upgrade`} <ExternalLink className="w-3 h-3 opacity-60" /></>
                  )}
                </Button>
              )}
            </div>
          );
        })}
      </div>

      {/* Usage stats */}
      <UsageCard plan={currentPlan} />

      {/* Stripe badge */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground/50">
        <span>🔒 Payments secured by Stripe. IKONBAI™, Inc. does not store card details.</span>
      </div>

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

// ── Plan limit definitions (mirror ratelimit.ts) ──────────────────────────
const PLAN_LIMITS: Record<string, { daily: number; memories: number; agents: number; rooms: number }> = {
  dev:        { daily:      1_000, memories:   500, agents:  3, rooms: 1 },
  starter:    { daily:     10_000, memories: 10_000, agents: 10, rooms: 5 },
  growth:     { daily:    100_000, memories: 999_999, agents: 99, rooms: 99 },
  enterprise: { daily: 99_999_999, memories: 999_999, agents: 99, rooms: 99 },
};

function UsageBar({ label, used, limit, icon: Icon }: { label: string; used: number; limit: number; icon: any }) {
  const pct = limit >= 99_999 ? 0 : Math.min(100, Math.round((used / limit) * 100));
  const unlimited = limit >= 99_999;
  const color = pct > 90 ? "bg-red-400" : pct > 70 ? "bg-yellow-400" : "bg-green-400";
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
  const { data: stats } = useQuery<any>({ queryKey: ["/api/stats"] });
  const { data: agents = [] } = useQuery<any[]>({ queryKey: ["/api/agents"] });
  const { data: rooms = [] } = useQuery<any[]>({ queryKey: ["/api/rooms"] });
  const limits = PLAN_LIMITS[plan] ?? PLAN_LIMITS["dev"];

  return (
    <div className="bg-card border border-card-border rounded-xl p-5">
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-foreground">Current Usage</h2>
        <p className="text-xs text-muted-foreground mt-0.5 capitalize">{plan} plan limits</p>
      </div>
      <div className="space-y-4">
        <UsageBar label="Memories" used={(stats as any)?.totalMemories ?? 0} limit={limits.memories} icon={Brain} />
        <UsageBar label="Agents" used={(agents as any[]).length} limit={limits.agents} icon={Bot} />
        <UsageBar label="Rooms" used={(rooms as any[]).length} limit={limits.rooms} icon={MessageSquare} />
        <div className="pt-1 border-t border-border text-[11px] text-muted-foreground flex items-center justify-between">
          <span>API requests / day</span>
          <span className="font-mono text-foreground">
            {limits.daily >= 99_999_999 ? "Unlimited" : limits.daily.toLocaleString()}
          </span>
        </div>
      </div>
    </div>
  );
}
