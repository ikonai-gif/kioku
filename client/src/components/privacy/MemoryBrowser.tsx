import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Search, Trash2, ChevronLeft, ChevronRight, Loader2, CheckSquare, Square, Eye, X,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface MemoryItem {
  id: number;
  content: string;
  type: string;
  importance: number;
  agentName: string | null;
  namespace: string | null;
  createdAt: number;
  size: number;
}

interface MemoriesResponse {
  memories: MemoryItem[];
  total: number;
  page: number;
  limit: number;
}

const TYPE_COLORS: Record<string, string> = {
  semantic: "bg-blue-500/15 text-blue-400",
  episodic: "bg-purple-500/15 text-purple-400",
  procedural: "bg-green-500/15 text-green-400",
  emotional: "bg-pink-500/15 text-pink-400",
  temporal: "bg-amber-500/15 text-amber-400",
  causal: "bg-red-500/15 text-red-400",
  contextual: "bg-cyan-500/15 text-cyan-400",
};

export default function MemoryBrowser() {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [page, setPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [viewingMemory, setViewingMemory] = useState<MemoryItem | null>(null);

  // Debounce search
  const [searchTimer, setSearchTimer] = useState<ReturnType<typeof setTimeout> | null>(null);
  const handleSearch = (val: string) => {
    setSearch(val);
    if (searchTimer) clearTimeout(searchTimer);
    const timer = setTimeout(() => {
      setDebouncedSearch(val);
      setPage(1);
    }, 300);
    setSearchTimer(timer);
  };

  const queryParams = new URLSearchParams({ page: String(page), limit: "20" });
  if (debouncedSearch) queryParams.set("search", debouncedSearch);
  if (typeFilter) queryParams.set("type", typeFilter);

  const { data, isLoading } = useQuery<MemoriesResponse>({
    queryKey: [`/api/privacy/memories?${queryParams.toString()}`],
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("DELETE", `/api/privacy/memories/${id}`);
      if (!res.ok) throw new Error("Failed to delete");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/privacy/memories"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["/api/privacy/summary"] });
      toast({ title: "Memory deleted" });
    },
    onError: () => toast({ title: "Failed to delete memory", variant: "destructive" }),
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: async (ids: number[]) => {
      const res = await apiRequest("DELETE", "/api/privacy/memories", { ids });
      if (!res.ok) throw new Error("Failed to delete");
    },
    onSuccess: () => {
      setSelectedIds(new Set());
      queryClient.invalidateQueries({ queryKey: ["/api/privacy/memories"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["/api/privacy/summary"] });
      toast({ title: "Memories deleted" });
    },
    onError: () => toast({ title: "Bulk delete failed", variant: "destructive" }),
  });

  const memories = data?.memories ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / 20);

  const toggleSelect = (id: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === memories.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(memories.map(m => m.id)));
    }
  };

  const types = ["semantic", "episodic", "procedural", "emotional", "temporal", "causal", "contextual"];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">Memory Browser</h2>
        <span className="text-xs text-muted-foreground">{total} total</span>
      </div>

      {/* Search + Filters */}
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search memories…"
            value={search}
            onChange={e => handleSearch(e.target.value)}
            className="pl-9 h-10"
          />
        </div>
        <div className="flex gap-1.5 overflow-x-auto pb-1 no-scrollbar">
          <button
            onClick={() => { setTypeFilter(""); setPage(1); }}
            className={cn(
              "px-3 py-1.5 rounded-full text-xs whitespace-nowrap transition-colors",
              !typeFilter
                ? "bg-primary/20 text-primary font-medium"
                : "bg-muted/30 text-muted-foreground hover:text-foreground"
            )}
          >
            All
          </button>
          {types.map(t => (
            <button
              key={t}
              onClick={() => { setTypeFilter(typeFilter === t ? "" : t); setPage(1); }}
              className={cn(
                "px-3 py-1.5 rounded-full text-xs capitalize whitespace-nowrap transition-colors",
                typeFilter === t
                  ? "bg-primary/20 text-primary font-medium"
                  : "bg-muted/30 text-muted-foreground hover:text-foreground"
              )}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* Bulk actions */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-2 p-2 rounded-lg bg-red-500/10" style={{ borderColor: "hsl(var(--border))" }}>
          <span className="text-xs text-red-400 font-medium">{selectedIds.size} selected</span>
          <Button
            size="sm"
            variant="destructive"
            className="h-7 text-xs ml-auto"
            onClick={() => bulkDeleteMutation.mutate(Array.from(selectedIds))}
            disabled={bulkDeleteMutation.isPending}
          >
            {bulkDeleteMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Trash2 className="w-3 h-3 mr-1" />}
            Delete Selected
          </Button>
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setSelectedIds(new Set())}>
            Clear
          </Button>
        </div>
      )}

      {/* Memory list */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        </div>
      ) : memories.length === 0 ? (
        <div className="text-center py-12 text-sm text-muted-foreground">
          {debouncedSearch || typeFilter ? "No memories match your filters" : "No memories stored yet"}
        </div>
      ) : (
        <div className="space-y-1.5">
          {/* Select all */}
          <button
            onClick={toggleSelectAll}
            className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {selectedIds.size === memories.length ? (
              <CheckSquare className="w-3.5 h-3.5 text-primary" />
            ) : (
              <Square className="w-3.5 h-3.5" />
            )}
            Select all
          </button>

          {memories.map(mem => (
            <div
              key={mem.id}
              className={cn(
                "group flex items-start gap-3 p-3 rounded-lg border transition-colors",
                selectedIds.has(mem.id) ? "bg-primary/5" : "hover:bg-muted/20"
              )}
              style={{ borderColor: "hsl(var(--border))" }}
            >
              <button
                onClick={() => toggleSelect(mem.id)}
                className="mt-0.5 flex-shrink-0"
              >
                {selectedIds.has(mem.id) ? (
                  <CheckSquare className="w-4 h-4 text-primary" />
                ) : (
                  <Square className="w-4 h-4 text-muted-foreground" />
                )}
              </button>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-foreground line-clamp-2">{mem.content}</p>
                <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                  <span className={cn("text-[10px] px-2 py-0.5 rounded-full", TYPE_COLORS[mem.type] ?? "bg-muted text-muted-foreground")}>
                    {mem.type}
                  </span>
                  {mem.agentName && (
                    <span className="text-[10px] text-muted-foreground">by {mem.agentName}</span>
                  )}
                  <span className="text-[10px] text-muted-foreground/60">
                    {new Date(mem.createdAt).toLocaleDateString()}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                <button
                  onClick={() => setViewingMemory(mem)}
                  className="p-1.5 rounded-md hover:bg-muted/30 text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Eye className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => deleteMutation.mutate(mem.id)}
                  className="p-1.5 rounded-md hover:bg-red-500/10 text-muted-foreground hover:text-red-400 transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between pt-2">
          <Button
            size="sm"
            variant="ghost"
            className="h-8 text-xs"
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page <= 1}
          >
            <ChevronLeft className="w-3.5 h-3.5 mr-1" /> Previous
          </Button>
          <span className="text-xs text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="h-8 text-xs"
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
          >
            Next <ChevronRight className="w-3.5 h-3.5 ml-1" />
          </Button>
        </div>
      )}

      {/* Memory detail modal */}
      {viewingMemory && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setViewingMemory(null)} />
          <div className="relative w-full max-w-lg bg-card border rounded-2xl p-5 shadow-2xl max-h-[80vh] overflow-y-auto" style={{ borderColor: "hsl(var(--border))" }}>
            <div className="flex items-start justify-between mb-4">
              <div>
                <h3 className="text-sm font-semibold text-foreground">Memory Details</h3>
                <div className="flex items-center gap-2 mt-1">
                  <span className={cn("text-[10px] px-2 py-0.5 rounded-full", TYPE_COLORS[viewingMemory.type] ?? "bg-muted text-muted-foreground")}>
                    {viewingMemory.type}
                  </span>
                  {viewingMemory.agentName && (
                    <span className="text-[10px] text-muted-foreground">by {viewingMemory.agentName}</span>
                  )}
                </div>
              </div>
              <button onClick={() => setViewingMemory(null)} className="p-1 rounded-md hover:bg-muted/30 text-muted-foreground">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="text-sm text-foreground whitespace-pre-wrap leading-relaxed bg-muted/10 rounded-lg p-3" style={{ borderColor: "hsl(var(--border))" }}>
              {viewingMemory.content}
            </div>
            <div className="mt-3 flex items-center justify-between text-[10px] text-muted-foreground/60">
              <span>Created: {new Date(viewingMemory.createdAt).toLocaleString()}</span>
              <span>Importance: {(viewingMemory.importance * 100).toFixed(0)}%</span>
            </div>
            <div className="mt-4 flex justify-end">
              <Button
                size="sm"
                variant="destructive"
                className="h-8 text-xs"
                onClick={() => {
                  deleteMutation.mutate(viewingMemory.id);
                  setViewingMemory(null);
                }}
              >
                <Trash2 className="w-3 h-3 mr-1" /> Delete Memory
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
