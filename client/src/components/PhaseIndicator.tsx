import React from "react";
import { motion } from "framer-motion";

type Phase = "position" | "debate" | "final" | "consensus";

const PHASES: { key: Phase; label: string }[] = [
  { key: "position", label: "Position" },
  { key: "debate", label: "Debate" },
  { key: "final", label: "Final" },
  { key: "consensus", label: "Consensus" },
];

interface PhaseIndicatorProps {
  currentPhase: Phase;
  completedPhases: Phase[];
}

export function PhaseIndicator({ currentPhase, completedPhases }: PhaseIndicatorProps) {
  const currentIdx = PHASES.findIndex((p) => p.key === currentPhase);

  return (
    <div className="flex items-center justify-center gap-0 py-3 px-4">
      {PHASES.map((phase, idx) => {
        const isCompleted = completedPhases.includes(phase.key);
        const isActive = phase.key === currentPhase;
        const isPast = idx < currentIdx || isCompleted;

        return (
          <React.Fragment key={phase.key}>
            {idx > 0 && (
              <div
                className="flex-1 h-[2px] mx-1"
                style={{
                  background: isPast
                    ? "linear-gradient(90deg, #22c55e, #22c55e)"
                    : isActive
                    ? "linear-gradient(90deg, #22c55e, rgba(201,163,64,0.3))"
                    : "rgba(255,255,255,0.08)",
                  maxWidth: 48,
                }}
              />
            )}
            <div className="flex flex-col items-center gap-1.5">
              <motion.div
                className="relative flex items-center justify-center rounded-full"
                style={{
                  width: 24,
                  height: 24,
                  background: isCompleted
                    ? "#22c55e"
                    : isActive
                    ? "linear-gradient(135deg, #C9A340, #D4AF37)"
                    : "rgba(255,255,255,0.08)",
                  boxShadow: isActive
                    ? "0 0 12px rgba(201,163,64,0.4)"
                    : isCompleted
                    ? "0 0 8px rgba(34,197,94,0.3)"
                    : "none",
                }}
                animate={isActive ? { scale: [1, 1.1, 1] } : {}}
                transition={isActive ? { duration: 1.5, repeat: Infinity } : {}}
              >
                {isCompleted ? (
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                    <path d="M2 6L5 9L10 3" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : (
                  <div
                    className="w-2 h-2 rounded-full"
                    style={{
                      background: isActive ? "#0a0f1e" : "rgba(255,255,255,0.25)",
                    }}
                  />
                )}
              </motion.div>
              <span
                className="text-[9px] font-medium whitespace-nowrap"
                style={{
                  color: isActive ? "#C9A340" : isCompleted ? "#22c55e" : "rgba(255,255,255,0.35)",
                }}
              >
                {phase.label}
              </span>
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
}
