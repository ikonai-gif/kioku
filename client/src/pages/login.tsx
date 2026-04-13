import { useState, useEffect } from "react";
import { useAuth } from "../App";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Sparkles } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";

import logoSrc from "@assets/kioku-logo.jpg";

function KiokuLogo({ size = 56 }: { size?: number }) {
  return (
    <img
      src={logoSrc}
      alt="KIOKU"
      width={size}
      height={size}
      className="gold-glow-strong"
      style={{ borderRadius: 12, objectFit: 'cover' }}
    />
  );
}

type Step = "email" | "check-email";

export default function LoginPage() {
  const { login } = useAuth();
  const { toast } = useToast();
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  // Show error if redirected back with ?error=expired
  useEffect(() => {
    const hash = window.location.hash || "";
    if (hash.includes("error=expired")) {
      setLinkError("Link expired or invalid. Please request a new one.");
      window.location.hash = "#/login";
    }
  }, []);

  function handleQuickDemo() {
    login("demo-session", {
      id: 1,
      email: "demo@kioku.ai",
      name: "Demo User",
      plan: "dev",
      billingCycle: "monthly",
      apiKey: "kk_demo_0000000000000000",
    });
  }

  async function handleRequestLink() {
    if (!email.includes("@")) {
      toast({ title: "Enter a valid email", variant: "destructive" });
      return;
    }
    setLoading(true);
    try {
      const res = await apiRequest("POST", "/api/auth/request-magic-link", { email, name });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setStep("check-email");
      toast({ title: "Magic link sent", description: "Check your email and click the link to sign in" });
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }


  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div className="mb-4">
            <KiokuLogo size={56} />
          </div>
          <h1 className="text-xl font-semibold text-foreground">KIOKU™</h1>
          <p className="text-sm text-muted-foreground mt-1">Agent Control Center</p>
          <p className="text-xs text-muted-foreground/80 mt-2 text-center max-w-[260px] leading-relaxed">
            Complex tasks solved faster with multiple agents working together
          </p>
        </div>

        {/* Card */}
        <div className="bg-card border border-card-border rounded-xl p-6 shadow-lg">
          {linkError && (
            <div className="mb-4 p-3 rounded-lg bg-destructive/10 border border-destructive/20">
              <p className="text-xs text-destructive">{linkError}</p>
            </div>
          )}
          {step === "email" ? (
            <div className="space-y-4">
              <div>
                <h2 className="text-sm font-semibold text-foreground mb-1">Sign in</h2>
                <p className="text-xs text-muted-foreground">We'll send a magic link to your email</p>
              </div>
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-foreground">Name</label>
                  <Input
                    placeholder="Your name"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    data-testid="input-name"
                    className="h-9 text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-foreground">Email</label>
                  <Input
                    type="email"
                    placeholder="you@company.com"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && handleRequestLink()}
                    data-testid="input-email"
                    className="h-9 text-sm"
                  />
                </div>
              </div>
              <Button
                className="w-full h-9 text-sm font-medium"
                style={{ background: "hsl(43 74% 52%)", color: "hsl(222 47% 8%)" }}
                onClick={handleRequestLink}
                disabled={loading}
                data-testid="button-get-magic-link"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Sparkles className="w-4 h-4 mr-2" />}
                Get Magic Link
              </Button>
              <div className="relative flex items-center py-1">
                <div className="flex-1 border-t border-border" />
                <span className="px-2 text-[10px] text-muted-foreground">or</span>
                <div className="flex-1 border-t border-border" />
              </div>
              <Button
                variant="outline"
                className="w-full h-9 text-sm font-medium"
                onClick={handleQuickDemo}
                data-testid="button-quick-demo"
              >
                Quick Demo — Enter without email
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-col items-center gap-3 py-4">
                <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
                  <Sparkles className="w-6 h-6 text-primary" />
                </div>
                <h2 className="text-sm font-semibold text-foreground">Check your email</h2>
                <p className="text-xs text-muted-foreground text-center leading-relaxed">
                  We sent a sign-in link to <span className="font-medium text-foreground">{email}</span>. Click the link in the email to continue.
                </p>
              </div>
              <button
                className="text-xs text-muted-foreground hover:text-foreground w-full text-center"
                onClick={() => { setStep("email"); setLinkError(null); }}
              >
                ← Back
              </button>
            </div>
          )}
        </div>

        <div className="text-center mt-6 space-y-1">
          <p className="text-[11px] text-muted-foreground/70">
            KIOKU™ is a product of <span className="text-muted-foreground font-medium">IKONBAI™, Inc.</span>
          </p>
          <p className="text-[10px] text-muted-foreground/40">
            Patent Pending &nbsp;&middot;&nbsp; &copy; {new Date().getFullYear()} IKONBAI™, Inc. All rights reserved.
          </p>
        </div>
      </div>
    </div>
  );
}
