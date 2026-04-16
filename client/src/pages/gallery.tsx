import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Copy, Download, Filter, FileText, Image as ImageIcon, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { motion, AnimatePresence } from "framer-motion";

type FilterType = "all" | "text" | "image";

const TYPE_BADGES: Record<string, { label: string; color: string }> = {
  lyrics: { label: "Lyrics", color: "bg-purple-500/20 text-purple-300 border-purple-500/30" },
  poem: { label: "Poem", color: "bg-blue-500/20 text-blue-300 border-blue-500/30" },
  story: { label: "Story", color: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30" },
  essay: { label: "Essay", color: "bg-amber-500/20 text-amber-300 border-amber-500/30" },
  script: { label: "Script", color: "bg-rose-500/20 text-rose-300 border-rose-500/30" },
  image: { label: "Image", color: "bg-cyan-500/20 text-cyan-300 border-cyan-500/30" },
};

function CreationCard({ creation, index, onExpand }: { creation: any; index: number; onExpand: () => void }) {
  const { toast } = useToast();
  const isImage = creation.type === "image";
  const badge = TYPE_BADGES[creation.type] || { label: creation.type, color: "bg-gray-500/20 text-gray-300 border-gray-500/30" };

  const copyToClipboard = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(creation.content);
      toast({ title: "Copied to clipboard" });
    } catch {
      toast({ title: "Copy failed", variant: "destructive" });
    }
  };

  const previewLines = creation.content.split("\n").slice(0, 3).join("\n");

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: index * 0.05 }}
      onClick={onExpand}
      className="group cursor-pointer rounded-xl border border-white/10 hover:border-[#C9A340]/30 transition-all duration-300 overflow-hidden"
      style={{
        background: "rgba(255,255,255,0.03)",
      }}
    >
      {/* Badge + Date header */}
      <div className="flex items-center justify-between px-3 pt-3 pb-2">
        <span className={cn("text-[10px] font-medium px-2 py-0.5 rounded-full border", badge.color)}>
          {badge.label}
        </span>
        <span className="text-[10px] text-muted-foreground/40">
          {new Date(Number(creation.createdAt)).toLocaleDateString()}
        </span>
      </div>

      {/* Content */}
      <div className="px-3 pb-2">
        {isImage ? (
          <div className="text-xs text-muted-foreground/70 leading-relaxed line-clamp-3">
            {creation.content}
          </div>
        ) : (
          <p className="text-xs text-foreground/80 leading-relaxed whitespace-pre-wrap line-clamp-3">
            {previewLines}
          </p>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 px-3 pb-3 opacity-0 group-hover:opacity-100 transition-opacity">
        {!isImage ? (
          <button
            onClick={copyToClipboard}
            className="flex items-center gap-1 text-[10px] text-muted-foreground/50 hover:text-[#C9A340] transition-colors"
          >
            <Copy className="w-3 h-3" /> Copy
          </button>
        ) : (
          <button
            onClick={(e) => { e.stopPropagation(); window.open(creation.content, "_blank"); }}
            className="flex items-center gap-1 text-[10px] text-muted-foreground/50 hover:text-[#C9A340] transition-colors"
          >
            <Download className="w-3 h-3" /> Download
          </button>
        )}
      </div>
    </motion.div>
  );
}

function ExpandedCreation({ creation, onClose }: { creation: any; onClose: () => void }) {
  const { toast } = useToast();
  const isImage = creation.type === "image";
  const badge = TYPE_BADGES[creation.type] || { label: creation.type, color: "bg-gray-500/20 text-gray-300 border-gray-500/30" };

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(creation.content);
      toast({ title: "Copied to clipboard" });
    } catch {
      toast({ title: "Copy failed", variant: "destructive" });
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <motion.div
        initial={{ scale: 0.95, y: 20 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.95, y: 20 }}
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-lg max-h-[80vh] overflow-y-auto rounded-2xl border border-white/10"
        style={{ background: "#0F1B3D" }}
      >
        {/* Header */}
        <div className="sticky top-0 flex items-center justify-between px-4 py-3 border-b border-white/10" style={{ background: "#0F1B3D" }}>
          <div className="flex items-center gap-2">
            <span className={cn("text-[10px] font-medium px-2 py-0.5 rounded-full border", badge.color)}>
              {badge.label}
            </span>
            <span className="text-[10px] text-muted-foreground/40">
              {new Date(Number(creation.createdAt)).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {!isImage ? (
              <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground hover:text-[#C9A340]" onClick={copyToClipboard}>
                <Copy className="w-3 h-3 mr-1" /> Copy
              </Button>
            ) : (
              <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground hover:text-[#C9A340]" onClick={() => window.open(creation.content, "_blank")}>
                <Download className="w-3 h-3 mr-1" /> Download
              </Button>
            )}
            <button onClick={onClose} className="text-muted-foreground/50 hover:text-foreground text-lg leading-none">&times;</button>
          </div>
        </div>

        {/* Content */}
        <div className="p-4">
          <p className="text-sm text-foreground/90 leading-relaxed whitespace-pre-wrap">
            {creation.content}
          </p>
        </div>
      </motion.div>
    </motion.div>
  );
}

export default function GalleryPage() {
  const [filter, setFilter] = useState<FilterType>("all");
  const [expanded, setExpanded] = useState<any | null>(null);

  const { data: creations = [], isLoading } = useQuery<any[]>({
    queryKey: ["/api/partner/creations"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/partner/creations");
      return res.json();
    },
  });

  const filtered = creations.filter((c: any) => {
    if (filter === "all") return true;
    if (filter === "image") return c.type === "image";
    return c.type !== "image";
  });

  return (
    <div className="min-h-full p-4 md:p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-[#C9A340]" />
          <h1 className="text-lg font-semibold text-foreground">Creations</h1>
          <span className="text-xs text-muted-foreground/50">{creations.length}</span>
        </div>
      </div>

      {/* Filter Tabs */}
      <div className="flex gap-1">
        {([
          { key: "all", label: "All", icon: Filter },
          { key: "text", label: "Text", icon: FileText },
          { key: "image", label: "Images", icon: ImageIcon },
        ] as const).map(({ key, label, icon: Icon }) => (
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
          </button>
        ))}
      </div>

      {/* Grid */}
      {isLoading ? (
        <div className="flex items-center justify-center py-20">
          <div className="w-6 h-6 rounded-full border-2 border-[#C9A340]/30 border-t-[#C9A340] animate-spin" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3">
          <Sparkles className="w-10 h-10 text-muted-foreground/20" />
          <p className="text-sm text-muted-foreground/40">No creations yet</p>
          <p className="text-xs text-muted-foreground/30">Use the Create button in Partner chat to get started</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {filtered.map((creation: any, i: number) => (
            <CreationCard
              key={creation.id}
              creation={creation}
              index={i}
              onExpand={() => setExpanded(creation)}
            />
          ))}
        </div>
      )}

      {/* Expanded modal */}
      <AnimatePresence>
        {expanded && <ExpandedCreation creation={expanded} onClose={() => setExpanded(null)} />}
      </AnimatePresence>
    </div>
  );
}
