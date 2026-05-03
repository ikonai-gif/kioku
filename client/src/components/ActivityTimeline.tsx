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
import { FileLightbox, IconForContentType } from "./FileLightbox";
import { LiveBrowserFrame } from "./LiveBrowserFrame";
import { PinnedArtifactsStrip, pinArtifactClient, type PinnedArtifactItem } from "./PinnedArtifacts";
import { Pin } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────

// Phase 2 (R-luca-computer-ui): inline media attached to a tool activity row.
export interface ActivityMedia {
  storageKey: string;
  signedUrl: string;
  signedExpiresAt: number;
  contentType: string;
  /**
   * Phase 4 (R-luca-computer-ui): added 'live_frame' for ephemeral
   * Browserbase live debugger iframes. Mounted only while the agent_browser
   * tool activity row is `status:'running'`; removed on done/error.
   */
  kind: "screenshot" | "file" | "video" | "live_frame";
  sourceUrl?: string | null;
  /** Phase 3 (R-luca-computer-ui): file size for FileLightbox PDF gate. */
  sizeBytes?: number;
}

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
  mediaUrls?: ActivityMedia[];
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
  const [lightbox, setLightbox] = useState<ActivityMedia | null>(null);
  // Phase 5 (R-luca-computer-ui): bumped on pin/unpin so the strip refreshes.
  const [pinRefresh, setPinRefresh] = useState(0);
  const lastCreatedRef = useRef<number>(0);
  const inflightRef = useRef<boolean>(false);

  // Refresh strip when any chip is pinned/unpinned (cross-component event).
  useEffect(() => {
    if (!show || roomId == null) return;
    function onChange(ev: Event) {
      const detail = (ev as CustomEvent).detail;
      if (detail?.roomId === roomId) setPinRefresh((n) => n + 1);
    }
    window.addEventListener("pinned-artifacts:changed", onChange);
    return () => window.removeEventListener("pinned-artifacts:changed", onChange);
  }, [show, roomId]);

  function onClickPin(pin: PinnedArtifactItem) {
    // For screenshot/file/live_frame pins we try to find the underlying media
    // in the loaded rows and open the lightbox. live_frame falls back to the
    // running row scroll behavior.
    for (const r of rows) {
      const m = (r.mediaUrls ?? []).find((mm) => mm.storageKey === pin.refId || mm.signedUrl === pin.refId);
      if (m) {
        if (m.kind !== "live_frame") setLightbox(m);
        return;
      }
    }
  }

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

      {/* Phase 5 (R-luca-computer-ui): pinned artifacts strip. */}
      {roomId != null && (
        <PinnedArtifactsStrip roomId={roomId} onClickPin={onClickPin} refreshKey={pinRefresh} />
      )}

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
          <ActivityCard key={r.stepId} row={r} roomId={roomId} onOpenMedia={setLightbox} />
        ))}
      </div>
      {lightbox && lightbox.kind !== "live_frame" && (
        <FileLightbox
          media={{
            signedUrl: lightbox.signedUrl,
            contentType: lightbox.contentType,
            kind: lightbox.kind,
            sourceUrl: lightbox.sourceUrl,
            sizeBytes: lightbox.sizeBytes,
          }}
          onClose={() => setLightbox(null)}
        />
      )}
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

function ActivityCard({ row, roomId, onOpenMedia }: { row: ActivityRow; roomId: number | null; onOpenMedia: (m: ActivityMedia) => void }) {
  const dotColor =
    row.status === "error" ? "#ef4444" : row.status === "done" ? "#4ade80" : "#C9A340";
  const elapsed = formatElapsed(row.elapsedMs);
  const preview = (row.preview ?? "").trim();
  const desc = (row.description ?? "").trim();
  const media = Array.isArray(row.mediaUrls) ? row.mediaUrls : [];

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
        {/* Phase 5 (R-luca-computer-ui): pin first non-live media or message. */}
        {roomId != null && (() => {
          const pinnable = (row.mediaUrls ?? []).find((m) => m.kind !== "live_frame");
          if (!pinnable) return null;
          return (
            <button
              type="button"
              onClick={async (e) => {
                e.stopPropagation();
                try {
                  await pinArtifactClient({
                    roomId,
                    type: pinnable.kind === "screenshot" ? "screenshot" : "file",
                    refId: pinnable.storageKey || pinnable.signedUrl,
                    label: row.description || labelFor(row.tool),
                  });
                } catch {
                  // Soft-fail; UI re-renders without strip change. Future: toast.
                }
              }}
              aria-label="Закрепить"
              className="flex-shrink-0 p-0.5 rounded hover:bg-white/10 transition"
              title="Закрепить"
            >
              <Pin className="w-2.5 h-2.5 text-[#C9A340]/60" />
            </button>
          );
        })()}
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
      {(() => {
        // Phase 4 (R-luca-computer-ui): pull live_frame OUT of the thumbnail
        // grid — it renders as a full-width inline iframe, not a chip. Only
        // mount it while the row is still running; on done/error the server
        // has already torn down the BB session so the URL is dead.
        const liveFrame =
          row.status === "running"
            ? media.find((m) => m.kind === "live_frame")
            : undefined;
        const otherMedia = media.filter((m) => m.kind !== "live_frame");
        return (
          <>
            {liveFrame && (
              <div className="mt-2">
                <LiveBrowserFrame
                  src={liveFrame.signedUrl}
                  replayUrl={liveFrame.sourceUrl}
                  roomId={roomId ?? undefined}
                  stepId={row.stepId}
                />
              </div>
            )}
            {otherMedia.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {otherMedia.map((m, i) => {
                  // Phase 3 (R-luca-computer-ui): branch by kind.
                  // - screenshot/image → 80×60 thumbnail (Phase 2 behaviour)
                  // - file (pdf/text/code) → icon-only chip with filename hint
                  const isImage =
                    /^image\//i.test(m.contentType) || m.kind === "screenshot";
                  return (
                    <button
                      key={`${row.stepId}-m-${i}`}
                      onClick={() => onOpenMedia(m)}
                      className="rounded overflow-hidden hover:ring-1 hover:ring-[#C9A340]/60 transition"
                      style={{
                        width: isImage ? 80 : "auto",
                        height: 60,
                        minWidth: 80,
                        background: "rgba(0,0,0,0.4)",
                        border: "1px solid rgba(201,163,64,0.2)",
                        display: isImage ? "block" : "flex",
                        alignItems: "center",
                        gap: 6,
                        padding: isImage ? 0 : "0 10px",
                      }}
                      aria-label={
                        isImage ? "Показать скриншот" : "Открыть файл"
                      }
                      title={m.sourceUrl || m.contentType || "file"}
                    >
                      {isImage ? (
                        <img
                          src={m.signedUrl}
                          alt="preview"
                          loading="lazy"
                          className="w-full h-full object-cover"
                          onError={(e) => {
                            // signed URL likely expired — next poll re-signs.
                            (e.currentTarget as HTMLImageElement).style.display = "none";
                          }}
                        />
                      ) : (
                        <>
                          <IconForContentType ct={m.contentType} className="w-4 h-4 text-[#C9A340]" />
                          <span
                            className="text-[10px] text-muted-foreground/80 font-mono truncate"
                            style={{ maxWidth: 140 }}
                          >
                            {m.contentType.split("/").pop() || "file"}
                          </span>
                        </>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </>
        );
      })()}
    </div>
  );
}

// Phase 3 (R-luca-computer-ui): legacy MediaLightbox replaced by FileLightbox
// in `./FileLightbox.tsx`, which supports image / pdf / code / fallback.

