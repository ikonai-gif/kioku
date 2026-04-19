import React from "react";
import { motion } from "framer-motion";

interface ProvenanceNodeProps {
  id: string;
  topic: string;
  decision: string | null;
  confidence: number | null;
  status: string;
  depth: number;
  startedAt: number;
  isSelected?: boolean;
  onClick?: () => void;
}

export function ProvenanceNode({
  topic,
  decision,
  confidence,
  status,
  depth,
  startedAt,
  isSelected,
  onClick,
}: ProvenanceNodeProps) {
  const dateStr = startedAt
    ? new Date(startedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : "";

  return (
    <motion.button
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      onClick={onClick}
      className="w-full text-left rounded-xl p-3 transition-all duration-200"
      style={{
        marginLeft: depth * 20,
        maxWidth: `calc(100% - ${depth * 20}px)`,
        background: isSelected ? "rgba(201,163,64,0.08)" : "rgba(255,255,255,0.02)",
        border: isSelected
          ? "1px solid rgba(201,163,64,0.4)"
          : "1px solid rgba(255,255,255,0.06)",
        boxShadow: isSelected
          ? "0 0 16px rgba(201,163,64,0.12)"
          : "none",
      }}
    >
      {/* Topic */}
      <p className="text-xs font-medium text-foreground truncate mb-1">{topic}</p>

      {/* Decision snippet */}
      {decision && (
        <p className="text-[11px] text-foreground/60 leading-relaxed line-clamp-2 mb-2">
          {decision}
        </p>
      )}

      {/* Footer: confidence + date + status */}
      <div className="flex items-center gap-2">
        {confidence !== null && (
          <span
            className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full"
            style={{
              background: "rgba(201,163,64,0.15)",
              color: "#C9A340",
            }}
          >
            {Math.round(confidence)}%
          </span>
        )}
        {status !== "completed" && (
          <span
            className="text-[9px] font-medium px-1.5 py-0.5 rounded-full"
            style={{
              background: "rgba(96,165,250,0.12)",
              color: "rgba(96,165,250,0.8)",
            }}
          >
            {status}
          </span>
        )}
        <span className="text-[9px] text-muted-foreground/40 ml-auto">{dateStr}</span>
      </div>
    </motion.button>
  );
}
