import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, GitBranch, Clock, Loader2, Inbox } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { ProvenanceTree } from "./ProvenanceTree";
import { cn } from "@/lib/utils";

interface ProvenanceChain {
  id: string;
  chainId: string;
  topic: string;
  status: string;
  confidence: number | null;
  createdAt: number;
}

type ViewMode = "tree" | "timeline";

interface ProvenanceViewerProps {
  roomId: number;
  initialChainId?: string;
  onClose: () => void;
}

export function ProvenanceViewer({ roomId, initialChainId, onClose }: ProvenanceViewerProps) {
  const [chains, setChains] = useState<ProvenanceChain[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedChainId, setSelectedChainId] = useState<string | null>(initialChainId || null);
  const [viewMode, setViewMode] = useState<ViewMode>("tree");

  useEffect(() => {
    let cancelled = false;

    async function fetchChains() {
      setLoading(true);
      setError(null);
      try {
        const res = await apiRequest("GET", `/api/rooms/${roomId}/provenance`);
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: "Failed to load provenance" }));
          throw new Error(err.error || "Failed to load provenance");
        }
        const data = await res.json();
        if (!cancelled) {
          const chainList = Array.isArray(data) ? data : data.chains || [];
          setChains(chainList);
          if (!selectedChainId && chainList.length > 0) {
            setSelectedChainId(chainList[0].chainId || chainList[0].id);
          }
        }
      } catch (e: any) {
        if (!cancelled) setError(e.message || "Failed to load provenance");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchChains();
    return () => { cancelled = true; };
  }, [roomId]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3 flex-shrink-0"
        style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}
      >
        <div className="flex items-center gap-2">
          <GitBranch className="w-4 h-4 text-[#C9A340]" />
          <h2 className="text-sm font-semibold text-foreground">Provenance</h2>
          {chains.length > 0 && (
            <span
              className="text-[9px] font-bold min-w-[16px] h-[16px] flex items-center justify-center rounded-full px-1"
              style={{ background: "#C9A340", color: "#0a0f1e" }}
            >
              {chains.length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* View mode toggle */}
          <div
            className="flex rounded-lg overflow-hidden"
            style={{ border: "1px solid rgba(255,255,255,0.08)" }}
          >
            <button
              onClick={() => setViewMode("tree")}
              className={cn(
                "px-2.5 py-1 text-[10px] font-medium transition-colors",
                viewMode === "tree" ? "text-[#C9A340]" : "text-muted-foreground/50"
              )}
              style={{
                background: viewMode === "tree" ? "rgba(201,163,64,0.12)" : "transparent",
              }}
            >
              <GitBranch className="w-3 h-3 inline mr-1" />
              Tree
            </button>
            <button
              onClick={() => setViewMode("timeline")}
              className={cn(
                "px-2.5 py-1 text-[10px] font-medium transition-colors",
                viewMode === "timeline" ? "text-[#C9A340]" : "text-muted-foreground/50"
              )}
              style={{
                background: viewMode === "timeline" ? "rgba(201,163,64,0.12)" : "transparent",
              }}
            >
              <Clock className="w-3 h-3 inline mr-1" />
              Timeline
            </button>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-white/5 transition-colors"
          >
            <X className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-3">
        {/* Loading */}
        {loading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-5 h-5 text-[#C9A340] animate-spin" />
          </div>
        )}

        {/* Error */}
        {error && !loading && (
          <div className="text-center py-8">
            <p className="text-xs text-red-400">{error}</p>
          </div>
        )}

        {/* Empty state */}
        {!loading && !error && chains.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full min-h-[200px] text-muted-foreground/40">
            <Inbox className="w-10 h-10 mb-3 opacity-50" />
            <p className="text-sm font-medium">No deliberation history yet</p>
            <p className="text-xs mt-1 text-center max-w-[200px] leading-relaxed">
              Start a deliberation to see provenance chains here
            </p>
          </div>
        )}

        {/* Chain list / tree */}
        {!loading && !error && chains.length > 0 && (
          <div className="space-y-3">
            {/* Chain selector (if multiple) */}
            {chains.length > 1 && (
              <div className="flex gap-1.5 overflow-x-auto pb-2">
                {chains.map((chain) => {
                  const cId = chain.chainId || chain.id;
                  return (
                    <button
                      key={cId}
                      onClick={() => setSelectedChainId(cId)}
                      className="flex-shrink-0 px-3 py-1.5 rounded-lg text-[11px] font-medium transition-colors"
                      style={{
                        background: selectedChainId === cId
                          ? "rgba(201,163,64,0.12)"
                          : "rgba(255,255,255,0.03)",
                        border: selectedChainId === cId
                          ? "1px solid rgba(201,163,64,0.3)"
                          : "1px solid rgba(255,255,255,0.06)",
                        color: selectedChainId === cId ? "#C9A340" : "rgba(255,255,255,0.5)",
                      }}
                    >
                      {chain.topic?.slice(0, 30) || cId.slice(0, 8)}
                      {chain.topic && chain.topic.length > 30 ? "..." : ""}
                    </button>
                  );
                })}
              </div>
            )}

            {/* Tree or timeline view */}
            {selectedChainId && viewMode === "tree" && (
              <ProvenanceTree chainId={selectedChainId} />
            )}

            {selectedChainId && viewMode === "timeline" && (
              <TimelineView chainId={selectedChainId} chains={chains} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Simple timeline view — chronological list of provenance nodes */
function TimelineView({ chainId, chains }: { chainId: string; chains: ProvenanceChain[] }) {
  const sorted = [...chains].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

  return (
    <div className="relative pl-5 space-y-3">
      {/* Vertical line */}
      <div
        className="absolute left-[7px] top-2 bottom-2 w-[2px] rounded-full"
        style={{ background: "linear-gradient(180deg, rgba(201,163,64,0.3), rgba(201,163,64,0.05))" }}
      />

      {sorted.map((chain) => {
        const cId = chain.chainId || chain.id;
        const dateStr = chain.createdAt
          ? new Date(chain.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
          : "";

        return (
          <motion.div
            key={cId}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            className="relative rounded-xl p-3"
            style={{
              background: cId === chainId ? "rgba(201,163,64,0.06)" : "rgba(255,255,255,0.02)",
              border: cId === chainId
                ? "1px solid rgba(201,163,64,0.25)"
                : "1px solid rgba(255,255,255,0.06)",
            }}
          >
            {/* Dot */}
            <div
              className="absolute -left-[17px] top-4 w-2.5 h-2.5 rounded-full"
              style={{
                background: cId === chainId
                  ? "#C9A340"
                  : "rgba(255,255,255,0.2)",
                boxShadow: cId === chainId ? "0 0 8px rgba(201,163,64,0.4)" : "none",
              }}
            />

            <p className="text-xs font-medium text-foreground truncate">{chain.topic || "Untitled"}</p>
            <div className="flex items-center gap-2 mt-1">
              {chain.confidence !== null && (
                <span
                  className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full"
                  style={{ background: "rgba(201,163,64,0.15)", color: "#C9A340" }}
                >
                  {Math.round(chain.confidence)}%
                </span>
              )}
              <span
                className="text-[9px] px-1.5 py-0.5 rounded-full"
                style={{
                  background: chain.status === "completed"
                    ? "rgba(34,197,94,0.1)"
                    : "rgba(96,165,250,0.1)",
                  color: chain.status === "completed"
                    ? "rgba(34,197,94,0.7)"
                    : "rgba(96,165,250,0.7)",
                }}
              >
                {chain.status}
              </span>
              <span className="text-[9px] text-muted-foreground/40 ml-auto">{dateStr}</span>
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}
