import React from "react";
import { motion } from "framer-motion";

interface CapabilityCard {
  icon: string;
  title: string;
  prompt: string;
}

const CARDS: CapabilityCard[] = [
  { icon: "📧", title: "Check Email", prompt: "Check my recent emails and summarize important ones" },
  { icon: "📅", title: "Today's Schedule", prompt: "What's on my calendar today? Any conflicts?" },
  { icon: "🔍", title: "Web Search", prompt: "Search the web for the latest news about..." },
  { icon: "💻", title: "Run Code", prompt: "Write and execute a Python script that..." },
  { icon: "🧠", title: "Remember This", prompt: "Remember that I prefer..." },
  { icon: "🤝", title: "Team Discussion", prompt: "Start a deliberation about..." },
  { icon: "📊", title: "Analyze Data", prompt: "Analyze this data and create a visualization..." },
  { icon: "📁", title: "My Files", prompt: "Show me my recent files and downloads" },
];

interface CapabilityCardsProps {
  onSelectPrompt: (prompt: string) => void;
}

export function CapabilityCards({ onSelectPrompt }: CapabilityCardsProps) {
  return (
    <div className="w-full max-w-lg mx-auto px-4 py-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {CARDS.map((card, idx) => (
          <motion.button
            key={card.title}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: idx * 0.06, ease: "easeOut" }}
            onClick={() => onSelectPrompt(card.prompt)}
            className="group relative flex flex-col items-center gap-2 px-3 py-4 rounded-2xl text-center transition-colors cursor-pointer"
            style={{
              background: "rgba(255,255,255,0.04)",
              border: "1px solid rgba(255,255,255,0.08)",
              backdropFilter: "blur(12px)",
            }}
            whileHover={{
              borderColor: "rgba(201,163,64,0.5)",
              boxShadow: "0 0 20px rgba(201,163,64,0.12), inset 0 0 20px rgba(201,163,64,0.04)",
            }}
            whileTap={{ scale: 0.97 }}
          >
            {/* Gold glow corners on hover */}
            <div
              className="pointer-events-none absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-300"
              style={{
                background:
                  "radial-gradient(circle at 0% 0%, rgba(201,163,64,0.15) 0%, transparent 40%), " +
                  "radial-gradient(circle at 100% 0%, rgba(201,163,64,0.15) 0%, transparent 40%), " +
                  "radial-gradient(circle at 0% 100%, rgba(201,163,64,0.15) 0%, transparent 40%), " +
                  "radial-gradient(circle at 100% 100%, rgba(201,163,64,0.15) 0%, transparent 40%)",
              }}
            />
            <span className="text-2xl select-none">{card.icon}</span>
            <span className="text-xs font-medium text-foreground/80 leading-tight">
              {card.title}
            </span>
          </motion.button>
        ))}
      </div>
    </div>
  );
}
