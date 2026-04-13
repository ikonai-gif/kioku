import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Plus, Trash2, Bot, Clock, Key, Copy, Check, ShieldOff, Settings2, Eye, EyeOff, Crown, Lightbulb, Shield, Loader2, Users, Webhook, Radio, Zap } from "lucide-react";
import { AgentAvatar } from "@/lib/agent-icon";
import { cn } from "@/lib/utils";

const AGENT_COLORS = ["#D4AF37", "#3B82F6", "#A855F7", "#10B981", "#F97316", "#EF4444"];

const PROVIDER_MODELS: Record<string, string[]> = {
  openai: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"],
  gemini: ["gemini-2.0-flash", "gemini-2.5-flash", "gemini-2.5-pro", "gemini-3.1-pro"],
};

function timeAgo(ts: number | null): string {
  if (!ts) return "Never";
  const diff = Date.now() - ts;
  if (diff < 60000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
  return `${Math.round(diff / 86400000)}d ago`;
}

function AgentTokenSection({ agentId }: { agentId: number }) {
  const { toast } = useToast();
  const [newToken, setNewToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const { data: tokens = [], isLoading } = useQuery<any[]>({
    queryKey: [`/api/agents/${agentId}/tokens`],
  });

  const generateMutation = useMutation({
    mutationFn: () =>
      apiRequest("POST", `/api/agents/${agentId}/token`, { name: "default" }).then(r => r.json()),
    onSuccess: (data) => {
      setNewToken(data.token);
      setCopied(false);
      queryClient.invalidateQueries({ queryKey: [`/api/agents/${agentId}/tokens`] });
    },
    onError: () => toast({ title: "Failed to generate token", variant: "destructive" }),
  });

  const revokeMutation = useMutation({
    mutationFn: (tokenId: number) =>
      apiRequest("DELETE", `/api/agents/${agentId}/tokens/${tokenId}`).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/agents/${agentId}/tokens`] });
      toast({ title: "Token revoked" });
    },
    onError: () => toast({ title: "Failed to revoke token", variant: "destructive" }),
  });

  const handleCopy = async () => {
    if (!newToken) return;
    try {
      await navigator.clipboard.writeText(newToken);
      setCopied(true);
      toast({ title: "Token copied to clipboard" });
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({ title: "Failed to copy", variant: "destructive" });
    }
  };

  const handleDismissNewToken = () => {
    setNewToken(null);
  };

  const activeTokens = tokens.filter((t: any) => !t.revoked);
  const hasActiveToken = activeTokens.length > 0;

  // Just generated a token — show it once
  if (newToken) {
    return (
      <div className="mt-3 rounded-lg border border-[#D4AF37]/30 bg-[#D4AF37]/5 p-3 space-y-2">
        <div className="flex items-center gap-1.5 text-[10px] font-medium text-[#D4AF37]">
          <Key className="w-3 h-3" /> Token Generated — Save It Now
        </div>
        <div className="flex items-center gap-2">
          <code className="flex-1 text-[11px] bg-background/50 rounded px-2 py-1.5 font-mono text-foreground break-all select-all leading-relaxed">
            {newToken}
          </code>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0 shrink-0"
            onClick={handleCopy}
            data-testid={`button-copy-token-${agentId}`}
          >
            {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5 text-[#D4AF37]" />}
          </Button>
        </div>
        <p className="text-[10px] text-muted-foreground">This token won't be shown again.</p>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 text-[10px] text-muted-foreground px-2"
          onClick={handleDismissNewToken}
        >
          Dismiss
        </Button>
      </div>
    );
  }

  if (isLoading) {
    return <div className="mt-3 h-8 bg-muted/30 rounded-lg animate-pulse" />;
  }

  // Show existing active tokens
  if (hasActiveToken) {
    return (
      <div className="mt-3 space-y-1.5">
        {activeTokens.map((t: any) => (
          <div key={t.id} className="flex items-center justify-between gap-2 rounded-lg bg-muted/30 px-2.5 py-1.5">
            <div className="flex items-center gap-1.5 min-w-0">
              <Key className="w-3 h-3 text-[#D4AF37] shrink-0" />
              <span className="text-[11px] font-mono text-muted-foreground truncate">
                kat_{"••••••••"}
              </span>
            </div>
            <button
              className="text-[10px] text-muted-foreground/60 hover:text-red-400 flex items-center gap-1 transition-colors shrink-0"
              onClick={() => revokeMutation.mutate(t.id)}
              disabled={revokeMutation.isPending}
              data-testid={`button-revoke-token-${t.id}`}
            >
              <ShieldOff className="w-3 h-3" /> Revoke
            </button>
          </div>
        ))}
      </div>
    );
  }

  // No tokens — show Generate button
  return (
    <div className="mt-3">
      <Button
        size="sm"
        variant="outline"
        className="h-7 text-[10px] gap-1.5 border-[#D4AF37]/20 text-[#D4AF37] hover:bg-[#D4AF37]/10 hover:text-[#D4AF37] w-full sm:w-auto"
        onClick={() => generateMutation.mutate()}
        disabled={generateMutation.isPending}
        data-testid={`button-generate-token-${agentId}`}
      >
        <Key className="w-3 h-3" />
        {generateMutation.isPending ? "Generating…" : "Generate Token"}
      </Button>
    </div>
  );
}

function AgentLlmSection({ agent }: { agent: any }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState<string>(agent.llmProvider || "");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState<string>(agent.llmModel || "");
  const [showKey, setShowKey] = useState(false);
  const hasKey = !!agent.llmApiKey;

  const updateMutation = useMutation({
    mutationFn: (data: any) =>
      apiRequest("PATCH", `/api/agents/${agent.id}`, data).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
      toast({ title: "LLM config updated" });
      setApiKey("");
      setOpen(false);
    },
    onError: () => toast({ title: "Failed to update LLM config", variant: "destructive" }),
  });

  const clearMutation = useMutation({
    mutationFn: () =>
      apiRequest("PATCH", `/api/agents/${agent.id}`, { llmProvider: null, llmApiKey: null, llmModel: null }).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
      setProvider("");
      setApiKey("");
      setModel("");
      toast({ title: "Reverted to shared API key" });
    },
    onError: () => toast({ title: "Failed to clear LLM config", variant: "destructive" }),
  });

  const handleSave = () => {
    const updates: any = {};
    if (provider) updates.llmProvider = provider;
    if (apiKey) updates.llmApiKey = apiKey;
    if (model) updates.llmModel = model;
    else if (provider && PROVIDER_MODELS[provider]) updates.llmModel = PROVIDER_MODELS[provider][0];
    if (Object.keys(updates).length === 0) return;
    updateMutation.mutate(updates);
  };

  const availableModels = provider ? (PROVIDER_MODELS[provider] || []) : [];

  if (!open) {
    return (
      <button
        className="mt-2 flex items-center gap-1.5 text-[10px] text-muted-foreground/70 hover:text-[#D4AF37] transition-colors"
        onClick={() => setOpen(true)}
      >
        <Settings2 className="w-3 h-3" />
        {hasKey ? `Custom key (${agent.llmProvider || "?"}) · ${agent.llmModel || "default"}` : "LLM Settings"}
      </button>
    );
  }

  return (
    <div className="mt-3 rounded-lg border border-[#D4AF37]/20 bg-[#0A1628]/60 p-3 space-y-2.5">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-medium text-[#D4AF37] flex items-center gap-1.5">
          <Settings2 className="w-3 h-3" /> LLM Configuration
        </span>
        <button className="text-[10px] text-muted-foreground hover:text-foreground" onClick={() => setOpen(false)}>Close</button>
      </div>

      {/* Provider */}
      <div className="space-y-1">
        <label className="text-[10px] text-muted-foreground">Provider</label>
        <Select value={provider} onValueChange={(v) => { setProvider(v); setModel(""); }}>
          <SelectTrigger className="h-7 text-[11px] bg-background/30 border-border/40">
            <SelectValue placeholder="Default (shared key)" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="openai">OpenAI</SelectItem>
            <SelectItem value="gemini">Gemini</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* API Key */}
      {provider && (
        <div className="space-y-1">
          <label className="text-[10px] text-muted-foreground">API Key {hasKey && <span className="text-[#D4AF37]">(set: {agent.llmApiKey})</span>}</label>
          <div className="relative">
            <Input
              type={showKey ? "text" : "password"}
              placeholder={hasKey ? "Enter new key to replace" : `${provider === "openai" ? "sk-..." : "AIza..."}`}
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              className="h-7 text-[11px] pr-8 bg-background/30 border-border/40 font-mono"
            />
            <button
              type="button"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={() => setShowKey(!showKey)}
            >
              {showKey ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
            </button>
          </div>
        </div>
      )}

      {/* Model */}
      {provider && availableModels.length > 0 && (
        <div className="space-y-1">
          <label className="text-[10px] text-muted-foreground">Model</label>
          <Select value={model} onValueChange={setModel}>
            <SelectTrigger className="h-7 text-[11px] bg-background/30 border-border/40">
              <SelectValue placeholder={availableModels[0]} />
            </SelectTrigger>
            <SelectContent>
              {availableModels.map(m => (
                <SelectItem key={m} value={m}>{m}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 pt-1">
        <Button
          size="sm"
          className="h-6 text-[10px] px-3"
          style={{ background: "hsl(43 74% 52%)", color: "hsl(222 47% 8%)" }}
          onClick={handleSave}
          disabled={updateMutation.isPending || (!apiKey && !model && !provider)}
        >
          {updateMutation.isPending ? "Saving…" : "Save"}
        </Button>
        {hasKey && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 text-[10px] px-2 text-muted-foreground hover:text-red-400"
            onClick={() => clearMutation.mutate()}
            disabled={clearMutation.isPending}
          >
            {clearMutation.isPending ? "Clearing…" : "Use Shared Key"}
          </Button>
        )}
      </div>
    </div>
  );
}

function AgentConnectionSection({ agent }: { agent: any }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [agentType, setAgentType] = useState<string>(agent.agentType || "internal");
  const [webhookUrl, setWebhookUrl] = useState(agent.webhookUrl || "");
  const [webhookSecret, setWebhookSecret] = useState(agent.webhookSecret || "");
  const [showSecret, setShowSecret] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; status?: number; error?: string } | null>(null);

  const updateMutation = useMutation({
    mutationFn: (data: any) =>
      apiRequest("PATCH", `/api/agents/${agent.id}`, data).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
      toast({ title: "Connection type updated" });
      setOpen(false);
    },
    onError: () => toast({ title: "Failed to update connection", variant: "destructive" }),
  });

  const handleSave = () => {
    const updates: any = { agentType };
    if (agentType === "webhook") {
      updates.webhookUrl = webhookUrl || null;
      updates.webhookSecret = webhookSecret || null;
    } else {
      updates.webhookUrl = null;
      updates.webhookSecret = null;
    }
    updateMutation.mutate(updates);
  };

  const handleTestWebhook = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await apiRequest("POST", `/api/agents/${agent.id}/test-webhook`);
      const data = await res.json();
      setTestResult(data);
    } catch {
      setTestResult({ ok: false, error: "Request failed" });
    }
    setTesting(false);
  };

  const typeLabel = agent.agentType === "webhook" ? "Webhook" : agent.agentType === "polling" ? "Polling" : "Internal AI";
  const typeIcon = agent.agentType === "webhook" ? <Webhook className="w-3 h-3" /> : agent.agentType === "polling" ? <Radio className="w-3 h-3" /> : <Zap className="w-3 h-3" />;

  if (!open) {
    return (
      <button
        className="mt-2 flex items-center gap-1.5 text-[10px] text-muted-foreground/70 hover:text-[#D4AF37] transition-colors"
        onClick={() => setOpen(true)}
      >
        {typeIcon}
        <span>{typeLabel}</span>
        {agent.agentType === "webhook" && agent.webhookUrl && (
          <span className="text-[9px] text-muted-foreground/50 truncate max-w-[120px]">{agent.webhookUrl}</span>
        )}
      </button>
    );
  }

  return (
    <div className="mt-3 rounded-lg border border-[#D4AF37]/20 bg-[#0A1628]/60 p-3 space-y-2.5">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-medium text-[#D4AF37] flex items-center gap-1.5">
          <Webhook className="w-3 h-3" /> Connection Type
        </span>
        <button className="text-[10px] text-muted-foreground hover:text-foreground" onClick={() => setOpen(false)}>Close</button>
      </div>

      <div className="space-y-1">
        <label className="text-[10px] text-muted-foreground">Type</label>
        <Select value={agentType} onValueChange={setAgentType}>
          <SelectTrigger className="h-7 text-[11px] bg-background/30 border-border/40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="internal">Internal AI (OpenAI/Gemini)</SelectItem>
            <SelectItem value="webhook">Webhook (POST to URL)</SelectItem>
            <SelectItem value="polling">Polling (agent pulls turns)</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {agentType === "webhook" && (
        <>
          <div className="space-y-1">
            <label className="text-[10px] text-muted-foreground">Webhook URL</label>
            <Input
              placeholder="https://your-server.com/agent/respond"
              value={webhookUrl}
              onChange={e => setWebhookUrl(e.target.value)}
              className="h-7 text-[11px] bg-background/30 border-border/40 font-mono"
            />
          </div>
          <div className="space-y-1">
            <label className="text-[10px] text-muted-foreground">Webhook Secret (HMAC signing key)</label>
            <div className="relative">
              <Input
                type={showSecret ? "text" : "password"}
                placeholder="whk_..."
                value={webhookSecret}
                onChange={e => setWebhookSecret(e.target.value)}
                className="h-7 text-[11px] pr-8 bg-background/30 border-border/40 font-mono"
              />
              <button
                type="button"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => setShowSecret(!showSecret)}
              >
                {showSecret ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
              </button>
            </div>
          </div>
          {testResult && (
            <div className={cn("text-[10px] px-2 py-1 rounded", testResult.ok ? "text-green-400 bg-green-400/10" : "text-red-400 bg-red-400/10")}>
              {testResult.ok ? `Webhook responded: ${testResult.status}` : `Failed: ${testResult.error || `HTTP ${testResult.status}`}`}
            </div>
          )}
        </>
      )}

      {agentType === "polling" && (
        <div className="text-[10px] text-muted-foreground bg-muted/20 rounded p-2">
          Polling mode: Generate an agent token above, then poll <code className="text-[#D4AF37]">GET /api/agent/pending-turns</code> and respond via <code className="text-[#D4AF37]">POST /api/agent/turns/:id/respond</code>
        </div>
      )}

      <div className="flex items-center gap-2 pt-1">
        <Button
          size="sm"
          className="h-6 text-[10px] px-3"
          style={{ background: "hsl(43 74% 52%)", color: "hsl(222 47% 8%)" }}
          onClick={handleSave}
          disabled={updateMutation.isPending}
        >
          {updateMutation.isPending ? "Saving…" : "Save"}
        </Button>
        {agentType === "webhook" && webhookUrl && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 text-[10px] px-2 text-muted-foreground hover:text-[#D4AF37]"
            onClick={handleTestWebhook}
            disabled={testing}
          >
            {testing ? "Testing…" : "Test Webhook"}
          </Button>
        )}
      </div>
    </div>
  );
}

const QUICK_TEMPLATES = [
  {
    id: "executive-board",
    name: "Executive Board",
    icon: <Crown className="w-4 h-4" />,
    agents: [
      { name: "CFO-Agent", color: "#4ade80" },
      { name: "Legal-Agent", color: "#60a5fa" },
      { name: "Strategy-Agent", color: "#c084fc" },
      { name: "Ops-Agent", color: "#f59e0b" },
    ],
  },
  {
    id: "product-team",
    name: "Product Team",
    icon: <Lightbulb className="w-4 h-4" />,
    agents: [
      { name: "PM-Agent", color: "#34d399" },
      { name: "Design-Agent", color: "#f472b6" },
      { name: "Engineering-Agent", color: "#38bdf8" },
    ],
  },
  {
    id: "advisory-council",
    name: "Advisory Council",
    icon: <Shield className="w-4 h-4" />,
    agents: [
      { name: "Risk-Agent", color: "#ef4444" },
      { name: "Innovation-Agent", color: "#a78bfa" },
      { name: "Market-Agent", color: "#fb923c" },
    ],
  },
];

function QuickStartSection() {
  const { toast } = useToast();
  const [creatingId, setCreatingId] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: async (templateId: string) => {
      setCreatingId(templateId);
      const res = await apiRequest("POST", `/api/agents/templates/${templateId}`);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to create team");
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
      queryClient.invalidateQueries({ queryKey: ["/api/rooms"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: `${data.template} team created with ${data.agents.length} agents!` });
      setCreatingId(null);
    },
    onError: (err: Error) => {
      toast({ title: err.message, variant: "destructive" });
      setCreatingId(null);
    },
  });

  return (
    <div className="rounded-xl border border-[#D4AF37]/15 bg-gradient-to-r from-[#D4AF37]/[0.03] to-transparent p-4 sm:p-5 space-y-3">
      <div className="flex items-center gap-2">
        <Users className="w-4 h-4 text-[#D4AF37]" />
        <h2 className="text-sm font-semibold text-foreground">Quick Start</h2>
        <span className="text-[10px] text-muted-foreground">— Create a team with one click</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {QUICK_TEMPLATES.map((tpl) => (
          <div
            key={tpl.id}
            className="rounded-lg border border-white/5 bg-white/[0.02] p-3 space-y-2 hover:border-[#D4AF37]/20 transition-all"
          >
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-md bg-[#D4AF37]/10 text-[#D4AF37] flex items-center justify-center">
                {tpl.icon}
              </div>
              <span className="text-xs font-semibold text-foreground">{tpl.name}</span>
            </div>
            <div className="flex gap-1 flex-wrap">
              {tpl.agents.map((a) => (
                <span key={a.name} className="text-[9px] px-1.5 py-0.5 rounded-full bg-white/[0.03] border border-white/5" style={{ color: a.color }}>
                  {a.name}
                </span>
              ))}
            </div>
            <Button
              size="sm"
              className="w-full h-7 text-[10px] gap-1"
              style={{ background: "hsl(43 74% 52%)", color: "hsl(222 47% 8%)" }}
              onClick={() => createMutation.mutate(tpl.id)}
              disabled={createMutation.isPending}
            >
              {creatingId === tpl.id ? (
                <><Loader2 className="w-3 h-3 animate-spin" /> Creating...</>
              ) : (
                "Create Team"
              )}
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function AgentsPage() {
  const { toast } = useToast();
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", description: "", color: "#D4AF37", llmProvider: "", llmApiKey: "", llmModel: "", agentType: "internal", webhookUrl: "", webhookSecret: "" });

  const { data: agents = [], isLoading } = useQuery<any[]>({ queryKey: ["/api/agents"] });

  // Auto-suggest next agent name
  const nextAgentName = `Agent ${agents.length + 1}`;

  const createMutation = useMutation({
    mutationFn: (data: any) => apiRequest("POST", "/api/agents", data).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      setCreating(false);
      setForm({ name: "", description: "", color: "#D4AF37", llmProvider: "", llmApiKey: "", llmModel: "", agentType: "internal", webhookUrl: "", webhookSecret: "" });
      toast({ title: "Agent created" });
    },
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      apiRequest("PATCH", `/api/agents/${id}/toggle`, { enabled }).then(r => r.json()),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/agents"] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/agents/${id}`).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: "Agent removed" });
    },
  });

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-foreground">Agents</h1>
          <p className="text-sm text-muted-foreground mt-0.5">{agents.length} agent{agents.length !== 1 ? "s" : ""} in your workspace</p>
        </div>
        <Button
          size="sm"
          className="h-8 text-xs gap-1.5"
          style={{ background: "hsl(43 74% 52%)", color: "hsl(222 47% 8%)" }}
          onClick={() => setCreating(true)}
          data-testid="button-new-agent"
        >
          <Plus className="w-3.5 h-3.5" /> New Agent
        </Button>
      </div>

      {/* Quick Start Templates — show if fewer than 4 agents */}
      {!isLoading && agents.length < 4 && <QuickStartSection />}

      {isLoading && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1,2,3].map(i => (
            <div key={i} className="bg-card border border-card-border rounded-xl p-5 animate-pulse h-40" />
          ))}
        </div>
      )}

      {!isLoading && agents.length === 0 && (
        <div className="bg-card border border-card-border rounded-xl p-10 text-center">
          <Bot className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">No agents yet</p>
          <Button size="sm" variant="ghost" className="mt-3 text-xs" onClick={() => setCreating(true)}>
            Add your first agent
          </Button>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {agents.map((agent: any) => (
          <div key={agent.id} className={cn(
            "bg-card border border-card-border rounded-xl p-5 transition-all",
            !agent.enabled && "opacity-60"
          )} data-testid={`card-agent-${agent.id}`}>
            {/* Header */}
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-center gap-3">
                <AgentAvatar name={agent.name} color={agent.color} size="lg" />
                <div>
                  <div className="text-sm font-semibold text-foreground">{agent.name}</div>
                  <div className={cn(
                    "text-[10px] font-medium",
                    agent.status === "online" && agent.enabled ? "text-green-400"
                    : agent.status === "idle" ? "text-yellow-400"
                    : "text-muted-foreground"
                  )}>
                    {!agent.enabled ? "disabled" : agent.status}
                  </div>
                </div>
              </div>
              <Switch
                checked={!!agent.enabled}
                onCheckedChange={(v) => toggleMutation.mutate({ id: agent.id, enabled: v })}
                data-testid={`switch-agent-${agent.id}`}
              />
            </div>

            {agent.description && (
              <p className="text-xs text-muted-foreground mb-3 line-clamp-2">{agent.description}</p>
            )}

            {/* Stats */}
            <div className="grid grid-cols-2 gap-2 mb-3">
              <div className="bg-muted/50 rounded-lg p-2">
                <div className="text-sm font-bold text-foreground tabular-nums">{agent.memoriesCount.toLocaleString()}</div>
                <div className="text-[10px] text-muted-foreground">memories</div>
              </div>
              <div className="bg-muted/50 rounded-lg p-2">
                <div className="flex items-center gap-1 text-[10px] text-muted-foreground mt-0.5">
                  <Clock className="w-3 h-3" />
                  {timeAgo(agent.lastActiveAt)}
                </div>
                <div className="text-[10px] text-muted-foreground">last active</div>
              </div>
            </div>

            {/* Token */}
            <AgentTokenSection agentId={agent.id} />

            {/* LLM Config */}
            <AgentLlmSection agent={agent} />

            {/* Connection Type */}
            <AgentConnectionSection agent={agent} />

            {/* Delete */}
            <button
              className="mt-2 text-[10px] text-muted-foreground/50 hover:text-red-400 flex items-center gap-1 transition-colors"
              onClick={() => deleteMutation.mutate(agent.id)}
              data-testid={`button-delete-agent-${agent.id}`}
            >
              <Trash2 className="w-3 h-3" /> Remove
            </button>
          </div>
        ))}
      </div>

      {/* Create dialog */}
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm">New Agent</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium">Name</label>
              <Input
                placeholder={nextAgentName}
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                className="h-9 text-sm"
                data-testid="input-agent-name"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium">Description</label>
              <Input
                placeholder="What does this agent do?"
                value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                className="h-9 text-sm"
                data-testid="input-agent-description"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium">Color</label>
              <div className="flex gap-2">
                {AGENT_COLORS.map(c => (
                  <button
                    key={c}
                    className={cn("w-7 h-7 rounded-full border-2 transition-all",
                      form.color === c ? "border-foreground scale-110" : "border-transparent")}
                    style={{ background: c }}
                    onClick={() => setForm(f => ({ ...f, color: c }))}
                  />
                ))}
              </div>
            </div>
            {/* LLM Config (optional) */}
            <div className="space-y-1.5 pt-1 border-t border-border/30">
              <label className="text-[10px] font-medium text-muted-foreground">LLM Configuration (optional)</label>
              <Select value={form.llmProvider} onValueChange={(v) => setForm(f => ({ ...f, llmProvider: v, llmModel: "" }))}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="Default (shared key)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="openai">OpenAI</SelectItem>
                  <SelectItem value="gemini">Gemini</SelectItem>
                </SelectContent>
              </Select>
              {form.llmProvider && (
                <>
                  <Input
                    type="password"
                    placeholder={form.llmProvider === "openai" ? "sk-..." : "AIza..."}
                    value={form.llmApiKey}
                    onChange={e => setForm(f => ({ ...f, llmApiKey: e.target.value }))}
                    className="h-8 text-xs font-mono"
                  />
                  <Select value={form.llmModel} onValueChange={(v) => setForm(f => ({ ...f, llmModel: v }))}>
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue placeholder={(PROVIDER_MODELS[form.llmProvider] || [])[0] || "Select model"} />
                    </SelectTrigger>
                    <SelectContent>
                      {(PROVIDER_MODELS[form.llmProvider] || []).map(m => (
                        <SelectItem key={m} value={m}>{m}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </>
              )}
            </div>
            {/* Connection Type */}
            <div className="space-y-1.5 pt-1 border-t border-border/30">
              <label className="text-[10px] font-medium text-muted-foreground">Connection Type</label>
              <Select value={form.agentType} onValueChange={(v) => setForm(f => ({ ...f, agentType: v }))}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="internal">Internal AI</SelectItem>
                  <SelectItem value="webhook">Webhook</SelectItem>
                  <SelectItem value="polling">Polling</SelectItem>
                </SelectContent>
              </Select>
              {form.agentType === "webhook" && (
                <>
                  <Input
                    placeholder="https://your-server.com/agent/respond"
                    value={form.webhookUrl}
                    onChange={e => setForm(f => ({ ...f, webhookUrl: e.target.value }))}
                    className="h-8 text-xs font-mono"
                  />
                  <Input
                    type="password"
                    placeholder="Webhook secret (whk_...)"
                    value={form.webhookSecret}
                    onChange={e => setForm(f => ({ ...f, webhookSecret: e.target.value }))}
                    className="h-8 text-xs font-mono"
                  />
                </>
              )}
              {form.agentType === "polling" && (
                <p className="text-[10px] text-muted-foreground">Generate a token after creation to start polling.</p>
              )}
            </div>
            <Button
              className="w-full h-9 text-sm"
              style={{ background: "hsl(43 74% 52%)", color: "hsl(222 47% 8%)" }}
              onClick={() => {
                const payload: any = { name: form.name || nextAgentName, description: form.description, color: form.color };
                if (form.llmProvider) payload.llmProvider = form.llmProvider;
                if (form.llmApiKey) payload.llmApiKey = form.llmApiKey;
                if (form.llmModel) payload.llmModel = form.llmModel;
                if (form.agentType !== "internal") payload.agentType = form.agentType;
                if (form.agentType === "webhook" && form.webhookUrl) payload.webhookUrl = form.webhookUrl;
                if (form.agentType === "webhook" && form.webhookSecret) payload.webhookSecret = form.webhookSecret;
                createMutation.mutate(payload);
              }}
              disabled={createMutation.isPending}
              data-testid="button-create-agent-submit"
            >
              {createMutation.isPending ? "Creating…" : "Create Agent"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
