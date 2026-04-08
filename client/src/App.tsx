import { useState, useEffect, createContext, useContext } from "react";
import { Router, Switch, Route } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/queryClient";
import { setSessionToken, setUnauthHandler } from "./lib/auth";
import { Toaster } from "@/components/ui/toaster";

import LoginPage from "./pages/login";
import DashboardPage from "./pages/dashboard";
import AgentsPage from "./pages/agents";
import MemoryPage from "./pages/memory";
import FlowsPage from "./pages/flows";
import RoomsPage from "./pages/rooms";
import RoomDetailPage from "./pages/room-detail";
import LogsPage from "./pages/logs";
import BillingPage from "./pages/billing";
import AppLayout from "./components/layout";
import NotFound from "./pages/not-found";

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

export default function App() {
  const [dark, setDark] = useState(true); // default dark
  const [user, setUser] = useState<any | null>(null);
  const [sessionToken, setToken] = useState<string | null>(null);

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

  const login = (token: string, userData: any) => {
    setToken(token);
    setUser(userData);
    setSessionToken(token);
  };

  const logout = async () => {
    if (sessionToken) {
      await fetch("/api/auth/logout", {
        method: "POST",
        headers: { "x-session-token": sessionToken },
      }).catch(() => {});
    }
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
            {!user ? (
              <LoginPage />
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
                  <Route component={NotFound} />
                </Switch>
              </AppLayout>
            )}
          </Router>
          <Toaster />
        </AuthContext.Provider>
      </ThemeContext.Provider>
    </QueryClientProvider>
  );
}
