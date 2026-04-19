import React from "react";
import { motion } from "framer-motion";

interface AgentDebateCardProps {
  agentName: string;
  agentColor: string;
  position: string;
  confidence: number;
  reasoning?: string;
  changedMind?: boolean;
  index?: number;
}

export function AgentDebateCard({
  agentName,
  agentColor,
  position,
  confidence,
  reasoning,
  changedMind,
  index = 0,
}: AgentDebateCardProps) {
  const [expanded, setExpanded] = React.useState(false);

  return (
    <motion.div
      initial={{ opacity: 0, x: -12 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: index * 0.1, duration: 0.3 }}
      className="rounded-xl overflow-hidden cursor-pointer"
      style={{
        background: "rgba(255,255,255,0.03)",
        backdropFilter: "blur(12px)",
        borderLeft: `3px solid ${agentColor}`,
        border: "1px solid rgba(255,255,255,0.06)",
        borderLeftWidth: 3,
        borderLeftColor: agentColor,
      }}
      onClick={() => setExpanded(!expanded)}
    >
      <div className="p-3">
        {/* Header row */}
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <div
              className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold"
              style={{ background: agentColor + "22", color: agentColor }}
            >
              {agentName.charAt(0).toUpperCase()}
            </div>
            <span className="text-xs font-semibold text-foreground">{agentName}</span>
            {changedMind && (
              <span
                className="text-[9px] font-medium px-1.5 py-0.5 rounded-full"
                style={{
                  background: "rgba(201,163,64,0.15)",
                  color: "#C9A340",
                  border: "1px solid rgba(201,163,64,0.25)",
                }}
              >
                &#x21BB; Changed
              </span>
            )}
          </div>
          <span className="text-[10px] font-mono text-muted-foreground/60">
            {Math.round(confidence)}%
          </span>
        </div>

        {/* Position text */}
        <p className="text-xs text-foreground/80 leading-relaxed mb-2.5">{position}</p>

        {/* Confidence bar */}
        <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.06)" }}>
          <motion.div
            className="h-full rounded-full"
            initial={{ width: 0 }}
            animate={{ width: `${Math.min(100, Math.max(0, confidence))}%` }}
            transition={{ duration: 0.6, ease: "easeOut" }}
            style={{
              background: "linear-gradient(90deg, #C9A340, #D4AF37, #E8C547)",
            }}
          />
        </div>

        {/* Reasoning (expanded) */}
        {expanded && reasoning && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            transition={{ duration: 0.2 }}
            className="mt-2.5 pt-2.5"
            style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}
          >
            <p className="text-[10px] font-medium text-muted-foreground/50 uppercase tracking-wider mb-1">Reasoning</p>
            <p className="text-[11px] text-foreground/60 leading-relaxed">{reasoning}</p>
          </motion.div>
        )}
      </div>
    </motion.div>
  );
}
