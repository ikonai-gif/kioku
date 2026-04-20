import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { FolderOpen, Grid3X3, List, Filter, Image as ImageIcon, FileText, Code, Files, HardDrive, ExternalLink, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import FileCard, { type FileItem, getFileCategoryForFilter } from "@/components/FileCard";
import FilePreview from "@/components/FilePreview";

type FilterType = "all" | "image" | "document" | "code" | "workspace";
type ViewMode = "grid" | "list";

type WorkspaceItem = { name: string; size: number; updated_at: string; agentId?: number };

function formatSize(bytes: number): string {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Split a `__agent<id>__/rest/of/path` entry. Returns { agentId, display }
// where display has the prefix stripped. If no prefix, both are undefined.
function splitAgentPrefix(name: string): { agentId?: number; display: string } {
  const m = name.match(/^__agent(\d+)__\/(.*)$/);
  if (!m) return { display: name };
  return { agentId: Number(m[1]), display: m[2] };
}

function WorkspaceBrowser() {
  const [prefix, setPrefix] = useState<string>("");
  const { data, isLoading, refetch, isFetching } = useQuery<{ ok: boolean; items: WorkspaceItem[]; error?: string; primaryAgentId?: number | null }>({
    queryKey: ["/api/workspace/list", prefix],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/workspace/list?prefix=${encodeURIComponent(prefix)}`);
      return await res.json();
    },
  });

  const items = data?.items || [];

  async function openFile(path: string, agentId?: number) {
    try {
      const qs = new URLSearchParams({ path, days: "7" });
      if (typeof agentId === "number") qs.set("agentId", String(agentId));
      const res = await apiRequest("GET", `/api/workspace/sign?${qs.toString()}`);
      const json = await res.json();
      if (json?.url) window.open(json.url, "_blank", "noopener");
    } catch (e) {
      // silent — user can retry
    }
  }

  // Common prefixes — auto (mirrored media), scripts/notes, series folders
  const shortcuts = [
    { key: "", label: "/" },
    { key: "auto", label: "auto" },
    { key: "tests", label: "tests" },
    { key: "IKONBAI", label: "IKONBAI" },
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1 flex-wrap">
          {shortcuts.map((s) => (
            <button
              key={s.key}
              onClick={() => setPrefix(s.key)}
              className={cn(
                "px-2.5 py-1 rounded-md text-[11px] border transition-colors",
                prefix === s.key
                  ? "bg-[#C9A340]/15 text-[#C9A340] border-[#C9A340]/30"
                  : "text-muted-foreground/60 hover:text-foreground border-white/[0.08] hover:bg-white/5"
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
        <input
          type="text"
          value={prefix}
          onChange={(e) => setPrefix(e.target.value)}
          placeholder="subfolder (e.g. IKONBAI/ep1)"
          className="flex-1 min-w-[160px] bg-transparent border border-white/[0.08] rounded-md px-2.5 py-1 text-[11px] placeholder:text-muted-foreground/30 focus:outline-none focus:border-[#C9A340]/40"
        />
        <button
          onClick={() => refetch()}
          className="p-1.5 rounded-md border border-white/[0.08] text-muted-foreground/60 hover:text-foreground hover:bg-white/5"
          title="Refresh"
        >
          <RefreshCw className={cn("w-3.5 h-3.5", isFetching && "animate-spin")} />
        </button>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <div className="w-5 h-5 rounded-full border-2 border-[#C9A340]/30 border-t-[#C9A340] animate-spin" />
        </div>
      )}

      {!isLoading && data && !data.ok && (
        <div className="py-10 text-center text-xs text-red-400/70">
          {data.error === "workspace_not_configured"
            ? "Workspace storage is not configured on this server."
            : data.error || "Workspace unavailable."}
        </div>
      )}

      {!isLoading && data?.ok && items.length === 0 && (
        <div className="flex flex-col items-center justify-center py-14 gap-2">
          <HardDrive className="w-8 h-8 text-muted-foreground/20" />
          <p className="text-xs text-muted-foreground/40">
            {prefix ? `Empty: ${prefix}` : "Workspace is empty"}
          </p>
          <p className="text-[10px] text-muted-foreground/30">
            Generated media and saved scripts will appear here.
          </p>
        </div>
      )}

      {!isLoading && items.length > 0 && (
        <div className="space-y-1">
          {items.map((it) => {
            const { agentId: prefixAgentId, display } = splitAgentPrefix(it.name);
            // When the item had a __agent<id>__/ prefix, pass the raw name to
            // /sign so the server strips it and uses that agent. Otherwise
            // build the full path as usual.
            const signPath = prefixAgentId !== undefined ? it.name : (prefix ? `${prefix}/${it.name}` : it.name);
            const agentIdForSign = prefixAgentId ?? it.agentId;
            return (
              <button
                key={`${agentIdForSign ?? "p"}:${signPath}`}
                onClick={() => openFile(signPath, agentIdForSign)}
                className="w-full flex items-center gap-3 px-3 py-2 rounded-md border border-white/[0.06] hover:border-[#C9A340]/30 hover:bg-white/[0.02] transition-colors text-left"
              >
                <FileText className="w-4 h-4 text-[#C9A340]/70 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <div className="text-xs text-foreground truncate">{display}</div>
                    {prefixAgentId !== undefined && (
                      <span className="shrink-0 text-[9px] px-1.5 py-0.5 rounded border border-[#C9A340]/30 text-[#C9A340]/80 bg-[#C9A340]/5">
                        agent #{prefixAgentId}
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] text-muted-foreground/50">
                    {formatSize(it.size)} · {it.updated_at?.slice(0, 19).replace("T", " ")}
                  </div>
                </div>
                <ExternalLink className="w-3.5 h-3.5 text-muted-foreground/40 shrink-0" />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function FilesPage() {
  const [filter, setFilter] = useState<FilterType>("all");
  const [view, setView] = useState<ViewMode>("grid");
  const [preview, setPreview] = useState<FileItem | null>(null);

  const { data: files = [], isLoading } = useQuery<FileItem[]>({
    queryKey: ["/api/gallery", "files"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/gallery?limit=200");
      const data = await res.json();
      // gallery includes all types: file, image, lyrics, poem, etc.
      // For the Files tab, show only file + image types (downloadable items)
      return (Array.isArray(data) ? data : []).filter(
        (item: any) => item.type === "file" || item.type === "image"
      );
    },
  });

  const filtered = files.filter((f) => {
    if (filter === "all") return true;
    return getFileCategoryForFilter(f) === filter;
  });

  const imageCount = files.filter((f) => getFileCategoryForFilter(f) === "image").length;
  const docCount = files.filter((f) => getFileCategoryForFilter(f) === "document").length;
  const codeCount = files.filter((f) => getFileCategoryForFilter(f) === "code").length;

  return (
    <div className="min-h-full p-4 md:p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FolderOpen className="w-5 h-5 text-[#C9A340]" />
          <h1 className="text-lg font-semibold text-foreground">Files</h1>
          <span className="text-xs text-muted-foreground/50">{files.length}</span>
        </div>
        {/* View toggle */}
        <div className="flex items-center gap-1 rounded-lg border border-white/[0.08] p-0.5">
          <button
            onClick={() => setView("grid")}
            className={cn(
              "p-1.5 rounded-md transition-colors",
              view === "grid"
                ? "bg-[#C9A340]/15 text-[#C9A340]"
                : "text-muted-foreground/50 hover:text-foreground"
            )}
          >
            <Grid3X3 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setView("list")}
            className={cn(
              "p-1.5 rounded-md transition-colors",
              view === "list"
                ? "bg-[#C9A340]/15 text-[#C9A340]"
                : "text-muted-foreground/50 hover:text-foreground"
            )}
          >
            <List className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-1 flex-wrap">
        {([
          { key: "all" as const, label: "All", icon: Filter, count: files.length },
          { key: "image" as const, label: "Images", icon: ImageIcon, count: imageCount },
          { key: "document" as const, label: "Documents", icon: FileText, count: docCount },
          { key: "code" as const, label: "Code", icon: Code, count: codeCount },
          { key: "workspace" as const, label: "Workspace", icon: HardDrive, count: 0 },
        ]).map(({ key, label, icon: Icon, count }) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors",
              filter === key
                ? "bg-[#C9A340]/15 text-[#C9A340] border border-[#C9A340]/30"
                : "text-muted-foreground/60 hover:text-foreground hover:bg-white/5 border border-transparent"
            )}
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
            {count > 0 && <span className="text-[9px] opacity-60">({count})</span>}
          </button>
        ))}
      </div>

      {/* Workspace tab renders its own browser (separate source: Supabase Storage) */}
      {filter === "workspace" && <WorkspaceBrowser />}

      {/* Loading state */}
      {filter !== "workspace" && isLoading && (
        <div className="flex items-center justify-center py-20">
          <div className="w-6 h-6 rounded-full border-2 border-[#C9A340]/30 border-t-[#C9A340] animate-spin" />
        </div>
      )}

      {/* Empty state */}
      {filter !== "workspace" && !isLoading && filtered.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 gap-3">
          <Files className="w-10 h-10 text-muted-foreground/20" />
          <p className="text-sm text-muted-foreground/40">
            {filter !== "all" ? `No ${filter} files found` : "No files yet"}
          </p>
          <p className="text-xs text-muted-foreground/30">
            Files created by your AI agent will appear here
          </p>
        </div>
      )}

      {/* File grid / list */}
      {filter !== "workspace" && !isLoading && filtered.length > 0 && (
        view === "grid" ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {filtered.map((file) => (
              <FileCard
                key={file.id}
                file={file}
                view="grid"
                onPreview={() => setPreview(file)}
              />
            ))}
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map((file) => (
              <FileCard
                key={file.id}
                file={file}
                view="list"
                onPreview={() => setPreview(file)}
              />
            ))}
          </div>
        )
      )}

      {/* Preview modal */}
      {preview && (
        <FilePreview file={preview} onClose={() => setPreview(null)} />
      )}
    </div>
  );
}
