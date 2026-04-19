import { X, Download, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { API_BASE } from "@/lib/queryClient";
import type { FileItem } from "./FileCard";

interface FilePreviewProps {
  file: FileItem;
  onClose: () => void;
}

export default function FilePreview({ file, onClose }: FilePreviewProps) {
  const isImage = file.type === "image";
  const downloadUrl = `${API_BASE}/api/files/${file.id}/download`;

  const handleDownload = () => {
    const a = document.createElement("a");
    a.href = downloadUrl;
    a.download = file.title || "download";
    a.click();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />

      {/* Modal */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-2xl max-h-[85vh] flex flex-col rounded-2xl border border-white/10 overflow-hidden"
        style={{ background: "#0F1B3D" }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 flex-shrink-0">
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-medium text-foreground truncate">{file.title || "Untitled"}</h3>
            <p className="text-[10px] text-muted-foreground/50 mt-0.5">
              {new Date(file.created_at).toLocaleDateString(undefined, {
                month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit",
              })}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0 ml-3">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs text-muted-foreground hover:text-[#C9A340]"
              onClick={handleDownload}
            >
              <Download className="w-3 h-3 mr-1" /> Download
            </Button>
            {isImage && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs text-muted-foreground hover:text-[#C9A340]"
                onClick={() => window.open(downloadUrl, "_blank")}
              >
                <ExternalLink className="w-3 h-3 mr-1" /> Open
              </Button>
            )}
            <button
              onClick={onClose}
              className="text-muted-foreground/50 hover:text-foreground text-lg leading-none p-1"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          {isImage ? (
            <div className="flex items-center justify-center">
              <img
                src={downloadUrl}
                alt={file.title || "Image preview"}
                className="max-w-full max-h-[60vh] rounded-lg object-contain"
              />
            </div>
          ) : file.content_text ? (
            <pre className="text-xs text-foreground/80 leading-relaxed whitespace-pre-wrap font-mono bg-white/[0.03] rounded-lg p-4 border border-white/[0.05]">
              {file.content_text}
            </pre>
          ) : (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <p className="text-sm text-muted-foreground/50">Preview not available</p>
              <Button
                size="sm"
                className="text-xs"
                style={{ background: "hsl(43 74% 52%)", color: "hsl(222 47% 8%)" }}
                onClick={handleDownload}
              >
                <Download className="w-3 h-3 mr-1.5" /> Download to view
              </Button>
            </div>
          )}
        </div>

        {/* Prompt / metadata footer */}
        {file.prompt && (
          <div className="px-4 py-2.5 border-t border-white/[0.06] flex-shrink-0">
            <p className="text-[10px] text-muted-foreground/40 mb-0.5">Prompt</p>
            <p className="text-xs text-muted-foreground/70 line-clamp-2">{file.prompt}</p>
          </div>
        )}
      </div>
    </div>
  );
}
