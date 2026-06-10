import { cn } from "@/lib/utils";
import { ExternalLink, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface ConnectorDef {
  id: string;
  name: string;
  emoji: string;
  description: string;
  /** provider key in the integrations status API, if available */
  providerKey?: string;
  /** OAuth connect endpoint, if backend supports it */
  connectEndpoint?: string;
}

import { useI18n } from "@/i18n";

export type ConnectorStatus = "connected" | "disconnected" | "coming_soon";

const STATUS_CONFIG: Record<ConnectorStatus, { labelKey: string; dot: string; badge: string }> = {
  connected: {
    labelKey: "connectors.statusConnected",
    dot: "bg-emerald-400",
    badge: "bg-emerald-500/15 text-emerald-400 border-emerald-500/25",
  },
  disconnected: {
    labelKey: "connectors.statusDisconnected",
    dot: "bg-red-400",
    badge: "bg-red-500/15 text-red-400 border-red-500/25",
  },
  coming_soon: {
    labelKey: "connectors.statusComingSoon",
    dot: "bg-yellow-400",
    badge: "bg-yellow-500/15 text-yellow-400 border-yellow-500/25",
  },
};

interface ConnectorCardProps {
  connector: ConnectorDef;
  status: ConnectorStatus;
  email?: string;
  onConnect: () => void;
  onDisconnect: () => void;
  loading?: boolean;
}

export default function ConnectorCard({
  connector,
  status,
  email,
  onConnect,
  onDisconnect,
  loading,
}: ConnectorCardProps) {
  const { t } = useI18n();
  const cfg = STATUS_CONFIG[status];

  return (
    <div
      className="rounded-xl border border-white/[0.06] hover:border-[#C9A340]/20 transition-all duration-300 p-4"
      style={{ background: "rgba(255,255,255,0.03)" }}
    >
      {/* Top row: icon + name + status */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="text-2xl flex-shrink-0">{connector.emoji}</span>
          <div>
            <h3 className="text-sm font-medium text-foreground">{connector.name}</h3>
            <p className="text-[11px] text-muted-foreground/50 mt-0.5 leading-snug">
              {connector.description}
            </p>
          </div>
        </div>
        {/* Status badge */}
        <span className={cn("text-[9px] font-medium px-2 py-0.5 rounded-full border flex-shrink-0 flex items-center gap-1", cfg.badge)}>
          <span className={cn("w-1.5 h-1.5 rounded-full", cfg.dot)} />
          {t(cfg.labelKey)}
        </span>
      </div>

      {/* Connected email */}
      {status === "connected" && email && (
        <p className="text-[10px] text-muted-foreground/40 mt-2 ml-9 truncate">{email}</p>
      )}

      {/* Action */}
      <div className="mt-3 ml-9">
        {status === "connected" ? (
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-[10px] px-3 border-white/10 text-muted-foreground hover:text-red-400 hover:border-red-400/30"
            onClick={onDisconnect}
            disabled={loading}
          >
            {loading ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
            {t("common.disconnect")}
          </Button>
        ) : status === "disconnected" ? (
          <Button
            size="sm"
            className="h-7 text-[10px] px-3"
            style={{ background: "hsl(43 74% 52%)", color: "hsl(222 47% 8%)" }}
            onClick={onConnect}
            disabled={loading}
          >
            {loading ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <ExternalLink className="w-3 h-3 mr-1" />}
            {t("common.connect")}
          </Button>
        ) : (
          <span className="text-[10px] text-muted-foreground/30 italic">{t("connectors.availableSoon")}</span>
        )}
      </div>
    </div>
  );
}
