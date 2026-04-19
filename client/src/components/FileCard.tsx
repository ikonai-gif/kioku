import { Download, FileText, Image as ImageIcon, Code, FileSpreadsheet, File, Eye } from "lucide-react";
import { cn } from "@/lib/utils";
import { API_BASE } from "@/lib/queryClient";

export interface FileItem {
  id: number;
  type: string;
  title: string | null;
  prompt: string | null;
  content_url: string | null;
  content_text: string | null;
  metadata: Record<string, any>;
  created_at: number;
}

const FILE_ICONS: Record<string, typeof FileText> = {
  image: ImageIcon,
  code: Code,
  spreadsheet: FileSpreadsheet,
  file: FileText,
};

function getFileCategory(item: FileItem): "image" | "document" | "code" | "file" {
  if (item.type === "image") return "image";
  const title = (item.title || "").toLowerCase();
  const meta = item.metadata || {};
  const mime = (meta.mimeType || "").toLowerCase();
  if (
    title.endsWith(".js") || title.endsWith(".ts") || title.endsWith(".py") ||
    title.endsWith(".jsx") || title.endsWith(".tsx") || title.endsWith(".json") ||
    title.endsWith(".html") || title.endsWith(".css") || title.endsWith(".sql") ||
    mime.includes("javascript") || mime.includes("python") || mime.includes("json")
  ) return "code";
  if (
    title.endsWith(".pdf") || title.endsWith(".docx") || title.endsWith(".doc") ||
    title.endsWith(".xlsx") || title.endsWith(".csv") || title.endsWith(".txt") ||
    mime.includes("pdf") || mime.includes("document") || mime.includes("spreadsheet") ||
    mime.includes("text/")
  ) return "document";
  return "file";
}

const CATEGORY_COLORS: Record<string, string> = {
  image: "bg-cyan-500/15 text-cyan-400 border-cyan-500/25",
  document: "bg-amber-500/15 text-amber-400 border-amber-500/25",
  code: "bg-purple-500/15 text-purple-400 border-purple-500/25",
  file: "bg-slate-500/15 text-slate-400 border-slate-500/25",
};

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function getExtension(title: string): string {
  const parts = title.split(".");
  return parts.length > 1 ? parts.pop()!.toUpperCase() : "";
}

interface FileCardProps {
  file: FileItem;
  view: "grid" | "list";
  onPreview: () => void;
}

export function getFileCategoryForFilter(item: FileItem) {
  return getFileCategory(item);
}

export default function FileCard({ file, view, onPreview }: FileCardProps) {
  const category = getFileCategory(file);
  const Icon = FILE_ICONS[category] || File;
  const ext = getExtension(file.title || "file");
  const isImage = category === "image";
  const downloadUrl = `${API_BASE}/api/files/${file.id}/download`;

  const handleDownload = (e: React.MouseEvent) => {
    e.stopPropagation();
    const a = document.createElement("a");
    a.href = downloadUrl;
    a.download = file.title || "download";
    a.click();
  };

  if (view === "grid") {
    return (
      <div
        onClick={onPreview}
        className="group cursor-pointer rounded-xl border border-white/[0.06] hover:border-[#C9A340]/30
          transition-all duration-300 overflow-hidden"
        style={{ background: "rgba(255,255,255,0.03)" }}
      >
        {/* Thumbnail area */}
        <div className="relative h-32 flex items-center justify-center bg-white/[0.02]">
          {isImage ? (
            <img
              src={downloadUrl}
              alt={file.title || "Image"}
              className="w-full h-full object-cover"
              loading="lazy"
            />
          ) : (
            <Icon className="w-10 h-10 text-muted-foreground/30" />
          )}
          {/* Hover overlay */}
          <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
            <button
              onClick={(e) => { e.stopPropagation(); onPreview(); }}
              className="p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
            >
              <Eye className="w-4 h-4" />
            </button>
            <button
              onClick={handleDownload}
              className="p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
            >
              <Download className="w-4 h-4" />
            </button>
          </div>
        </div>
        {/* Info */}
        <div className="px-3 py-2.5 space-y-1.5">
          <p className="text-xs font-medium text-foreground/80 truncate">{file.title || "Untitled"}</p>
          <div className="flex items-center justify-between">
            <span className={cn("text-[9px] font-medium px-1.5 py-0.5 rounded-full border", CATEGORY_COLORS[category])}>
              {ext || category}
            </span>
            <span className="text-[10px] text-muted-foreground/40">{formatDate(file.created_at)}</span>
          </div>
        </div>
      </div>
    );
  }

  // List view
  return (
    <div
      onClick={onPreview}
      className="group cursor-pointer flex items-center gap-3 px-4 py-3 rounded-xl border border-white/[0.06]
        hover:border-[#C9A340]/30 transition-all duration-300"
      style={{ background: "rgba(255,255,255,0.03)" }}
    >
      {/* Icon */}
      <div className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 bg-white/[0.04]">
        {isImage ? (
          <img
            src={downloadUrl}
            alt={file.title || "Image"}
            className="w-10 h-10 rounded-lg object-cover"
            loading="lazy"
          />
        ) : (
          <Icon className="w-5 h-5 text-muted-foreground/50" />
        )}
      </div>
      {/* Info */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground/80 truncate">{file.title || "Untitled"}</p>
        <div className="flex items-center gap-2 mt-0.5">
          <span className={cn("text-[9px] font-medium px-1.5 py-0.5 rounded-full border", CATEGORY_COLORS[category])}>
            {ext || category}
          </span>
          <span className="text-[10px] text-muted-foreground/40">{formatDate(file.created_at)}</span>
        </div>
      </div>
      {/* Actions */}
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={(e) => { e.stopPropagation(); onPreview(); }}
          className="p-1.5 rounded-md hover:bg-white/10 text-muted-foreground/50 hover:text-[#C9A340] transition-colors"
        >
          <Eye className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={handleDownload}
          className="p-1.5 rounded-md hover:bg-white/10 text-muted-foreground/50 hover:text-[#C9A340] transition-colors"
        >
          <Download className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
