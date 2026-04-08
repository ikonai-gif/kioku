import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Plus, Trash2, Bot, Clock } from "lucide-react";
import { AgentAvatar } from "@/lib/agent-icon";
import { cn } from "@/lib/utils";

const AGENT_COLORS = ["#D4AF37", "#3B82F6", "#A855F7", "#10B981", "#F97316", "#EF4444"];

function timeAgo(ts: number | null): string {
  if (!ts) return "Never";
  const diff = Date.now() - ts;
  if (diff < 60000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
  return `${Math.round(diff / 86400000)}d ago`;
}

export default function AgentsPage() {
  const { toast } = useToast();
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", description: "", color: "#D4AF37" });

  const { data: agents = [], isLoading } = useQuery<any[]>({ queryKey: ["/api/agents"] });

  // Auto-suggest next agent name
  const nextAgentName = `Agent ${agents.length + 1}`;

  const createMutation = useMutation({
    mutationFn: (data: any) => apiRequest("POST", "/api/agents", data).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      setCreating(false);
      setForm({ name: "", description: "", color: "#D4AF37" });
      toast({ title: "Agent created" });
    },
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      apiRequest("PATCH", `/api/agents/${id}/toggle`, { enabled }).then(r => r.json()),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/agents"] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/agents/${id}`).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: "Agent removed" });
    },
  });

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-foreground">Agents</h1>
          <p className="text-sm text-muted-foreground mt-0.5">{agents.length} agent{agents.length !== 1 ? "s" : ""} in your workspace</p>
        </div>
        <Button
          size="sm"
          className="h-8 text-xs gap-1.5"
          style={{ background: "hsl(43 74% 52%)", color: "hsl(222 47% 8%)" }}
          onClick={() => setCreating(true)}
          data-testid="button-new-agent"
        >
          <Plus className="w-3.5 h-3.5" /> New Agent
        </Button>
      </div>

      {isLoading && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1,2,3].map(i => (
            <div key={i} className="bg-card border border-card-border rounded-xl p-5 animate-pulse h-40" />
          ))}
        </div>
      )}

      {!isLoading && agents.length === 0 && (
        <div className="bg-card border border-card-border rounded-xl p-10 text-center">
          <Bot className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">No agents yet</p>
          <Button size="sm" variant="ghost" className="mt-3 text-xs" onClick={() => setCreating(true)}>
            Add your first agent
          </Button>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {agents.map((agent: any) => (
          <div key={agent.id} className={cn(
            "bg-card border border-card-border rounded-xl p-5 transition-all",
            !agent.enabled && "opacity-60"
          )} data-testid={`card-agent-${agent.id}`}>
            {/* Header */}
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-center gap-3">
                <AgentAvatar name={agent.name} color={agent.color} size="lg" />
                <div>
                  <div className="text-sm font-semibold text-foreground">{agent.name}</div>
                  <div className={cn(
                    "text-[10px] font-medium",
                    agent.status === "online" && agent.enabled ? "text-green-400"
                    : agent.status === "idle" ? "text-yellow-400"
                    : "text-muted-foreground"
                  )}>
                    {!agent.enabled ? "disabled" : agent.status}
                  </div>
                </div>
              </div>
              <Switch
                checked={!!agent.enabled}
                onCheckedChange={(v) => toggleMutation.mutate({ id: agent.id, enabled: v })}
                data-testid={`switch-agent-${agent.id}`}
              />
            </div>

            {agent.description && (
              <p className="text-xs text-muted-foreground mb-3 line-clamp-2">{agent.description}</p>
            )}

            {/* Stats */}
            <div className="grid grid-cols-2 gap-2 mb-3">
              <div className="bg-muted/50 rounded-lg p-2">
                <div className="text-sm font-bold text-foreground tabular-nums">{agent.memoriesCount.toLocaleString()}</div>
                <div className="text-[10px] text-muted-foreground">memories</div>
              </div>
              <div className="bg-muted/50 rounded-lg p-2">
                <div className="flex items-center gap-1 text-[10px] text-muted-foreground mt-0.5">
                  <Clock className="w-3 h-3" />
                  {timeAgo(agent.lastActiveAt)}
                </div>
                <div className="text-[10px] text-muted-foreground">last active</div>
              </div>
            </div>

            {/* Delete */}
            <button
              className="text-[10px] text-muted-foreground/50 hover:text-red-400 flex items-center gap-1 transition-colors"
              onClick={() => deleteMutation.mutate(agent.id)}
              data-testid={`button-delete-agent-${agent.id}`}
            >
              <Trash2 className="w-3 h-3" /> Remove
            </button>
          </div>
        ))}
      </div>

      {/* Create dialog */}
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm">New Agent</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium">Name</label>
              <Input
                placeholder={nextAgentName}
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                className="h-9 text-sm"
                data-testid="input-agent-name"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium">Description</label>
              <Input
                placeholder="What does this agent do?"
                value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                className="h-9 text-sm"
                data-testid="input-agent-description"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium">Color</label>
              <div className="flex gap-2">
                {AGENT_COLORS.map(c => (
                  <button
                    key={c}
                    className={cn("w-7 h-7 rounded-full border-2 transition-all",
                      form.color === c ? "border-foreground scale-110" : "border-transparent")}
                    style={{ background: c }}
                    onClick={() => setForm(f => ({ ...f, color: c }))}
                  />
                ))}
              </div>
            </div>
            <Button
              className="w-full h-9 text-sm"
              style={{ background: "hsl(43 74% 52%)", color: "hsl(222 47% 8%)" }}
              onClick={() => createMutation.mutate({ ...form, name: form.name || nextAgentName })}
              disabled={createMutation.isPending}
              data-testid="button-create-agent-submit"
            >
              {createMutation.isPending ? "Creating…" : "Create Agent"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
