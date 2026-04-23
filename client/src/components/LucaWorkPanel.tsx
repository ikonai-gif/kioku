/**
 * Luca Day 8 — Work panel.
 *
 * Compact side-panel version of /luca/board for embedding in the partner
 * chat view. Shows pending approvals so the user sees Luca's work
 * alongside the chat, not as a separate page.
 *
 * Behavior mirrors the full Board page (same helpers, same API, same
 * safety invariant in log_only mode). Key differences:
 *   - Polls only while `show` is true (no background drain when closed).
 *   - Renders a Close button and fills the container height.
 *   - Owner-only: the parent is expected to gate on role too, but we
 *     double-check here as a defense-in-depth.
 *
 * Reuses:
 *   - /api/debug/luca-gate (gate mode)
 *   - /api/luca/approvals (list)
 *   - /api/luca/approvals/:id/decide (send/edit/reject)
 *   - luca-board-helpers (canExecute, canReject, parseEditPayload, ...)
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../App";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Textarea } from "@/components/ui/textarea";
import {
  Send, X as XIcon, Pencil, Clock, AlertTriangle, ShieldAlert,
  CheckCircle2, XCircle, Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  canExecuteApproval, canRejectApproval, countPending,
  parseEditPayload, formatRelative, formatExpiresIn, prettyJson,
  type GateMode,
} from "@/lib/luca-board-helpers";

// ── Types ─────────────────────────────────────────────────────────────

interface ApprovalRow {
  id: string;
  agentId: number;
  userId: number;
  meetingId: number | null;
  turnId: string | null;
  toolName: string;
  draftPayload: unknown;
  finalPayload: unknown | null;
  status: "pending" | "approved" | "edited" | "rejected" | "timeout" | "error";
  decisionNote: string | null;
  codeSha: string | null;
  createdAt: string;
  decidedAt: string | null;
  expiresAt: string;
  executedAt: string | null;
  executionResult: unknown | null;
}

interface GateState {
  LUCA_V1A_ENABLED: string | null;
  LUCA_APPROVAL_GATE_ENABLED: string | null;
  LUCA_APPROVAL_GATE_MODE: "block" | "log_only" | null;
  LUCA_EXPANDED_SCOPE_ENABLED: string | null;
  resolved: {
    isApprovalGateActive: boolean;
    isApprovalGateEnforcing: boolean;
  };
}

// ── Panel ─────────────────────────────────────────────────────────────

export function LucaWorkPanel({
  show,
  onClose,
  isMobile = false,
}: {
  show: boolean;
  onClose: () => void;
  isMobile?: boolean;
}) {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const isOwner = user?.role === "owner";
  const enabled = show && isOwner;

  // Gate state
  const { data: gate } = useQuery<GateState>({
    queryKey: ["/api/debug/luca-gate"],
    enabled,
    refetchInterval: enabled ? 30_000 : false,
  });

  const mode: GateMode = gate?.LUCA_APPROVAL_GATE_MODE ?? null;
  const isLogOnly = mode === "log_only";
  const isBlock = mode === "block";

  // Approvals list — poll every 5s when open
  const { data: listData, isLoading, error: listError } = useQuery<{
    approvals: ApprovalRow[];
  }>({
    queryKey: ["/api/luca/approvals"],
    enabled,
    refetchInterval: enabled ? 5_000 : false,
    refetchIntervalInBackground: false,
  });

  const approvals = listData?.approvals ?? [];

  // Edit modal state
  const [editingRow, setEditingRow] = useState<ApprovalRow | null>(null);
  const [editJson, setEditJson] = useState<string>("");
  const [editErr, setEditErr] = useState<string | null>(null);

  function openEdit(row: ApprovalRow) {
    setEditingRow(row);
    setEditJson(prettyJson(row.draftPayload));
    setEditErr(null);
  }

  function closeEdit() {
    setEditingRow(null);
    setEditJson("");
    setEditErr(null);
  }

  // Decide mutation
  const decideMutation = useMutation({
    mutationFn: async (vars: {
      id: string;
      action: "send" | "edit" | "reject";
      editedPayload?: unknown;
    }) => {
      const body: Record<string, unknown> = { action: vars.action };
      if (vars.action === "edit") body.edited_payload = vars.editedPayload;
      const res = await apiRequest(
        "POST",
        `/api/luca/approvals/${vars.id}/decide`,
        body,
      );
      const json = await res.json();
      if (!res.ok) {
        const err = new Error(json?.detail ?? json?.error ?? "decide_failed");
        (err as any).status = res.status;
        (err as any).code = json?.error;
        throw err;
      }
      return json;
    },
    onSuccess: (data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["/api/luca/approvals"] });
      const verb =
        vars.action === "send" ? "approved"
        : vars.action === "edit" ? "edited and approved"
        : "rejected";
      if (data.executed) {
        toast({
          title: `Approval ${verb}`,
          description: data.execution_ok
            ? "Tool executed successfully."
            : "Tool ran but returned an error — check execution_result.",
        });
      } else {
        toast({ title: `Approval ${verb}` });
      }
      if (vars.action === "edit") closeEdit();
    },
    onError: (err: any) => {
      const code = err?.code;
      const status = err?.status;
      let title = "Decision failed";
      let description = err?.message ?? "Unknown error";
      if (status === 409 || code === "approval_already_decided") {
        title = "Already decided";
        description = "Someone else resolved this approval. Refreshing.";
        queryClient.invalidateQueries({ queryKey: ["/api/luca/approvals"] });
      } else if (code === "approval_edit_missing_payload") {
        title = "Edit needs a payload";
        description = "The edit payload is required and must be JSON.";
      }
      toast({ title, description, variant: "destructive" });
    },
  });

  function handleSend(row: ApprovalRow) {
    if (!canExecuteApproval(row, mode)) return;
    decideMutation.mutate({ id: row.id, action: "send" });
  }

  function handleReject(row: ApprovalRow) {
    if (!canRejectApproval(row)) return;
    decideMutation.mutate({ id: row.id, action: "reject" });
  }

  function handleSaveEdit() {
    if (!editingRow) return;
    if (!isBlock) {
      setEditErr("Edit is disabled in log_only mode.");
      return;
    }
    const result = parseEditPayload(editJson);
    if (!result.ok) {
      setEditErr(result.error);
      return;
    }
    decideMutation.mutate({
      id: editingRow.id,
      action: "edit",
      editedPayload: result.value,
    });
  }

  // Live countdown tick — only while panel visible
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const iv = setInterval(() => forceTick((x) => x + 1), 1000);
    return () => clearInterval(iv);
  }, [enabled]);

  const pendingCount = useMemo(() => countPending(approvals), [approvals]);

  if (!isOwner) return null;

  return (
    <div
      className={cn(
        "h-full flex flex-col overflow-hidden",
        isMobile
          ? "fixed inset-0 z-50"
          : "",
      )}
      style={{
        background: isMobile
          ? "linear-gradient(180deg, #0a0f1e 0%, #0F1B3D 50%, #0a0f1e 100%)"
          : "rgba(10, 15, 30, 0.85)",
        borderLeft: isMobile ? "none" : "1px solid rgba(255,255,255,0.06)",
        backdropFilter: isMobile ? undefined : "blur(12px)",
      }}
      data-testid="luca-work-panel"
    >
      {/* Panel header */}
      <div
        className="flex items-center gap-2 px-4 py-3 flex-shrink-0"
        style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}
      >
        <ShieldAlert className="w-4 h-4 text-amber-400" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-foreground leading-tight">
            Luca's work
          </div>
          <div className="text-[10px] text-muted-foreground mt-0.5 flex items-center gap-2">
            <span>{pendingCount} pending</span>
            {mode && (
              <>
                <span className="opacity-40">·</span>
                <span
                  className={cn(
                    isBlock && "text-emerald-400",
                    isLogOnly && "text-amber-400",
                  )}
                >
                  {mode}
                </span>
              </>
            )}
          </div>
        </div>
        <button
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground p-1 rounded hover:bg-white/5 transition-colors"
          aria-label="Close Luca work panel"
          data-testid="luca-work-panel-close"
        >
          <XIcon className="w-4 h-4" />
        </button>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {/* Mode banner — compact */}
        {isLogOnly && (
          <Alert className="border-amber-500/30 bg-amber-500/5 py-2">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
            <AlertDescription className="text-amber-100/90 text-xs leading-relaxed">
              <strong>Log-only.</strong> Shadow rows — Luca already ran these.
              Send/Edit disabled to prevent double-execute. Use Reject to
              dismiss.
            </AlertDescription>
          </Alert>
        )}
        {isBlock && (
          <Alert className="border-emerald-500/30 bg-emerald-500/5 py-2">
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
            <AlertDescription className="text-emerald-100/90 text-xs">
              <strong>Enforcement on.</strong> Luca is waiting on your decision.
            </AlertDescription>
          </Alert>
        )}

        {/* States */}
        {isLoading && (
          <div className="flex items-center gap-2 text-muted-foreground text-xs">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Loading approvals…
          </div>
        )}

        {listError && (
          <Alert variant="destructive" className="py-2">
            <XCircle className="h-3.5 w-3.5" />
            <AlertDescription className="text-xs">
              Failed to load: {(listError as Error).message}
            </AlertDescription>
          </Alert>
        )}

        {!isLoading && !listError && approvals.length === 0 && (
          <div className="text-center py-10 text-muted-foreground">
            <CheckCircle2 className="w-6 h-6 mx-auto mb-2 text-emerald-400/60" />
            <div className="text-xs">No pending approvals.</div>
            <div className="text-[10px] mt-1 opacity-70">
              Luca isn't waiting on anything right now.
            </div>
          </div>
        )}

        {/* Cards */}
        {approvals.map((row) => (
          <CompactApprovalCard
            key={row.id}
            row={row}
            mode={mode}
            isDeciding={decideMutation.isPending}
            onSend={() => handleSend(row)}
            onReject={() => handleReject(row)}
            onEdit={() => openEdit(row)}
          />
        ))}

        {!isLoading && approvals.length > 0 && (
          <div className="text-[10px] text-muted-foreground/70 text-center pt-1">
            polling every 5s
          </div>
        )}
      </div>

      {/* Edit modal */}
      <Dialog open={!!editingRow} onOpenChange={(o) => !o && closeEdit()}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              Edit payload — {editingRow?.toolName}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              JSON will be passed as the tool's arguments. Must be an object.
            </p>
            <Textarea
              value={editJson}
              onChange={(e) => {
                setEditJson(e.target.value);
                setEditErr(null);
              }}
              rows={14}
              className="font-mono text-xs"
              data-testid="edit-json-textarea-panel"
            />
            {editErr && (
              <div className="text-xs text-red-400" data-testid="edit-json-error-panel">
                {editErr}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={closeEdit}>
              Cancel
            </Button>
            <Button
              onClick={handleSaveEdit}
              disabled={!isBlock || decideMutation.isPending}
              data-testid="edit-save-button-panel"
            >
              {decideMutation.isPending ? (
                <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
              ) : (
                <Pencil className="w-4 h-4 mr-1.5" />
              )}
              Save & send
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Compact card ──────────────────────────────────────────────────────

function CompactApprovalCard({
  row,
  mode,
  isDeciding,
  onSend,
  onReject,
  onEdit,
}: {
  row: ApprovalRow;
  mode: GateMode;
  isDeciding: boolean;
  onSend: () => void;
  onReject: () => void;
  onEdit: () => void;
}) {
  const isPending = row.status === "pending";
  const expired = new Date(row.expiresAt).getTime() <= Date.now();
  const canExecute = canExecuteApproval(row, mode);
  const canReject = canRejectApproval(row);
  const disableExecute = !canExecute || isDeciding;
  const disableReject = !canReject || isDeciding;

  return (
    <Card
      className={cn(
        "border-border/60 bg-card/50",
        !isPending && "opacity-60",
      )}
      data-testid={`approval-card-panel-${row.id}`}
    >
      <CardHeader className="pb-2 px-3 pt-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <code className="text-xs font-mono text-foreground font-semibold break-all">
                {row.toolName}
              </code>
              <Badge variant="outline" className="text-[9px] px-1 py-0">
                {row.status}
              </Badge>
              {expired && isPending && (
                <Badge variant="destructive" className="text-[9px] px-1 py-0">
                  expired
                </Badge>
              )}
            </div>
            <div className="text-[10px] text-muted-foreground mt-1 flex items-center gap-2 flex-wrap">
              <span className="flex items-center gap-1">
                <Clock className="w-2.5 h-2.5" />
                {formatRelative(row.createdAt)}
              </span>
              {isPending && !expired && (
                <span>in {formatExpiresIn(row.expiresAt)}</span>
              )}
              <span className="font-mono text-[9px] opacity-50">
                {row.id.slice(0, 6)}
              </span>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0 px-3 pb-3">
        <div className="rounded bg-muted/30 border border-border/40 p-2">
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground mb-1">
            Draft
          </div>
          <pre className="text-[11px] font-mono text-foreground/90 whitespace-pre-wrap break-all max-h-28 overflow-auto leading-snug">
            {prettyJson(row.draftPayload)}
          </pre>
        </div>

        {row.executionResult != null && (
          <div className="mt-2 rounded bg-muted/20 border border-border/30 p-2">
            <div className="text-[9px] uppercase tracking-wider text-muted-foreground mb-1">
              Result
            </div>
            <pre className="text-[11px] font-mono text-foreground/80 whitespace-pre-wrap break-all max-h-24 overflow-auto leading-snug">
              {prettyJson(row.executionResult)}
            </pre>
          </div>
        )}

        {isPending && (
          <div className="flex gap-1.5 mt-3">
            <Button
              size="sm"
              onClick={onSend}
              disabled={disableExecute}
              title={
                !canExecute
                  ? "Send is disabled in log_only mode"
                  : expired
                  ? "Approval expired"
                  : undefined
              }
              className="h-7 px-2 text-xs"
              data-testid={`send-panel-${row.id}`}
            >
              <Send className="w-3 h-3 mr-1" />
              Send
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={onEdit}
              disabled={disableExecute}
              title={
                !canExecute
                  ? "Edit is disabled in log_only mode"
                  : expired
                  ? "Approval expired"
                  : undefined
              }
              className="h-7 px-2 text-xs"
              data-testid={`edit-panel-${row.id}`}
            >
              <Pencil className="w-3 h-3 mr-1" />
              Edit
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={onReject}
              disabled={disableReject}
              className="h-7 px-2 text-xs text-red-400 hover:text-red-300 hover:bg-red-500/10 ml-auto"
              data-testid={`reject-panel-${row.id}`}
            >
              <XIcon className="w-3 h-3 mr-1" />
              No
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
