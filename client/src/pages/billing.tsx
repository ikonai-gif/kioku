import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Check, Zap } from "lucide-react";
import { cn } from "@/lib/utils";

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

export default function BillingPage() {
  const { toast } = useToast();
  const [cycle, setCycle] = useState<"monthly" | "yearly">("monthly");

  const { data: user } = useQuery<any>({ queryKey: ["/api/auth/me"] });

  const upgradeMutation = useMutation({
    mutationFn: ({ plan, billingCycle }: { plan: string; billingCycle: string }) =>
      apiRequest("PATCH", "/api/billing/plan", { plan, billingCycle }).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      toast({ title: "Plan updated" });
    },
    onError: () => toast({ title: "Update failed", variant: "destructive" }),
  });

  const currentPlan = user?.plan ?? "dev";
  const currentCycle = user?.billingCycle ?? "monthly";

  const savings = (plan: typeof PLANS[0]) => {
    if (plan.monthlyPrice === 0) return null;
    const annual = plan.monthlyPrice * 12;
    const saved = annual - plan.yearlyPrice;
    return saved;
  };

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-foreground">Billing</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Current plan: <span className="font-semibold text-foreground capitalize">{currentPlan}</span>
          {" · "}{currentCycle === "yearly" ? "Billed annually" : "Billed monthly"}
        </p>
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
              {/* Popular badge */}
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
                      saved ? <div className="text-[10px] text-green-400 font-medium mt-0.5">Save ${saved}/yr vs monthly</div> : null
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
                  className="w-full h-8 text-xs"
                  variant={plan.id === "dev" ? "outline" : "default"}
                  style={plan.id !== "dev" ? { background: "hsl(43 74% 52%)", color: "hsl(222 47% 8%)" } : {}}
                  onClick={() => upgradeMutation.mutate({ plan: plan.id, billingCycle: cycle })}
                  disabled={upgradeMutation.isPending}
                  data-testid={`button-select-plan-${plan.id}`}
                >
                  {plan.monthlyPrice === 0 ? "Downgrade" : "Upgrade"}
                </Button>
              )}
            </div>
          );
        })}
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
    </div>
  );
}
