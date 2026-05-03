/**
 * Phase 5 (R-luca-computer-ui) — pinned artifacts header strip.
 *
 * Renders chip list of pins for a room above the activity timeline. Click
 * scrolls to the source row (if it's a tool-activity-derived pin) or opens
 * a lightbox for files/screenshots. Pin/unpin mutations live on the
 * ActivityCard (cross-component messaging via callback).
 *
 * Soft warning at 50 pins (BRO1 R438 Q3); hard reject at 100 by server.
 */

import { useEffect, useState } from "react";
import { Pin, X } from "lucide-react";
import { API_BASE } from "@/lib/queryClient";
import { getSessionToken } from "@/lib/auth";

export interface PinnedArtifactItem {
  id: number;
  roomId: number;
  userId: number;
  type: "screenshot" | "file" | "live_frame" | "message";
  refId: string;
  label: string | null;
  createdAt: number;
}

interface Props {
  roomId: number;
  onClickPin?: (pin: PinnedArtifactItem) => void;
  /** Bumped by ActivityCard when it pins/unpins, triggers refresh. */
  refreshKey?: number;
}

const SOFT_WARN = 50;

export function PinnedArtifactsStrip({ roomId, onClickPin, refreshKey }: Props) {
  const [items, setItems] = useState<PinnedArtifactItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const token = getSessionToken();
        const res = await fetch(`${API_BASE}/api/rooms/${roomId}/pinned-artifacts`, {
          headers: { ...(token ? { "x-session-token": token } : {}) },
          credentials: "include",
        });
        if (!res.ok) {
          if (!cancelled) setError(`HTTP ${res.status}`);
          return;
        }
        const data = await res.json();
        if (!cancelled && Array.isArray(data?.items)) {
          setItems(data.items);
          setError(null);
        }
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? "fetch error");
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [roomId, refreshKey]);

  if (error) return null;
  if (items.length === 0) return null;

  return (
    <div
      className="flex items-center gap-1.5 overflow-x-auto px-3 py-2 flex-shrink-0"
      style={{
        background: "rgba(201,163,64,0.04)",
        borderBottom: "1px solid rgba(255,255,255,0.06)",
      }}
    >
      <Pin className="w-3 h-3 text-[#C9A340]/70 flex-shrink-0" />
      {items.map((p) => (
        <PinnedChip key={p.id} pin={p} roomId={roomId} onClickPin={onClickPin} />
      ))}
      {items.length >= SOFT_WARN && (
        <span
          className="text-[9px] text-amber-400/80 ml-2 flex-shrink-0"
          title="можно удалить старые пины"
        >
          {items.length}/100
        </span>
      )}
    </div>
  );
}

function PinnedChip({
  pin,
  roomId,
  onClickPin,
}: {
  pin: PinnedArtifactItem;
  roomId: number;
  onClickPin?: (pin: PinnedArtifactItem) => void;
}) {
  const [removing, setRemoving] = useState(false);

  const labelText = pin.label || pin.refId.slice(0, 24);
  const typeIcon = (() => {
    switch (pin.type) {
      case "screenshot":
        return "📷";
      case "file":
        return "📄";
      case "live_frame":
        return "🖥";
      case "message":
        return "💬";
      default:
        return "📌";
    }
  })();

  async function unpin(e: React.MouseEvent) {
    e.stopPropagation();
    if (removing) return;
    setRemoving(true);
    try {
      const token = getSessionToken();
      await fetch(`${API_BASE}/api/rooms/${roomId}/pinned-artifacts/${pin.id}`, {
        method: "DELETE",
        headers: { ...(token ? { "x-session-token": token } : {}) },
        credentials: "include",
      });
      // Parent re-fetches via refreshKey; we just stop showing.
      window.dispatchEvent(new CustomEvent("pinned-artifacts:changed", { detail: { roomId } }));
    } finally {
      setRemoving(false);
    }
  }

  return (
    <button
      onClick={() => onClickPin?.(pin)}
      className="group flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] flex-shrink-0 hover:bg-white/5 transition"
      style={{
        background: "rgba(0,0,0,0.3)",
        border: "1px solid rgba(201,163,64,0.2)",
      }}
      title={pin.label || `${pin.type}:${pin.refId}`}
    >
      <span aria-hidden>{typeIcon}</span>
      <span className="text-foreground/90 truncate" style={{ maxWidth: 120 }}>
        {labelText}
      </span>
      <span
        role="button"
        tabIndex={0}
        onClick={unpin}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") unpin(e as any);
        }}
        className="opacity-0 group-hover:opacity-100 transition rounded-full p-0.5 hover:bg-white/10 inline-flex"
        aria-label="Открепить"
      >
        <X className="w-2.5 h-2.5" />
      </span>
    </button>
  );
}

/**
 * Mutation helper used by ActivityCard pin button. Returns the response item
 * on success or throws.
 */
export async function pinArtifactClient(params: {
  roomId: number;
  type: PinnedArtifactItem["type"];
  refId: string;
  label?: string;
}): Promise<PinnedArtifactItem> {
  const token = getSessionToken();
  const res = await fetch(`${API_BASE}/api/rooms/${params.roomId}/pinned-artifacts`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { "x-session-token": token } : {}),
    },
    credentials: "include",
    body: JSON.stringify({
      type: params.type,
      refId: params.refId,
      label: params.label ?? null,
    }),
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`pin failed: HTTP ${res.status} ${msg}`);
  }
  const data = await res.json();
  window.dispatchEvent(new CustomEvent("pinned-artifacts:changed", { detail: { roomId: params.roomId } }));
  return data.item as PinnedArtifactItem;
}
