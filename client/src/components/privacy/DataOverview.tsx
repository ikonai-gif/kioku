import { useQuery } from "@tanstack/react-query";
import { Shield, Brain, Bot, Plug, Database } from "lucide-react";
import { cn } from "@/lib/utils";

interface PrivacySummary {
  memoryCount: number;
  conversationCount: number;
  connectedServices: number;
  dataSize: number;
  dataSizeFormatted: string;
}

function StatCard({ icon: Icon, label, value, color }: {
  icon: any; label: string; value: string | number; color: string;
}) {
  return (
    <div className="bg-card border rounded-xl p-4 gold-glow" style={{ borderColor: "hsl(var(--border))" }}>
      <div className="flex items-center gap-3 mb-3">
        <div className={cn("w-9 h-9 rounded-lg flex items-center justify-center", color)}>
          <Icon className="w-4 h-4" />
        </div>
      </div>
      <div className="text-2xl font-bold text-foreground tabular-nums">{value}</div>
      <div className="text-xs text-muted-foreground mt-0.5">{label}</div>
    </div>
  );
}

export default function DataOverview() {
  const { data: summary, isLoading } = useQuery<PrivacySummary>({
    queryKey: ["/api/privacy/summary"],
  });

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="bg-card border rounded-xl p-4 gold-glow animate-pulse h-28" style={{ borderColor: "hsl(var(--border))" }} />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Shield className="w-4 h-4" style={{ color: "hsl(43 74% 52%)" }} />
        <h2 className="text-sm font-semibold text-foreground">Your Data Overview</h2>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          icon={Brain}
          label="Total Memories"
          value={summary?.memoryCount ?? 0}
          color="bg-purple-500/15 text-purple-400"
        />
        <StatCard
          icon={Bot}
          label="Agents"
          value={summary?.conversationCount ?? 0}
          color="bg-blue-500/15 text-blue-400"
        />
        <StatCard
          icon={Plug}
          label="Connected Services"
          value={summary?.connectedServices ?? 0}
          color="bg-green-500/15 text-green-400"
        />
        <StatCard
          icon={Database}
          label="Storage Used"
          value={summary?.dataSizeFormatted ?? "0 KB"}
          color="bg-amber-500/15 text-amber-400"
        />
      </div>
    </div>
  );
}
