import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Brain, Bot, Activity, Zap, ArrowRight, Plus, MessageSquare, GitBranch } from "lucide-react";
import { cn } from "@/lib/utils";
import { Link } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

function StatCard({ icon: Icon, label, value, sub, color }: {
  icon: any; label: string; value: string | number; sub?: string; color: string;
}) {
  return (
    <div className="bg-card border border-card-border rounded-xl p-5 gold-glow">
      <div className="flex items-start justify-between mb-3">
        <div className={cn("w-9 h-9 rounded-lg flex items-center justify-center", color)}>
          <Icon className="w-4.5 h-4.5" />
        </div>
      </div>
      <div className="text-2xl font-bold text-foreground tabular-nums">{value}</div>
      <div className="text-xs text-muted-foreground mt-0.5">{label}</div>
      {sub && <div className="text-[10px] text-muted-foreground/60 mt-1">{sub}</div>}
    </div>
  );
}

export default function DashboardPage() {
  const { data: stats } = useQuery({ queryKey: ["/api/stats"] });
  const { data: agents = [] } = useQuery({ queryKey: ["/api/agents"] });
  const { data: logs = [] } = useQuery({ queryKey: ["/api/logs"] });

  const recentLogs = (logs as any[]).slice(0, 6);

  const opColors: Record<string, string> = {
    stored: "text-green-400",
    search: "text-blue-400",
    retrieved: "text-yellow-400",
    deliberation: "text-purple-400",
  };

  const opLabels: Record<string, string> = {
    stored: "stored",
    search: "searched",
    retrieved: "retrieved",
    deliberation: "deliberation",
  };

  const isEmpty = (agents as any[]).length === 0;

  if (isEmpty) {
    return (
      <div className="flex flex-col items-center justify-center h-full px-6 py-16 text-center max-w-lg mx-auto">
        {/* Logo mark */}
        <div className="w-16 h-16 rounded-2xl flex items-center justify-center mb-6"
          style={{ background: "hsl(43 74% 52% / 0.12)", border: "1px solid hsl(43 74% 52% / 0.25)" }}>
          <Brain className="w-8 h-8" style={{ color: "hsl(43 74% 52%)" }} />
        </div>

        <h1 className="text-xl font-bold text-foreground mb-2">Welcome to KIOKU™</h1>
        <p className="text-sm text-muted-foreground mb-8 leading-relaxed">
          Your AI memory layer is ready. Start by creating your first agent — give it a name, role, and task.
        </p>

        {/* Steps */}
        <div className="w-full space-y-3 mb-8">
          {[
            { n: 1, icon: Bot,           label: "Create an Agent",      desc: "Name, color, description",    href: "/agents" },
            { n: 2, icon: GitBranch,     label: "Build a Flow",         desc: "Connect agents into pipelines", href: "/flows" },
            { n: 3, icon: MessageSquare, label: "Open a Room",          desc: "Start deliberating",          href: "/rooms" },
          ].map(({ n, icon: Icon, label, desc, href }) => (
            <Link key={n} href={href}>
              <a className="flex items-center gap-4 p-4 rounded-xl border border-border hover:border-primary/40 hover:bg-muted/20 transition-all group">
                <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0"
                  style={{ background: "hsl(43 74% 52% / 0.15)", color: "hsl(43 74% 52%)" }}>{n}</div>
                <Icon className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                <div className="flex-1 text-left">
                  <div className="text-sm font-medium text-foreground">{label}</div>
                  <div className="text-[11px] text-muted-foreground">{desc}</div>
                </div>
                <ArrowRight className="w-3.5 h-3.5 text-muted-foreground/40 group-hover:text-primary transition-colors" />
              </a>
            </Link>
          ))}
        </div>

        <Link href="/agents">
          <a>
            <button className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold transition-all"
              style={{ background: "hsl(43 74% 52%)", color: "hsl(222 47% 8%)" }}>
              <Plus className="w-4 h-4" /> Create First Agent
            </button>
          </a>
        </Link>
      </div>
    );
  }

  return (
    <div className="p-5 max-w-6xl mx-auto space-y-4">
      {/* Header */}
      <div>
        <h1 className="text-lg font-semibold text-foreground">Dashboard</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Your workspace at a glance</p>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          icon={Brain}
          label="Total Memories"
          value={(stats as any)?.totalMemories ?? "—"}
          color="bg-yellow-400/10 text-yellow-400"
        />
        <StatCard
          icon={Bot}
          label="Active Agents"
          value={(stats as any)?.activeAgents ?? "—"}
          sub={`of ${(agents as any[]).length} total agents`}
          color="bg-blue-400/10 text-blue-400"
        />
        <StatCard
          icon={Activity}
          label="Operations"
          value={(stats as any)?.totalOps ?? "—"}
          sub="all time"
          color="bg-purple-400/10 text-purple-400"
        />
        <StatCard
          icon={Zap}
          label="Avg Latency"
          value={(stats as any)?.avgLatency ? `${(stats as any).avgLatency} ms` : "—"}
          sub="Redis cache"
          color="bg-green-400/10 text-green-400"
        />
      </div>

      {/* Agents + Feed */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {/* Agent status */}
        <div className="bg-card border border-card-border rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-foreground">Agents</h2>
            <a href="/#/agents" className="text-[10px] text-primary hover:text-primary/80">View all →</a>
          </div>
          <div className="grid grid-cols-[auto_1fr_auto_auto] gap-x-3 text-[10px] uppercase tracking-wider text-muted-foreground/60 font-medium mb-2 px-1">
            <span></span><span>Agent</span><span className="text-right">Memories</span><span className="text-right">Status</span>
          </div>
          <div className="space-y-2">
            {(agents as any[]).length === 0 && (
              <p className="text-sm text-muted-foreground">No agents yet</p>
            )}
            {(agents as any[]).map((agent: any) => (
              <div key={agent.id} className="grid grid-cols-[auto_1fr_auto_auto] gap-x-3 items-center px-1 py-1.5 rounded-lg hover:bg-muted/30 transition-colors">
                <div className={cn(
                  "w-2 h-2 rounded-full flex-shrink-0",
                  agent.status === "online" && agent.enabled ? "pulse-online" : "opacity-20"
                )} style={{ background: agent.color }} />
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground">{agent.name}</div>
                  <div className="text-[11px] text-muted-foreground truncate">{agent.description}</div>
                </div>
                <div className="text-xs font-mono text-foreground text-right">{agent.memoriesCount.toLocaleString()}</div>
                <div className={cn(
                  "text-[10px] px-2 py-0.5 rounded-full font-medium text-right min-w-[46px] text-center",
                  agent.status === "online" && agent.enabled
                    ? "bg-green-400/10 text-green-400"
                    : agent.status === "idle"
                    ? "bg-yellow-400/10 text-yellow-400"
                    : "bg-muted text-muted-foreground"
                )}>
                  {!agent.enabled ? "off" : agent.status}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Live feed */}
        <div className="bg-card border border-card-border rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-foreground">Live Feed</h2>
            <div className="flex items-center gap-3">
            <a href="/#/logs" className="text-[10px] text-primary hover:text-primary/80">View all →</a>
            <span className="flex items-center gap-1.5 text-[10px] text-green-400">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400 pulse-online" />
              Live
            </span>
            </div>
          </div>
          <div className="space-y-2.5">
            {recentLogs.length === 0 && (
              <p className="text-sm text-muted-foreground">No activity yet</p>
            )}
            {recentLogs.map((log: any) => (
              <div key={log.id} className="flex items-start gap-2.5 text-xs">
                <div className="w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0" style={{ background: log.agentColor }} />
                <div className="flex-1 min-w-0">
                  <span className="font-medium text-foreground">{log.agentName}</span>
                  <span className="text-muted-foreground"> → </span>
                  <span className={cn("font-medium", opColors[log.operation] ?? "text-muted-foreground")}>
                    {opLabels[log.operation] ?? log.operation}
                  </span>
                  <span className="text-muted-foreground ml-1 truncate block">{log.detail}</span>
                </div>
                {log.latencyMs ? (
                  <span className="text-[10px] text-muted-foreground/60 flex-shrink-0">{log.latencyMs}ms</span>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* API Key */}
      <APIKeyCard />
    </div>
  );
}

function APIKeyCard() {
  const { data: user, refetch } = useQuery({ queryKey: ["/api/auth/me"] });
  const { toast } = useToast();
  const [show, setShow] = useState(false);
  const [rotating, setRotating] = useState(false);
  const isDemo = (user as any)?.id === 1;

  async function handleRotate() {
    if (!confirm("Rotate API key? Your current key will stop working immediately.")) return;
    setRotating(true);
    try {
      const res = await apiRequest("POST", "/api/auth/rotate-key");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      await refetch();
      toast({ title: "API key rotated", description: "New key is active." });
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    } finally {
      setRotating(false);
    }
  }

  return (
    <div className="bg-card border border-card-border rounded-xl p-5">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">API Key</h2>
          <p className="text-xs text-muted-foreground mt-0.5">Authenticate KIOKU API requests with this key</p>
        </div>
        {!isDemo && (
          <button
            className="text-[11px] text-red-400 hover:text-red-300 font-medium disabled:opacity-40"
            onClick={handleRotate}
            disabled={rotating}
          >{rotating ? "Rotating…" : "Regenerate"}</button>
        )}
      </div>
      <div className="flex items-center gap-2">
        <div className="flex-1 bg-muted rounded-lg px-3 py-2 font-mono text-xs text-foreground truncate">
          {show ? (user as any)?.apiKey ?? "—" : "kk_" + "•".repeat(40)}
        </div>
        <button
          className="text-xs text-primary hover:text-primary/80 font-medium px-2"
          onClick={() => setShow(s => !s)}
        >{show ? "Hide" : "Reveal"}</button>
        {(user as any)?.apiKey && (
          <button
            className="text-xs text-muted-foreground hover:text-foreground px-2"
            onClick={() => { navigator.clipboard.writeText((user as any).apiKey); toast({ title: "Copied" }); }}
          >Copy</button>
        )}
      </div>
      <div className="mt-3 bg-muted/50 rounded-lg p-3">
        <p className="text-[10px] text-muted-foreground font-mono">
          curl -X POST https://usekioku.com/api/memories \<br />
          &nbsp;&nbsp;-H "X-API-Key: {'<YOUR_KEY>'}" \<br />
          &nbsp;&nbsp;-d {'{"content":"User prefers dark mode","type":"semantic"}'}
        </p>
      </div>
    </div>
  );
}

