import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Check, Zap, ExternalLink, ChevronDown, ChevronUp, Shield, Clock, Headphones, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "../App";
import { apiRequest } from "@/lib/queryClient";

const KIOKU_API = "";

const TIERS = [
  {
    id: "free",
    name: "Free",
    monthlyPrice: 0,
    yearlyPrice: 0,
    description: "For individuals exploring AI agents",
    features: [
      "2 agents",
      "100 memories",
      "5 deliberations/mo",
      "Community support",
      "Hybrid search",
      "Auto-deduplication",
    ],
  },
  {
    id: "starter",
    name: "Starter",
    monthlyPrice: 29,
    yearlyPrice: 278,
    description: "For developers building with AI agents",
    features: [
      "5 agents",
      "1,000 memories",
      "25 deliberations/mo",
      "Email support",
      "Usage analytics",
      "Redis cache",
    ],
  },
  {
    id: "professional",
    name: "Professional",
    monthlyPrice: 79,
    yearlyPrice: 756,
    description: "For teams shipping AI-powered products",
    popular: true,
    features: [
      "15 agents",
      "10,000 memories",
      "100 deliberations/mo",
      "Webhook agents",
      "Priority support",
      "Multi-agent namespaces",
      "Advanced analytics",
    ],
  },
  {
    id: "team",
    name: "Team",
    monthlyPrice: 199,
    yearlyPrice: 1908,
    description: "For organizations scaling AI operations",
    features: [
      "50 agents",
      "50,000 memories",
      "Unlimited deliberations",
      "Human participants",
      "SSO integration",
      "Dedicated support",
      "Custom SLA",
      "Admin controls",
    ],
  },
];

const FAQS = [
  {
    q: "Can I switch plans at any time?",
    a: "Yes. Upgrade instantly and get prorated credit. Downgrade takes effect at the end of your billing cycle.",
  },
  {
    q: "What happens when I hit my plan limits?",
    a: "You'll receive a warning at 80% usage. Once you reach 100%, new operations are paused until you upgrade or the next billing cycle begins.",
  },
  {
    q: "Do you offer a free trial for paid plans?",
    a: "The Free tier is always available with no time limit. For paid plans, you can start with the Starter tier at $29/mo to evaluate the platform.",
  },
  {
    q: "How does billing work for the Team plan?",
    a: "Team plans are billed per-workspace, not per-seat. All members of your organization can use the full allocation.",
  },
  {
    q: "Is my data secure?",
    a: "All data is encrypted at rest and in transit. We use Stripe for payment processing and never store card details. SOC 2 compliance is in progress.",
  },
  {
    q: "Can I cancel anytime?",
    a: "Absolutely. Cancel from the billing portal with one click. You'll retain access until the end of your paid period.",
  },
];

async function createCheckout(apiKey: string, plan: string, billingCycle: string) {
  const res = await apiRequest("POST", "/api/billing/checkout", {
    plan,
    billing_cycle: billingCycle,
    success_url: `${window.location.origin}${window.location.pathname}#/billing?upgraded=1`,
    cancel_url: `${window.location.origin}${window.location.pathname}#/pricing`,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as any;
    throw new Error(err?.error ?? "Checkout failed");
  }
  return res.json() as Promise<{ checkout_url: string }>;
}

export default function PricingPage() {
  const { toast } = useToast();
  const { user } = useAuth();
  const [cycle, setCycle] = useState<"monthly" | "yearly">("monthly");
  const [loadingPlan, setLoadingPlan] = useState<string | null>(null);
  const [openFaq, setOpenFaq] = useState<number | null>(null);

  const currentPlan = user?.plan ?? null;
  const apiKey = user?.apiKey ?? "";

  async function handleSubscribe(planId: string) {
    if (planId === "free") {
      window.location.hash = "#/billing";
      return;
    }

    if (!user) {
      // Not logged in — go to login
      window.location.hash = "#/";
      toast({ title: "Please sign in to subscribe" });
      return;
    }

    setLoadingPlan(planId);
    try {
      const { checkout_url } = await createCheckout(apiKey, planId, cycle);
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

  return (
    <div className="min-h-screen bg-background">
      {/* Hero Section */}
      <div className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-b from-primary/5 via-transparent to-transparent pointer-events-none" />
        <div className="max-w-6xl mx-auto px-4 sm:px-6 pt-12 sm:pt-20 pb-8 sm:pb-12 text-center relative">
          <div className="inline-flex items-center gap-1.5 bg-primary/10 text-primary text-xs font-semibold px-3 py-1 rounded-full mb-4">
            <Zap className="w-3 h-3" /> Simple, transparent pricing
          </div>
          <h1 className="text-3xl sm:text-4xl lg:text-5xl font-bold text-foreground tracking-tight">
            Choose the right plan for{" "}
            <span className="text-primary">your team</span>
          </h1>
          <p className="mt-4 text-base sm:text-lg text-muted-foreground max-w-2xl mx-auto">
            Start free, scale as you grow. All plans include core memory infrastructure, hybrid search, and auto-deduplication.
          </p>

          {/* Billing cycle toggle */}
          <div className="mt-8 flex items-center justify-center gap-1 bg-muted p-1 rounded-lg w-fit mx-auto">
            <button
              className={cn(
                "px-5 py-2 rounded-md text-sm font-medium transition-all",
                cycle === "monthly" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
              )}
              onClick={() => setCycle("monthly")}
            >
              Monthly
            </button>
            <button
              className={cn(
                "px-5 py-2 rounded-md text-sm font-medium transition-all flex items-center gap-1.5",
                cycle === "yearly" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
              )}
              onClick={() => setCycle("yearly")}
            >
              Yearly
              <span className="text-[10px] text-green-500 font-bold bg-green-500/10 px-1.5 py-0.5 rounded">SAVE 20%</span>
            </button>
          </div>
        </div>
      </div>

      {/* Pricing Cards */}
      <div className="max-w-6xl mx-auto px-4 sm:px-6 pb-16">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 lg:gap-5">
          {TIERS.map((tier) => {
            const isActive = currentPlan === tier.id || (currentPlan === "dev" && tier.id === "free");
            const price = cycle === "yearly" ? tier.yearlyPrice : tier.monthlyPrice;
            const isLoading = loadingPlan === tier.id;
            const isPopular = tier.popular;
            const monthlySavings = tier.monthlyPrice > 0
              ? (tier.monthlyPrice * 12) - tier.yearlyPrice
              : null;

            return (
              <div
                key={tier.id}
                className={cn(
                  "relative bg-card border rounded-2xl p-5 sm:p-6 flex flex-col transition-all",
                  isActive && "border-primary ring-2 ring-primary/20",
                  isPopular && !isActive && "border-primary/40 lg:scale-105 lg:shadow-xl lg:z-10",
                  !isActive && !isPopular && "border-card-border hover:border-muted-foreground/30"
                )}
              >
                {isPopular && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <div className="flex items-center gap-1 text-[11px] font-bold text-background bg-primary px-3 py-1 rounded-full shadow-md">
                      <Zap className="w-3 h-3" /> Most Popular
                    </div>
                  </div>
                )}

                {isActive && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <div className="text-[11px] font-bold text-primary-foreground bg-primary px-3 py-1 rounded-full shadow-md">
                      Current Plan
                    </div>
                  </div>
                )}

                <div className="mt-2">
                  <h3 className="text-lg font-bold text-foreground">{tier.name}</h3>
                  <p className="text-xs text-muted-foreground mt-1">{tier.description}</p>
                </div>

                <div className="mt-4 mb-5">
                  {tier.monthlyPrice === 0 ? (
                    <div className="text-3xl sm:text-4xl font-bold text-foreground">$0</div>
                  ) : (
                    <>
                      <div className="text-3xl sm:text-4xl font-bold text-foreground tabular-nums">
                        ${cycle === "yearly" ? Math.round(tier.yearlyPrice / 12) : price}
                        <span className="text-sm font-normal text-muted-foreground">/mo</span>
                      </div>
                      {cycle === "yearly" && monthlySavings ? (
                        <div className="text-xs text-green-500 font-medium mt-1">
                          ${tier.yearlyPrice}/yr · Save ${monthlySavings}/yr
                        </div>
                      ) : cycle === "monthly" ? (
                        <div className="text-[11px] text-muted-foreground mt-1">
                          ${tier.yearlyPrice}/yr if billed annually
                        </div>
                      ) : null}
                    </>
                  )}
                </div>

                <ul className="space-y-2.5 flex-1 mb-6">
                  {tier.features.map((f) => (
                    <li key={f} className="flex items-start gap-2 text-sm text-muted-foreground">
                      <Check className="w-4 h-4 text-green-500 mt-0.5 flex-shrink-0" />
                      {f}
                    </li>
                  ))}
                </ul>

                {isActive ? (
                  <Button
                    variant="outline"
                    className="w-full h-10 text-sm font-medium"
                    onClick={() => { window.location.hash = "#/billing"; }}
                  >
                    Manage Plan
                  </Button>
                ) : (
                  <Button
                    className={cn(
                      "w-full h-10 text-sm font-semibold gap-1.5",
                      tier.monthlyPrice === 0 && "bg-muted text-foreground hover:bg-muted/80"
                    )}
                    style={tier.monthlyPrice > 0 ? { background: "hsl(43 74% 52%)", color: "hsl(222 47% 8%)" } : {}}
                    onClick={() => handleSubscribe(tier.id)}
                    disabled={isLoading}
                  >
                    {isLoading ? "Opening…" : tier.monthlyPrice === 0 ? "Get Started" : (
                      <>Subscribe <ArrowRight className="w-3.5 h-3.5" /></>
                    )}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Trust Badges */}
      <div className="max-w-4xl mx-auto px-4 sm:px-6 pb-12">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {[
            { icon: Shield, title: "Secure by default", desc: "End-to-end encryption, SOC 2 in progress" },
            { icon: Clock, title: "99.9% uptime SLA", desc: "Enterprise-grade reliability on Team plan" },
            { icon: Headphones, title: "Expert support", desc: "From community to dedicated, we've got you" },
          ].map(({ icon: Icon, title, desc }) => (
            <div key={title} className="flex items-start gap-3 bg-card border border-card-border rounded-xl p-4">
              <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
                <Icon className="w-4 h-4 text-primary" />
              </div>
              <div>
                <div className="text-sm font-semibold text-foreground">{title}</div>
                <div className="text-xs text-muted-foreground mt-0.5">{desc}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* FAQ Section */}
      <div className="max-w-3xl mx-auto px-4 sm:px-6 pb-16">
        <h2 className="text-2xl font-bold text-foreground text-center mb-8">
          Frequently Asked Questions
        </h2>
        <div className="space-y-2">
          {FAQS.map((faq, i) => (
            <div
              key={i}
              className="bg-card border border-card-border rounded-xl overflow-hidden"
            >
              <button
                className="w-full flex items-center justify-between px-5 py-4 text-left"
                onClick={() => setOpenFaq(openFaq === i ? null : i)}
              >
                <span className="text-sm font-medium text-foreground pr-4">{faq.q}</span>
                {openFaq === i ? (
                  <ChevronUp className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                ) : (
                  <ChevronDown className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                )}
              </button>
              {openFaq === i && (
                <div className="px-5 pb-4 text-sm text-muted-foreground leading-relaxed">
                  {faq.a}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Bottom CTA */}
      <div className="max-w-4xl mx-auto px-4 sm:px-6 pb-16">
        <div className="bg-gradient-to-r from-primary/10 via-primary/5 to-primary/10 border border-primary/20 rounded-2xl p-6 sm:p-8 text-center">
          <h3 className="text-xl font-bold text-foreground mb-2">Ready to get started?</h3>
          <p className="text-sm text-muted-foreground mb-5">
            Join developers building the next generation of AI-powered applications.
          </p>
          <Button
            className="h-10 px-6 text-sm font-semibold gap-1.5"
            style={{ background: "hsl(43 74% 52%)", color: "hsl(222 47% 8%)" }}
            onClick={() => {
              if (user) {
                handleSubscribe("starter");
              } else {
                window.location.hash = "#/";
              }
            }}
          >
            {user ? "Upgrade Now" : "Sign Up Free"} <ArrowRight className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      {/* Footer */}
      <div className="max-w-6xl mx-auto px-4 sm:px-6 pb-8 flex flex-col sm:flex-row items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground/50">
          <span>Payments secured by Stripe. IKONBAI, Inc. does not store card details.</span>
        </div>
        <p className="text-[10px] text-muted-foreground/40">
          &copy; {new Date().getFullYear()} IKONBAI, Inc. &middot; Patent Pending &middot;{" "}
          <a href="#/privacy" className="underline hover:text-muted-foreground/70">Privacy Policy</a>
          {" · "}
          <a href="#/terms" className="underline hover:text-muted-foreground/70">Terms of Service</a>
        </p>
      </div>
    </div>
  );
}
