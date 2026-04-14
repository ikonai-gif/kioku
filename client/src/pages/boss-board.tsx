import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useAuth } from "../App";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Shield, Activity, Database, Cpu, Users, Brain, Bot, MessageSquare,
  GitBranch, Zap, Download, FileText, Plus, BookOpen, Key, Clock,
  CheckCircle2, AlertCircle, XCircle, ExternalLink, Crown,
} from "lucide-react";
import { cn } from "@/lib/utils";

function StatusDot({ status }: { status: string }) {
  const color = status === "ok" || status === "connected"
    ? "bg-emerald-400 shadow-emerald-400/50"
    : status === "degraded" || status === "not configured"
    ? "bg-amber-400 shadow-amber-400/50"
    : "bg-red-400 shadow-red-400/50";
  return <span className={cn("inline-block w-2.5 h-2.5 rounded-full shadow-lg", color)} />;
}

function KpiCard({ icon: Icon, label, value, sub, accent = false }: {
  icon: any; label: string; value: string | number; sub?: string; accent?: boolean;
}) {
  return (
    <Card className="bg-[hsl(222,47%,11%)]/80 border-amber-500/10 hover:border-amber-500/25 transition-colors">
      <CardContent className="p-5">
        <div className="flex items-start justify-between mb-3">
          <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-amber-500/10">
            <Icon className="w-4.5 h-4.5 text-amber-400" />
          </div>
        </div>
        <div className={cn(
          "text-2xl font-bold tabular-nums",
          accent ? "text-amber-400" : "text-foreground"
        )}>{value}</div>
        <div className="text-xs text-muted-foreground mt-0.5">{label}</div>
        {sub && <div className="text-[10px] text-muted-foreground/60 mt-1">{sub}</div>}
      </CardContent>
    </Card>
  );
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatTs(ts: number | string | null): string {
  if (!ts) return "—";
  const d = new Date(typeof ts === "number" ? ts : parseInt(ts as string));
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function BossBoardPage() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();

  // Redirect non-owners
  useEffect(() => {
    if (user && user.role !== "owner") {
      setLocation("/");
    }
  }, [user, setLocation]);

  const { data: adminStatus, isLoading } = useQuery({
    queryKey: ["/api/admin/status"],
    refetchInterval: 30000,
    enabled: user?.role === "owner",
  });

  const { data: billingData } = useQuery({
    queryKey: ["/api/billing/status"],
    enabled: user?.role === "owner",
  });

  if (!user || user.role !== "owner") return null;

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 rounded-full border-2 border-amber-400/30 border-t-amber-400 animate-spin" />
          <span className="text-xs text-muted-foreground">Loading Boss Board...</span>
        </div>
      </div>
    );
  }

  const health = adminStatus?.health ?? {};
  const usage = adminStatus?.usage ?? {};
  const account = adminStatus?.account ?? {};
  const security = adminStatus?.security ?? {};
  const recentActivity = adminStatus?.recent_activity ?? {};

  const handleExport = async (format: string) => {
    try {
      const res = await apiRequest("GET", `/api/account/export?format=${format}`);
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `kioku-export.${format === "kmef" ? "json" : format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch { /* ignore */ }
  };

  return (
    <div className="min-h-full bg-gradient-to-br from-[hsl(222,47%,8%)] via-[hsl(222,47%,11%)] to-[hsl(222,47%,14%)] p-4 md:p-8">
      {/* Header */}
      <div className="flex items-center gap-3 mb-8">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-amber-500/15 border border-amber-500/25">
          <Crown className="w-5 h-5 text-amber-400" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-foreground tracking-tight">Boss Board</h1>
          <p className="text-xs text-muted-foreground">Owner Dashboard — Full System Overview</p>
        </div>
        <Badge className="ml-auto bg-amber-500/15 text-amber-400 border-amber-500/25 hover:bg-amber-500/20">
          {account.plan?.toUpperCase() ?? "DEV"} Plan
        </Badge>
      </div>

      {/* Section 1: System Health */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-4 flex items-center gap-2">
          <Shield className="w-4 h-4" /> System Health
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card className="bg-[hsl(222,47%,11%)]/80 border-amber-500/10">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-2">
                <StatusDot status={health.status ?? "unknown"} />
                <span className="text-xs font-medium text-foreground">Server</span>
              </div>
              <div className="text-lg font-bold text-amber-400 capitalize">{health.status ?? "Unknown"}</div>
              <div className="text-[10px] text-muted-foreground">v{health.version ?? "?"}</div>
            </CardContent>
          </Card>
          <Card className="bg-[hsl(222,47%,11%)]/80 border-amber-500/10">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-2">
                <StatusDot status={health.database ?? "unknown"} />
                <span className="text-xs font-medium text-foreground">Database</span>
              </div>
              <div className="text-lg font-bold text-amber-400 capitalize">{health.database ?? "Unknown"}</div>
              <div className="text-[10px] text-muted-foreground">PostgreSQL</div>
            </CardContent>
          </Card>
          <Card className="bg-[hsl(222,47%,11%)]/80 border-amber-500/10">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-2">
                <StatusDot status={health.redis === "connected" ? "ok" : health.redis ?? "unknown"} />
                <span className="text-xs font-medium text-foreground">Redis</span>
              </div>
              <div className="text-lg font-bold text-amber-400 capitalize">{health.redis ?? "N/A"}</div>
              <div className="text-[10px] text-muted-foreground">Rate Limiter</div>
            </CardContent>
          </Card>
          <Card className="bg-[hsl(222,47%,11%)]/80 border-amber-500/10">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-2">
                <Clock className="w-3 h-3 text-muted-foreground" />
                <span className="text-xs font-medium text-foreground">Uptime</span>
              </div>
              <div className="text-lg font-bold text-amber-400">{formatUptime(health.uptime ?? 0)}</div>
              <div className="text-[10px] text-muted-foreground">{health.active_ws_connections ?? 0} WS connections</div>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* Section 2: Usage Overview */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-4 flex items-center gap-2">
          <Activity className="w-4 h-4" /> Usage Overview
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiCard icon={Brain} label="Total Memories" value={usage.memories?.count ?? 0} accent />
          <KpiCard icon={Bot} label="Active Agents" value={usage.agents?.count ?? 0} accent />
          <KpiCard icon={MessageSquare} label="Rooms" value={usage.rooms?.count ?? 0} />
          <KpiCard icon={GitBranch} label="Flows" value={usage.flows?.count ?? 0} />
          <KpiCard icon={Zap} label="API Calls Today" value={usage.requests_today ?? 0} accent />
          <KpiCard
            icon={MessageSquare}
            label="Deliberations"
            value={usage.metered?.deliberations ?? 0}
            sub={`${usage.metered?.rounds ?? 0} rounds`}
          />
          <KpiCard
            icon={Cpu}
            label="Tokens Used"
            value={(usage.metered?.tokens_used ?? 0).toLocaleString()}
          />
          <KpiCard icon={Users} label="Total Users" value={account.total_users ?? 0} />
        </div>
      </section>

      {/* Section 3: Recent Activity */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-4 flex items-center gap-2">
          <Clock className="w-4 h-4" /> Recent Activity
        </h2>
        <div className="grid md:grid-cols-2 gap-4">
          {/* Recent API Calls */}
          <Card className="bg-[hsl(222,47%,11%)]/80 border-amber-500/10">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium text-foreground">Last API Calls</CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {(recentActivity.api_calls ?? []).length === 0 ? (
                  <p className="text-xs text-muted-foreground">No recent API calls</p>
                ) : (
                  (recentActivity.api_calls ?? []).map((call: any, i: number) => (
                    <div key={i} className="flex items-center gap-2 text-xs py-1.5 border-b border-border/30 last:border-0">
                      <Badge variant="outline" className={cn(
                        "text-[10px] font-mono px-1.5",
                        call.status < 300 ? "border-emerald-500/30 text-emerald-400" :
                        call.status < 400 ? "border-amber-500/30 text-amber-400" :
                        "border-red-500/30 text-red-400"
                      )}>{call.status}</Badge>
                      <span className="font-mono text-muted-foreground w-10">{call.method}</span>
                      <span className="text-foreground truncate flex-1 font-mono">{call.path}</span>
                      <span className="text-muted-foreground/60 text-[10px]">{call.latency_ms}ms</span>
                      <span className="text-muted-foreground/40 text-[10px] w-16 text-right">{formatTs(call.timestamp)}</span>
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>

          {/* Recent Deliberations */}
          <Card className="bg-[hsl(222,47%,11%)]/80 border-amber-500/10">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium text-foreground">Recent Deliberations</CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {(recentActivity.deliberations ?? []).length === 0 ? (
                  <p className="text-xs text-muted-foreground">No recent deliberations</p>
                ) : (
                  (recentActivity.deliberations ?? []).map((sess: any, i: number) => (
                    <div key={i} className="py-2 border-b border-border/30 last:border-0">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className={cn(
                          "text-[10px]",
                          sess.status === "completed" ? "border-emerald-500/30 text-emerald-400" : "border-amber-500/30 text-amber-400"
                        )}>
                          {sess.status === "completed" ? <CheckCircle2 className="w-3 h-3 mr-1" /> : <AlertCircle className="w-3 h-3 mr-1" />}
                          {sess.status}
                        </Badge>
                        <span className="text-[10px] text-muted-foreground font-mono">{sess.model}</span>
                      </div>
                      <p className="text-xs text-foreground mt-1 line-clamp-1">{sess.topic}</p>
                      <p className="text-[10px] text-muted-foreground/60 mt-0.5">{formatTs(sess.started_at)}</p>
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* Section 4: Quick Actions */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-4 flex items-center gap-2">
          <Zap className="w-4 h-4" /> Quick Actions
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Button
            variant="outline"
            className="h-auto py-4 px-4 flex flex-col items-center gap-2 border-amber-500/15 hover:border-amber-500/40 hover:bg-amber-500/5 text-foreground"
            onClick={() => handleExport("kmef")}
          >
            <Download className="w-5 h-5 text-amber-400" />
            <span className="text-xs">Export KMEF</span>
          </Button>
          <Button
            variant="outline"
            className="h-auto py-4 px-4 flex flex-col items-center gap-2 border-amber-500/15 hover:border-amber-500/40 hover:bg-amber-500/5 text-foreground"
            onClick={() => handleExport("csv")}
          >
            <FileText className="w-5 h-5 text-amber-400" />
            <span className="text-xs">Export CSV</span>
          </Button>
          <a href="#/rooms">
            <Button
              variant="outline"
              className="w-full h-auto py-4 px-4 flex flex-col items-center gap-2 border-amber-500/15 hover:border-amber-500/40 hover:bg-amber-500/5 text-foreground"
            >
              <Plus className="w-5 h-5 text-amber-400" />
              <span className="text-xs">New Deliberation</span>
            </Button>
          </a>
          <a href="#/agents">
            <Button
              variant="outline"
              className="w-full h-auto py-4 px-4 flex flex-col items-center gap-2 border-amber-500/15 hover:border-amber-500/40 hover:bg-amber-500/5 text-foreground"
            >
              <Bot className="w-5 h-5 text-amber-400" />
              <span className="text-xs">Create Agent</span>
            </Button>
          </a>
          <a href="#/docs">
            <Button
              variant="outline"
              className="w-full h-auto py-4 px-4 flex flex-col items-center gap-2 border-amber-500/15 hover:border-amber-500/40 hover:bg-amber-500/5 text-foreground"
            >
              <BookOpen className="w-5 h-5 text-amber-400" />
              <span className="text-xs">API Docs</span>
            </Button>
          </a>
        </div>
      </section>

      {/* Section 5: Financial + Security */}
      <div className="grid md:grid-cols-2 gap-4 mb-8">
        {/* Financial */}
        <Card className="bg-[hsl(222,47%,11%)]/80 border-amber-500/10">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-foreground flex items-center gap-2">
              <Database className="w-4 h-4 text-amber-400" /> Financial
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Current Plan</span>
              <Badge className="bg-amber-500/15 text-amber-400 border-amber-500/25">{account.plan?.toUpperCase() ?? "DEV"}</Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Stripe Status</span>
              <span className="text-xs text-foreground">{billingData?.status ?? "Not connected"}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Deliberations (Month)</span>
              <span className="text-xs text-amber-400 font-bold">{usage.metered?.deliberations ?? 0}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">API Calls (Month)</span>
              <span className="text-xs text-amber-400 font-bold">{usage.metered?.api_calls ?? 0}</span>
            </div>
          </CardContent>
        </Card>

        {/* Security */}
        <Card className="bg-[hsl(222,47%,11%)]/80 border-amber-500/10">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-foreground flex items-center gap-2">
              <Key className="w-4 h-4 text-amber-400" /> Security
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Active Agent Tokens</span>
              <span className="text-xs text-amber-400 font-bold">{security.active_api_keys ?? 0}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Active WS Connections</span>
              <span className="text-xs text-foreground">{health.active_ws_connections ?? 0}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Active Deliberations</span>
              <span className="text-xs text-foreground">{health.active_deliberations ?? 0}</span>
            </div>
            <div className="flex items-center gap-2 pt-1">
              <a href="#/privacy" className="text-[10px] text-amber-400/60 hover:text-amber-400 underline">Privacy Policy</a>
              <a href="#/terms" className="text-[10px] text-amber-400/60 hover:text-amber-400 underline">Terms of Service</a>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Footer */}
      <div className="text-center">
        <p className="text-[10px] text-muted-foreground/30">
          KIOKU™ Boss Board — {account.email} — {new Date().toISOString().slice(0, 10)}
        </p>
      </div>
    </div>
  );
}
