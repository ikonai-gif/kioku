import React, { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Loader2, MessageSquare } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { PhaseIndicator } from "./PhaseIndicator";
import { AgentDebateCard } from "./AgentDebateCard";
import { ConsensusCard } from "./ConsensusCard";

type Phase = "position" | "debate" | "final" | "consensus";

interface AgentPosition {
  agentId: number;
  agentName: string;
  agentColor: string;
  position: string;
  confidence: number;
  reasoning: string;
}

interface DeliberationRound {
  phase: Phase;
  round: number;
  positions: AgentPosition[];
  timestamp: number;
}

interface ConsensusResult {
  decision: string;
  confidence: number;
  method: string;
  votes: Array<{ agentName: string; position: string; confidence: number; changedMind: boolean }>;
  dissent: string[];
}

interface DeliberationSession {
  sessionId: string;
  roomId: number;
  topic: string;
  status: "running" | "completed";
  rounds: DeliberationRound[];
  consensus: ConsensusResult | null;
  startedAt?: number;
  completedAt?: number;
  parentDecisionId?: string;
  provenanceChain?: string;
}

interface DeliberationViewProps {
  roomId: number;
  topic: string;
  onClose: () => void;
  onConsensusReached?: (decision: string, sessionId: string) => void;
  onViewProvenance?: (chainId: string) => void;
}

export function DeliberationView({
  roomId,
  topic,
  onClose,
  onConsensusReached,
  onViewProvenance,
}: DeliberationViewProps) {
  const [session, setSession] = useState<DeliberationSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(true);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionIdRef = useRef<string | null>(null);

  // Track which agents changed confidence between rounds
  const getChangedMinds = useCallback((rounds: DeliberationRound[], agentName: string): boolean => {
    if (rounds.length < 2) return false;
    const last = rounds[rounds.length - 1];
    const prev = rounds[rounds.length - 2];
    const lastPos = last.positions.find((p) => p.agentName === agentName);
    const prevPos = prev.positions.find((p) => p.agentName === agentName);
    if (!lastPos || !prevPos) return false;
    return Math.abs(lastPos.confidence - prevPos.confidence) > 5;
  }, []);

  // Start deliberation
  useEffect(() => {
    let cancelled = false;

    async function startDeliberation() {
      try {
        const res = await apiRequest("POST", `/api/rooms/${roomId}/deliberate`, { topic });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: "Failed to start deliberation" }));
          throw new Error(err.error || "Failed to start deliberation");
        }
        const data: DeliberationSession = await res.json();
        if (cancelled) return;
        sessionIdRef.current = data.sessionId;
        setSession(data);
        setStarting(false);

        // If already completed (fast response)
        if (data.status === "completed") {
          if (data.consensus && onConsensusReached) {
            onConsensusReached(data.consensus.decision, data.sessionId);
          }
          return;
        }

        // Start polling
        pollRef.current = setInterval(async () => {
          try {
            const pollRes = await apiRequest(
              "GET",
              `/api/rooms/${roomId}/deliberations/${sessionIdRef.current}`
            );
            if (!pollRes.ok) return;
            const pollData: DeliberationSession = await pollRes.json();
            setSession(pollData);
            if (pollData.status === "completed") {
              if (pollRef.current) clearInterval(pollRef.current);
              if (pollData.consensus && onConsensusReached) {
                onConsensusReached(pollData.consensus.decision, pollData.sessionId);
              }
            }
          } catch {
            // Silently retry on next interval
          }
        }, 2000);
      } catch (e: any) {
        if (!cancelled) {
          setError(e.message || "Failed to start deliberation");
          setStarting(false);
        }
      }
    }

    startDeliberation();

    return () => {
      cancelled = true;
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [roomId, topic, onConsensusReached]);

  // Determine current phase
  const currentPhase: Phase = session?.consensus
    ? "consensus"
    : session?.rounds?.length
    ? session.rounds[session.rounds.length - 1].phase
    : "position";

  const completedPhases: Phase[] = [];
  if (session?.rounds) {
    const seenPhases = new Set(session.rounds.map((r) => r.phase));
    if (seenPhases.has("position") && currentPhase !== "position") completedPhases.push("position");
    if (seenPhases.has("debate") && currentPhase !== "debate") completedPhases.push("debate");
    if (seenPhases.has("final") && currentPhase !== "final") completedPhases.push("final");
    if (session.consensus) {
      completedPhases.push("position", "debate", "final");
    }
  }
  // Deduplicate
  const uniqueCompleted = [...new Set(completedPhases)] as Phase[];

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3 flex-shrink-0"
        style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <MessageSquare className="w-4 h-4 text-[#C9A340] flex-shrink-0" />
          <h2 className="text-sm font-semibold text-foreground truncate">Deliberation</h2>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 rounded-lg hover:bg-white/5 transition-colors flex-shrink-0"
        >
          <X className="w-4 h-4 text-muted-foreground" />
        </button>
      </div>

      {/* Topic */}
      <div className="px-4 py-2 flex-shrink-0" style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
        <p className="text-[10px] font-medium text-muted-foreground/50 uppercase tracking-wider mb-0.5">Topic</p>
        <p className="text-xs text-foreground/80">{topic}</p>
      </div>

      {/* Phase Indicator */}
      {session && (
        <div className="flex-shrink-0" style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
          <PhaseIndicator currentPhase={currentPhase} completedPhases={uniqueCompleted} />
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
        {/* Loading state */}
        {starting && (
          <div className="flex flex-col items-center justify-center h-full min-h-[160px]">
            <Loader2 className="w-6 h-6 text-[#C9A340] animate-spin mb-3" />
            <p className="text-xs text-muted-foreground/60">Starting deliberation...</p>
          </div>
        )}

        {/* Error state */}
        {error && (
          <div className="flex flex-col items-center justify-center h-full min-h-[160px]">
            <p className="text-xs text-red-400 mb-2">{error}</p>
            <button
              onClick={onClose}
              className="text-xs text-[#C9A340] underline"
            >
              Close
            </button>
          </div>
        )}

        {/* Running indicator */}
        {session && session.status === "running" && !starting && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg" style={{ background: "rgba(201,163,64,0.06)" }}>
            <Loader2 className="w-3 h-3 text-[#C9A340] animate-spin" />
            <span className="text-[11px] text-[#C9A340]/70">Agents deliberating...</span>
          </div>
        )}

        {/* Rounds / agent positions */}
        <AnimatePresence>
          {session?.rounds?.map((round, roundIdx) => (
            <div key={`${round.phase}-${round.round}`} className="space-y-2">
              {/* Round header */}
              <div className="flex items-center gap-2 mt-1">
                <div
                  className="h-[1px] flex-1"
                  style={{ background: "rgba(255,255,255,0.06)" }}
                />
                <span className="text-[9px] font-medium text-muted-foreground/40 uppercase tracking-wider">
                  {round.phase} — Round {round.round}
                </span>
                <div
                  className="h-[1px] flex-1"
                  style={{ background: "rgba(255,255,255,0.06)" }}
                />
              </div>

              {round.positions.map((pos, posIdx) => (
                <AgentDebateCard
                  key={`${pos.agentId}-${round.phase}-${round.round}`}
                  agentName={pos.agentName}
                  agentColor={pos.agentColor}
                  position={pos.position}
                  confidence={pos.confidence}
                  reasoning={pos.reasoning}
                  changedMind={roundIdx > 0 && getChangedMinds(session.rounds.slice(0, roundIdx + 1), pos.agentName)}
                  index={posIdx}
                />
              ))}
            </div>
          ))}
        </AnimatePresence>

        {/* Consensus */}
        {session?.consensus && (
          <div className="mt-3">
            <ConsensusCard
              decision={session.consensus.decision}
              confidence={session.consensus.confidence}
              method={session.consensus.method}
              votes={session.consensus.votes}
              dissent={session.consensus.dissent}
              onViewProvenance={
                onViewProvenance && session.provenanceChain
                  ? () => onViewProvenance(session.provenanceChain!)
                  : undefined
              }
            />
          </div>
        )}
      </div>
    </div>
  );
}
