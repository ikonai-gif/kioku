import React from "react";
import { motion } from "framer-motion";
import { Check, X, Eye } from "lucide-react";

interface Vote {
  agentName: string;
  position: string;
  confidence: number;
  changedMind: boolean;
}

interface ConsensusCardProps {
  decision: string;
  confidence: number;
  method: string;
  votes: Vote[];
  dissent: string[];
  onViewProvenance?: () => void;
}

export function ConsensusCard({
  decision,
  confidence,
  votes,
  dissent,
  onViewProvenance,
}: ConsensusCardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.4, ease: "easeOut" }}
      className="rounded-xl overflow-hidden"
      style={{
        background: "rgba(255,255,255,0.04)",
        backdropFilter: "blur(16px)",
        border: "1px solid rgba(201,163,64,0.35)",
        boxShadow: "0 0 20px rgba(201,163,64,0.1), 0 4px 16px rgba(0,0,0,0.2)",
      }}
    >
      {/* Gold accent top line */}
      <div
        className="h-[2px]"
        style={{ background: "linear-gradient(90deg, #C9A340, #D4AF37, #C9A340)" }}
      />

      <div className="p-4">
        {/* Header */}
        <div className="flex items-center gap-2 mb-3">
          <div
            className="w-6 h-6 rounded-full flex items-center justify-center"
            style={{ background: "rgba(201,163,64,0.2)" }}
          >
            <Check className="w-3.5 h-3.5 text-[#C9A340]" />
          </div>
          <span className="text-[10px] font-semibold uppercase tracking-wider text-[#C9A340]">
            Consensus Reached
          </span>
        </div>

        {/* Decision text */}
        <p className="text-sm font-medium text-foreground leading-relaxed mb-3">{decision}</p>

        {/* Overall confidence */}
        <div className="mb-4">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] text-muted-foreground/60">Overall Confidence</span>
            <span className="text-xs font-mono font-semibold text-[#C9A340]">
              {Math.round(confidence)}%
            </span>
          </div>
          <div className="h-2 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.06)" }}>
            <motion.div
              className="h-full rounded-full"
              initial={{ width: 0 }}
              animate={{ width: `${Math.min(100, Math.max(0, confidence))}%` }}
              transition={{ duration: 0.8, ease: "easeOut", delay: 0.3 }}
              style={{
                background: "linear-gradient(90deg, #C9A340, #D4AF37, #E8C547)",
              }}
            />
          </div>
        </div>

        {/* Vote breakdown */}
        <div className="space-y-1.5 mb-3">
          <p className="text-[10px] font-medium text-muted-foreground/50 uppercase tracking-wider">
            Vote Breakdown
          </p>
          {votes.map((vote) => {
            const isDissenter = dissent.includes(vote.agentName);
            return (
              <div
                key={vote.agentName}
                className="flex items-center gap-2 py-1 px-2 rounded-lg"
                style={{ background: "rgba(255,255,255,0.02)" }}
              >
                {isDissenter ? (
                  <X className="w-3 h-3 text-red-400/70 flex-shrink-0" />
                ) : (
                  <Check className="w-3 h-3 text-green-400/70 flex-shrink-0" />
                )}
                <span className="text-[11px] text-foreground/70 flex-1">{vote.agentName}</span>
                {vote.changedMind && (
                  <span className="text-[8px] text-[#C9A340]/60">&#x21BB;</span>
                )}
                <span className="text-[10px] font-mono text-muted-foreground/50">
                  {Math.round(vote.confidence)}%
                </span>
              </div>
            );
          })}
        </div>

        {/* Dissent */}
        {dissent.length > 0 && (
          <div className="mb-3 p-2 rounded-lg" style={{ background: "rgba(239,68,68,0.06)", border: "1px solid rgba(239,68,68,0.12)" }}>
            <p className="text-[10px] font-medium text-red-400/70 mb-0.5">Dissent</p>
            <p className="text-[11px] text-foreground/60">{dissent.join(", ")}</p>
          </div>
        )}

        {/* View Provenance button */}
        {onViewProvenance && (
          <button
            onClick={onViewProvenance}
            className="flex items-center gap-1.5 w-full justify-center py-2 rounded-lg text-xs font-medium transition-colors"
            style={{
              background: "rgba(201,163,64,0.1)",
              border: "1px solid rgba(201,163,64,0.2)",
              color: "#C9A340",
            }}
          >
            <Eye className="w-3.5 h-3.5" />
            View Provenance
          </button>
        )}
      </div>
    </motion.div>
  );
}
