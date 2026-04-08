import { useQuery } from "@tanstack/react-query";
import { Activity, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";

const opColors: Record<string, string> = {
  stored: "text-green-400 bg-green-400/10",
  search: "text-blue-400 bg-blue-400/10",
  retrieved: "text-yellow-400 bg-yellow-400/10",
  deliberation: "text-purple-400 bg-purple-400/10",
};

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function LogsPage() {
  const { data: logs = [], isLoading, dataUpdatedAt } = useQuery<any[]>({
    queryKey: ["/api/logs"],
    refetchInterval: 5000,
  });

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-foreground">Live Feed</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Real-time operations across all agents</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 text-[10px] text-green-400">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 pulse-online" />
            Auto-refresh
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-muted-foreground"
            onClick={() => queryClient.invalidateQueries({ queryKey: ["/api/logs"] })}
            data-testid="button-refresh-logs"
          >
            <RefreshCw className="w-3 h-3 mr-1" /> Refresh
          </Button>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-4 gap-3">
        {(["stored", "search", "retrieved", "deliberation"] as const).map(op => {
          const count = (logs as any[]).filter((l: any) => l.operation === op).length;
          return (
            <div key={op} className={cn("rounded-xl px-4 py-3 flex flex-col gap-0.5", opColors[op]?.split(" ")[1] ?? "bg-muted")}>
              <div className={cn("text-xl font-bold tabular-nums", opColors[op]?.split(" ")[0])}>{count}</div>
              <div className={cn("text-[10px] font-medium", opColors[op]?.split(" ")[0])}>{op}</div>
            </div>
          );
        })}
      </div>

      {/* Log list */}
      <div className="bg-card border border-card-border rounded-xl overflow-hidden">
        {/* Header */}
        <div className="grid grid-cols-[auto_1fr_auto_auto] gap-4 px-4 py-2.5 border-b border-card-border">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Agent</span>
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Detail</span>
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Latency</span>
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Time</span>
        </div>

        {isLoading && (
          <div className="space-y-0">
            {[1,2,3,4,5].map(i => (
              <div key={i} className="h-11 px-4 flex items-center border-b border-card-border animate-pulse">
                <div className="w-20 h-4 bg-muted rounded" />
              </div>
            ))}
          </div>
        )}

        {!isLoading && (logs as any[]).length === 0 && (
          <div className="py-12 text-center">
            <Activity className="w-7 h-7 text-muted-foreground mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">No operations yet</p>
          </div>
        )}

        {(logs as any[]).map((log: any, i: number) => (
          <div
            key={log.id}
            className={cn(
              "grid grid-cols-[auto_1fr_auto_auto] gap-4 px-4 py-2.5 items-center text-xs border-b border-card-border/50 last:border-0 hover:bg-muted/30 transition-colors",
              i === 0 && "bg-muted/20"
            )}
            data-testid={`row-log-${log.id}`}
          >
            {/* Agent */}
            <div className="flex items-center gap-1.5 min-w-[80px]">
              <div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: log.agentColor }} />
              <span className="font-medium text-foreground">{log.agentName ?? "System"}</span>
            </div>

            {/* Detail */}
            <div className="flex items-center gap-2 min-w-0">
              <span className={cn("text-[10px] px-1.5 py-0.5 rounded font-medium flex-shrink-0", opColors[log.operation] ?? "bg-muted text-muted-foreground")}>
                {log.operation}
              </span>
              <span className="text-muted-foreground truncate">{log.detail}</span>
            </div>

            {/* Latency */}
            <span className="text-muted-foreground/60 font-mono text-[11px] tabular-nums">
              {log.latencyMs ? `${log.latencyMs}ms` : "—"}
            </span>

            {/* Time */}
            <span className="text-muted-foreground/50 text-[11px] whitespace-nowrap">
              {timeAgo(log.createdAt)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
