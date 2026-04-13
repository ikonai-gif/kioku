import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Search, Trash2, Brain, Plus, Download, Clock, GitBranch, MapPin, Shield } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

const typeColors: Record<string, string> = {
  semantic: "bg-blue-400/10 text-blue-400",
  episodic: "bg-yellow-400/10 text-yellow-400",
  procedural: "bg-purple-400/10 text-purple-400",
  temporal: "bg-cyan-400/10 text-cyan-400",
  causal: "bg-orange-400/10 text-orange-400",
  contextual: "bg-emerald-400/10 text-emerald-400",
};

const typeIcons: Record<string, React.ReactNode> = {
  temporal: <Clock className="w-3 h-3" />,
  causal: <GitBranch className="w-3 h-3" />,
  contextual: <MapPin className="w-3 h-3" />,
};

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
  return `${Math.round(diff / 86400000)}d ago`;
}

function confidenceColor(confidence: number): string {
  if (confidence >= 0.7) return "rgb(34 197 94)";   // green
  if (confidence >= 0.4) return "rgb(245 158 11)";  // amber
  return "rgb(239 68 68)";                            // red
}

export default function MemoryPage() {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [filterType, setFilterType] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    content: "",
    type: "semantic",
    agentName: "",
    importance: "0.5",
    expiresAt: "",
    causeId: "",
    contextTrigger: "",
  });

  // Debounce search
  const handleSearch = (v: string) => {
    setSearch(v);
    clearTimeout((window as any)._memSearchTimer);
    (window as any)._memSearchTimer = setTimeout(() => setDebouncedQ(v), 400);
  };

  const { data: memories = [], isLoading } = useQuery<any[]>({
    queryKey: ["/api/memories", debouncedQ],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/memories${debouncedQ ? `?q=${encodeURIComponent(debouncedQ)}` : ""}`);
      const data = await res.json();
      // API returns { data: [...], pagination: {...} } — unwrap
      return Array.isArray(data) ? data : (data.data ?? []);
    },
  });

  // Fetch all memories for causal link picker
  const { data: allMemories = [] } = useQuery<any[]>({
    queryKey: ["/api/memories", "all-for-picker"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/memories?limit=200");
      const data = await res.json();
      return Array.isArray(data) ? data : (data.data ?? []);
    },
    enabled: creating && form.type === "causal",
  });

  const filteredMemories = filterType
    ? (memories as any[]).filter((m: any) => m.type === filterType)
    : memories;

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/memories/${id}`).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/memories"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: "Memory deleted" });
    },
  });

  const createMutation = useMutation({
    mutationFn: (data: any) => apiRequest("POST", "/api/memories", data).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/memories"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      setCreating(false);
      setForm({ content: "", type: "semantic", agentName: "", importance: "0.5", expiresAt: "", causeId: "", contextTrigger: "" });
      toast({ title: "Memory added" });
    },
  });

  const handleCreate = () => {
    const payload: any = {
      content: form.content,
      type: form.type,
      agentName: form.agentName || null,
      importance: parseFloat(form.importance),
    };
    if (form.type === "temporal" && form.expiresAt) {
      payload.expiresAt = new Date(form.expiresAt).getTime();
    }
    if (form.type === "causal" && form.causeId) {
      payload.causeId = parseInt(form.causeId);
    }
    if (form.type === "contextual" && form.contextTrigger) {
      payload.contextTrigger = form.contextTrigger;
    }
    createMutation.mutate(payload);
  };

  return (
    <div className="p-4 md:p-6 max-w-4xl mx-auto space-y-4 md:space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-foreground">Memory Browser</h1>
          <p className="text-sm text-muted-foreground mt-0.5">{(memories as any[]).length} memories</p>
        </div>
        <div className="flex items-center gap-2">
          {/* Export CSV */}
          <Button
            size="sm" variant="outline"
            className="h-8 text-xs gap-1.5"
            onClick={() => {
              const rows = (filteredMemories as any[]);
              if (!rows.length) return;
              const header = "id,content,type,agentName,importance,confidence,createdAt";
              const body = rows.map((m: any) =>
                `${m.id},"${String(m.content).replace(/"/g, '""')}",${m.type},${m.agentName ?? ""},${m.importance},${(m.currentConfidence ?? m.confidence ?? 1).toFixed(3)},${new Date(m.createdAt).toISOString()}`
              ).join("\n");
              const blob = new Blob([header + "\n" + body], { type: "text/csv" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a"); a.href = url;
              a.download = `kioku-memory-${Date.now()}.csv`; a.click();
              URL.revokeObjectURL(url);
            }}
            data-testid="button-export-csv"
          >
            <Download className="w-3.5 h-3.5" /> <span className="hidden sm:inline">CSV</span>
          </Button>
          {/* Export JSON */}
          <Button
            size="sm" variant="outline"
            className="h-8 text-xs gap-1.5"
            onClick={() => {
              const blob = new Blob([JSON.stringify(filteredMemories, null, 2)], { type: "application/json" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a"); a.href = url;
              a.download = `kioku-memory-${Date.now()}.json`; a.click();
              URL.revokeObjectURL(url);
            }}
            data-testid="button-export-json"
          >
            <Download className="w-3.5 h-3.5" /> <span className="hidden sm:inline">JSON</span>
          </Button>
          <Button
            size="sm"
            className="h-8 text-xs gap-1.5"
            style={{ background: "hsl(43 74% 52%)", color: "hsl(222 47% 8%)" }}
            onClick={() => setCreating(true)}
            data-testid="button-add-memory"
          >
            <Plus className="w-3.5 h-3.5" /> Add Memory
          </Button>
        </div>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
        <Input
          type="search"
          placeholder="Search memories..."
          value={search}
          onChange={e => handleSearch(e.target.value)}
          className="pl-9 h-9 text-sm"
          data-testid="input-memory-search"
        />
      </div>

      {/* Type filter pills */}
      <div className="flex gap-2 flex-wrap items-center">
        <span className="text-[10px] text-muted-foreground">Filter:</span>
        <button
          className={cn("text-[10px] px-2 py-0.5 rounded-full font-medium border transition-all",
            filterType === null ? "border-foreground/30 text-foreground" : "border-border text-muted-foreground hover:border-muted-foreground/50"
          )}
          onClick={() => setFilterType(null)}
        >all</button>
        {Object.entries(typeColors).map(([type, cls]) => (
          <button
            key={type}
            className={cn(
              "text-[10px] px-2 py-0.5 rounded-full font-medium transition-all",
              filterType === type ? cls : "border border-border text-muted-foreground hover:border-muted-foreground/50"
            )}
            onClick={() => setFilterType(t => t === type ? null : type)}
            data-testid={`filter-memory-${type}`}
          >{type}</button>
        ))}
      </div>

      {/* Memory list */}
      {isLoading && (
        <div className="space-y-2">
          {[1,2,3,4].map(i => (
            <div key={i} className="bg-card border border-card-border rounded-xl h-16 animate-pulse" />
          ))}
        </div>
      )}

      {!isLoading && filteredMemories.length === 0 && (
        <div className="bg-card border border-card-border rounded-xl p-10 text-center">
          <Brain className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">
            {debouncedQ ? `No results for "${debouncedQ}"` : "No memories yet"}
          </p>
        </div>
      )}

      <div className="space-y-2">
        {(filteredMemories as any[]).map((mem: any) => {
          const conf = mem.currentConfidence ?? mem.confidence ?? 1.0;
          return (
            <div key={mem.id}
              className="bg-card border border-card-border rounded-xl px-4 py-3 flex items-start gap-3 group hover:border-primary/30 transition-colors"
              data-testid={`row-memory-${mem.id}`}
            >
              {/* importance bar */}
              <div className="w-1 self-stretch rounded-full flex-shrink-0 mt-0.5"
                style={{ background: `hsl(43 74% ${30 + Math.round(mem.importance * 40)}%)`, opacity: 0.5 + mem.importance * 0.5 }} />

              <div className="flex-1 min-w-0">
                <p className="text-sm text-foreground leading-relaxed">{mem.content}</p>
                <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                  <span className={cn("text-[10px] px-1.5 py-0.5 rounded-full font-medium inline-flex items-center gap-1", typeColors[mem.type] ?? "bg-muted text-muted-foreground")}>
                    {typeIcons[mem.type] ?? null}
                    {mem.type}
                  </span>
                  {mem.agentName && (
                    <span className="text-[10px] text-muted-foreground">{mem.agentName}</span>
                  )}
                  <span className="text-[10px] text-muted-foreground/60">{timeAgo(mem.createdAt)}</span>
                  <span className="text-[10px] text-muted-foreground/50" title="Importance score (0-1): higher = retrieved first">importance: {mem.importance.toFixed(2)}</span>

                  {/* Confidence indicator */}
                  <span className="inline-flex items-center gap-1 text-[10px]" title={`Confidence: ${(conf * 100).toFixed(0)}% | Reinforced ${mem.reinforcements ?? 0}x`}>
                    <Shield className="w-3 h-3" style={{ color: confidenceColor(conf) }} />
                    <span style={{ color: confidenceColor(conf) }}>{(conf * 100).toFixed(0)}%</span>
                  </span>

                  {/* Type-specific metadata */}
                  {mem.type === "temporal" && mem.expiresAt && (
                    <span className="text-[10px] text-cyan-400/70">
                      expires {new Date(mem.expiresAt).toLocaleDateString()}
                    </span>
                  )}
                  {mem.type === "causal" && mem.causeId && (
                    <span className="text-[10px] text-orange-400/70">
                      cause: #{mem.causeId}
                    </span>
                  )}
                  {mem.type === "contextual" && mem.contextTrigger && (
                    <span className="text-[10px] text-emerald-400/70 truncate max-w-[120px]" title={mem.contextTrigger}>
                      trigger: {mem.contextTrigger}
                    </span>
                  )}
                </div>

                {/* Confidence decay bar */}
                <div className="mt-2 w-full h-1 rounded-full bg-muted/30 overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{
                      width: `${Math.max(2, conf * 100)}%`,
                      background: confidenceColor(conf),
                      opacity: 0.4 + conf * 0.6,
                    }}
                  />
                </div>
              </div>

              <button
                className="opacity-30 group-hover:opacity-100 text-muted-foreground hover:text-red-400 transition-all p-1"
                onClick={() => deleteMutation.mutate(mem.id)}
                data-testid={`button-delete-memory-${mem.id}`}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          );
        })}
      </div>

      {/* Add memory dialog */}
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm">Add Memory</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium">Content *</label>
              <textarea
                className="w-full bg-input/30 border border-border rounded-lg p-2.5 text-sm text-foreground placeholder:text-muted-foreground resize-none focus:outline-none focus:ring-1 focus:ring-ring"
                rows={3}
                placeholder="What should be remembered?"
                value={form.content}
                onChange={e => setForm(f => ({ ...f, content: e.target.value }))}
                data-testid="input-memory-content"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium">Type</label>
                <Select value={form.type} onValueChange={v => setForm(f => ({ ...f, type: v }))}>
                  <SelectTrigger className="h-9 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="semantic">semantic</SelectItem>
                    <SelectItem value="episodic">episodic</SelectItem>
                    <SelectItem value="procedural">procedural</SelectItem>
                    <SelectItem value="temporal">temporal</SelectItem>
                    <SelectItem value="causal">causal</SelectItem>
                    <SelectItem value="contextual">contextual</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium">Importance (0-1)</label>
                <Input
                  type="number"
                  min="0" max="1" step="0.1"
                  value={form.importance}
                  onChange={e => setForm(f => ({ ...f, importance: e.target.value }))}
                  className="h-9 text-sm"
                />
              </div>
            </div>

            {/* Conditional fields for new types */}
            {form.type === "temporal" && (
              <div className="space-y-1.5">
                <label className="text-xs font-medium">Expires At</label>
                <Input
                  type="datetime-local"
                  value={form.expiresAt}
                  onChange={e => setForm(f => ({ ...f, expiresAt: e.target.value }))}
                  className="h-9 text-sm"
                  data-testid="input-memory-expires-at"
                />
              </div>
            )}

            {form.type === "causal" && (
              <div className="space-y-1.5">
                <label className="text-xs font-medium">Cause Memory (link to another memory)</label>
                <Select value={form.causeId} onValueChange={v => setForm(f => ({ ...f, causeId: v }))}>
                  <SelectTrigger className="h-9 text-xs">
                    <SelectValue placeholder="Select a cause memory..." />
                  </SelectTrigger>
                  <SelectContent>
                    {(allMemories as any[]).map((m: any) => (
                      <SelectItem key={m.id} value={String(m.id)}>
                        #{m.id} - {m.content.slice(0, 50)}{m.content.length > 50 ? "..." : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {form.type === "contextual" && (
              <div className="space-y-1.5">
                <label className="text-xs font-medium">Context Trigger</label>
                <Input
                  placeholder="e.g. in meetings with CEO, always mention..."
                  value={form.contextTrigger}
                  onChange={e => setForm(f => ({ ...f, contextTrigger: e.target.value }))}
                  className="h-9 text-sm"
                  data-testid="input-memory-context-trigger"
                />
              </div>
            )}

            <div className="space-y-1.5">
              <label className="text-xs font-medium">Agent Name (optional)</label>
              <Input
                placeholder="e.g. NIKA"
                value={form.agentName}
                onChange={e => setForm(f => ({ ...f, agentName: e.target.value }))}
                className="h-9 text-sm"
              />
            </div>
            <Button
              className="w-full h-9 text-sm"
              style={{ background: "hsl(43 74% 52%)", color: "hsl(222 47% 8%)" }}
              onClick={handleCreate}
              disabled={!form.content || createMutation.isPending}
              data-testid="button-create-memory-submit"
            >
              {createMutation.isPending ? "Saving..." : "Save Memory"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
