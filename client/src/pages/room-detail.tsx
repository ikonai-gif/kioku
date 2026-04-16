import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Send, CheckCircle2, Star, Bot, Wifi, WifiOff, Zap, ChevronDown, ChevronRight, Loader2, Trophy, MessageSquare, ThumbsUp, ThumbsDown, Minus, Clock, History, AlertTriangle, User, Timer } from "lucide-react";
import { AgentAvatar, getAgentIcon } from "@/lib/agent-icon";
import { Link } from "wouter";
import { cn, safeParseIds } from "@/lib/utils";
import { useAuth } from "../App";

const FLOW_COLORS = [
  "#D4AF37", "#3B82F6", "#A855F7", "#10B981",
  "#F97316", "#EF4444", "#06B6D4", "#EC4899",
];

// ── Deliberation Phase Parsing ──────────────────────────────────
type DelibPhase = "idle" | "starting" | "position" | "debate" | "final" | "consensus" | "completed" | "failed";

interface ParsedDelibMessage {
  phase: "position" | "debate" | "final" | "consensus" | "system";
  agentName: string;
  agentColor: string;
  agentId: number | null;
  position: string;
  confidence: number;
  modelTag: string;
  isSystem: boolean;
  isConsensus: boolean;
  isHuman: boolean;
  rawContent: string;
  id: number;
  createdAt: string;
}

function parseDelibMessage(msg: any): ParsedDelibMessage | null {
  const content: string = msg.content || "";

  // System messages from KIOKU
  if (msg.agentName === "KIOKU\u2122 System" || msg.agentName === "KIOKU™ System") {
    let phase: ParsedDelibMessage["phase"] = "system";
    if (content.includes("Phase 1")) phase = "position";
    else if (content.includes("Debate Round")) phase = "debate";
    else if (content.includes("Final Positions")) phase = "final";
    else if (content.includes("complete")) phase = "consensus";

    return {
      phase,
      agentName: msg.agentName,
      agentColor: msg.agentColor || "#888",
      agentId: null,
      position: content,
      confidence: 0,
      modelTag: "",
      isSystem: true,
      isConsensus: false,
      isHuman: false,
      rawContent: content,
      id: msg.id,
      createdAt: msg.createdAt,
    };
  }

  // Consensus message
  if (msg.agentName === "KIOKU\u2122 Consensus" || msg.agentName === "KIOKU™ Consensus") {
    const confMatch = content.match(/confidence:\s*(\d+)%/);
    return {
      phase: "consensus",
      agentName: "Consensus",
      agentColor: "#FFD700",
      agentId: null,
      position: content.replace(/\[CONSENSUS\]\s*/, "").replace(/\(confidence:.*\)/, "").trim(),
      confidence: confMatch ? parseInt(confMatch[1]) / 100 : 0,
      modelTag: "",
      isSystem: false,
      isConsensus: true,
      isHuman: false,
      rawContent: content,
      id: msg.id,
      createdAt: msg.createdAt,
    };
  }

  // Agent deliberation messages — contain phase markers like [📍 Phase 1 — Initial Positions]
  const phaseMatch = content.match(/\[(📍 Phase 1|💬 Debate Round|🎯 Final)/);
  if (!phaseMatch) return null;

  let phase: ParsedDelibMessage["phase"] = "position";
  if (content.includes("💬 Debate")) phase = "debate";
  else if (content.includes("🎯 Final")) phase = "final";

  const modelMatch = content.match(/\[([^\]]+)\]\s*\[([^\]]+)\]/);
  const modelTag = modelMatch ? modelMatch[2] : "";

  // Extract position text and confidence
  const confMatch = content.match(/\(confidence:\s*(\d+)%\)/);
  const confidence = confMatch ? parseInt(confMatch[1]) / 100 : 0.5;

  // Strip phase label and model tag to get the position
  const position = content
    .replace(/\[.*?\]\s*/g, "")
    .replace(/\(confidence:\s*\d+%\)/, "")
    .trim();

  const isHuman = content.includes("[Human]") || (msg.agentId === null && !msg.agentName?.includes("KIOKU"));

  return {
    phase,
    agentName: msg.agentName,
    agentColor: msg.agentColor || "#888",
    agentId: msg.agentId,
    position,
    confidence,
    modelTag,
    isSystem: false,
    isConsensus: false,
    isHuman,
    rawContent: content,
    id: msg.id,
    createdAt: msg.createdAt,
  };
}

// ── Confidence Bar ──────────────────────────────────────────────
function ConfidenceBar({ value, size = "sm" }: { value: number; size?: "sm" | "md" }) {
  const pct = Math.round(value * 100);
  const color = pct >= 70 ? "#10B981" : pct >= 40 ? "#D4AF37" : "#EF4444";
  return (
    <div className="flex items-center gap-2">
      <div className={cn("rounded-full bg-white/5 overflow-hidden", size === "md" ? "h-2 flex-1" : "h-1.5 w-16")}>
        <div
          className="h-full rounded-full transition-all duration-700 ease-out"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
      <span className={cn("font-mono font-semibold", size === "md" ? "text-xs" : "text-[10px]")} style={{ color }}>
        {pct}%
      </span>
    </div>
  );
}

// ── Phase Section Header ────────────────────────────────────────
function PhaseHeader({ label, active, completed }: { label: string; active: boolean; completed: boolean }) {
  return (
    <div className={cn(
      "flex items-center gap-2 px-3 py-2 rounded-lg border transition-all duration-300",
      active
        ? "border-[#D4AF37]/40 bg-[#D4AF37]/5"
        : completed
          ? "border-border/50 bg-background/30"
          : "border-border/20 bg-background/10 opacity-50"
    )}>
      <div className={cn(
        "w-2 h-2 rounded-full flex-shrink-0",
        active ? "bg-[#D4AF37] animate-pulse" : completed ? "bg-emerald-400" : "bg-muted-foreground/30"
      )} />
      <span className={cn(
        "text-xs font-semibold",
        active ? "text-[#D4AF37]" : completed ? "text-emerald-400/80" : "text-muted-foreground/40"
      )}>
        {label}
      </span>
      {completed && <CheckCircle2 className="w-3 h-3 text-emerald-400/60 ml-auto" />}
      {active && <Loader2 className="w-3 h-3 text-[#D4AF37] animate-spin ml-auto" />}
    </div>
  );
}

// ── Agent Response Card ─────────────────────────────────────────
function AgentResponseCard({ item, animate }: { item: ParsedDelibMessage; animate: boolean }) {
  const isError = item.position.startsWith("[error:");
  return (
    <div className={cn(
      "rounded-xl border p-3 transition-all duration-500",
      animate ? "animate-in slide-in-from-bottom-2 fade-in" : "",
      isError
        ? "border-red-400/30 bg-red-400/[0.03]"
        : item.isHuman
        ? "border-[#D4AF37]/40 bg-[#D4AF37]/[0.03] hover:border-[#D4AF37]/60"
        : "border-border/40 bg-card/30 hover:border-border/60"
    )}>
      <div className="flex items-start gap-3">
        {item.isHuman ? (
          <div className="w-6 h-6 rounded-full bg-[#D4AF37]/20 border border-[#D4AF37]/40 flex items-center justify-center mt-0.5 flex-shrink-0">
            <User className="w-3 h-3 text-[#D4AF37]" />
          </div>
        ) : (
          <AgentAvatar name={item.agentName} color={isError ? "#EF4444" : item.agentColor} size="sm" className="mt-0.5" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className="text-xs font-semibold" style={{ color: isError ? "#EF4444" : item.agentColor }}>
              {item.agentName}
            </span>
            {isError && (
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-red-400/10 text-red-400 font-medium border border-red-400/20">
                Error
              </span>
            )}
            {item.isHuman && (
              <span className="text-[9px] px-2 py-0.5 rounded-full bg-[#D4AF37]/15 text-[#D4AF37] font-bold uppercase tracking-wider border border-[#D4AF37]/30">
                Human
              </span>
            )}
            {item.modelTag && !item.isHuman && (
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-white/5 text-muted-foreground/50 font-mono">
                {item.modelTag}
              </span>
            )}
          </div>
          <p className={cn("text-sm leading-relaxed mb-2", isError ? "text-red-400/80" : "text-foreground/90")}>{item.position}</p>
          {!isError && <ConfidenceBar value={item.confidence} />}
        </div>
      </div>
    </div>
  );
}

// ── Consensus Card ──────────────────────────────────────────────
function ConsensusCard({ item }: { item: ParsedDelibMessage }) {
  return (
    <div className="rounded-xl border-2 border-[#D4AF37]/40 bg-gradient-to-br from-[#D4AF37]/5 to-transparent p-4 space-y-3 animate-in slide-in-from-bottom-3 fade-in duration-700"
      style={{ boxShadow: "0 0 20px rgba(212,175,55,0.08)" }}>
      <div className="flex items-center gap-2">
        <Trophy className="w-4 h-4 text-[#D4AF37]" />
        <span className="text-sm font-bold text-[#D4AF37]">Consensus Reached</span>
      </div>
      <p className="text-sm text-foreground leading-relaxed">{item.position}</p>
      <ConfidenceBar value={item.confidence} size="md" />
    </div>
  );
}

// ── Vote Classification Helper ─────────────────────────────────
// Classifies a vote as agree/disagree/abstain relative to the winning decision
type VoteType = "agree" | "disagree" | "abstain";

interface ClassifiedVote {
  agentName: string;
  position: string;
  confidence: number;
  changedMind: boolean;
  voteType: VoteType;
}

function classifyVotes(
  votes: Array<{ agentName: string; position: string; confidence: number; changedMind: boolean }>,
  winningDecision: string
): ClassifiedVote[] {
  return votes.map((v) => {
    let voteType: VoteType;
    if (v.confidence < 0.15) {
      voteType = "abstain";
    } else {
      // Compare position similarity to winning decision
      const normPos = v.position.toLowerCase().trim();
      const normDecision = winningDecision.toLowerCase().trim();
      // If positions substantially overlap or match, it's an agree
      const isAgree = normPos === normDecision ||
        normPos.includes(normDecision.slice(0, Math.min(40, normDecision.length))) ||
        normDecision.includes(normPos.slice(0, Math.min(40, normPos.length)));
      voteType = isAgree ? "agree" : "disagree";
    }
    return { ...v, voteType };
  });
}

const VOTE_COLORS: Record<VoteType, string> = {
  agree: "#10B981",
  disagree: "#EF4444",
  abstain: "#6B7280",
};

const VOTE_LABELS: Record<VoteType, string> = {
  agree: "AGREE",
  disagree: "DISAGREE",
  abstain: "ABSTAIN",
};

const VOTE_ICONS: Record<VoteType, typeof ThumbsUp> = {
  agree: ThumbsUp,
  disagree: ThumbsDown,
  abstain: Minus,
};

// ── Vote Tally Bar ─────────────────────────────────────────────
function VoteTallyBar({ votes }: { votes: ClassifiedVote[] }) {
  const total = votes.length;
  if (total === 0) return null;

  const agreeCount = votes.filter((v) => v.voteType === "agree").length;
  const disagreeCount = votes.filter((v) => v.voteType === "disagree").length;
  const abstainCount = votes.filter((v) => v.voteType === "abstain").length;

  const agreePct = (agreeCount / total) * 100;
  const disagreePct = (disagreeCount / total) * 100;
  const abstainPct = (abstainCount / total) * 100;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
        <span>Vote Distribution</span>
        <span>{total} total votes</span>
      </div>
      {/* Bar */}
      <div className="h-3 rounded-full overflow-hidden flex bg-white/5">
        {agreePct > 0 && (
          <div
            className="h-full transition-all duration-700 ease-out"
            style={{ width: `${agreePct}%`, background: VOTE_COLORS.agree }}
            title={`Agree: ${agreeCount} (${Math.round(agreePct)}%)`}
          />
        )}
        {disagreePct > 0 && (
          <div
            className="h-full transition-all duration-700 ease-out"
            style={{ width: `${disagreePct}%`, background: VOTE_COLORS.disagree }}
            title={`Disagree: ${disagreeCount} (${Math.round(disagreePct)}%)`}
          />
        )}
        {abstainPct > 0 && (
          <div
            className="h-full transition-all duration-700 ease-out"
            style={{ width: `${abstainPct}%`, background: VOTE_COLORS.abstain }}
            title={`Abstain: ${abstainCount} (${Math.round(abstainPct)}%)`}
          />
        )}
      </div>
      {/* Legend */}
      <div className="flex items-center gap-4 flex-wrap">
        {agreeCount > 0 && (
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full" style={{ background: VOTE_COLORS.agree }} />
            <span className="text-[10px] text-muted-foreground">
              Agree <span className="font-semibold text-foreground/80">{agreeCount}</span>
            </span>
          </div>
        )}
        {disagreeCount > 0 && (
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full" style={{ background: VOTE_COLORS.disagree }} />
            <span className="text-[10px] text-muted-foreground">
              Disagree <span className="font-semibold text-foreground/80">{disagreeCount}</span>
            </span>
          </div>
        )}
        {abstainCount > 0 && (
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full" style={{ background: VOTE_COLORS.abstain }} />
            <span className="text-[10px] text-muted-foreground">
              Abstain <span className="font-semibold text-foreground/80">{abstainCount}</span>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Agent Vote Card (with expandable reasoning) ────────────────
function AgentVoteCard({ vote, agentColor }: { vote: ClassifiedVote; agentColor?: string }) {
  const [expanded, setExpanded] = useState(false);
  const Icon = VOTE_ICONS[vote.voteType];
  const color = agentColor || "#888";
  const pct = Math.round(vote.confidence * 100);

  return (
    <div className="rounded-xl border border-border/40 bg-card/30 overflow-hidden transition-all duration-300 hover:border-border/60">
      <button
        className="w-full px-3 py-3 flex items-start gap-3 text-left"
        onClick={() => setExpanded(!expanded)}
      >
        <AgentAvatar name={vote.agentName} color={color} size="sm" className="mt-0.5 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className="text-xs font-semibold" style={{ color }}>
              {vote.agentName}
            </span>
            {/* Vote badge */}
            <span
              className="text-[9px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider flex items-center gap-1"
              style={{
                background: VOTE_COLORS[vote.voteType] + "18",
                color: VOTE_COLORS[vote.voteType],
                border: `1px solid ${VOTE_COLORS[vote.voteType]}33`,
              }}
            >
              <Icon className="w-2.5 h-2.5" />
              {VOTE_LABELS[vote.voteType]}
            </span>
            {vote.changedMind && (
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-yellow-400/10 text-yellow-400 font-medium">
                Changed mind
              </span>
            )}
          </div>
          {/* Confidence */}
          <div className="flex items-center gap-2 mt-1">
            <div className="h-1.5 flex-1 max-w-[120px] rounded-full bg-white/5 overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-700 ease-out"
                style={{
                  width: `${pct}%`,
                  background: pct >= 70 ? "#10B981" : pct >= 40 ? "#D4AF37" : "#EF4444",
                }}
              />
            </div>
            <span
              className="text-[10px] font-mono font-semibold"
              style={{ color: pct >= 70 ? "#10B981" : pct >= 40 ? "#D4AF37" : "#EF4444" }}
            >
              {pct}%
            </span>
          </div>
        </div>
        <ChevronRight
          className={cn(
            "w-3.5 h-3.5 text-muted-foreground/40 flex-shrink-0 mt-1 transition-transform duration-200",
            expanded && "rotate-90"
          )}
        />
      </button>
      {/* Expandable reasoning */}
      {expanded && (
        <div className="px-3 pb-3 pt-0 animate-in slide-in-from-top-1 fade-in duration-200">
          <div className="ml-9 pl-3 border-l-2 border-border/30">
            <p className="text-xs text-muted-foreground leading-relaxed">{vote.position}</p>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Confidence Gauge (large radial) ────────────────────────────
function ConfidenceGauge({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const radius = 40;
  const circumference = 2 * Math.PI * radius;
  const progress = (pct / 100) * circumference;
  const color = pct >= 70 ? "#10B981" : pct >= 40 ? "#D4AF37" : "#EF4444";

  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative w-24 h-24">
        <svg className="w-24 h-24 -rotate-90" viewBox="0 0 100 100">
          <circle cx="50" cy="50" r={radius} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="6" />
          <circle
            cx="50" cy="50" r={radius} fill="none"
            stroke={color} strokeWidth="6"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference - progress}
            className="transition-all duration-1000 ease-out"
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-xl font-bold font-mono" style={{ color }}>{pct}%</span>
        </div>
      </div>
      <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium">
        Consensus Confidence
      </span>
    </div>
  );
}

// ── Enhanced Consensus Panel ───────────────────────────────────
function EnhancedConsensusPanel({
  consensus,
  agentColors,
}: {
  consensus: {
    decision: string;
    confidence: number;
    method: string;
    votes: Array<{ agentName: string; position: string; confidence: number; changedMind: boolean }>;
    dissent: string[];
  };
  agentColors: Record<string, string>;
}) {
  const classifiedVotes = classifyVotes(consensus.votes, consensus.decision);

  return (
    <div
      className="rounded-2xl border-2 border-[#D4AF37]/30 p-4 md:p-5 space-y-5 animate-in slide-in-from-bottom-3 fade-in duration-700"
      style={{
        background: "linear-gradient(135deg, rgba(212,175,55,0.04) 0%, rgba(15,23,42,0.6) 50%, rgba(212,175,55,0.02) 100%)",
        boxShadow: "0 0 30px rgba(212,175,55,0.06), inset 0 1px 0 rgba(212,175,55,0.1)",
      }}
    >
      {/* Header */}
      <div className="flex items-center gap-2">
        <Trophy className="w-5 h-5 text-[#D4AF37]" />
        <span className="text-sm font-bold text-[#D4AF37]">Consensus Reached</span>
        <span className="ml-auto text-[9px] px-2 py-0.5 rounded-full bg-[#D4AF37]/10 text-[#D4AF37] font-medium uppercase tracking-wider">
          {consensus.method.replace("_", " ")}
        </span>
      </div>

      {/* Decision + Gauge row */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
        <div className="flex-1">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5 font-medium">
            Overall Decision
          </p>
          <p className="text-sm text-foreground leading-relaxed font-medium">{consensus.decision}</p>
        </div>
        <ConfidenceGauge value={consensus.confidence} />
      </div>

      {/* Vote Tally Bar */}
      <VoteTallyBar votes={classifiedVotes} />

      {/* Agent Vote Cards */}
      <div className="space-y-2">
        <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium">
          Individual Votes ({consensus.votes.length})
        </p>
        {classifiedVotes.map((vote) => (
          <AgentVoteCard
            key={vote.agentName}
            vote={vote}
            agentColor={agentColors[vote.agentName]}
          />
        ))}
      </div>

      {/* Dissenting Opinions */}
      {consensus.dissent.length > 0 && (
        <div
          className="rounded-xl border border-red-400/20 bg-red-400/5 p-3 space-y-2"
          style={{ boxShadow: "0 0 12px rgba(239,68,68,0.04)" }}
        >
          <div className="flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 text-red-400/80" />
            <span className="text-[10px] font-semibold text-red-400/90 uppercase tracking-wider">
              Dissenting Opinions
            </span>
          </div>
          {consensus.dissent.map((d, i) => (
            <p key={i} className="text-xs text-red-300/70 leading-relaxed pl-5">
              {d}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Deliberation History Item ──────────────────────────────────
function DelibHistoryItem({
  session,
  onSelect,
  isSelected,
}: {
  session: any;
  onSelect: () => void;
  isSelected: boolean;
}) {
  const status = session.status as string;
  const hasConsensus = !!session.consensus;
  const confidence = hasConsensus ? Math.round(session.consensus.confidence * 100) : 0;

  return (
    <button
      className={cn(
        "w-full text-left rounded-xl border p-3 transition-all duration-200",
        isSelected
          ? "border-[#D4AF37]/40 bg-[#D4AF37]/5"
          : "border-border/30 bg-card/20 hover:border-border/50 hover:bg-card/40"
      )}
      onClick={onSelect}
    >
      <div className="flex items-start gap-3">
        <div className={cn(
          "w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0",
          status === "completed" ? "bg-emerald-400/10" : status === "failed" ? "bg-red-400/10" : "bg-[#D4AF37]/10"
        )}>
          {status === "completed" ? (
            <Trophy className="w-3.5 h-3.5 text-emerald-400" />
          ) : status === "failed" ? (
            <AlertTriangle className="w-3.5 h-3.5 text-red-400" />
          ) : (
            <Loader2 className="w-3.5 h-3.5 text-[#D4AF37] animate-spin" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-foreground truncate">{session.topic}</p>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <span className="text-[10px] text-muted-foreground flex items-center gap-1">
              <Clock className="w-2.5 h-2.5" />
              {new Date(session.startedAt).toLocaleDateString(undefined, {
                month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
              })}
            </span>
            {hasConsensus && (
              <span
                className="text-[10px] font-mono font-semibold"
                style={{ color: confidence >= 70 ? "#10B981" : confidence >= 40 ? "#D4AF37" : "#EF4444" }}
              >
                {confidence}%
              </span>
            )}
            <span className={cn(
              "text-[9px] px-1.5 py-0.5 rounded font-medium",
              status === "completed" ? "bg-emerald-400/10 text-emerald-400" :
              status === "failed" ? "bg-red-400/10 text-red-400" :
              "bg-[#D4AF37]/10 text-[#D4AF37]"
            )}>
              {status}
            </span>
          </div>
        </div>
        <ChevronRight className={cn(
          "w-3.5 h-3.5 text-muted-foreground/30 flex-shrink-0 mt-1 transition-transform duration-200",
          isSelected && "rotate-90"
        )} />
      </div>
    </button>
  );
}

// ── Deliberation History List ──────────────────────────────────
function DeliberationHistoryList({
  roomId,
  agentColors,
}: {
  roomId: number;
  agentColors: Record<string, string>;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data: sessions = [], isLoading } = useQuery<any[]>({
    queryKey: ["/api/rooms", roomId, "deliberations"],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/rooms/${roomId}/deliberations`);
      if (!r.ok) return [];
      return r.json();
    },
  });

  // Sort by most recent first
  const sorted = useMemo(
    () => [...sessions].sort((a: any, b: any) => (b.startedAt || 0) - (a.startedAt || 0)),
    [sessions]
  );

  const selectedSession = sorted.find((s: any) => s.sessionId === selectedId);

  if (isLoading) {
    return (
      <div className="space-y-2">
        {[1, 2].map((i) => (
          <div key={i} className="h-16 rounded-xl bg-card/20 animate-pulse border border-border/20" />
        ))}
      </div>
    );
  }

  if (sorted.length === 0) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <History className="w-3.5 h-3.5 text-muted-foreground/60" />
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          Deliberation History
        </span>
        <span className="text-[10px] text-muted-foreground/40">{sorted.length} sessions</span>
        <div className="flex-1 h-px bg-border/30" />
      </div>

      <div className="space-y-2">
        {sorted.map((session: any) => (
          <div key={session.sessionId}>
            <DelibHistoryItem
              session={session}
              onSelect={() => setSelectedId(selectedId === session.sessionId ? null : session.sessionId)}
              isSelected={selectedId === session.sessionId}
            />
            {/* Expanded session detail */}
            {selectedId === session.sessionId && selectedSession?.consensus && (
              <div className="mt-2 ml-4 animate-in slide-in-from-top-1 fade-in duration-200">
                <EnhancedConsensusPanel
                  consensus={selectedSession.consensus}
                  agentColors={agentColors}
                />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Circular Countdown Timer ──────────────────────────────────
function CircularTimer({ secondsLeft, totalSeconds }: { secondsLeft: number; totalSeconds: number }) {
  const radius = 20;
  const circumference = 2 * Math.PI * radius;
  const progress = (secondsLeft / totalSeconds) * circumference;
  const color = secondsLeft > 20 ? "#D4AF37" : secondsLeft > 10 ? "#F97316" : "#EF4444";

  return (
    <div className="relative w-12 h-12 flex-shrink-0">
      <svg className="w-12 h-12 -rotate-90" viewBox="0 0 50 50">
        <circle cx="25" cy="25" r={radius} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="3" />
        <circle
          cx="25" cy="25" r={radius} fill="none"
          stroke={color} strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference - progress}
          className="transition-all duration-1000 linear"
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="text-xs font-bold font-mono" style={{ color }}>{secondsLeft}s</span>
      </div>
    </div>
  );
}

// ── Human Input Card ─────────────────────────────────────────
function HumanInputCard({
  sessionId,
  roomId,
  phase,
  round,
  topic,
  priorPositions,
  timeoutMs,
  onSubmitted,
  onSkipped,
}: {
  sessionId: string;
  roomId: number;
  phase: string;
  round: number;
  topic: string;
  priorPositions: Array<{ agentName: string; position: string; confidence: number; reasoning: string }>;
  timeoutMs: number;
  onSubmitted: () => void;
  onSkipped: () => void;
}) {
  const [position, setPosition] = useState("");
  const [confidence, setConfidence] = useState(0.7);
  const [reasoning, setReasoning] = useState("");
  const [secondsLeft, setSecondsLeft] = useState(Math.floor(timeoutMs / 1000));
  const [submitting, setSubmitting] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef(Date.now());

  useEffect(() => {
    startTimeRef.current = Date.now();
    timerRef.current = setInterval(() => {
      const elapsed = Date.now() - startTimeRef.current;
      const remaining = Math.max(0, Math.ceil((timeoutMs - elapsed) / 1000));
      setSecondsLeft(remaining);
      if (remaining <= 0) {
        if (timerRef.current) clearInterval(timerRef.current);
        onSkipped();
      }
    }, 1000);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [timeoutMs, onSkipped]);

  async function handleSubmit() {
    if (!position.trim() || submitting) return;
    setSubmitting(true);
    try {
      const r = await apiRequest("POST", `/api/rooms/${roomId}/deliberations/${sessionId}/human-input`, {
        phase,
        round,
        position: position.trim(),
        confidence,
        reasoning: reasoning.trim() || undefined,
      });
      if (r.ok) {
        onSubmitted();
      }
    } catch {
      // ignore — will timeout naturally
    }
    setSubmitting(false);
  }

  function handleSkip() {
    if (timerRef.current) clearInterval(timerRef.current);
    onSkipped();
  }

  const phaseLabel = phase === "position" ? "Initial Position" : phase === "debate" ? `Debate Round ${round}` : "Final Position";
  const confPct = Math.round(confidence * 100);
  const totalSeconds = Math.floor(timeoutMs / 1000);

  return (
    <div
      className="rounded-2xl border-2 p-4 space-y-4 animate-in slide-in-from-bottom-3 fade-in duration-500"
      style={{
        borderColor: "#D4AF37",
        background: "linear-gradient(135deg, rgba(212,175,55,0.06) 0%, rgba(15,23,42,0.8) 50%, rgba(212,175,55,0.03) 100%)",
        boxShadow: "0 0 30px rgba(212,175,55,0.12), inset 0 1px 0 rgba(212,175,55,0.15)",
        animation: "pulse-gold 2s ease-in-out infinite",
      }}
    >
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded-full bg-[#D4AF37]/20 border border-[#D4AF37]/40 flex items-center justify-center">
          <User className="w-4 h-4 text-[#D4AF37]" />
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-[#D4AF37]">Your Turn</span>
            <span className="text-[9px] px-2 py-0.5 rounded-full bg-[#D4AF37]/15 text-[#D4AF37] font-semibold uppercase tracking-wider border border-[#D4AF37]/30">
              Human
            </span>
          </div>
          <span className="text-[10px] text-muted-foreground">{phaseLabel}</span>
        </div>
        <CircularTimer secondsLeft={secondsLeft} totalSeconds={totalSeconds} />
      </div>

      {/* Prior positions summary (collapsed) */}
      {priorPositions.length > 0 && (
        <div className="rounded-lg bg-white/[0.02] border border-border/30 p-3 space-y-1.5">
          <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">
            Other positions ({priorPositions.length})
          </span>
          {priorPositions.slice(0, 4).map((p, i) => (
            <div key={i} className="flex items-start gap-2">
              <span className="text-[10px] font-semibold text-foreground/70 flex-shrink-0">{p.agentName}:</span>
              <span className="text-[10px] text-muted-foreground leading-relaxed line-clamp-1">{p.position}</span>
            </div>
          ))}
          {priorPositions.length > 4 && (
            <span className="text-[9px] text-muted-foreground/50">+{priorPositions.length - 4} more</span>
          )}
        </div>
      )}

      {/* Position textarea */}
      <div>
        <label className="text-[11px] text-muted-foreground font-medium mb-1.5 block">Your Position</label>
        <textarea
          className="w-full bg-muted/30 border border-[#D4AF37]/30 rounded-lg px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/40 outline-none focus:border-[#D4AF37]/60 transition-colors resize-none"
          rows={3}
          placeholder="State your position on the topic..."
          value={position}
          onChange={e => setPosition(e.target.value)}
          disabled={submitting}
          autoFocus
        />
      </div>

      {/* Confidence slider */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="text-[11px] text-muted-foreground font-medium">Confidence</label>
          <span
            className="text-xs font-mono font-bold"
            style={{ color: confPct >= 70 ? "#10B981" : confPct >= 40 ? "#D4AF37" : "#EF4444" }}
          >
            {confPct}%
          </span>
        </div>
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={confidence}
          onChange={e => setConfidence(parseFloat(e.target.value))}
          disabled={submitting}
          className="w-full h-2 rounded-full appearance-none cursor-pointer"
          style={{
            background: `linear-gradient(to right, #D4AF37 0%, #D4AF37 ${confPct}%, rgba(255,255,255,0.05) ${confPct}%, rgba(255,255,255,0.05) 100%)`,
          }}
        />
      </div>

      {/* Reasoning (optional) */}
      <div>
        <label className="text-[11px] text-muted-foreground font-medium mb-1.5 block">Reasoning (optional)</label>
        <textarea
          className="w-full bg-muted/30 border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/40 outline-none focus:border-[#D4AF37]/40 transition-colors resize-none"
          rows={2}
          placeholder="Explain your reasoning..."
          value={reasoning}
          onChange={e => setReasoning(e.target.value)}
          disabled={submitting}
        />
      </div>

      {/* Actions */}
      <div className="flex items-center gap-3">
        <Button
          className="flex-1 font-semibold"
          style={{
            background: "linear-gradient(135deg, #D4AF37, #B8960C)",
            color: "hsl(222 47% 8%)",
          }}
          onClick={handleSubmit}
          disabled={!position.trim() || submitting}
        >
          {submitting ? (
            <>
              <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
              Submitting...
            </>
          ) : (
            <>
              <Send className="w-3.5 h-3.5 mr-1.5" />
              Submit Position
            </>
          )}
        </Button>
        <button
          className="text-xs text-muted-foreground hover:text-foreground transition-colors px-3 py-2"
          onClick={handleSkip}
          disabled={submitting}
        >
          Skip Round
        </button>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═════════════════════════════════════════════════════════════════

export default function RoomDetailPage({ params }: { params: { id: string } }) {
  const roomId = Number(params.id);
  const { toast } = useToast();
  const [speakingAs, setSpeakingAs] = useState<any | null>(null);
  const [input, setInput] = useState("");
  const [isDecision, setIsDecision] = useState(false);
  const [showDecisions, setShowDecisions] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // ── Deliberation State ──
  const [showDelibPanel, setShowDelibPanel] = useState(false);
  const [delibTopic, setDelibTopic] = useState("");
  const [delibRounds, setDelibRounds] = useState(1);
  const [delibPhase, setDelibPhase] = useState<DelibPhase>("idle");
  const [delibSessionId, setDelibSessionId] = useState<string | null>(null);

  // ── Human Participant State ──
  const [includeHuman, setIncludeHuman] = useState(false);
  const [humanTurnData, setHumanTurnData] = useState<{
    sessionId: string;
    phase: string;
    round: number;
    topic: string;
    priorPositions: Array<{ agentName: string; position: string; confidence: number; reasoning: string }>;
    timeoutMs: number;
  } | null>(null);
  const { user, sessionToken } = useAuth();

  const { data: allRooms = [] } = useQuery<any[]>({ queryKey: ["/api/rooms"] });
  const room = (allRooms as any[]).find((r: any) => r.id === roomId) ?? null;

  const { data: agents = [] } = useQuery<any[]>({ queryKey: ["/api/agents"] });
  const { data: flows = [] } = useQuery<any[]>({ queryKey: ["/api/flows"] });

  // ── Fetch latest consensus from structured API ──
  const { data: latestConsensus } = useQuery<any>({
    queryKey: ["/api/rooms", roomId, "consensus"],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/rooms/${roomId}/consensus`);
      if (!r.ok) return null;
      return r.json();
    },
  });

  // Build agent name → color map for vote cards
  const agentColors = useMemo(() => {
    const map: Record<string, string> = {};
    (agents as any[]).forEach((a: any) => { map[a.name] = a.color; });
    return map;
  }, [agents]);

  const [wsConnected, setWsConnected] = useState(false);

  const { data: messages = [], isLoading: msgsLoading } = useQuery<any[]>({
    queryKey: ["/api/rooms", roomId, "messages"],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/rooms/${roomId}/messages`);
      return r.json();
    },
    refetchInterval: wsConnected ? false : 4000,
  });

  // ── WebSocket real-time ───────────────────────────────────────
  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const tokenParam = sessionToken ? `?token=${encodeURIComponent(sessionToken)}` : "";
    const wsUrl = `${protocol}://${window.location.host}/ws${tokenParam}`;
    let ws: WebSocket;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let unmounted = false;

    function connect() {
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        if (unmounted) { ws.close(); return; }
        setWsConnected(true);
        ws.send(JSON.stringify({ type: "subscribe", roomId }));
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "message") {
            queryClient.setQueryData<any[]>(
              ["/api/rooms", roomId, "messages"],
              (prev) => {
                if (!prev) return [data];
                if (prev.some((m) => m.id === data.id)) return prev;
                return [...prev, data];
              }
            );
          } else if (data.type === "human_turn") {
            setHumanTurnData({
              sessionId: data.sessionId,
              phase: data.phase,
              round: data.round,
              topic: data.topic,
              priorPositions: data.priorPositions || [],
              timeoutMs: data.timeoutMs || 60000,
            });
          }
        } catch {
          // ignore malformed frames
        }
      };

      ws.onclose = () => {
        setWsConnected(false);
        if (!unmounted) {
          reconnectTimer = setTimeout(connect, 3000);
        }
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connect();

    return () => {
      unmounted = true;
      clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [roomId]);

  const roomAgentIds: number[] = room ? safeParseIds(room.agentIds) : [];
  const roomAgents = (agents as any[]).filter((a: any) => roomAgentIds.includes(a.id));

  // Auto-select first agent
  useEffect(() => {
    if (roomAgents.length > 0 && !speakingAs) setSpeakingAs(roomAgents[0]);
  }, [roomAgents.length]);

  // Auto-scroll
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  const sendMutation = useMutation({
    mutationFn: (data: any) =>
      apiRequest("POST", `/api/rooms/${roomId}/messages`, data).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/rooms", roomId, "messages"] });
      setInput("");
      setIsDecision(false);
    },
    onError: () => toast({ title: "Failed to send", variant: "destructive" }),
  });

  function send() {
    if (!input.trim() || !speakingAs) return;
    sendMutation.mutate({
      agentId: speakingAs.id,
      agentName: speakingAs.name,
      agentColor: speakingAs.color,
      content: input.trim(),
      isDecision,
    });
  }

  // ── Start Deliberation ──
  const delibMutation = useMutation({
    mutationFn: async (data: { topic: string; debateRounds: number; includeHuman?: boolean; humanName?: string }) => {
      const r = await apiRequest("POST", `/api/rooms/${roomId}/deliberate`, data);
      if (!r.ok) {
        const err = await r.json().catch(() => ({ error: r.statusText }));
        throw new Error(err.error || "Failed to start deliberation");
      }
      return r.json();
    },
    onSuccess: (session: any) => {
      setDelibSessionId(session.sessionId);
      setDelibPhase("completed");
      setShowDelibPanel(false);
      setHumanTurnData(null);
      toast({ title: "Deliberation complete" });
    },
    onError: (err: any) => {
      setDelibPhase("failed");
      setHumanTurnData(null);
      toast({ title: err.message || "Deliberation failed", variant: "destructive" });
    },
  });

  function startDeliberation() {
    if (!delibTopic.trim()) return;
    setDelibPhase("starting");
    setHumanTurnData(null);
    delibMutation.mutate({
      topic: delibTopic.trim(),
      debateRounds: delibRounds,
      includeHuman: includeHuman || undefined,
      humanName: includeHuman ? (user?.name || "Human Participant") : undefined,
    });
  }

  // ── Parse deliberation messages from the chat stream ──
  const delibMessages = useMemo(() => {
    const parsed: ParsedDelibMessage[] = [];
    for (const msg of messages as any[]) {
      const p = parseDelibMessage(msg);
      if (p) parsed.push(p);
    }
    return parsed;
  }, [messages]);

  // Track active phase from incoming messages
  useEffect(() => {
    if (delibPhase === "idle" || delibPhase === "completed") return;
    if (delibMessages.length === 0) return;

    const last = delibMessages[delibMessages.length - 1];
    if (last.isConsensus) {
      setDelibPhase("completed");
    } else if (last.rawContent.includes("failed")) {
      setDelibPhase("failed");
    } else if (last.phase === "final" && !last.isSystem) {
      setDelibPhase("final");
    } else if (last.phase === "debate" && !last.isSystem) {
      setDelibPhase("debate");
    } else if (last.phase === "position" && !last.isSystem) {
      setDelibPhase("position");
    } else if (last.isSystem && last.rawContent.includes("started")) {
      setDelibPhase("starting");
    }
  }, [delibMessages, delibPhase]);

  // Group delib messages by phase
  const delibPhases = useMemo(() => {
    const groups: { phase: string; label: string; items: ParsedDelibMessage[] }[] = [];
    let current: typeof groups[0] | null = null;

    for (const msg of delibMessages) {
      if (msg.isSystem && !msg.isConsensus) {
        // Phase header from system
        const label = msg.rawContent
          .replace(/^[⚡📍💬🎯✅❌📋]\s*/, "")
          .trim();
        if (msg.rawContent.includes("Phase 1") || msg.rawContent.includes("Debate Round") || msg.rawContent.includes("Final Positions")) {
          current = { phase: msg.phase, label, items: [] };
          groups.push(current);
        }
        continue;
      }
      if (msg.isConsensus) {
        groups.push({ phase: "consensus", label: "Consensus", items: [msg] });
        continue;
      }
      if (current) {
        current.items.push(msg);
      }
    }
    return groups;
  }, [delibMessages]);

  // Detect if there's an active or recent deliberation in messages
  const hasDelibActivity = delibMessages.length > 0;
  const isDelibRunning = delibMutation.isPending;

  // Get flow color for room
  const getFlowInfo = () => {
    const result: Array<{ flow: any; color: string; agentIds: number[] }> = [];
    (flows as any[]).forEach((f: any, i: number) => {
      const fIds: number[] = safeParseIds(f.agentIds);
      if (roomAgentIds.some(id => fIds.includes(id))) {
        result.push({ flow: f, color: FLOW_COLORS[i % FLOW_COLORS.length], agentIds: fIds });
      }
    });
    return result;
  };

  const flowInfo = getFlowInfo();

  const decisions = (messages as any[]).filter((m: any) => !!m.isDecision);
  const chat = showDecisions ? decisions : (messages as any[]);

  // ── Tab state: Chat vs Deliberation ──
  const [activeTab, setActiveTab] = useState<"chat" | "deliberation">("chat");

  return (
    <div className="flex flex-col h-screen overflow-hidden">

      {/* ── Top bar ──────────────────────────────────────────────────── */}
      <div className="flex-shrink-0 border-b border-border bg-background">
        {/* Room header */}
        <div className="px-4 md:px-5 py-3 flex items-center gap-3">
          <Link href="/rooms">
            <a className="text-muted-foreground hover:text-foreground transition-colors">
              <ArrowLeft className="w-4 h-4" />
            </a>
          </Link>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-sm font-semibold text-foreground">{room?.name ?? "Room"}</h1>
              <span
                title={wsConnected ? "Real-time connected" : "Polling fallback"}
                className={cn(
                  "w-1.5 h-1.5 rounded-full flex-shrink-0",
                  wsConnected ? "bg-emerald-400 animate-pulse" : "bg-muted-foreground/40"
                )}
              />
            </div>
            {room?.description && (
              <p className="text-[10px] text-muted-foreground">{room.description}</p>
            )}
          </div>
          {/* decisions toggle */}
          <button
            className={cn("flex items-center gap-1.5 text-[10px] px-2.5 py-1.5 rounded-lg border transition-all",
              showDecisions
                ? "bg-yellow-400/10 text-yellow-400 border-yellow-400/30"
                : "border-border text-muted-foreground hover:border-muted-foreground/40")}
            onClick={() => setShowDecisions(d => !d)}
          >
            <Star className="w-3 h-3" />
            Decisions ({decisions.length})
          </button>
        </div>

        {/* ── Colored flow labels ──────────────────────────────────── */}
        {flowInfo.length > 0 && (
          <div className="px-4 md:px-5 pb-2 flex items-center gap-2 flex-wrap">
            <span className="text-[10px] text-muted-foreground">Flows:</span>
            {flowInfo.map(({ flow, color, agentIds }) => {
              const flowAgents = (agents as any[]).filter((a: any) => agentIds.includes(a.id) && roomAgentIds.includes(a.id));
              return (
                <div key={flow.id}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-medium cursor-pointer hover:opacity-80 transition-opacity"
                  style={{ background: color + "20", color, border: `1px solid ${color}44` }}
                  onClick={() => {
                    if (flowAgents[0]) setSpeakingAs(flowAgents[0]);
                  }}
                  title={`Click to speak as ${flowAgents[0]?.name}`}
                >
                  <div className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />
                  {flow.name}
                  <span className="opacity-60 ml-1">
                    {flowAgents.map((a: any) => a.name).join(", ")}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* ── Chat / Deliberation tabs ────────────────────────────── */}
        <div className="px-4 md:px-5 flex items-center gap-1 border-t border-border/50">
          <button
            className={cn(
              "flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 transition-all",
              activeTab === "chat"
                ? "border-[#D4AF37] text-[#D4AF37]"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
            onClick={() => setActiveTab("chat")}
          >
            <MessageSquare className="w-3 h-3" />
            Chat
          </button>
          <button
            className={cn(
              "flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 transition-all",
              activeTab === "deliberation"
                ? "border-[#D4AF37] text-[#D4AF37]"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
            onClick={() => setActiveTab("deliberation")}
          >
            <Zap className="w-3 h-3" />
            Deliberation
            {isDelibRunning && (
              <span className="w-1.5 h-1.5 rounded-full bg-[#D4AF37] animate-pulse" />
            )}
          </button>
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════════ */}
      {/* CHAT TAB                                                   */}
      {/* ═══════════════════════════════════════════════════════════ */}
      {activeTab === "chat" && (
        <>
          {/* ── AI Disclosure ──────────────────────────────────────── */}
          <div className="mx-3 md:mx-5 mt-2 px-3 py-2 rounded-lg bg-yellow-400/5 border border-yellow-400/15 flex items-center gap-2">
            <Bot className="w-3.5 h-3.5 text-yellow-400/70 flex-shrink-0" />
            <p className="text-[10px] text-muted-foreground/60 leading-relaxed">
              <span className="font-semibold text-yellow-400/70">AI Disclosure:</span>{" "}
              This War Room™ may include AI-generated responses. Content does not constitute professional advice.
              KIOKU™ is a product of IKONBAI™, Inc.
            </p>
          </div>

          {/* ── Messages area ────────────────────────────────────── */}
          <div className="flex-1 overflow-auto px-3 md:px-5 py-4 space-y-3">
            {msgsLoading && (
              <div className="space-y-3">
                {[1, 2, 3].map(i => <div key={i} className="h-14 bg-card rounded-xl animate-pulse" />)}
              </div>
            )}

            {!msgsLoading && chat.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full text-center">
                <Bot className="w-9 h-9 text-muted-foreground mb-3 opacity-40" />
                <p className="text-sm text-muted-foreground">
                  {showDecisions ? "No decisions logged yet" : "No messages yet"}
                </p>
                <p className="text-xs text-muted-foreground/50 mt-1">
                  {showDecisions
                    ? "Mark a message as Decision to log it here"
                    : "Select an agent below and start the discussion"}
                </p>
              </div>
            )}

            {chat.map((msg: any) => (
              <div key={msg.id}
                className={cn(
                  "flex gap-3 items-start group",
                  msg.isDecision && "bg-yellow-400/5 border border-yellow-400/15 rounded-xl p-3"
                )}
                data-testid={`msg-${msg.id}`}
              >
                <AgentAvatar name={msg.agentName ?? ""} color={msg.agentColor} size="sm" className="mt-0.5" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                    <span className="text-xs font-semibold" style={{ color: msg.agentColor }}>
                      {msg.agentName}
                    </span>
                    <span className="text-[10px] text-muted-foreground/40">
                      {new Date(msg.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </span>
                    {!!msg.isDecision && (
                      <span className="flex items-center gap-1 text-[10px] text-yellow-400 font-medium">
                        <Star className="w-2.5 h-2.5" fill="currentColor" /> Decision
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-foreground leading-relaxed">{msg.content}</p>
                </div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>

          {/* ── Input area ──────────────────────────────────────── */}
          <div className="flex-shrink-0 border-t border-border bg-background px-3 md:px-5 py-3 md:py-4 space-y-2.5">
            {/* In Room — participant toggle strip */}
            {roomAgents.length > 0 && (
              <div className="flex items-center gap-2 flex-wrap border-b border-border pb-3">
                <span className="text-[10px] text-muted-foreground">In Room:</span>
                {roomAgents.map((a: any) => {
                  const online = a.status === "online";
                  return (
                    <button
                      key={a.id}
                      data-testid={`button-toggle-agent-${a.id}`}
                      onClick={() => {
                        const newStatus = online ? "offline" : "online";
                        apiRequest("PATCH", `/api/agents/${a.id}/toggle`, { status: newStatus })
                          .then(() => queryClient.invalidateQueries({ queryKey: ["/api/agents"] }));
                      }}
                      title={online ? `${a.name} — click to disable` : `${a.name} — click to enable`}
                      className={cn(
                        "flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border transition-all",
                        online
                          ? "border-transparent"
                          : "border-border text-muted-foreground opacity-40 grayscale hover:opacity-60"
                      )}
                      style={online ? { background: a.color + "22", border: `1px solid ${a.color}55`, color: a.color } : {}}
                    >
                      <div className={cn("w-1.5 h-1.5 rounded-full", online ? "animate-pulse" : "bg-muted-foreground/30")}
                        style={online ? { background: a.color } : {}} />
                      <AgentAvatar name={a.name} color={a.color} size="sm" />
                      {a.name}
                      {online
                        ? <Wifi className="w-2.5 h-2.5 opacity-60" />
                        : <WifiOff className="w-2.5 h-2.5" />}
                    </button>
                  );
                })}
              </div>
            )}

            {/* Speaking as — agent pills */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[10px] text-muted-foreground">Speaking as:</span>
              {roomAgents.length === 0 && (
                <span className="text-[10px] text-muted-foreground/50">No agents — add agents when creating the room</span>
              )}
              {roomAgents.map((a: any) => {
                const active = speakingAs?.id === a.id;
                return (
                  <button key={a.id}
                    className={cn("text-[11px] px-3 py-1 rounded-full font-medium border transition-all",
                      active ? "text-[hsl(222_47%_8%)]" : "border-border text-muted-foreground hover:border-muted-foreground/50")}
                    style={active ? { background: a.color, border: `1px solid ${a.color}` } : {}}
                    onClick={() => setSpeakingAs(a)}
                    data-testid={`button-speak-as-${a.id}`}
                  >
                    {a.name}
                  </button>
                );
              })}

              <label className="ml-auto flex items-center gap-1.5 cursor-pointer select-none">
                <input type="checkbox" className="w-3 h-3 accent-yellow-400"
                  checked={isDecision} onChange={e => setIsDecision(e.target.checked)}
                  data-testid="checkbox-is-decision" />
                <span className="text-[10px] text-muted-foreground">Mark as Decision</span>
              </label>
            </div>

            {/* Text input */}
            <div className="flex gap-2">
              {speakingAs && (
                <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg flex-shrink-0"
                  style={{ background: speakingAs.color + "20", border: `1px solid ${speakingAs.color}44` }}>
                  <div className="w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold"
                    style={{ background: speakingAs.color + "33", color: speakingAs.color }}>
                    {speakingAs.name[0]}
                  </div>
                  <span className="text-[10px] font-medium" style={{ color: speakingAs.color }}>
                    {speakingAs.name}
                  </span>
                </div>
              )}
              <input
                ref={inputRef}
                className="flex-1 bg-muted/40 border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 outline-none focus:border-primary/40 transition-colors"
                placeholder={
                  speakingAs
                    ? `${speakingAs.name}: type a message, command, or task…`
                    : "Select an agent to speak as"
                }
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                disabled={!speakingAs || sendMutation.isPending}
                data-testid="input-room-message"
              />
              <Button size="sm" className="h-9 px-3 flex-shrink-0"
                style={{
                  background: isDecision ? "hsl(48 96% 53%)" : "hsl(43 74% 52%)",
                  color: "hsl(222 47% 8%)"
                }}
                onClick={send}
                disabled={!input.trim() || !speakingAs || sendMutation.isPending}
                data-testid="button-send-message"
              >
                <Send className="w-3.5 h-3.5" />
              </Button>
            </div>
          </div>
        </>
      )}

      {/* ═══════════════════════════════════════════════════════════ */}
      {/* DELIBERATION TAB                                           */}
      {/* ═══════════════════════════════════════════════════════════ */}
      {activeTab === "deliberation" && (
        <div className="flex-1 overflow-auto">
          {/* ── Start Deliberation Panel ─────────────────────────── */}
          <div className="px-4 md:px-5 py-4 border-b border-border/50">
            <button
              className="w-full flex items-center justify-between"
              onClick={() => setShowDelibPanel(!showDelibPanel)}
            >
              <div className="flex items-center gap-2">
                <Zap className="w-4 h-4 text-[#D4AF37]" />
                <span className="text-sm font-semibold text-foreground">Start Deliberation</span>
              </div>
              <ChevronDown className={cn(
                "w-4 h-4 text-muted-foreground transition-transform duration-200",
                showDelibPanel && "rotate-180"
              )} />
            </button>

            {showDelibPanel && (
              <div className="mt-4 space-y-4 animate-in slide-in-from-top-1 fade-in duration-200">
                {/* Topic input */}
                <div>
                  <label className="text-[11px] text-muted-foreground font-medium mb-1.5 block">
                    Deliberation Topic
                  </label>
                  <textarea
                    className="w-full bg-muted/30 border border-border rounded-lg px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/40 outline-none focus:border-[#D4AF37]/40 transition-colors resize-none"
                    rows={3}
                    placeholder="What should the agents deliberate on? e.g., 'Should we adopt a microservices architecture?'"
                    value={delibTopic}
                    onChange={e => setDelibTopic(e.target.value)}
                    disabled={isDelibRunning}
                    data-testid="input-delib-topic"
                  />
                </div>

                {/* Join as Participant toggle */}
                <div
                  className={cn(
                    "flex items-center gap-3 rounded-xl border p-3 transition-all duration-200 cursor-pointer select-none",
                    includeHuman
                      ? "border-[#D4AF37]/40 bg-[#D4AF37]/5"
                      : "border-border/40 bg-card/20 hover:border-border/60"
                  )}
                  onClick={() => !isDelibRunning && setIncludeHuman(!includeHuman)}
                >
                  <div className={cn(
                    "w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 transition-colors",
                    includeHuman ? "bg-[#D4AF37]/20 border border-[#D4AF37]/40" : "bg-muted/30 border border-border/40"
                  )}>
                    <User className={cn("w-4 h-4", includeHuman ? "text-[#D4AF37]" : "text-muted-foreground/50")} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <span className={cn("text-xs font-semibold", includeHuman ? "text-[#D4AF37]" : "text-foreground/80")}>
                      Join as Participant
                    </span>
                    <p className="text-[10px] text-muted-foreground leading-relaxed">
                      Respond alongside AI agents in each phase (60s per round)
                    </p>
                  </div>
                  <div className={cn(
                    "w-9 h-5 rounded-full relative transition-all duration-200",
                    includeHuman ? "bg-[#D4AF37]" : "bg-muted/50"
                  )}>
                    <div className={cn(
                      "w-4 h-4 rounded-full bg-white absolute top-0.5 transition-all duration-200",
                      includeHuman ? "left-[18px]" : "left-0.5"
                    )} />
                  </div>
                </div>

                {/* Rounds selector + Start button row */}
                <div className="flex items-end gap-3">
                  <div className="flex-shrink-0">
                    <label className="text-[11px] text-muted-foreground font-medium mb-1.5 block">
                      Debate Rounds
                    </label>
                    <select
                      className="bg-muted/30 border border-border rounded-lg px-3 py-2 text-sm text-foreground outline-none focus:border-[#D4AF37]/40 transition-colors appearance-none cursor-pointer"
                      value={delibRounds}
                      onChange={e => setDelibRounds(Number(e.target.value))}
                      disabled={isDelibRunning}
                      data-testid="select-delib-rounds"
                    >
                      <option value={1}>1 round</option>
                      <option value={2}>2 rounds</option>
                      <option value={3}>3 rounds</option>
                    </select>
                  </div>

                  {/* Agent count badge */}
                  <div className="flex-1 flex items-center gap-2">
                    <div className="flex -space-x-1.5">
                      {roomAgents.filter((a: any) => a.status === "online").slice(0, 5).map((a: any) => (
                        <AgentAvatar key={a.id} name={a.name} color={a.color} size="sm" />
                      ))}
                      {includeHuman && (
                        <div className="w-6 h-6 rounded-full bg-[#D4AF37]/20 border-2 border-background flex items-center justify-center">
                          <User className="w-3 h-3 text-[#D4AF37]" />
                        </div>
                      )}
                    </div>
                    <span className="text-[10px] text-muted-foreground">
                      {roomAgents.filter((a: any) => a.status === "online").length} agents{includeHuman ? " + you" : ""} online
                    </span>
                  </div>

                  <Button
                    className="flex-shrink-0 px-5 font-semibold"
                    style={{
                      background: "linear-gradient(135deg, #D4AF37, #B8960C)",
                      color: "hsl(222 47% 8%)",
                    }}
                    onClick={startDeliberation}
                    disabled={!delibTopic.trim() || isDelibRunning || (!includeHuman && roomAgents.filter((a: any) => a.status === "online").length < 2)}
                    data-testid="button-start-deliberation"
                  >
                    {isDelibRunning ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                        Running...
                      </>
                    ) : (
                      <>
                        <Zap className="w-3.5 h-3.5 mr-1.5" />
                        Start
                      </>
                    )}
                  </Button>
                </div>

                {/* Minimum agents warning */}
                {!includeHuman && roomAgents.filter((a: any) => a.status === "online").length < 2 && (
                  <p className="text-[11px] text-red-400/80">
                    At least 2 online agents required for deliberation (or enable "Join as Participant"). Enable agents in the Chat tab.
                  </p>
                )}
              </div>
            )}
          </div>

          {/* ── Phase Progress Bar ───────────────────────────────── */}
          {(isDelibRunning || delibPhases.length > 0) && (
            <div className="px-4 md:px-5 py-3 border-b border-border/30 space-y-2">
              <div className="flex items-center gap-2">
                {isDelibRunning && <Loader2 className="w-3 h-3 text-[#D4AF37] animate-spin" />}
                <span className="text-[11px] font-medium text-muted-foreground">
                  {isDelibRunning ? "Deliberation in progress..." : "Deliberation phases"}
                </span>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                <PhaseHeader
                  label="Initial Positions"
                  active={isDelibRunning && (delibPhase === "starting" || delibPhase === "position")}
                  completed={delibPhases.some(p => p.phase === "position" && p.items.length > 0)}
                />
                <PhaseHeader
                  label="Debate"
                  active={isDelibRunning && delibPhase === "debate"}
                  completed={delibPhases.some(p => p.phase === "debate" && p.items.length > 0)}
                />
                <PhaseHeader
                  label="Final Positions"
                  active={isDelibRunning && delibPhase === "final"}
                  completed={delibPhases.some(p => p.phase === "final" && p.items.length > 0)}
                />
                <PhaseHeader
                  label="Consensus"
                  active={isDelibRunning && delibPhase === "consensus"}
                  completed={delibPhases.some(p => p.phase === "consensus")}
                />
              </div>
            </div>
          )}

          {/* ── Deliberation Results ─────────────────────────────── */}
          <div className="px-4 md:px-5 py-4 space-y-6">
            {/* Empty state */}
            {delibPhases.length === 0 && !isDelibRunning && (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <div className="w-14 h-14 rounded-2xl bg-[#D4AF37]/5 border border-[#D4AF37]/20 flex items-center justify-center mb-4"
                  style={{ boxShadow: "0 0 30px rgba(212,175,55,0.05)" }}>
                  <Zap className="w-6 h-6 text-[#D4AF37]/50" />
                </div>
                <p className="text-sm text-muted-foreground mb-1">No deliberations yet</p>
                <p className="text-xs text-muted-foreground/50 max-w-[280px]">
                  Enter a topic above and click Start to begin a structured multi-agent deliberation with phases, confidence scoring, and consensus building.
                </p>
              </div>
            )}

            {/* Phase groups */}
            {delibPhases.map((group, gi) => (
              <div key={gi} className="space-y-3">
                {/* Phase section header */}
                <div className="flex items-center gap-2">
                  <div className={cn(
                    "w-1.5 h-1.5 rounded-full",
                    group.phase === "consensus" ? "bg-[#D4AF37]" : "bg-emerald-400"
                  )} />
                  <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    {group.label}
                  </span>
                  <div className="flex-1 h-px bg-border/30" />
                </div>

                {/* Agent response cards or consensus */}
                <div className="space-y-2 pl-1">
                  {group.items.map((item) =>
                    item.isConsensus ? (
                      // Show enhanced consensus panel if structured data available
                      latestConsensus?.votes ? (
                        <EnhancedConsensusPanel
                          key={item.id}
                          consensus={latestConsensus}
                          agentColors={agentColors}
                        />
                      ) : (
                        <ConsensusCard key={item.id} item={item} />
                      )
                    ) : (
                      <AgentResponseCard key={item.id} item={item} animate={gi === delibPhases.length - 1} />
                    )
                  )}
                </div>
              </div>
            ))}

            {/* Human participant input card */}
            {humanTurnData && isDelibRunning && (
              <HumanInputCard
                sessionId={humanTurnData.sessionId}
                roomId={roomId}
                phase={humanTurnData.phase}
                round={humanTurnData.round}
                topic={humanTurnData.topic}
                priorPositions={humanTurnData.priorPositions}
                timeoutMs={humanTurnData.timeoutMs}
                onSubmitted={() => setHumanTurnData(null)}
                onSkipped={() => setHumanTurnData(null)}
              />
            )}

            {/* Loading placeholder during deliberation */}
            {isDelibRunning && !humanTurnData && (
              <div className="space-y-3">
                {[1, 2].map(i => (
                  <div key={i} className="rounded-xl border border-border/20 p-3 animate-pulse">
                    <div className="flex items-start gap-3">
                      <div className="w-6 h-6 rounded-full bg-muted/40" />
                      <div className="flex-1 space-y-2">
                        <div className="h-3 w-20 bg-muted/30 rounded" />
                        <div className="h-3 w-full bg-muted/20 rounded" />
                        <div className="h-3 w-3/4 bg-muted/20 rounded" />
                        <div className="h-1.5 w-16 bg-muted/20 rounded-full" />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* ── Deliberation History ─────────────────────────────── */}
            {!isDelibRunning && (
              <DeliberationHistoryList roomId={roomId} agentColors={agentColors} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
