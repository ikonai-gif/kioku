import React, { useState, useMemo, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  X,
  Inbox,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Mail,
  MailOpen,
  Archive,
  ExternalLink,
  Reply,
  AlertCircle,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ----- Types -----

interface InboxMessage {
  account: string;
  id: string;
  threadId: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
  unread?: boolean;
}

interface InboxGroup {
  key: string;
  label: string;
  color: string; // red | orange | blue | green | slate | gray
  count: number;
  messages: InboxMessage[];
}

interface InboxAccountStatus {
  email: string;
  ok: boolean;
  messages_found?: number;
  error?: string;
  needs_reconnect?: boolean;
}

interface InboxResponse {
  meta: {
    fetchedAt: number | string;
    query: string | Record<string, unknown>;
    totalMessages: number;
    totalAccounts: number;
    brokenAccounts: number;
  };
  accountStatuses: InboxAccountStatus[];
  groups: InboxGroup[];
}

interface InboxFullMessage extends InboxMessage {
  body?: string;
  html?: string;
}

interface InboxPanelProps {
  show: boolean;
  onClose: () => void;
  isMobile: boolean;
  onReplyViaLuca?: (msg: InboxMessage) => void;
}

// ----- Color palette per group -----

const COLOR_STYLES: Record<
  string,
  { bg: string; border: string; text: string; dot: string; ring: string }
> = {
  red: {
    bg: "rgba(239,68,68,0.10)",
    border: "rgba(239,68,68,0.35)",
    text: "#fca5a5",
    dot: "#ef4444",
    ring: "rgba(239,68,68,0.25)",
  },
  orange: {
    bg: "rgba(249,115,22,0.10)",
    border: "rgba(249,115,22,0.35)",
    text: "#fdba74",
    dot: "#f97316",
    ring: "rgba(249,115,22,0.25)",
  },
  blue: {
    bg: "rgba(59,130,246,0.10)",
    border: "rgba(59,130,246,0.35)",
    text: "#93c5fd",
    dot: "#3b82f6",
    ring: "rgba(59,130,246,0.25)",
  },
  green: {
    bg: "rgba(34,197,94,0.10)",
    border: "rgba(34,197,94,0.35)",
    text: "#86efac",
    dot: "#22c55e",
    ring: "rgba(34,197,94,0.25)",
  },
  slate: {
    bg: "rgba(100,116,139,0.10)",
    border: "rgba(100,116,139,0.35)",
    text: "#cbd5e1",
    dot: "#64748b",
    ring: "rgba(100,116,139,0.25)",
  },
  gray: {
    bg: "rgba(156,163,175,0.08)",
    border: "rgba(156,163,175,0.30)",
    text: "#d1d5db",
    dot: "#9ca3af",
    ring: "rgba(156,163,175,0.20)",
  },
};

const styleFor = (color: string) => COLOR_STYLES[color] || COLOR_STYLES.slate;

// ----- Helpers -----

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    const day = 24 * 60 * 60 * 1000;
    if (diff < day && d.getDate() === now.getDate()) {
      return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    }
    if (diff < 7 * day) {
      return d.toLocaleDateString(undefined, { weekday: "short" });
    }
    return d.toLocaleDateString(undefined, { day: "2-digit", month: "short" });
  } catch {
    return "";
  }
}

function senderName(from: string): string {
  // "Name <email@x>" or "email@x"
  const m = from.match(/^([^<]+)</);
  if (m) return m[1].trim().replace(/^"|"$/g, "");
  return from.trim();
}

function gmailUrlFor(account: string, messageId: string): string {
  // Authuser by email is a hint, not strict — works when user is signed into multiple
  const acc = encodeURIComponent(account);
  return `https://mail.google.com/mail/u/${acc}/#inbox/${messageId}`;
}

// ----- Fetchers -----

async function fetchInbox(): Promise<InboxResponse> {
  const r = await fetch("/api/partner/inbox?onlyUnread=true&days=14&perAccount=40", {
    credentials: "include",
  });
  if (!r.ok) throw new Error(`inbox HTTP ${r.status}`);
  return r.json();
}

async function fetchMessage(account: string, id: string): Promise<InboxFullMessage> {
  const r = await fetch(
    `/api/partner/inbox/message?account=${encodeURIComponent(account)}&id=${encodeURIComponent(id)}`,
    { credentials: "include" }
  );
  if (!r.ok) throw new Error(`message HTTP ${r.status}`);
  return r.json();
}

async function performAction(
  account: string,
  id: string,
  action: "mark_read" | "mark_unread" | "archive"
): Promise<void> {
  const r = await fetch(`/api/partner/inbox/action`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account, id, action }),
  });
  if (!r.ok) throw new Error(`action HTTP ${r.status}`);
}

// ----- Component -----

export function InboxPanel({ show, onClose, isMobile, onReplyViaLuca }: InboxPanelProps) {
  const qc = useQueryClient();
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [expandedMsg, setExpandedMsg] = useState<string | null>(null); // `${account}|${id}`

  const inboxQ = useQuery({
    queryKey: ["partner-inbox"],
    queryFn: fetchInbox,
    enabled: show,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  // When data loads, default to opening first non-empty group
  useEffect(() => {
    if (inboxQ.data && Object.keys(openGroups).length === 0) {
      const next: Record<string, boolean> = {};
      for (const g of inboxQ.data.groups) {
        next[g.key] = g.count > 0 && (g.color === "red" || g.color === "orange");
      }
      // If nothing opened, open the first non-empty
      if (!Object.values(next).some(Boolean)) {
        const first = inboxQ.data.groups.find((g) => g.count > 0);
        if (first) next[first.key] = true;
      }
      setOpenGroups(next);
    }
  }, [inboxQ.data]);

  const messageQ = useQuery({
    queryKey: ["partner-inbox-msg", expandedMsg],
    queryFn: async () => {
      if (!expandedMsg) return null;
      const [account, id] = expandedMsg.split("|");
      return fetchMessage(account, id);
    },
    enabled: !!expandedMsg,
    staleTime: 60_000,
  });

  const actionM = useMutation({
    mutationFn: async (args: {
      account: string;
      id: string;
      action: "mark_read" | "mark_unread" | "archive";
    }) => performAction(args.account, args.id, args.action),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["partner-inbox"] });
    },
  });

  const totalUnread = inboxQ.data?.meta.totalMessages || 0;
  const brokenAccounts = inboxQ.data?.accountStatuses.filter((a) => !a.ok) || [];

  const toggleGroup = (key: string) =>
    setOpenGroups((prev) => ({ ...prev, [key]: !prev[key] }));

  const panelContent = (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3 flex-shrink-0"
        style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <Inbox className="w-4 h-4 text-[#C9A340] flex-shrink-0" />
          <h2 className="text-sm font-semibold text-foreground truncate">Inbox</h2>
          {totalUnread > 0 && (
            <span
              className="text-[9px] font-bold min-w-[16px] h-[16px] flex items-center justify-center rounded-full px-1"
              style={{ background: "#C9A340", color: "#0a0f1e" }}
            >
              {totalUnread}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => inboxQ.refetch()}
            disabled={inboxQ.isFetching}
            className="p-1.5 rounded-lg hover:bg-white/5 transition-colors disabled:opacity-40"
            title="Обновить"
          >
            <RefreshCw
              className={cn(
                "w-3.5 h-3.5 text-muted-foreground",
                inboxQ.isFetching && "animate-spin"
              )}
            />
          </button>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-white/5 transition-colors"
            title="Закрыть"
          >
            <X className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>
      </div>

      {/* Account status warnings */}
      {brokenAccounts.length > 0 && (
        <div
          className="px-3 py-2 flex-shrink-0 space-y-1"
          style={{
            background: "rgba(239,68,68,0.06)",
            borderBottom: "1px solid rgba(239,68,68,0.2)",
          }}
        >
          {brokenAccounts.map((a) => (
            <div key={a.email} className="flex items-center gap-2 text-[11px] text-red-300/90">
              <AlertCircle className="w-3 h-3 flex-shrink-0" />
              <span className="truncate flex-1">
                <span className="font-medium">{a.email}</span>
                {a.error ? `: ${a.error}` : a.needs_reconnect ? " — нужно переподключить" : " — недоступен"}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        {inboxQ.isLoading && (
          <div className="flex flex-col items-center justify-center h-full min-h-[200px] text-muted-foreground/50">
            <Loader2 className="w-8 h-8 mb-3 animate-spin" />
            <p className="text-sm">Загружаю почту…</p>
          </div>
        )}

        {inboxQ.isError && (
          <div className="flex flex-col items-center justify-center h-full min-h-[200px] text-red-300/80 p-6">
            <AlertCircle className="w-8 h-8 mb-3" />
            <p className="text-sm font-medium">Не удалось загрузить inbox</p>
            <p className="text-xs mt-1 text-center max-w-[260px] text-muted-foreground/60">
              {(inboxQ.error as Error)?.message || "Неизвестная ошибка"}
            </p>
            <button
              onClick={() => inboxQ.refetch()}
              className="mt-4 px-3 py-1.5 rounded-lg text-xs"
              style={{
                background: "rgba(201,163,64,0.15)",
                color: "#C9A340",
                border: "1px solid rgba(201,163,64,0.3)",
              }}
            >
              Повторить
            </button>
          </div>
        )}

        {inboxQ.data && totalUnread === 0 && (
          <div className="flex flex-col items-center justify-center h-full min-h-[200px] text-muted-foreground/40">
            <Inbox className="w-10 h-10 mb-3 opacity-50" />
            <p className="text-sm font-medium">Все непрочитанные разобраны</p>
            <p className="text-xs mt-1 text-center max-w-[220px] leading-relaxed">
              Новые письма появятся здесь автоматически
            </p>
          </div>
        )}

        {inboxQ.data && totalUnread > 0 && (
          <div className="p-3 space-y-2">
            {inboxQ.data.groups
              .filter((g) => g.count > 0)
              .map((group) => {
                const s = styleFor(group.color);
                const isOpen = !!openGroups[group.key];
                return (
                  <div
                    key={group.key}
                    className="rounded-xl overflow-hidden"
                    style={{
                      background: s.bg,
                      border: `1px solid ${s.border}`,
                    }}
                  >
                    <button
                      onClick={() => toggleGroup(group.key)}
                      className="w-full flex items-center justify-between px-3 py-2.5 text-left hover:bg-white/[0.03] transition-colors"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span
                          className="w-2 h-2 rounded-full flex-shrink-0"
                          style={{ background: s.dot }}
                        />
                        <span className="text-sm font-semibold" style={{ color: s.text }}>
                          {group.label}
                        </span>
                        <span
                          className="text-[10px] font-bold min-w-[18px] h-[18px] flex items-center justify-center rounded-full px-1.5"
                          style={{
                            background: s.ring,
                            color: s.text,
                          }}
                        >
                          {group.count}
                        </span>
                      </div>
                      {isOpen ? (
                        <ChevronDown className="w-4 h-4 flex-shrink-0" style={{ color: s.text }} />
                      ) : (
                        <ChevronRight className="w-4 h-4 flex-shrink-0" style={{ color: s.text }} />
                      )}
                    </button>

                    <AnimatePresence initial={false}>
                      {isOpen && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: "auto", opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.2 }}
                          className="overflow-hidden"
                        >
                          <div
                            className="space-y-1.5 p-2"
                            style={{ borderTop: `1px solid ${s.border}` }}
                          >
                            {group.messages.map((msg) => {
                              const key = `${msg.account}|${msg.id}`;
                              const isExpanded = expandedMsg === key;
                              return (
                                <MessageCard
                                  key={key}
                                  msg={msg}
                                  color={s}
                                  expanded={isExpanded}
                                  fullData={isExpanded ? messageQ.data : null}
                                  loadingFull={isExpanded && messageQ.isLoading}
                                  onToggle={() =>
                                    setExpandedMsg((prev) => (prev === key ? null : key))
                                  }
                                  onAction={(action) =>
                                    actionM.mutate({ account: msg.account, id: msg.id, action })
                                  }
                                  onReply={() => onReplyViaLuca?.(msg)}
                                  busy={actionM.isPending}
                                />
                              );
                            })}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                );
              })}

            {inboxQ.data.meta.fetchedAt && (
              <p className="text-[10px] text-muted-foreground/40 text-center pt-2">
                Обновлено: {new Date(inboxQ.data.meta.fetchedAt).toLocaleString()}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );

  // Mobile: bottom sheet
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

  // Desktop: inline panel rendered by parent in split layout
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

// ----- Message card -----

interface MessageCardProps {
  msg: InboxMessage;
  color: { bg: string; border: string; text: string; dot: string; ring: string };
  expanded: boolean;
  fullData: InboxFullMessage | null | undefined;
  loadingFull: boolean;
  onToggle: () => void;
  onAction: (action: "mark_read" | "mark_unread" | "archive") => void;
  onReply: () => void;
  busy: boolean;
}

function MessageCard({
  msg,
  color,
  expanded,
  fullData,
  loadingFull,
  onToggle,
  onAction,
  onReply,
  busy,
}: MessageCardProps) {
  return (
    <div
      className="rounded-lg overflow-hidden transition-all"
      style={{
        background: expanded ? "rgba(255,255,255,0.04)" : "rgba(255,255,255,0.015)",
        border: expanded
          ? `1px solid ${color.border}`
          : "1px solid rgba(255,255,255,0.04)",
      }}
    >
      <button
        onClick={onToggle}
        className="w-full text-left px-3 py-2 hover:bg-white/[0.03] transition-colors"
      >
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2 mb-0.5">
              <span className="text-[12px] font-semibold text-foreground/90 truncate">
                {senderName(msg.from)}
              </span>
              <span className="text-[10px] text-muted-foreground/50 flex-shrink-0">
                {formatDate(msg.date)}
              </span>
            </div>
            <p className="text-[12px] text-foreground/80 truncate font-medium">
              {msg.subject || "(без темы)"}
            </p>
            <p className="text-[11px] text-muted-foreground/60 truncate mt-0.5">
              {msg.snippet}
            </p>
            <p className="text-[9px] text-muted-foreground/40 mt-1 truncate">
              {msg.account}
            </p>
          </div>
        </div>
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div
              className="px-3 py-3"
              style={{ borderTop: `1px solid ${color.border}` }}
            >
              {loadingFull && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground/60">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Загружаю письмо…
                </div>
              )}
              {!loadingFull && fullData && (
                <>
                  <div className="text-[11px] text-muted-foreground/70 mb-2 space-y-0.5">
                    <div>
                      <span className="text-muted-foreground/50">От:</span> {fullData.from}
                    </div>
                    <div>
                      <span className="text-muted-foreground/50">Дата:</span>{" "}
                      {new Date(fullData.date).toLocaleString()}
                    </div>
                  </div>
                  <div
                    className="text-[12px] text-foreground/85 leading-relaxed whitespace-pre-wrap break-words max-h-[320px] overflow-y-auto rounded-md p-2"
                    style={{
                      background: "rgba(0,0,0,0.25)",
                      border: "1px solid rgba(255,255,255,0.04)",
                    }}
                  >
                    {fullData.body || fullData.snippet || "(пустое тело)"}
                  </div>
                </>
              )}

              {/* Actions */}
              <div className="flex flex-wrap gap-1.5 mt-3">
                <ActionBtn
                  icon={<Reply className="w-3 h-3" />}
                  label="Ответить через Luca"
                  primary
                  onClick={onReply}
                  disabled={busy}
                />
                <ActionBtn
                  icon={
                    msg.unread === false ? (
                      <Mail className="w-3 h-3" />
                    ) : (
                      <MailOpen className="w-3 h-3" />
                    )
                  }
                  label={msg.unread === false ? "Непрочитано" : "Прочитано"}
                  onClick={() =>
                    onAction(msg.unread === false ? "mark_unread" : "mark_read")
                  }
                  disabled={busy}
                />
                <ActionBtn
                  icon={<Archive className="w-3 h-3" />}
                  label="Архив"
                  onClick={() => onAction("archive")}
                  disabled={busy}
                />
                <a
                  href={gmailUrlFor(msg.account, msg.id)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors"
                  style={{
                    background: "rgba(255,255,255,0.04)",
                    color: "rgba(255,255,255,0.65)",
                    border: "1px solid rgba(255,255,255,0.08)",
                  }}
                >
                  <ExternalLink className="w-3 h-3" />
                  Открыть в Gmail
                </a>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ActionBtn({
  icon,
  label,
  onClick,
  disabled,
  primary,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      )}
      style={
        primary
          ? {
              background: "rgba(201,163,64,0.15)",
              color: "#C9A340",
              border: "1px solid rgba(201,163,64,0.35)",
            }
          : {
              background: "rgba(255,255,255,0.04)",
              color: "rgba(255,255,255,0.7)",
              border: "1px solid rgba(255,255,255,0.08)",
            }
      }
    >
      {icon}
      {label}
    </button>
  );
}
