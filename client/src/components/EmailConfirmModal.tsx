/**
 * EmailConfirmModal
 *
 * Shown when Luca prepares a send_new_email or send_email_reply.
 * The backend creates a one-time confirmation token (15-min TTL).
 * The user can "Send" (confirm) or "Cancel" the action here.
 */
import React, { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Mail, Reply, Send, X, Loader2, AlertCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

// ── Types ────────────────────────────────────────────────────────────────────

export interface EmailConfirmPreview {
  kind: "new" | "reply";
  account: string;
  to?: string;
  subject?: string;
  message_id?: string;
  cc?: string | null;
  bcc?: string | null;
  body_preview: string;
}

export interface EmailConfirmPayload {
  token: string;
  expiresAt: number;
  preview: EmailConfirmPreview;
}

interface EmailConfirmModalProps {
  payload: EmailConfirmPayload | null;
  onClose: () => void;
  onSent: (token: string) => void;
  onCancelled: (token: string) => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function EmailConfirmModal({
  payload,
  onClose,
  onSent,
  onCancelled,
}: EmailConfirmModalProps) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!payload) return null;

  const { token, preview } = payload;
  const isNew = preview.kind === "new";

  async function submit(action: "confirm" | "cancel") {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/partner/inbox/confirm/${encodeURIComponent(token)}`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        throw new Error(data?.error || `HTTP ${r.status}`);
      }
      if (action === "confirm") {
        toast({ title: "Письмо отправлено", description: isNew ? `Кому: ${preview.to}` : "Ответ отправлен" });
        onSent(token);
      } else {
        onCancelled(token);
      }
      onClose();
    } catch (err: any) {
      setError(err.message || "Ошибка");
      setBusy(false);
    }
  }

  return (
    <AnimatePresence>
      <motion.div
        key="email-confirm-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[100] flex items-center justify-center p-4"
        style={{ background: "rgba(0,0,0,0.65)", backdropFilter: "blur(4px)" }}
        onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
      >
        <motion.div
          key="email-confirm-panel"
          initial={{ scale: 0.95, opacity: 0, y: 12 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.95, opacity: 0, y: 12 }}
          transition={{ type: "spring", stiffness: 300, damping: 25 }}
          className="w-full max-w-md rounded-2xl overflow-hidden"
          style={{
            background: "rgba(12,18,38,0.98)",
            border: "1px solid rgba(201,163,64,0.35)",
            boxShadow: "0 24px 60px rgba(0,0,0,0.6), 0 0 0 1px rgba(201,163,64,0.1)",
          }}
        >
          {/* Header */}
          <div
            className="flex items-center justify-between px-5 py-4"
            style={{ borderBottom: "1px solid rgba(255,255,255,0.07)" }}
          >
            <div className="flex items-center gap-2.5">
              <div
                className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
                style={{ background: "rgba(201,163,64,0.15)", border: "1px solid rgba(201,163,64,0.3)" }}
              >
                {isNew
                  ? <Mail className="w-3.5 h-3.5" style={{ color: "#C9A340" }} />
                  : <Reply className="w-3.5 h-3.5" style={{ color: "#C9A340" }} />
                }
              </div>
              <div>
                <p className="text-sm font-semibold text-foreground">
                  {isNew ? "Отправить письмо?" : "Отправить ответ?"}
                </p>
                <p className="text-[11px] text-muted-foreground/60">Luca подготовил сообщение</p>
              </div>
            </div>
            <button
              onClick={() => { if (!busy) onClose(); }}
              className="p-1.5 rounded-lg hover:bg-white/5 transition-colors"
              disabled={busy}
            >
              <X className="w-4 h-4 text-muted-foreground" />
            </button>
          </div>

          {/* Preview */}
          <div className="px-5 py-4 space-y-3">
            {/* Meta fields */}
            <div
              className="rounded-xl p-3 space-y-1.5 text-[12px]"
              style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}
            >
              <MetaRow label="От" value={preview.account} />
              {isNew && preview.to && <MetaRow label="Кому" value={preview.to} highlight />}
              {isNew && preview.subject && <MetaRow label="Тема" value={preview.subject} />}
              {preview.cc && <MetaRow label="CC" value={preview.cc} />}
              {preview.bcc && <MetaRow label="BCC" value={preview.bcc} />}
              {!isNew && preview.message_id && (
                <MetaRow label="Ответ на" value={`msg: ${preview.message_id}`} />
              )}
            </div>

            {/* Body preview */}
            <div>
              <p className="text-[10px] font-medium text-muted-foreground/50 uppercase tracking-wide mb-1.5">
                Текст письма
              </p>
              <div
                className="text-[12px] text-foreground/80 leading-relaxed whitespace-pre-wrap break-words rounded-xl p-3 max-h-[180px] overflow-y-auto"
                style={{ background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.05)" }}
              >
                {preview.body_preview}
                {preview.body_preview.length >= 500 && (
                  <span className="text-muted-foreground/50"> … (обрезано)</span>
                )}
              </div>
            </div>

            {/* Error */}
            {error && (
              <div
                className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-red-300"
                style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)" }}
              >
                <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
                {error}
              </div>
            )}
          </div>

          {/* Actions */}
          <div
            className="flex gap-2.5 px-5 py-4"
            style={{ borderTop: "1px solid rgba(255,255,255,0.07)" }}
          >
            {/* Cancel */}
            <button
              onClick={() => submit("cancel")}
              disabled={busy}
              className="flex-1 py-2.5 rounded-xl text-sm font-medium transition-all disabled:opacity-50"
              style={{
                background: "rgba(255,255,255,0.05)",
                color: "rgba(255,255,255,0.7)",
                border: "1px solid rgba(255,255,255,0.1)",
              }}
            >
              Отменить
            </button>

            {/* Confirm Send */}
            <button
              onClick={() => submit("confirm")}
              disabled={busy}
              className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-sm font-semibold transition-all disabled:opacity-50"
              style={{
                background: busy ? "rgba(201,163,64,0.3)" : "rgba(201,163,64,0.9)",
                color: busy ? "rgba(255,255,255,0.6)" : "#0a0f1e",
                border: "1px solid rgba(201,163,64,0.5)",
              }}
            >
              {busy ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <>
                  <Send className="w-3.5 h-3.5" />
                  Отправить
                </>
              )}
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function MetaRow({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="flex items-baseline gap-2 min-w-0">
      <span className="text-muted-foreground/50 w-10 shrink-0">{label}:</span>
      <span
        className="truncate font-medium"
        style={{ color: highlight ? "#C9A340" : "rgba(255,255,255,0.85)" }}
      >
        {value}
      </span>
    </div>
  );
}
