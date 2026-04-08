import { Link, useLocation } from "wouter";
import { useAuth, useTheme } from "../App";
import { Button } from "@/components/ui/button";
import {
  LayoutDashboard, Bot, Brain, GitBranch, MessageSquare, Activity,
  CreditCard, LogOut, Sun, Moon, ChevronRight
} from "lucide-react";
import { cn } from "@/lib/utils";

import logoSrc from "@assets/kioku-logo.jpg";

function KiokuLogo({ size = 32 }: { size?: number }) {
  return (
    <img
      src={logoSrc}
      alt="KIOKU"
      width={size}
      height={size}
      style={{ borderRadius: 8, objectFit: 'cover', flexShrink: 0 }}
    />
  );
}

const navItems = [
  { href: "/", icon: LayoutDashboard, label: "Dashboard" },
  { href: "/agents", icon: Bot, label: "Agents" },
  { href: "/memory", icon: Brain, label: "Memory" },
  { href: "/flows", icon: GitBranch, label: "Flows" },
  { href: "/rooms", icon: MessageSquare, label: "Rooms" },
  { href: "/logs", icon: Activity, label: "Live Feed" },
  { href: "/billing", icon: CreditCard, label: "Billing" },
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { user, logout } = useAuth();
  const { dark, toggle } = useTheme();

  const planColors: Record<string, string> = {
    dev: "text-muted-foreground",
    starter: "text-blue-400",
    team: "text-yellow-400",
    business: "text-purple-400",
  };

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Sidebar */}
      <aside className="w-56 flex-shrink-0 flex flex-col bg-sidebar border-r border-sidebar-border">
        {/* Logo */}
        <div className="px-5 py-4 border-b border-sidebar-border">
          <div className="flex items-center gap-2.5">
            <KiokuLogo size={28} />
            <div>
              <div className="text-sm font-semibold text-sidebar-foreground tracking-tight">KIOKU™</div>
              <div className="text-[10px] text-sidebar-foreground/50 -mt-0.5">Agent Control Center</div>
            </div>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-0.5">
          {navItems.map(({ href, icon: Icon, label }) => {
            const active = location === href || (href !== "/" && location.startsWith(href));
            return (
              <Link key={href} href={href}>
                <a className={cn(
                  "flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors cursor-pointer",
                  active
                    ? "bg-sidebar-accent text-sidebar-primary font-medium"
                    : "text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/50"
                )}>
                  <Icon className="w-4 h-4 flex-shrink-0" />
                  {label}
                  {active && <ChevronRight className="w-3 h-3 ml-auto opacity-50" />}
                </a>
              </Link>
            );
          })}
        </nav>

        {/* User / footer */}
        <div className="px-3 py-4 border-t border-sidebar-border space-y-2">
          <div className="px-3 py-2">
            <div className="text-xs font-medium text-sidebar-foreground truncate">{user?.email}</div>
            <div className={cn("text-[10px] uppercase tracking-wider font-semibold mt-0.5", planColors[user?.plan ?? "dev"])}>
              {user?.plan ?? "dev"} plan
            </div>
          </div>
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="flex-1 justify-start text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/50 text-xs h-8"
              onClick={toggle}
            >
              {dark ? <Sun className="w-3.5 h-3.5 mr-2" /> : <Moon className="w-3.5 h-3.5 mr-2" />}
              {dark ? "Light" : "Dark"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-sidebar-foreground/50 hover:text-red-400 hover:bg-red-400/10 h-8 w-8 p-0"
              onClick={logout}
              data-testid="button-logout"
            >
              <LogOut className="w-3.5 h-3.5" />
            </Button>
          </div>
          <div className="px-3 pt-1 pb-0.5">
            <p className="text-[9px] text-sidebar-foreground/25 leading-relaxed">
              IKONBAI™, Inc. &nbsp;&middot;&nbsp; Patent Pending
            </p>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        {children}
      </main>
    </div>
  );
}
