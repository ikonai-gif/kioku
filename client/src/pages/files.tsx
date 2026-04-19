import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { FolderOpen, Grid3X3, List, Filter, Image as ImageIcon, FileText, Code, Files } from "lucide-react";
import { cn } from "@/lib/utils";
import FileCard, { type FileItem, getFileCategoryForFilter } from "@/components/FileCard";
import FilePreview from "@/components/FilePreview";

type FilterType = "all" | "image" | "document" | "code";
type ViewMode = "grid" | "list";

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

      {/* Loading state */}
      {isLoading && (
        <div className="flex items-center justify-center py-20">
          <div className="w-6 h-6 rounded-full border-2 border-[#C9A340]/30 border-t-[#C9A340] animate-spin" />
        </div>
      )}

      {/* Empty state */}
      {!isLoading && filtered.length === 0 && (
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
      {!isLoading && filtered.length > 0 && (
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
