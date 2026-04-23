/**
 * Luca Day 7 — Approval Board page.
 *
 * Owner-only UI at `/luca/board`. Lists pending tool_approvals rows and
 * offers three decisions per card: Send, No (reject), Edit.
 *
 * Two modes — reads `/api/debug/luca-gate` on load:
 *   - `block`: Decisions do work. Send/Edit re-enter the dispatcher;
 *     Reject marks rejected. All 3 buttons enabled.
 *   - `log_only`: Rows are SHADOW observability rows — Luca already
 *     executed the tool. Approving again would DOUBLE-EXECUTE. In this
 *     mode we disable Send and Edit; only Reject is enabled (safe — no
 *     side-effects). A banner makes this explicit.
 *
 * Polling: 5s while the page is visible. React Query handles focus
 * pause. One call point — the pending counter derives from the same
 * list (`approvals.length`).
 *
 * Edit UX: JSON textarea pre-filled with the draft. On save the client
 * JSON.parse's and POSTs action=edit with the parsed object. Invalid
 * JSON stays in the textarea with an inline error (no submit).
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
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

// ── Page ──────────────────────────────────────────────────────────────

export default function LucaBoardPage() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Owner gate — redirect non-owners
  useEffect(() => {
    if (user && user.role !== "owner") {
      setLocation("/");
    }
  }, [user, setLocation]);

  // Gate state — determines if Send/Edit are safe
  const { data: gate } = useQuery<GateState>({
    queryKey: ["/api/debug/luca-gate"],
    enabled: user?.role === "owner",
    refetchInterval: 30_000,
  });

  const mode: GateMode = gate?.LUCA_APPROVAL_GATE_MODE ?? null;
  const isLogOnly = mode === "log_only";
  const isBlock = mode === "block";

  // Pending list — poll every 5s
  const { data: listData, isLoading, error: listError } = useQuery<{
    approvals: ApprovalRow[];
  }>({
    queryKey: ["/api/luca/approvals"],
    enabled: user?.role === "owner",
    refetchInterval: 5_000,
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

  // Decide mutation — send / edit / reject
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

  // Live countdown tick so expiresIn updates every second
  const [, forceTick] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => forceTick((x) => x + 1), 1000);
    return () => clearInterval(iv);
  }, []);

  const pendingCount = useMemo(() => countPending(approvals), [approvals]);

  if (!user || user.role !== "owner") {
    return null;
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground flex items-center gap-2">
            <ShieldAlert className="w-6 h-6 text-amber-400" />
            Luca Approval Board
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            High-stakes tool calls Luca needs you to review before they run.
          </p>
        </div>
        <div className="text-right">
          <div className="text-xs text-muted-foreground">Gate mode</div>
          <Badge
            variant={isBlock ? "default" : "secondary"}
            className={cn(
              "mt-1",
              isBlock && "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
              isLogOnly && "bg-amber-500/20 text-amber-300 border-amber-500/30",
            )}
          >
            {mode ?? "unknown"}
          </Badge>
        </div>
      </div>

      {/* Log-only mode banner */}
      {isLogOnly && (
        <Alert className="border-amber-500/30 bg-amber-500/5">
          <AlertTriangle className="h-4 w-4 text-amber-400" />
          <AlertDescription className="text-amber-100/90 text-sm leading-relaxed">
            <strong>Log-only mode.</strong> These are shadow observability rows —
            Luca already executed each tool normally. Approving again would
            double-execute the side effect. Send and Edit are disabled; use
            Reject to dismiss old shadow rows. To enable enforcement, flip
            <code className="mx-1 px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-200 font-mono text-xs">
              LUCA_APPROVAL_GATE_MODE=block
            </code>
            in Railway.
          </AlertDescription>
        </Alert>
      )}

      {/* Block mode confirmation strip */}
      {isBlock && (
        <Alert className="border-emerald-500/30 bg-emerald-500/5">
          <CheckCircle2 className="h-4 w-4 text-emerald-400" />
          <AlertDescription className="text-emerald-100/90 text-sm">
            <strong>Enforcement on.</strong> Luca is waiting on your decision
            before executing these tools.
          </AlertDescription>
        </Alert>
      )}

      {/* List state */}
      {isLoading && (
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading approvals…
        </div>
      )}

      {listError && (
        <Alert variant="destructive">
          <XCircle className="h-4 w-4" />
          <AlertDescription>
            Failed to load approvals: {(listError as Error).message}
          </AlertDescription>
        </Alert>
      )}

      {!isLoading && !listError && approvals.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          <CheckCircle2 className="w-8 h-8 mx-auto mb-2 text-emerald-400/60" />
          <div className="text-sm">No pending approvals.</div>
          <div className="text-xs mt-1">
            Luca isn't waiting on anything right now.
          </div>
        </div>
      )}

      {/* Summary */}
      {!isLoading && approvals.length > 0 && (
        <div className="text-xs text-muted-foreground">
          {pendingCount} pending · polling every 5s
        </div>
      )}

      {/* Cards */}
      <div className="space-y-3" data-testid="approvals-list">
        {approvals.map((row) => (
          <ApprovalCard
            key={row.id}
            row={row}
            mode={mode}
            isDeciding={decideMutation.isPending}
            onSend={() => handleSend(row)}
            onReject={() => handleReject(row)}
            onEdit={() => openEdit(row)}
          />
        ))}
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
              data-testid="edit-json-textarea"
            />
            {editErr && (
              <div className="text-xs text-red-400" data-testid="edit-json-error">
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
              data-testid="edit-save-button"
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

// ── Card ──────────────────────────────────────────────────────────────

function ApprovalCard({
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
      data-testid={`approval-card-${row.id}`}
    >
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <code className="text-sm font-mono text-foreground font-semibold">
                {row.toolName}
              </code>
              <Badge variant="outline" className="text-[10px]">
                {row.status}
              </Badge>
              {expired && isPending && (
                <Badge variant="destructive" className="text-[10px]">
                  expired
                </Badge>
              )}
            </div>
            <div className="text-xs text-muted-foreground mt-1.5 flex items-center gap-3 flex-wrap">
              <span className="flex items-center gap-1">
                <Clock className="w-3 h-3" />
                {formatRelative(row.createdAt)}
              </span>
              {isPending && !expired && (
                <span>expires in {formatExpiresIn(row.expiresAt)}</span>
              )}
              <span className="font-mono text-[10px] opacity-60">
                {row.id.slice(0, 8)}
              </span>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {/* Payload preview */}
        <div className="rounded-md bg-muted/30 border border-border/40 p-3">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
            Draft payload
          </div>
          <pre className="text-xs font-mono text-foreground/90 whitespace-pre-wrap break-all max-h-40 overflow-auto">
            {prettyJson(row.draftPayload)}
          </pre>
        </div>

        {/* Execution result — only if already executed (edge case) */}
        {row.executionResult != null && (
          <div className="mt-3 rounded-md bg-muted/20 border border-border/30 p-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
              Execution result
            </div>
            <pre className="text-xs font-mono text-foreground/80 whitespace-pre-wrap break-all max-h-32 overflow-auto">
              {prettyJson(row.executionResult)}
            </pre>
          </div>
        )}

        {/* Actions */}
        {isPending && (
          <div className="flex gap-2 mt-4">
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
              data-testid={`send-${row.id}`}
            >
              <Send className="w-3.5 h-3.5 mr-1.5" />
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
              data-testid={`edit-${row.id}`}
            >
              <Pencil className="w-3.5 h-3.5 mr-1.5" />
              Edit
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={onReject}
              disabled={disableReject}
              className="text-red-400 hover:text-red-300 hover:bg-red-500/10"
              data-testid={`reject-${row.id}`}
            >
              <XIcon className="w-3.5 h-3.5 mr-1.5" />
              No
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
