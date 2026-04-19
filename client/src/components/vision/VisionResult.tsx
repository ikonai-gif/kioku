import React, { useState } from "react";
import { Search, Share2, BookmarkPlus, Languages, Code, FileText, MessageSquare, X, ChevronDown, ChevronUp, Sparkles } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

interface VisionSuggestion {
  type: string;
  label: string;
  payload: string;
}

interface VisionResultProps {
  analysis: string;
  suggestions: VisionSuggestion[];
  imagePreview?: string;
  onAction?: (suggestion: VisionSuggestion) => void;
  onDismiss?: () => void;
  className?: string;
}

const ACTION_ICONS: Record<string, React.ReactNode> = {
  search: <Search className="w-3.5 h-3.5" />,
  share: <Share2 className="w-3.5 h-3.5" />,
  memory: <BookmarkPlus className="w-3.5 h-3.5" />,
  translate: <Languages className="w-3.5 h-3.5" />,
  code: <Code className="w-3.5 h-3.5" />,
  extract: <FileText className="w-3.5 h-3.5" />,
  chat: <MessageSquare className="w-3.5 h-3.5" />,
};

export function VisionResult({ analysis, suggestions, imagePreview, onAction, onDismiss, className }: VisionResultProps) {
  const [expanded, setExpanded] = useState(true);

  return (
    <motion.div
      initial={{ opacity: 0, y: 12, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -8, scale: 0.98 }}
      className={`rounded-xl overflow-hidden ${className || ""}`}
      style={{
        background: "linear-gradient(135deg, rgba(15,27,61,0.95), rgba(10,20,50,0.98))",
        border: "1px solid rgba(201,163,64,0.2)",
        boxShadow: "0 4px 24px rgba(0,0,0,0.3), inset 0 1px 0 rgba(201,163,64,0.1)",
      }}
    >
      {/* Header */}
      <div
        className="flex items-center gap-2 px-4 py-3 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
        style={{
          borderBottom: expanded ? "1px solid rgba(201,163,64,0.1)" : "none",
        }}
      >
        <Sparkles className="w-4 h-4 text-[#C9A340] flex-shrink-0" />
        <span className="text-sm font-medium text-[#C9A340]">Vision Analysis</span>
        <div className="flex-1" />
        {onDismiss && (
          <button
            onClick={(e) => { e.stopPropagation(); onDismiss(); }}
            className="w-6 h-6 flex items-center justify-center rounded-full hover:bg-white/10 transition-colors"
          >
            <X className="w-3.5 h-3.5 text-white/40" />
          </button>
        )}
        {expanded ? (
          <ChevronUp className="w-4 h-4 text-white/30" />
        ) : (
          <ChevronDown className="w-4 h-4 text-white/30" />
        )}
      </div>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            {/* Content area — stacked on mobile */}
            <div className="flex flex-col sm:flex-row gap-3 p-4">
              {/* Image thumbnail */}
              {imagePreview && (
                <div className="flex-shrink-0 sm:w-24 sm:h-24 w-full h-40 rounded-lg overflow-hidden"
                  style={{ border: "1px solid rgba(201,163,64,0.15)" }}
                >
                  <img
                    src={imagePreview}
                    alt="Analyzed"
                    className="w-full h-full object-cover"
                  />
                </div>
              )}

              {/* Analysis text */}
              <div className="flex-1 min-w-0">
                <p className="text-sm text-foreground/85 leading-relaxed whitespace-pre-wrap">
                  {analysis}
                </p>
              </div>
            </div>

            {/* Suggested actions */}
            {suggestions.length > 0 && (
              <div className="px-4 pb-4">
                <p className="text-[10px] font-medium text-[#C9A340]/50 uppercase tracking-wider mb-2">
                  Suggested Actions
                </p>
                <div className="flex flex-wrap gap-2">
                  {suggestions.map((s, i) => (
                    <motion.button
                      key={i}
                      initial={{ opacity: 0, scale: 0.9 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ delay: i * 0.05 }}
                      onClick={() => onAction?.(s)}
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-all hover:scale-[1.02]"
                      style={{
                        background: s.type === "chat"
                          ? "rgba(201,163,64,0.15)"
                          : "rgba(255,255,255,0.06)",
                        border: `1px solid ${
                          s.type === "chat"
                            ? "rgba(201,163,64,0.3)"
                            : "rgba(255,255,255,0.1)"
                        }`,
                        color: s.type === "chat"
                          ? "#C9A340"
                          : "rgba(255,255,255,0.7)",
                      }}
                    >
                      {ACTION_ICONS[s.type] || <Sparkles className="w-3.5 h-3.5" />}
                      {s.label}
                    </motion.button>
                  ))}
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
