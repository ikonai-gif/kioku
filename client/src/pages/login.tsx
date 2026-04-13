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

type Step = "email" | "token" | "auto-verify";

export default function LoginPage() {
  const { login } = useAuth();
  const { toast } = useToast();
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(false);
  const [demoToken, setDemoToken] = useState<string | null>(null);
  const [autoError, setAutoError] = useState<string | null>(null);

  // Auto-verify: if URL contains token (from magic link email), log in automatically
  useEffect(() => {
    const hash = window.location.hash || "";
    const hashQuery = hash.split("?")[1] || "";
    const params = new URLSearchParams(hashQuery || window.location.search.slice(1));
    const urlToken = params.get("token");
    if (!urlToken) return;

    setStep("auto-verify");
    fetch("/api/auth/verify-magic-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: urlToken }),
    })
      .then(r => r.json())
      .then(data => {
        if (data.ok && data.sessionToken) {
          login(data.sessionToken, data.user);
          // Clean up URL hash
          window.location.hash = "#/";
        } else {
          setAutoError(data.error || "Link expired or invalid. Please request a new one.");
          setStep("email");
        }
      })
      .catch(() => {
        setAutoError("Network error. Please try again.");
        setStep("email");
      });
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
      setDemoToken(data.token); // demo only
      setStep("token");
      toast({ title: "Magic link sent", description: "Check your email and click the link to sign in" });
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }

  async function handleVerify() {
    if (!token.trim()) {
      toast({ title: "Enter your token", variant: "destructive" });
      return;
    }
    setLoading(true);
    try {
      const res = await apiRequest("POST", "/api/auth/verify-magic-link", { token: token.trim() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      login(data.sessionToken, data.user);
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
          {autoError && (
            <div className="mb-4 p-3 rounded-lg bg-destructive/10 border border-destructive/20">
              <p className="text-xs text-destructive">{autoError}</p>
            </div>
          )}
          {step === "auto-verify" ? (
            <div className="flex flex-col items-center gap-3 py-6">
              <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              <p className="text-sm text-muted-foreground">Signing you in...</p>
            </div>
          ) : step === "email" ? (
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
              <div>
                <h2 className="text-sm font-semibold text-foreground mb-1">Enter your token</h2>
                <p className="text-xs text-muted-foreground">Paste the token from your email</p>
              </div>
              {demoToken && (
                <div className="bg-muted rounded-lg p-3">
                  <p className="text-[10px] text-muted-foreground mb-1 uppercase tracking-wider font-medium">Demo token</p>
                  <p className="text-xs font-mono text-foreground break-all select-all">{demoToken}</p>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-2 h-6 text-[10px] text-primary hover:text-primary"
                    onClick={() => setToken(demoToken)}
                  >Copy to field</Button>
                </div>
              )}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground">Token</label>
                <Input
                  placeholder="Paste token here"
                  value={token}
                  onChange={e => setToken(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && handleVerify()}
                  data-testid="input-token"
                  className="h-9 text-sm font-mono"
                />
              </div>
              <Button
                className="w-full h-9 text-sm font-medium"
                style={{ background: "hsl(43 74% 52%)", color: "hsl(222 47% 8%)" }}
                onClick={handleVerify}
                disabled={loading}
                data-testid="button-verify-token"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                Sign In
              </Button>
              <button
                className="text-xs text-muted-foreground hover:text-foreground w-full text-center"
                onClick={() => { setStep("email"); setDemoToken(null); setToken(""); }}
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
