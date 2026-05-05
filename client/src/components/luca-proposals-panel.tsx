/**
 * R468 — Luca Proposals Panel for Owner Dashboard.
 *
 * Owner-only widget that lists pending luca_propose_improvement rows and
 * lets BOSS approve/reject them inline. Approving does NOT auto-apply —
 * BRO2 implements approved proposals as a separate engineering task.
 *
 * Mounts inside boss-board.tsx. Uses /api/luca/proposals (R467 endpoints).
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Lightbulb, Check, X, ChevronDown, ChevronRight, Clock, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

type ProposalStatus = "pending" | "approved" | "rejected" | "applied";

interface Proposal {
  id: number;
  user_id: number;
  agent_id: number | null;
  title: string;
  body: string;
  category: "tool" | "prompt" | "memory" | "process" | "other";
  status: ProposalStatus;
  created_at: string;
  decided_at: string | null;
  decision_note: string | null;
  applied_pr_url: string | null;
  applied_commit_sha: string | null;
}

interface ProposalsResponse {
  proposals: Proposal[];
  count: number;
  status: ProposalStatus;
}

const CATEGORY_COLORS: Record<Proposal["category"], string> = {
  tool: "bg-blue-500/15 text-blue-400 border-blue-500/25",
  prompt: "bg-purple-500/15 text-purple-400 border-purple-500/25",
  memory: "bg-emerald-500/15 text-emerald-400 border-emerald-500/25",
  process: "bg-amber-500/15 text-amber-400 border-amber-500/25",
  other: "bg-zinc-500/15 text-zinc-400 border-zinc-500/25",
};

function formatRelative(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const diffMs = Date.now() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.floor(diffH / 24);
  return `${diffD}d ago`;
}

function ProposalCard({ p, onDecide, busy }: {
  p: Proposal;
  onDecide: (id: number, decision: "approved" | "rejected", note: string) => void;
  busy: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [note, setNote] = useState("");
  const [showNote, setShowNote] = useState(false);

  return (
    <div className="border border-amber-500/10 rounded-lg p-4 bg-[hsl(222,47%,9%)]/50 hover:border-amber-500/25 transition-colors">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex-1 min-w-0">
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-start gap-2 text-left w-full group"
            data-testid={`proposal-toggle-${p.id}`}
          >
            {expanded
              ? <ChevronDown className="w-4 h-4 mt-1 text-amber-400/60 shrink-0" />
              : <ChevronRight className="w-4 h-4 mt-1 text-amber-400/60 shrink-0" />}
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-foreground group-hover:text-amber-400 transition-colors break-words">
                {p.title}
              </div>
              <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground">
                <span>#{p.id}</span>
                <span>•</span>
                <Clock className="w-3 h-3" />
                <span>{formatRelative(p.created_at)}</span>
                {p.agent_id !== null && (
                  <>
                    <span>•</span>
                    <span>agent {p.agent_id}</span>
                  </>
                )}
              </div>
            </div>
          </button>
        </div>
        <Badge className={cn("shrink-0 text-[10px] uppercase", CATEGORY_COLORS[p.category])}>
          {p.category}
        </Badge>
      </div>

      {expanded && (
        <div className="ml-6 space-y-3">
          <div className="text-xs text-muted-foreground whitespace-pre-wrap break-words bg-[hsl(222,47%,7%)] rounded p-3 border border-amber-500/5 max-h-72 overflow-auto">
            {p.body}
          </div>

          {p.status === "pending" && (
            <>
              {showNote && (
                <Textarea
                  value={note}
                  onChange={e => setNote(e.target.value)}
                  placeholder="Optional note (≤2000 chars)"
                  maxLength={2000}
                  className="text-xs bg-[hsl(222,47%,7%)] border-amber-500/15"
                  rows={2}
                  data-testid={`proposal-note-${p.id}`}
                />
              )}
              <div className="flex items-center gap-2 flex-wrap">
                <Button
                  size="sm"
                  onClick={() => onDecide(p.id, "approved", note)}
                  disabled={busy}
                  className="h-8 bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 border border-emerald-500/25"
                  data-testid={`proposal-approve-${p.id}`}
                >
                  <Check className="w-3.5 h-3.5 mr-1" /> Approve
                </Button>
                <Button
                  size="sm"
                  onClick={() => onDecide(p.id, "rejected", note)}
                  disabled={busy}
                  className="h-8 bg-red-500/15 text-red-400 hover:bg-red-500/25 border border-red-500/25"
                  data-testid={`proposal-reject-${p.id}`}
                >
                  <X className="w-3.5 h-3.5 mr-1" /> Reject
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setShowNote(s => !s)}
                  className="h-8 text-[10px] text-muted-foreground hover:text-amber-400"
                  data-testid={`proposal-note-toggle-${p.id}`}
                >
                  {showNote ? "Hide note" : "Add note"}
                </Button>
                <span className="text-[10px] text-muted-foreground/60 ml-auto">
                  Approve = queue for BRO2 (no auto-PR)
                </span>
              </div>
            </>
          )}

          {p.status !== "pending" && (
            <div className="text-[10px] text-muted-foreground space-y-1">
              <div>
                <span className="font-medium">{p.status.toUpperCase()}</span>
                {p.decided_at && <> · {formatRelative(p.decided_at)}</>}
              </div>
              {p.decision_note && (
                <div className="text-foreground/80 italic">"{p.decision_note}"</div>
              )}
              {p.applied_pr_url && (
                <a
                  href={p.applied_pr_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-amber-400 hover:underline"
                >
                  Applied PR ↗
                </a>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function LucaProposalsPanel() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<ProposalStatus>("pending");

  const { data, isLoading, refetch, isFetching } = useQuery<ProposalsResponse>({
    queryKey: ["/api/luca/proposals", statusFilter],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/luca/proposals?status=${statusFilter}&limit=100`);
      if (!r.ok) throw new Error(`status ${r.status}`);
      return r.json();
    },
    refetchInterval: 60000,
  });

  // Pending count badge — always fetched separately so the chip number is
  // accurate even when the user is viewing approved/rejected.
  const { data: pendingData } = useQuery<ProposalsResponse>({
    queryKey: ["/api/luca/proposals", "pending", "counter"],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/luca/proposals?status=pending&limit=200`);
      if (!r.ok) throw new Error(`status ${r.status}`);
      return r.json();
    },
    refetchInterval: 60000,
  });

  const decide = useMutation({
    mutationFn: async (vars: { id: number; decision: "approved" | "rejected"; note: string }) => {
      const body: Record<string, unknown> = { decision: vars.decision };
      if (vars.note.trim()) body.note = vars.note.trim();
      const r = await apiRequest("POST", `/api/luca/proposals/${vars.id}/decide`, body);
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || `status ${r.status}`);
      }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/luca/proposals"] });
    },
  });

  const proposals = data?.proposals ?? [];
  const pendingCount = pendingData?.count ?? 0;

  return (
    <Card className="bg-[hsl(222,47%,11%)]/80 border-amber-500/10" data-testid="luca-proposals-panel">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium text-foreground flex items-center gap-2">
          <Lightbulb className="w-4 h-4 text-amber-400" />
          Luca Proposals
          {pendingCount > 0 && (
            <Badge
              className="ml-1 bg-amber-500/15 text-amber-400 border-amber-500/25 text-[10px]"
              data-testid="proposals-pending-counter"
            >
              {pendingCount} pending
            </Badge>
          )}
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="ml-auto text-amber-400/60 hover:text-amber-400 disabled:opacity-50"
            title="Refresh"
            data-testid="proposals-refresh"
          >
            <RefreshCw className={cn("w-3.5 h-3.5", isFetching && "animate-spin")} />
          </button>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="flex items-center gap-1 mb-3 flex-wrap">
          {(["pending", "approved", "rejected", "applied"] as ProposalStatus[]).map(s => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={cn(
                "px-2.5 py-1 rounded text-[10px] uppercase tracking-wide transition-colors",
                statusFilter === s
                  ? "bg-amber-500/20 text-amber-400 border border-amber-500/30"
                  : "text-muted-foreground hover:text-amber-400 border border-transparent"
              )}
              data-testid={`proposals-filter-${s}`}
            >
              {s}
            </button>
          ))}
        </div>

        {decide.isError && (
          <div className="text-[10px] text-red-400 mb-2" data-testid="proposals-error">
            {(decide.error as Error)?.message || "decide failed"}
          </div>
        )}

        {isLoading && (
          <div className="text-xs text-muted-foreground py-6 text-center">Loading…</div>
        )}

        {!isLoading && proposals.length === 0 && (
          <div className="text-xs text-muted-foreground py-6 text-center" data-testid="proposals-empty">
            No {statusFilter} proposals.
          </div>
        )}

        {!isLoading && proposals.length > 0 && (
          <div className="space-y-2.5">
            {proposals.map(p => (
              <ProposalCard
                key={p.id}
                p={p}
                onDecide={(id, decision, note) => decide.mutate({ id, decision, note })}
                busy={decide.isPending}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
