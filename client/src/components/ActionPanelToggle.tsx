import React from "react";
import { motion } from "framer-motion";
import { Layers } from "lucide-react";

interface ActionPanelToggleProps {
  onClick: () => void;
  isOpen: boolean;
  hasNew: boolean;
  artifactCount: number;
}

export function ActionPanelToggle({
  onClick,
  isOpen,
  hasNew,
  artifactCount,
}: ActionPanelToggleProps) {
  return (
    <motion.button
      onClick={onClick}
      className="fixed bottom-24 right-4 z-30 flex items-center justify-center w-12 h-12 rounded-full md:hidden"
      style={{
        background: isOpen
          ? "linear-gradient(135deg, #C9A340, #D4AF37)"
          : "rgba(12,18,38,0.95)",
        border: isOpen
          ? "1px solid rgba(201,163,64,0.6)"
          : "1px solid rgba(201,163,64,0.3)",
        boxShadow: isOpen
          ? "0 4px 20px rgba(201,163,64,0.4)"
          : "0 4px 20px rgba(0,0,0,0.5), 0 0 12px rgba(201,163,64,0.15)",
        color: isOpen ? "#0a0f1e" : "#C9A340",
      }}
      whileTap={{ scale: 0.92 }}
      whileHover={{ scale: 1.05 }}
      animate={hasNew ? { scale: [1, 1.08, 1] } : {}}
      transition={hasNew ? { duration: 0.6, repeat: 2 } : {}}
      title="Artifacts panel"
    >
      <Layers className="w-5 h-5" />

      {/* Notification dot */}
      {hasNew && !isOpen && (
        <motion.span
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          className="absolute -top-0.5 -right-0.5 flex items-center justify-center"
        >
          <span
            className="w-4 h-4 rounded-full flex items-center justify-center text-[8px] font-bold"
            style={{
              background: "#C9A340",
              color: "#0a0f1e",
              boxShadow: "0 0 8px rgba(201,163,64,0.6)",
            }}
          >
            {artifactCount > 9 ? "9+" : artifactCount}
          </span>
          <span
            className="absolute w-4 h-4 rounded-full animate-ping"
            style={{ background: "rgba(201,163,64,0.4)" }}
          />
        </motion.span>
      )}
    </motion.button>
  );
}
