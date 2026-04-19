import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Check, Loader2 } from "lucide-react";

// ── Tool name → friendly label + icon mapping ───────────────────
const TOOL_MAP: Record<string, { icon: string; label: string }> = {
  web_search:        { icon: "🔍", label: "Searching the web" },
  code_execution:    { icon: "💻", label: "Running code" },
  composio_gmail:    { icon: "📧", label: "Checking Gmail" },
  composio_calendar: { icon: "📅", label: "Checking Calendar" },
  composio_notion:   { icon: "📝", label: "Reading Notion" },
  composio_sheets:   { icon: "📊", label: "Reading Google Sheets" },
  image_generation:  { icon: "🎨", label: "Creating an image" },
  tts:               { icon: "🔊", label: "Generating speech" },
  deliberation:      { icon: "🤝", label: "Consulting team" },
};

function getFriendlyTool(toolName: string): { icon: string; label: string } {
  // Check exact match first
  if (TOOL_MAP[toolName]) return TOOL_MAP[toolName];
  // Check prefix match (e.g. "composio_gmail_send" → composio_gmail)
  for (const key of Object.keys(TOOL_MAP)) {
    if (toolName.startsWith(key)) return TOOL_MAP[key];
  }
  // Fallback: humanize the tool name
  const label = toolName.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return { icon: "⚙️", label };
}

export interface ToolStep {
  id: string;
  toolName: string;
  status: "running" | "done" | "error";
  startedAt: number;
}

interface TaskProgressProps {
  steps: ToolStep[];
  emotion?: string;
}

function ElapsedTime({ startedAt, running }: { startedAt: number; running: boolean }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!running) return;
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [startedAt, running]);

  useEffect(() => {
    if (!running) {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }
  }, [running, startedAt]);

  if (elapsed < 1) return null;
  return (
    <span className="text-[10px] text-muted-foreground/40 tabular-nums ml-auto flex-shrink-0">
      {elapsed}s
    </span>
  );
}

export function TaskProgress({ steps, emotion }: TaskProgressProps) {
  if (steps.length === 0) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex items-start gap-2 px-4 py-2"
    >
      {/* Timeline connector line */}
      <div className="flex flex-col items-center pt-1 flex-shrink-0" style={{ width: 28 }}>
        <div
          className="w-7 h-7 rounded-full flex items-center justify-center"
          style={{
            background: "linear-gradient(135deg, #0a0f1e 0%, #1a2744 100%)",
            border: "2px solid rgba(201,163,64,0.3)",
            boxShadow: "0 0 8px rgba(201,163,64,0.15)",
          }}
        >
          <span className="text-xs font-bold" style={{ color: "#C9A340" }}>L</span>
        </div>
        {steps.length > 1 && (
          <div
            className="w-px flex-1 mt-1"
            style={{ background: "rgba(201,163,64,0.15)", minHeight: 8 }}
          />
        )}
      </div>

      {/* Steps list */}
      <div
        className="flex-1 rounded-2xl overflow-hidden"
        style={{
          background: "rgba(201,163,64,0.04)",
          border: "1px solid rgba(201,163,64,0.12)",
        }}
      >
        <AnimatePresence initial={false}>
          {steps.map((step, idx) => {
            const tool = getFriendlyTool(step.toolName);
            const isRunning = step.status === "running";
            const isDone = step.status === "done";
            const isError = step.status === "error";
            const isLast = idx === steps.length - 1;

            return (
              <motion.div
                key={step.id}
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                transition={{ duration: 0.25, ease: "easeOut" }}
                className="flex items-center gap-2.5 px-3 py-2"
                style={{
                  borderBottom: isLast ? "none" : "1px solid rgba(255,255,255,0.04)",
                }}
              >
                {/* Icon */}
                <span className="text-sm flex-shrink-0 select-none">{tool.icon}</span>

                {/* Label */}
                <span
                  className="text-xs flex-1"
                  style={{
                    color: isRunning
                      ? "rgba(201,163,64,0.9)"
                      : isDone
                      ? "rgba(255,255,255,0.5)"
                      : "rgba(239,68,68,0.8)",
                  }}
                >
                  {tool.label}
                  {isRunning && (
                    <motion.span
                      animate={{ opacity: [1, 0.3, 1] }}
                      transition={{ duration: 1.5, repeat: Infinity }}
                    >
                      ...
                    </motion.span>
                  )}
                </span>

                {/* Elapsed time */}
                <ElapsedTime startedAt={step.startedAt} running={isRunning} />

                {/* Status icon */}
                <div className="flex-shrink-0 w-4 h-4 flex items-center justify-center">
                  {isRunning && (
                    <Loader2
                      className="w-3.5 h-3.5 animate-spin"
                      style={{ color: "#C9A340" }}
                    />
                  )}
                  {isDone && (
                    <motion.div
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      transition={{ type: "spring", stiffness: 400, damping: 15 }}
                    >
                      <Check className="w-3.5 h-3.5 text-green-400" />
                    </motion.div>
                  )}
                  {isError && (
                    <span className="text-xs text-red-400">!</span>
                  )}
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
