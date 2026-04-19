import React, { useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Layers, Code, Image as ImageIcon, FileText, Inbox, MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import { ArtifactViewer, type Artifact } from "./ArtifactViewer";

type TabKey = "all" | "code" | "images" | "files" | "deliberations";

const TABS: { key: TabKey; label: string; icon: React.ReactNode }[] = [
  { key: "all", label: "All", icon: <Layers className="w-3.5 h-3.5" /> },
  { key: "code", label: "Code", icon: <Code className="w-3.5 h-3.5" /> },
  { key: "images", label: "Images", icon: <ImageIcon className="w-3.5 h-3.5" /> },
  { key: "files", label: "Files", icon: <FileText className="w-3.5 h-3.5" /> },
  { key: "deliberations", label: "Deliberations", icon: <MessageSquare className="w-3.5 h-3.5" /> },
];

interface ActionPanelProps {
  artifacts: Artifact[];
  show: boolean;
  onClose: () => void;
  isMobile: boolean;
  deliberationContent?: React.ReactNode;
  hasActiveDeliberation?: boolean;
}

export function ActionPanel({ artifacts, show, onClose, isMobile, deliberationContent, hasActiveDeliberation }: ActionPanelProps) {
  const [activeTab, setActiveTab] = useState<TabKey>("all");
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);

  // Auto-select latest artifact when a new one appears
  const latestId = artifacts.length > 0 ? artifacts[artifacts.length - 1].id : null;
  React.useEffect(() => {
    if (latestId && artifacts.length > 0) {
      setSelectedIdx(artifacts.length - 1);
    }
  }, [latestId]);

  // Auto-switch to deliberations tab when a deliberation becomes active
  React.useEffect(() => {
    if (hasActiveDeliberation) setActiveTab("deliberations");
  }, [hasActiveDeliberation]);

  const filtered = useMemo(() => {
    if (activeTab === "all" || activeTab === "deliberations") return artifacts;
    return artifacts.filter((a) => a.category === activeTab);
  }, [artifacts, activeTab]);

  const selectedArtifact = selectedIdx !== null ? artifacts[selectedIdx] : null;

  const panelContent = (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3 flex-shrink-0"
        style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}
      >
        <div className="flex items-center gap-2">
          <Layers className="w-4 h-4 text-[#C9A340]" />
          <h2 className="text-sm font-semibold text-foreground">Artifacts</h2>
          {artifacts.length > 0 && (
            <span
              className="text-[9px] font-bold min-w-[16px] h-[16px] flex items-center justify-center rounded-full px-1"
              style={{ background: "#C9A340", color: "#0a0f1e" }}
            >
              {artifacts.length}
            </span>
          )}
        </div>
        {isMobile && (
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-white/5 transition-colors"
          >
            <X className="w-4 h-4 text-muted-foreground" />
          </button>
        )}
      </div>

      {/* Tab bar */}
      <div
        className="flex items-center gap-1 px-3 py-2 flex-shrink-0 overflow-x-auto"
        style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}
      >
        {TABS.map((tab) => {
          const count =
            tab.key === "all"
              ? artifacts.length
              : tab.key === "deliberations"
              ? (hasActiveDeliberation ? 1 : 0)
              : artifacts.filter((a) => a.category === tab.key).length;
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all whitespace-nowrap",
                activeTab === tab.key
                  ? "text-[#C9A340]"
                  : "text-muted-foreground/60 hover:text-foreground/80 hover:bg-white/5"
              )}
              style={
                activeTab === tab.key
                  ? {
                      background: "rgba(201,163,64,0.12)",
                      border: "1px solid rgba(201,163,64,0.25)",
                    }
                  : { border: "1px solid transparent" }
              }
            >
              {tab.icon}
              {tab.label}
              {count > 0 && (
                <span
                  className="text-[9px] font-bold min-w-[14px] h-[14px] flex items-center justify-center rounded-full px-0.5"
                  style={
                    activeTab === tab.key
                      ? { background: "rgba(201,163,64,0.25)", color: "#C9A340" }
                      : { background: "rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.4)" }
                  }
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Content */}
      {activeTab === "deliberations" ? (
        <div className="flex-1 overflow-y-auto">
          {deliberationContent || (
            <div className="flex flex-col items-center justify-center h-full min-h-[200px] text-muted-foreground/40 p-3">
              <MessageSquare className="w-10 h-10 mb-3 opacity-50" />
              <p className="text-sm font-medium">No active deliberation</p>
              <p className="text-xs mt-1 text-center max-w-[200px] leading-relaxed">
                Start a deliberation from the attach menu to see agents debate here
              </p>
            </div>
          )}
        </div>
      ) : (
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full min-h-[200px] text-muted-foreground/40">
            <Inbox className="w-10 h-10 mb-3 opacity-50" />
            <p className="text-sm font-medium">Artifacts will appear here</p>
            <p className="text-xs mt-1 text-center max-w-[200px] leading-relaxed">
              Code blocks, images, and files from AI responses show up automatically
            </p>
          </div>
        ) : (
          filtered.map((artifact, idx) => {
            const realIdx = artifacts.indexOf(artifact);
            return (
              <motion.button
                key={artifact.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: idx * 0.03 }}
                onClick={() => setSelectedIdx(realIdx)}
                className="w-full text-left rounded-xl p-3 transition-all duration-200"
                style={{
                  background:
                    selectedIdx === realIdx
                      ? "rgba(255,255,255,0.06)"
                      : "rgba(255,255,255,0.02)",
                  border:
                    selectedIdx === realIdx
                      ? "1px solid rgba(201,163,64,0.5)"
                      : "1px solid rgba(255,255,255,0.06)",
                  boxShadow:
                    selectedIdx === realIdx
                      ? "0 0 12px rgba(201,163,64,0.1)"
                      : "none",
                }}
              >
                <div className="flex items-center gap-3">
                  <ArtifactViewer artifact={artifact} mode="thumbnail" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-foreground truncate">{artifact.title}</p>
                    <p className="text-[10px] text-muted-foreground/50 capitalize mt-0.5">
                      {artifact.type}
                    </p>
                  </div>
                </div>
              </motion.button>
            );
          })
        )}
      </div>
      )}

      {/* Selected artifact detail */}
      <AnimatePresence>
        {selectedArtifact && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "50%", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: "easeInOut" }}
            className="flex-shrink-0 overflow-hidden"
            style={{
              borderTop: "1px solid rgba(201,163,64,0.15)",
              background: "rgba(5,10,25,0.6)",
            }}
          >
            <div className="h-full overflow-y-auto p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium text-foreground/80 truncate pr-2">
                  {selectedArtifact.title}
                </span>
                <button
                  onClick={() => setSelectedIdx(null)}
                  className="p-1 rounded hover:bg-white/5 text-muted-foreground/40 flex-shrink-0"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
              <ArtifactViewer artifact={selectedArtifact} mode="full" />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );

  // Mobile: overlay/sheet
  if (isMobile) {
    return (
      <AnimatePresence>
        {show && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="fixed inset-0 z-40"
              style={{ background: "rgba(0,0,0,0.6)" }}
              onClick={onClose}
            />
            <motion.div
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              transition={{ type: "tween", duration: 0.3, ease: "easeInOut" }}
              className="fixed bottom-0 left-0 right-0 z-50 rounded-t-2xl overflow-hidden"
              style={{
                height: "85dvh",
                background: "rgba(12,18,38,0.98)",
                backdropFilter: "blur(20px)",
                borderTop: "1px solid rgba(201,163,64,0.2)",
                boxShadow: "0 -12px 40px rgba(0,0,0,0.5)",
              }}
            >
              {/* Drag handle */}
              <div className="flex justify-center py-2">
                <div
                  className="w-10 h-1 rounded-full"
                  style={{ background: "rgba(255,255,255,0.15)" }}
                />
              </div>
              {panelContent}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    );
  }

  // Desktop: inline panel (rendered by parent in split layout)
  return (
    <div
      className="h-full flex flex-col"
      style={{
        background: "rgba(12,18,38,0.6)",
        borderLeft: "1px solid rgba(255,255,255,0.06)",
      }}
    >
      {panelContent}
    </div>
  );
}
