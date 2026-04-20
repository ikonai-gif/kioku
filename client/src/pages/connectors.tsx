import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Plug } from "lucide-react";
import ConnectorCard, { type ConnectorDef, type ConnectorStatus } from "@/components/ConnectorCard";

// ── Connector definitions ──────────────────────────────────────────────
const CONNECTORS: ConnectorDef[] = [
  // Gmail is rendered separately below (supports multiple accounts)
  {
    id: "google_calendar",
    name: "Google Calendar",
    emoji: "📅",
    description: "View events and manage your schedule",
    providerKey: undefined,
  },
  {
    id: "google_drive",
    name: "Google Drive",
    emoji: "📁",
    description: "Search and read files from Drive",
    providerKey: "google_drive",
    connectEndpoint: "/api/integrations/google/connect",
  },
  {
    id: "dropbox",
    name: "Dropbox",
    emoji: "📦",
    description: "Access and search your Dropbox files",
    providerKey: "dropbox",
    connectEndpoint: "/api/integrations/dropbox/connect",
  },
  {
    id: "notion",
    name: "Notion",
    emoji: "📝",
    description: "Search and read Notion pages and databases",
    providerKey: undefined,
  },
  {
    id: "google_sheets",
    name: "Google Sheets",
    emoji: "📊",
    description: "Read and analyze spreadsheet data",
    providerKey: undefined,
  },
  {
    id: "slack",
    name: "Slack",
    emoji: "💬",
    description: "Search messages and channels",
    providerKey: undefined,
  },
];

interface GmailAccount { id: number; email: string; createdAt: number }

export default function ConnectorsPage() {
  const { toast } = useToast();
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [gmailLoading, setGmailLoading] = useState(false);

  const { data: integrationStatus } = useQuery<Record<string, { connected: boolean; email?: string }>>({
    queryKey: ["/api/integrations/status"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/integrations/status");
      if (!res.ok) return {};
      return res.json();
    },
  });

  const { data: gmailAccountsData, refetch: refetchGmail } = useQuery<{ accounts: GmailAccount[] }>({
    queryKey: ["/api/integrations/gmail/accounts"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/integrations/gmail/accounts");
      if (!res.ok) return { accounts: [] };
      return res.json();
    },
  });
  const gmailAccounts: GmailAccount[] = gmailAccountsData?.accounts || [];

  const handleGmailConnect = async () => {
    setGmailLoading(true);
    try {
      const res = await apiRequest("GET", "/api/integrations/gmail/connect");
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        toast({ title: data.error || "Failed to get connect URL", variant: "destructive" });
      }
    } catch {
      toast({ title: "Connection failed", variant: "destructive" });
    } finally {
      setGmailLoading(false);
    }
  };

  const handleGmailDisconnect = async (email: string) => {
    if (!confirm(`Отключить ${email}?`)) return;
    try {
      const res = await apiRequest("DELETE", `/api/integrations/gmail?email=${encodeURIComponent(email)}`);
      if (res.ok) {
        toast({ title: `${email} отключён` });
        refetchGmail();
      } else {
        toast({ title: "Не удалось отключить", variant: "destructive" });
      }
    } catch {
      toast({ title: "Не удалось отключить", variant: "destructive" });
    }
  };

  const getStatus = (connector: ConnectorDef): ConnectorStatus => {
    if (!connector.providerKey) return "coming_soon";
    const info = integrationStatus?.[connector.providerKey];
    return info?.connected ? "connected" : "disconnected";
  };

  const getEmail = (connector: ConnectorDef): string | undefined => {
    if (!connector.providerKey) return undefined;
    return integrationStatus?.[connector.providerKey]?.email;
  };

  const handleConnect = async (connector: ConnectorDef) => {
    if (!connector.connectEndpoint) {
      toast({ title: `${connector.name} integration coming soon` });
      return;
    }
    setLoadingId(connector.id);
    try {
      const res = await apiRequest("GET", connector.connectEndpoint);
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        toast({ title: "Failed to get connect URL", variant: "destructive" });
      }
    } catch {
      toast({ title: "Connection failed", variant: "destructive" });
    } finally {
      setLoadingId(null);
    }
  };

  const handleDisconnect = (connector: ConnectorDef) => {
    // Disconnect not yet supported in backend — show info
    toast({ title: `To disconnect ${connector.name}, please contact support` });
  };

  const connectedCount = CONNECTORS.filter((c) => getStatus(c) === "connected").length + (gmailAccounts.length > 0 ? 1 : 0);
  const totalCount = CONNECTORS.length + 1;

  return (
    <div className="min-h-full p-4 md:p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Plug className="w-5 h-5 text-[#C9A340]" />
          <h1 className="text-lg font-semibold text-foreground">Connectors</h1>
          <span className="text-xs text-muted-foreground/50">
            {connectedCount} / {totalCount} active
          </span>
        </div>
      </div>

      <p className="text-xs text-muted-foreground/60 leading-relaxed max-w-md">
        Connect external services so your AI agent can access your files, calendar, and messages.
      </p>

      {/* Gmail — multi-account card */}
      <div
        className="rounded-xl border border-white/[0.06] hover:border-[#C9A340]/20 transition-all duration-300 p-4"
        style={{ background: "rgba(255,255,255,0.03)" }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="text-2xl flex-shrink-0">📧</span>
            <div>
              <h3 className="text-sm font-medium text-foreground">Gmail</h3>
              <p className="text-[11px] text-muted-foreground/50 mt-0.5 leading-snug">
                Несколько ящиков, поиск и чтение писем
              </p>
            </div>
          </div>
          <span
            className={`text-[9px] font-medium px-2 py-0.5 rounded-full border flex-shrink-0 flex items-center gap-1 ${
              gmailAccounts.length > 0
                ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/25"
                : "bg-red-500/15 text-red-400 border-red-500/25"
            }`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${gmailAccounts.length > 0 ? "bg-emerald-400" : "bg-red-400"}`} />
            {gmailAccounts.length > 0 ? `${gmailAccounts.length} подключено` : "Не подключен"}
          </span>
        </div>

        {gmailAccounts.length > 0 && (
          <ul className="mt-3 ml-9 space-y-1">
            {gmailAccounts.map((a) => (
              <li key={a.id} className="flex items-center justify-between text-[11px] text-muted-foreground/70">
                <span className="truncate">{a.email}</span>
                <button
                  onClick={() => handleGmailDisconnect(a.email)}
                  className="ml-3 text-[10px] text-muted-foreground/40 hover:text-red-400"
                >
                  отключить
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-3 ml-9">
          <button
            onClick={handleGmailConnect}
            disabled={gmailLoading}
            className="h-7 text-[10px] px-3 rounded-md font-medium inline-flex items-center gap-1"
            style={{ background: "hsl(43 74% 52%)", color: "hsl(222 47% 8%)" }}
          >
            {gmailLoading ? "…" : (gmailAccounts.length > 0 ? "Добавить ещё Gmail" : "Подключить Gmail")}
          </button>
        </div>
      </div>

      {/* Connectors grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {CONNECTORS.map((connector) => (
          <ConnectorCard
            key={connector.id}
            connector={connector}
            status={getStatus(connector)}
            email={getEmail(connector)}
            onConnect={() => handleConnect(connector)}
            onDisconnect={() => handleDisconnect(connector)}
            loading={loadingId === connector.id}
          />
        ))}
      </div>
    </div>
  );
}
