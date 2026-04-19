import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useAuth, useTheme } from "../App";
import { Button } from "@/components/ui/button";
import {
  LayoutDashboard, Bot, Brain, GitBranch, MessageSquare, Activity,
  CreditCard, BookOpen, LogOut, Sun, Moon, ChevronRight, Menu, X, Crown, Heart, Palette, Library,
  FolderOpen, Plug
} from "lucide-react";
import { cn } from "@/lib/utils";
import logoSrc from "@assets/kioku-logo.jpg";

function KiokuLogo({ size = 32 }: { size?: number }) {
  return (
    <img
      src={logoSrc}
      alt="KIOKU™ — Agent Control Center by IKONBAI™"
      width={size}
      height={size}
      style={{ borderRadius: 8, objectFit: "cover", flexShrink: 0 }}
    />
  );
}

const baseNavItems = [
  { href: "/",          icon: Heart,            label: "Partner"   },
  { href: "/gallery",   icon: Palette,          label: "Gallery"   },
  { href: "/knowledge", icon: Library,          label: "Knowledge" },
  { href: "/files",     icon: FolderOpen,       label: "Files"     },
  { href: "/connectors",icon: Plug,             label: "Connectors"},
  { href: "/dashboard", icon: LayoutDashboard,  label: "Dashboard" },
  { href: "/agents",    icon: Bot,              label: "Agents"    },
  { href: "/memory",    icon: Brain,            label: "Memory"    },
  { href: "/flows",     icon: GitBranch,        label: "Flows"     },
  { href: "/rooms",     icon: MessageSquare,    label: "Rooms"     },
  { href: "/logs",      icon: Activity,         label: "Live Feed" },
  { href: "/docs",      icon: BookOpen,         label: "API Docs"  },
  { href: "/billing",   icon: CreditCard,       label: "Billing"   },
];

const bossNavItem = { href: "/boss", icon: Crown, label: "Boss Board" };

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { user, logout } = useAuth();
  const { dark, toggle } = useTheme();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const isOwnerUser = user?.role === "owner";
  const navItems = isOwnerUser ? [bossNavItem, ...baseNavItems] : baseNavItems;
  const mobileNav = [
    { href: "/",        icon: Heart,      label: "Chat"     },
    { href: "/memory",  icon: Brain,      label: "Memory"   },
    { href: "/files",   icon: FolderOpen, label: "Files"    },
    { href: "/billing", icon: CreditCard, label: "Settings" },
  ];

  const planColors: Record<string, string> = {
    dev:      "text-muted-foreground",
    starter:  "text-blue-400",
    team:     "text-yellow-400",
    business: "text-purple-400",
  };

  const isActive = (href: string) =>
    location === href || (href !== "/" && location.startsWith(href));

  return (
    <div className="flex h-[100dvh] overflow-hidden bg-background">

      {/* ── Desktop sidebar (hidden on mobile) ──────────────────────────── */}
      <aside className="hidden md:flex w-56 flex-shrink-0 flex-col bg-sidebar border-r border-sidebar-border">
        {/* Logo */}
        <div className="px-5 py-4 border-b border-sidebar-border">
          <div className="flex items-center gap-2.5">
            <KiokuLogo size={28} />
            <div>
              <div className="flex items-center gap-1.5">
                <span className="text-sm font-semibold text-sidebar-foreground tracking-tight">KIOKU™</span>
                <span className="text-[9px] font-semibold uppercase tracking-widest text-yellow-400 bg-yellow-400/10 px-1 py-0.5 rounded border border-yellow-400/20">Beta</span>
              </div>
              <div className="text-[10px] text-sidebar-foreground/50 -mt-0.5">Agent Control Center</div>
            </div>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
          {navItems.map(({ href, icon: Icon, label }) => (
            <Link key={href} href={href}>
              <a className={cn(
                "flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors cursor-pointer",
                isActive(href)
                  ? "bg-sidebar-accent text-sidebar-primary font-medium"
                  : "text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/50"
              )}>
                <Icon className="w-4 h-4 flex-shrink-0" />
                {label}
                {isActive(href) && <ChevronRight className="w-3 h-3 ml-auto opacity-50" />}
              </a>
            </Link>
          ))}
        </nav>

        {/* Footer */}
        <div className="px-3 py-4 border-t border-sidebar-border space-y-2">
          <div className="px-3 py-2">
            <div className="text-xs font-medium text-sidebar-foreground truncate">{user?.email}</div>
            <div className={cn("text-[10px] uppercase tracking-wider font-semibold mt-0.5", planColors[user?.plan ?? "dev"])}>
              {user?.plan ?? "dev"} plan
            </div>
          </div>
          <div className="flex gap-1">
            <Button variant="ghost" size="sm"
              className="flex-1 justify-start text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/50 text-xs h-8"
              onClick={toggle}
            >
              {dark ? <Sun className="w-3.5 h-3.5 mr-2" /> : <Moon className="w-3.5 h-3.5 mr-2" />}
              {dark ? "Light" : "Dark"}
            </Button>
            <Button variant="ghost" size="sm"
              className="text-sidebar-foreground/50 hover:text-red-400 hover:bg-red-400/10 h-8 w-8 p-0"
              onClick={logout}
              data-testid="button-logout"
            >
              <LogOut className="w-3.5 h-3.5" />
            </Button>
          </div>
          <div className="px-3 pt-1 space-y-0.5">
            <p className="text-[9px] text-sidebar-foreground/25">© {new Date().getFullYear()} IKONBAI™, Inc. · Patent Pending</p>
            <div className="flex gap-2">
              <a href="#/privacy" className="text-[9px] text-sidebar-foreground/30 hover:text-sidebar-foreground/60 underline">Privacy</a>
              <a href="#/terms" className="text-[9px] text-sidebar-foreground/30 hover:text-sidebar-foreground/60 underline">Terms</a>
            </div>
          </div>
        </div>
      </aside>

      {/* ── Mobile top bar ───────────────────────────────────────────────── */}
      <div className="md:hidden fixed top-0 left-0 right-0 z-40 flex items-center justify-between px-4 h-14
        bg-sidebar border-b border-sidebar-border">
        <div className="flex items-center gap-2">
          <KiokuLogo size={24} />
          <span className="text-sm font-semibold text-sidebar-foreground">KIOKU™</span>
          <span className="text-[9px] font-semibold uppercase tracking-widest text-yellow-400 bg-yellow-400/10 px-1 py-0.5 rounded border border-yellow-400/20">Beta</span>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" className="w-9 h-9 p-0 text-sidebar-foreground/70" onClick={toggle}>
            {dark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </Button>
          <Button variant="ghost" size="sm" className="w-9 h-9 p-0 text-sidebar-foreground/70"
            onClick={() => setDrawerOpen(true)}>
            <Menu className="w-5 h-5" />
          </Button>
        </div>
      </div>

      {/* ── Mobile drawer overlay ─────────────────────────────────────────── */}
      {drawerOpen && (
        <div className="md:hidden fixed inset-0 z-50 flex">
          {/* Backdrop */}
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setDrawerOpen(false)} />

          {/* Drawer panel */}
          <div className="relative w-72 max-w-[85vw] bg-sidebar flex flex-col h-full shadow-2xl">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-sidebar-border">
              <div className="flex items-center gap-2.5">
                <KiokuLogo size={26} />
                <div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-semibold text-sidebar-foreground">KIOKU™</span>
                    <span className="text-[9px] font-semibold uppercase tracking-widest text-yellow-400 bg-yellow-400/10 px-1 py-0.5 rounded border border-yellow-400/20">Beta</span>
                  </div>
                  <div className="text-[10px] text-sidebar-foreground/50">Agent Control Center</div>
                </div>
              </div>
              <button className="text-sidebar-foreground/50 hover:text-sidebar-foreground p-1"
                onClick={() => setDrawerOpen(false)}>
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Nav */}
            <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
              {navItems.map(({ href, icon: Icon, label }) => (
                <Link key={href} href={href}>
                  <a className={cn(
                    "flex items-center gap-3 px-4 py-3 rounded-lg text-sm transition-colors cursor-pointer",
                    isActive(href)
                      ? "bg-sidebar-accent text-sidebar-primary font-medium"
                      : "text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/50"
                  )}
                    onClick={() => setDrawerOpen(false)}
                  >
                    <Icon className="w-5 h-5 flex-shrink-0" />
                    {label}
                    {isActive(href) && <ChevronRight className="w-3.5 h-3.5 ml-auto opacity-50" />}
                  </a>
                </Link>
              ))}
            </nav>

            {/* Footer */}
            <div className="px-4 py-4 border-t border-sidebar-border space-y-3">
              <div>
                <div className="text-xs font-medium text-sidebar-foreground truncate">{user?.email}</div>
                <div className={cn("text-[10px] uppercase tracking-wider font-semibold mt-0.5", planColors[user?.plan ?? "dev"])}>
                  {user?.plan ?? "dev"} plan
                </div>
              </div>
              <Button variant="ghost" size="sm"
                className="w-full justify-start text-sidebar-foreground/70 hover:text-red-400 text-xs h-9"
                onClick={() => { setDrawerOpen(false); logout(); }}
              >
                <LogOut className="w-3.5 h-3.5 mr-2" /> Sign out
              </Button>
              <p className="text-[9px] text-sidebar-foreground/25">© {new Date().getFullYear()} IKONBAI™, Inc. · Patent Pending</p>
              <div className="flex gap-2">
                <a href="#/privacy" onClick={() => setDrawerOpen(false)} className="text-[9px] text-sidebar-foreground/30 hover:text-sidebar-foreground/60 underline">Privacy</a>
                <a href="#/terms" onClick={() => setDrawerOpen(false)} className="text-[9px] text-sidebar-foreground/30 hover:text-sidebar-foreground/60 underline">Terms</a>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Main content ─────────────────────────────────────────────────── */}
      <main className="flex-1 overflow-auto md:pt-0 pt-14 pb-16 md:pb-0">
        {children}
      </main>

      {/* ── Mobile bottom tab bar ─────────────────────────────────────────── */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-40 flex w-full
        bg-sidebar border-t border-sidebar-border">
        {mobileNav.map(({ href, icon: Icon, label }) => {
          const active = isActive(href);
          return (
            <Link key={href} href={href} className="flex-1 min-w-0">
              <a className="flex flex-col items-center justify-center py-2 gap-0.5 transition-colors w-full"
                style={{ color: active ? "hsl(43 74% 52%)" : "hsl(215 20% 55%)" }}>
                <Icon className="w-5 h-5 flex-shrink-0" />
                <span className="text-[8px] font-medium truncate w-full text-center px-0.5">{label}</span>
              </a>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
