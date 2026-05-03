/**
 * Phase 1 — Luca activity timeline (right sidebar).
 *
 * Streams `tool_activity_log` rows for the current room (via `/api/rooms/:id/tool-activity`).
 * - Polls every 2s while open.
 * - Incremental fetch via `?since=<lastCreatedAt>`.
 * - Shows tool name (russian label), status dot, elapsed ms, optional preview snippet.
 *
 * No screenshots / iframes here — that's Phase 2+. This is the foundation
 * timeline so subsequent phases (browser panel, file previews, approvals) can
 * dock into the same sidebar.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Activity, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { API_BASE } from "@/lib/queryClient";
import { getSessionToken } from "@/lib/auth";

// ── Types ─────────────────────────────────────────────────────────────

export interface ActivityRow {
  id: number;
  stepId: string;
  roomId: number | null;
  messageId: number | null;
  userId: number | null;
  agentId: number | null;
  tool: string;
  status: "running" | "done" | "error" | string;
  description: string | null;
  preview: string | null;
  startedAt: number;
  finishedAt: number | null;
  elapsedMs: number | null;
  createdAt: number;
}

interface Props {
  roomId: number | null;
  show: boolean;
  onClose: () => void;
  isMobile: boolean;
}

// ── Russian labels (mirrors ToolActivityTrail map in partner-chat) ────

const TOOL_LABEL: Record<string, string> = {
  sandbox_shell: "Терминал",
  sandbox_write_file: "Запись файла",
  sandbox_read_file: "Чтение файла",
  sandbox_list_files: "Список файлов",
  sandbox_download: "Скачивание",
  web_search: "Поиск в интернете",
  browse_website: "Открытие страницы",
  luca_agent_browser: "Агент-браузер",
  generate_image: "Генерация кадра",
  generate_video: "Генерация сцены",
  generate_music: "Музыка",
  generate_speech: "Озвучка",
  stitch_media: "Склейка",
  workspace_save: "workspace ← сохранить",
  workspace_list: "workspace ← список",
  workspace_read: "workspace ← читать",
  luca_analyze_image: "Анализ изображения",
  luca_read_url: "Чтение URL",
};

function labelFor(tool: string): string {
  if (TOOL_LABEL[tool]) return TOOL_LABEL[tool];
  for (const k of Object.keys(TOOL_LABEL)) {
    if (tool.startsWith(k)) return TOOL_LABEL[k];
  }
  return tool.replace(/_/g, " ");
}

function formatElapsed(ms: number | null | undefined): string {
  if (!Number.isFinite(ms as number) || (ms as number) <= 0) return "";
  const n = ms as number;
  if (n < 1000) return `${n}ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(1)}s`;
  return `${Math.round(n / 60_000)}m`;
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// ── Component ────────────────────────────────────────────────────────

export function ActivityTimeline({ roomId, show, onClose, isMobile }: Props) {
  const [rows, setRows] = useState<ActivityRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const lastCreatedRef = useRef<number>(0);
  const inflightRef = useRef<boolean>(false);

  // Reset when room changes or panel re-opens.
  useEffect(() => {
    if (!show) return;
    setRows([]);
    setError(null);
    lastCreatedRef.current = 0;
  }, [roomId, show]);

  // Poll while open.
  useEffect(() => {
    if (!show || roomId == null) return;
    let cancelled = false;

    async function tick() {
      if (cancelled || inflightRef.current) return;
      inflightRef.current = true;
      try {
        const token = getSessionToken();
        const url = `${API_BASE}/api/rooms/${roomId}/tool-activity?since=${lastCreatedRef.current}&limit=200`;
        const res = await fetch(url, {
          headers: { ...(token ? { "x-session-token": token } : {}) },
          credentials: "include",
        });
        if (!res.ok) {
          if (!cancelled) setError(`HTTP ${res.status}`);
          return;
        }
        const data = (await res.json()) as ActivityRow[];
        if (cancelled || !Array.isArray(data) || data.length === 0) return;
        // De-dupe by id (running→done updates same step_id but different ids).
        setRows((prev) => {
          const byId = new Map<number, ActivityRow>();
          for (const r of prev) byId.set(r.id, r);
          for (const r of data) byId.set(r.id, r);
          return Array.from(byId.values()).sort((a, b) => a.createdAt - b.createdAt);
        });
        const maxCreated = data.reduce((m, r) => Math.max(m, r.createdAt), lastCreatedRef.current);
        lastCreatedRef.current = maxCreated;
        setError(null);
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? "fetch error");
      } finally {
        inflightRef.current = false;
      }
    }

    tick();
    const id = window.setInterval(tick, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [show, roomId]);

  // Group by step_id so running→done collapses into one card.
  const grouped = useMemo(() => {
    const byStep = new Map<string, ActivityRow>();
    for (const r of rows) {
      const existing = byStep.get(r.stepId);
      // Prefer the row with the latest status (done/error overrides running).
      if (!existing || r.createdAt >= existing.createdAt) byStep.set(r.stepId, r);
    }
    return Array.from(byStep.values()).sort((a, b) => a.startedAt - b.startedAt);
  }, [rows]);

  const panelContent = (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3 flex-shrink-0"
        style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}
      >
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-[#C9A340]" />
          <h2 className="text-sm font-semibold text-foreground">Активность Луки</h2>
          {grouped.length > 0 && (
            <span
              className="text-[9px] font-bold min-w-[16px] h-[16px] flex items-center justify-center rounded-full px-1"
              style={{ background: "#C9A340", color: "#0a0f1e" }}
            >
              {grouped.length}
            </span>
          )}
        </div>
        <button
          onClick={onClose}
          aria-label="Закрыть"
          className="p-1.5 rounded-lg hover:bg-white/5 transition-colors"
        >
          <X className="w-4 h-4 text-muted-foreground" />
        </button>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1.5">
        {error && (
          <div
            className="text-[11px] rounded-md px-2 py-1.5"
            style={{
              background: "rgba(239,68,68,0.1)",
              color: "#fca5a5",
              border: "1px solid rgba(239,68,68,0.2)",
            }}
          >
            ошибка загрузки: {error}
          </div>
        )}
        {!error && grouped.length === 0 && (
          <div className="text-[11px] text-muted-foreground/40 px-2 py-4 text-center">
            Лука пока ничего не делал
          </div>
        )}
        {grouped.map((r) => (
          <ActivityCard key={r.stepId} row={r} />
        ))}
      </div>
    </div>
  );

  if (isMobile) {
    return (
      <AnimatePresence>
        {show && (
          <motion.div
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", damping: 25, stiffness: 200 }}
            className="fixed inset-0 z-50"
            style={{ background: "rgba(10,15,30,0.98)" }}
          >
            {panelContent}
          </motion.div>
        )}
      </AnimatePresence>
    );
  }

  // Desktop: parent controls position/width via flex layout.
  return show ? <div className="h-full">{panelContent}</div> : null;
}

// ── Card ──────────────────────────────────────────────────────────────

function ActivityCard({ row }: { row: ActivityRow }) {
  const dotColor =
    row.status === "error" ? "#ef4444" : row.status === "done" ? "#4ade80" : "#C9A340";
  const elapsed = formatElapsed(row.elapsedMs);
  const preview = (row.preview ?? "").trim();
  const desc = (row.description ?? "").trim();

  return (
    <div
      className="text-[11px] leading-relaxed rounded-md px-2.5 py-2"
      style={{
        background: "rgba(0,0,0,0.25)",
        border: "1px solid rgba(201,163,64,0.08)",
      }}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "w-1.5 h-1.5 rounded-full flex-shrink-0",
            row.status === "running" && "animate-pulse"
          )}
          style={{ background: dotColor }}
        />
        <span className="text-[#C9A340]/90 font-medium truncate">{labelFor(row.tool)}</span>
        <span className="ml-auto text-[9px] text-muted-foreground/40 flex-shrink-0">
          {formatTime(row.startedAt)}
        </span>
        {elapsed && (
          <span className="text-[9px] text-muted-foreground/50 flex-shrink-0">{elapsed}</span>
        )}
      </div>
      {desc && (
        <div className="mt-1 text-muted-foreground/80 break-words">{desc}</div>
      )}
      {preview && (
        <div
          className="mt-1 text-[10px] text-muted-foreground/50 break-words font-mono line-clamp-3"
          title={preview}
        >
          {preview}
        </div>
      )}
    </div>
  );
}
