import { useState, useEffect, createContext, useContext } from "react";
import { Router, Switch, Route, useLocation } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { queryClient } from "./lib/queryClient";
import { setSessionToken, setUnauthHandler } from "./lib/auth";
import { Toaster } from "@/components/ui/toaster";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";
import OnboardingWizard from "./components/onboarding-wizard";

import LoginPage from "./pages/login";
import DashboardPage from "./pages/dashboard";
import AgentsPage from "./pages/agents";
import MemoryPage from "./pages/memory";
import FlowsPage from "./pages/flows";
import RoomsPage from "./pages/rooms";
import RoomDetailPage from "./pages/room-detail";
import LogsPage from "./pages/logs";
import BillingPage from "./pages/billing";
import PrivacyPage from "./pages/privacy";
import TermsPage from "./pages/terms";
import AppLayout from "./components/layout";
import NotFound from "./pages/not-found";
import VerifyPage from "./pages/verify";

// ── Page titles ──────────────────────────────────────────────────────────────
const PAGE_TITLES: Record<string, string> = {
  "/":        "Dashboard — KIOKU™",
  "/agents":  "Agents — KIOKU™",
  "/memory":  "Memory — KIOKU™",
  "/flows":   "Flows — KIOKU™",
  "/rooms":   "Rooms — KIOKU™",
  "/logs":    "Live Feed — KIOKU™",
  "/billing": "Billing — KIOKU™",
  "/privacy": "Privacy Policy — KIOKU™",
  "/terms":   "Terms of Service — KIOKU™",
};

function TitleManager() {
  const [location] = useLocation();
  useEffect(() => {
    const base = location.split("/").slice(0, 2).join("/") || "/";
    document.title = PAGE_TITLES[base] ?? "KIOKU™ — Agent Control Center";
  }, [location]);
  return null;
}

// ── Cookie consent banner ────────────────────────────────────────────────────
function CookieBanner() {
  // NOTE: no localStorage/sessionStorage per project rules — banner shows once per session (React state only)
  const [visible, setVisible] = useState(true);
  const accept = () => setVisible(false);
  const reject = () => setVisible(false);

  if (!visible) return null;

  return (
    <div className="fixed bottom-0 left-0 right-0 z-[9999] md:bottom-4 md:left-4 md:right-auto md:max-w-sm
      bg-sidebar border border-sidebar-border rounded-t-2xl md:rounded-2xl shadow-2xl p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs text-muted-foreground leading-relaxed">
          KIOKU™ uses session cookies for authentication and analytics.
          By continuing, you agree to our{" "}
          <a href="#/privacy" className="text-primary underline underline-offset-2">Privacy Policy</a>{" "}and{" "}
          <a href="#/terms" className="text-primary underline underline-offset-2">Terms of Service</a>.
        </p>
        <button onClick={reject} className="text-muted-foreground hover:text-foreground flex-shrink-0 mt-0.5">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="flex gap-2">
        <Button size="sm" className="flex-1 h-8 text-xs" onClick={accept}>Accept</Button>
        <Button size="sm" variant="outline" className="flex-1 h-8 text-xs" onClick={reject}>Reject All</Button>
      </div>
      <p className="text-[9px] text-muted-foreground/40 text-center">
        © {new Date().getFullYear()} IKONBAI™, Inc. · Patent Pending
      </p>
    </div>
  );
}

// Auth context
interface AuthCtx {
  user: any | null;
  sessionToken: string | null;
  login: (token: string, user: any) => void;
  logout: () => void;
}
export const AuthContext = createContext<AuthCtx>({
  user: null,
  sessionToken: null,
  login: () => {},
  logout: () => {},
});
export const useAuth = () => useContext(AuthContext);

// Theme context
interface ThemeCtx { dark: boolean; toggle: () => void; }
export const ThemeContext = createContext<ThemeCtx>({ dark: true, toggle: () => {} });
export const useTheme = () => useContext(ThemeContext);

function OnboardingOverlay() {
  const [dismissed, setDismissed] = useState(false);
  const { data: agents, isLoading } = useQuery<any[]>({ queryKey: ["/api/agents"] });

  // Show wizard only when agents loaded and count is zero, and user hasn't dismissed
  if (isLoading || dismissed || !agents || agents.length > 0) return null;

  return (
    <OnboardingWizard
      onComplete={() => {
        setDismissed(true);
        queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
        queryClient.invalidateQueries({ queryKey: ["/api/rooms"] });
        queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      }}
    />
  );
}

export default function App() {
  const [dark, setDark] = useState(true); // default dark
  const [user, setUser] = useState<any | null>(null);
  const [sessionToken, setToken] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(true); // true while checking cookie session

  // Apply dark class
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  // Register unauth handler
  useEffect(() => {
    setUnauthHandler(() => {
      setUser(null);
      setToken(null);
      setSessionToken(null);
    });
  }, []);

  // Auto-restore session from httpOnly cookie on page load/refresh
  useEffect(() => {
    fetch("/api/auth/me", { credentials: "include" })
      .then(res => res.ok ? res.json() : null)
      .then(userData => {
        if (userData && userData.id) {
          setUser(userData);
          // Cookie handles auth — no header token needed
        }
      })
      .catch(() => {})
      .finally(() => setRestoring(false));
  }, []);

  const login = (token: string, userData: any) => {
    setToken(token);
    setUser(userData);
    setSessionToken(token);
    setRestoring(false);
  };

  const logout = async () => {
    await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "include",
      headers: sessionToken ? { "x-session-token": sessionToken } : {},
    }).catch(() => {});
    setToken(null);
    setUser(null);
    setSessionToken(null);
    queryClient.clear();
  };

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeContext.Provider value={{ dark, toggle: () => setDark(d => !d) }}>
        <AuthContext.Provider value={{ user, sessionToken, login, logout }}>
          <Router hook={useHashLocation}>
            <TitleManager />
            {restoring ? (
              // Session restore in progress — show spinner to avoid flash of login page
              <div className="flex h-screen items-center justify-center bg-background">
                <div className="flex flex-col items-center gap-3">
                  <div className="w-8 h-8 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
                  <span className="text-xs text-muted-foreground">Loading…</span>
                </div>
              </div>
            ) : !user ? (
              <Switch>
                <Route path="/verify" component={VerifyPage} />
                <Route path="/privacy" component={PrivacyPage} />
                <Route path="/terms" component={TermsPage} />
                <Route component={LoginPage} />
              </Switch>
            ) : (
              <AppLayout>
                <Switch>
                  <Route path="/" component={DashboardPage} />
                  <Route path="/agents" component={AgentsPage} />
                  <Route path="/memory" component={MemoryPage} />
                  <Route path="/flows" component={FlowsPage} />
                  <Route path="/rooms" component={RoomsPage} />
                  <Route path="/rooms/:id" component={RoomDetailPage} />
                  <Route path="/logs" component={LogsPage} />
                  <Route path="/billing" component={BillingPage} />
                  <Route path="/privacy" component={PrivacyPage} />
                  <Route path="/terms" component={TermsPage} />
                  <Route component={NotFound} />
                </Switch>
                <OnboardingOverlay />
              </AppLayout>
            )}
            <CookieBanner />
          </Router>
          <Toaster />
        </AuthContext.Provider>
      </ThemeContext.Provider>
    </QueryClientProvider>
  );
}
