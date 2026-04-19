import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Plug } from "lucide-react";
import ConnectorCard, { type ConnectorDef, type ConnectorStatus } from "@/components/ConnectorCard";

// ── Connector definitions ──────────────────────────────────────────────
const CONNECTORS: ConnectorDef[] = [
  {
    id: "gmail",
    name: "Gmail",
    emoji: "📧",
    description: "Access emails and search your inbox",
    providerKey: undefined, // Not yet supported in backend
  },
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

export default function ConnectorsPage() {
  const { toast } = useToast();
  const [loadingId, setLoadingId] = useState<string | null>(null);

  const { data: integrationStatus } = useQuery<Record<string, { connected: boolean; email?: string }>>({
    queryKey: ["/api/integrations/status"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/integrations/status");
      if (!res.ok) return {};
      return res.json();
    },
  });

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

  const connectedCount = CONNECTORS.filter((c) => getStatus(c) === "connected").length;

  return (
    <div className="min-h-full p-4 md:p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Plug className="w-5 h-5 text-[#C9A340]" />
          <h1 className="text-lg font-semibold text-foreground">Connectors</h1>
          <span className="text-xs text-muted-foreground/50">
            {connectedCount} / {CONNECTORS.length} active
          </span>
        </div>
      </div>

      <p className="text-xs text-muted-foreground/60 leading-relaxed max-w-md">
        Connect external services so your AI agent can access your files, calendar, and messages.
      </p>

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
