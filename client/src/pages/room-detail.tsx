import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Send, CheckCircle2, Star, Bot, Wifi, WifiOff } from "lucide-react";
import { AgentAvatar, getAgentIcon } from "@/lib/agent-icon";
import { Link } from "wouter";
import { cn } from "@/lib/utils";

const FLOW_COLORS = [
  "#D4AF37", "#3B82F6", "#A855F7", "#10B981",
  "#F97316", "#EF4444", "#06B6D4", "#EC4899",
];

export default function RoomDetailPage({ params }: { params: { id: string } }) {
  const roomId = Number(params.id);
  const { toast } = useToast();
  const [speakingAs, setSpeakingAs] = useState<any | null>(null);
  const [input, setInput] = useState("");
  const [isDecision, setIsDecision] = useState(false);
  const [showDecisions, setShowDecisions] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const { data: allRooms = [] } = useQuery<any[]>({ queryKey: ["/api/rooms"] });
  const room = (allRooms as any[]).find((r: any) => r.id === roomId) ?? null;

  const { data: agents = [] } = useQuery<any[]>({ queryKey: ["/api/agents"] });
  const { data: flows = [] } = useQuery<any[]>({ queryKey: ["/api/flows"] });

  const { data: messages = [], isLoading: msgsLoading } = useQuery<any[]>({
    queryKey: ["/api/rooms", roomId, "messages"],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/rooms/${roomId}/messages`);
      return r.json();
    },
    refetchInterval: 4000,
  });

  const roomAgentIds: number[] = room ? JSON.parse(room.agentIds || "[]") : [];
  const roomAgents = (agents as any[]).filter((a: any) => roomAgentIds.includes(a.id));

  // Auto-select first agent
  useEffect(() => {
    if (roomAgents.length > 0 && !speakingAs) setSpeakingAs(roomAgents[0]);
  }, [roomAgents.length]);

  // Auto-scroll
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  const sendMutation = useMutation({
    mutationFn: (data: any) =>
      apiRequest("POST", `/api/rooms/${roomId}/messages`, data).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/rooms", roomId, "messages"] });
      setInput("");
      setIsDecision(false);
    },
    onError: () => toast({ title: "Failed to send", variant: "destructive" }),
  });

  function send() {
    if (!input.trim() || !speakingAs) return;
    sendMutation.mutate({
      agentId: speakingAs.id,
      agentName: speakingAs.name,
      agentColor: speakingAs.color,
      content: input.trim(),
      isDecision,
    });
  }

  // Get flow color for room
  const getFlowInfo = () => {
    const result: Array<{ flow: any; color: string; agentIds: number[] }> = [];
    (flows as any[]).forEach((f: any, i: number) => {
      const fIds: number[] = JSON.parse(f.agentIds || "[]");
      if (roomAgentIds.some(id => fIds.includes(id))) {
        result.push({ flow: f, color: FLOW_COLORS[i % FLOW_COLORS.length], agentIds: fIds });
      }
    });
    return result;
  };

  const flowInfo = getFlowInfo();

  const decisions = (messages as any[]).filter((m: any) => !!m.isDecision);
  const chat = showDecisions ? decisions : (messages as any[]);

  return (
    <div className="flex flex-col h-screen overflow-hidden">

      {/* ── Top bar ──────────────────────────────────────────────────────── */}
      <div className="flex-shrink-0 border-b border-border bg-background">
        {/* Room header */}
        <div className="px-5 py-3 flex items-center gap-3">
          <Link href="/rooms">
            <a className="text-muted-foreground hover:text-foreground transition-colors">
              <ArrowLeft className="w-4 h-4" />
            </a>
          </Link>
          <div className="flex-1 min-w-0">
            <h1 className="text-sm font-semibold text-foreground">{room?.name ?? "Room"}</h1>
            {room?.description && (
              <p className="text-[10px] text-muted-foreground">{room.description}</p>
            )}
          </div>
          {/* decisions toggle */}
          <button
            className={cn("flex items-center gap-1.5 text-[10px] px-2.5 py-1.5 rounded-lg border transition-all",
              showDecisions
                ? "bg-yellow-400/10 text-yellow-400 border-yellow-400/30"
                : "border-border text-muted-foreground hover:border-muted-foreground/40")}
            onClick={() => setShowDecisions(d => !d)}
          >
            <Star className="w-3 h-3" />
            Decisions ({decisions.length})
          </button>
        </div>

        {/* ── Colored flow labels ───────────────────────────────────────── */}
        {flowInfo.length > 0 && (
          <div className="px-5 pb-3 flex items-center gap-2 flex-wrap">
            <span className="text-[10px] text-muted-foreground">Flows:</span>
            {flowInfo.map(({ flow, color, agentIds }) => {
              const flowAgents = (agents as any[]).filter((a: any) => agentIds.includes(a.id) && roomAgentIds.includes(a.id));
              return (
                <div key={flow.id}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-medium cursor-pointer hover:opacity-80 transition-opacity"
                  style={{ background: color + "20", color, border: `1px solid ${color}44` }}
                  onClick={() => {
                    // select first agent of this flow
                    if (flowAgents[0]) setSpeakingAs(flowAgents[0]);
                  }}
                  title={`Click to speak as ${flowAgents[0]?.name}`}
                >
                  <div className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />
                  {flow.name}
                  <span className="opacity-60 ml-1">
                    {flowAgents.map((a: any) => a.name).join(", ")}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Messages area ────────────────────────────────────────────────── */}
      {/* ── AI Disclosure (FTC/EU AI Act) ──────────────────────────────── */}
      <div className="mx-3 md:mx-5 mt-2 px-3 py-2 rounded-lg bg-yellow-400/5 border border-yellow-400/15 flex items-center gap-2">
        <Bot className="w-3.5 h-3.5 text-yellow-400/70 flex-shrink-0" />
        <p className="text-[10px] text-muted-foreground/60 leading-relaxed">
          <span className="font-semibold text-yellow-400/70">AI Disclosure:</span>{" "}
          This War Room™ may include AI-generated responses. Content does not constitute professional advice.
          KIOKU™ is a product of IKONBAI™, Inc.
        </p>
      </div>

      <div className="flex-1 overflow-auto px-3 md:px-5 py-4 space-y-3">
        {msgsLoading && (
          <div className="space-y-3">
            {[1, 2, 3].map(i => <div key={i} className="h-14 bg-card rounded-xl animate-pulse" />)}
          </div>
        )}

        {!msgsLoading && chat.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <Bot className="w-9 h-9 text-muted-foreground mb-3 opacity-40" />
            <p className="text-sm text-muted-foreground">
              {showDecisions ? "No decisions logged yet" : "No messages yet"}
            </p>
            <p className="text-xs text-muted-foreground/50 mt-1">
              {showDecisions
                ? "Mark a message as Decision to log it here"
                : "Select an agent below and start the discussion"}
            </p>
          </div>
        )}

        {chat.map((msg: any) => (
          <div key={msg.id}
            className={cn(
              "flex gap-3 items-start group",
              msg.isDecision && "bg-yellow-400/5 border border-yellow-400/15 rounded-xl p-3"
            )}
            data-testid={`msg-${msg.id}`}
          >
            <AgentAvatar name={msg.agentName ?? ""} color={msg.agentColor} size="sm" className="mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                <span className="text-xs font-semibold" style={{ color: msg.agentColor }}>
                  {msg.agentName}
                </span>
                <span className="text-[10px] text-muted-foreground/40">
                  {new Date(msg.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
                {!!msg.isDecision && (
                  <span className="flex items-center gap-1 text-[10px] text-yellow-400 font-medium">
                    <Star className="w-2.5 h-2.5" fill="currentColor" /> Decision
                  </span>
                )}
              </div>
              <p className="text-sm text-foreground leading-relaxed">{msg.content}</p>
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* ── Input area ───────────────────────────────────────────────────── */}
      <div className="flex-shrink-0 border-t border-border bg-background px-3 md:px-5 py-3 md:py-4 space-y-2.5">

        {/* ── In Room — participant toggle strip ── */}
        {roomAgents.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap border-b border-border pb-3">
            <span className="text-[10px] text-muted-foreground">In Room:</span>
            {roomAgents.map((a: any) => {
              const online = a.status === "online";
              return (
                <button
                  key={a.id}
                  data-testid={`button-toggle-agent-${a.id}`}
                  onClick={() => {
                    const newStatus = online ? "offline" : "online";
                    apiRequest("PATCH", `/api/agents/${a.id}/toggle`, { status: newStatus })
                      .then(() => queryClient.invalidateQueries({ queryKey: ["/api/agents"] }));
                  }}
                  title={online ? `${a.name} — click to disable` : `${a.name} — click to enable`}
                  className={cn(
                    "flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border transition-all",
                    online
                      ? "border-transparent"
                      : "border-border text-muted-foreground opacity-40 grayscale hover:opacity-60"
                  )}
                  style={online ? { background: a.color + "22", border: `1px solid ${a.color}55`, color: a.color } : {}}
                >
                  <div className={cn("w-1.5 h-1.5 rounded-full", online ? "animate-pulse" : "bg-muted-foreground/30")}
                    style={online ? { background: a.color } : {}} />
                  <AgentAvatar name={a.name} color={a.color} size="sm" />
                  {a.name}
                  {online
                    ? <Wifi className="w-2.5 h-2.5 opacity-60" />
                    : <WifiOff className="w-2.5 h-2.5" />}
                </button>
              );
            })}
          </div>
        )}

        {/* Speaking as — agent pills */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] text-muted-foreground">Speaking as:</span>
          {roomAgents.length === 0 && (
            <span className="text-[10px] text-muted-foreground/50">No agents — add agents when creating the room</span>
          )}
          {roomAgents.map((a: any) => {
            const active = speakingAs?.id === a.id;
            return (
              <button key={a.id}
                className={cn("text-[11px] px-3 py-1 rounded-full font-medium border transition-all",
                  active ? "text-[hsl(222_47%_8%)]" : "border-border text-muted-foreground hover:border-muted-foreground/50")}
                style={active ? { background: a.color, border: `1px solid ${a.color}` } : {}}
                onClick={() => setSpeakingAs(a)}
                data-testid={`button-speak-as-${a.id}`}
              >
                {a.name}
              </button>
            );
          })}

          <label className="ml-auto flex items-center gap-1.5 cursor-pointer select-none">
            <input type="checkbox" className="w-3 h-3 accent-yellow-400"
              checked={isDecision} onChange={e => setIsDecision(e.target.checked)}
              data-testid="checkbox-is-decision" />
            <span className="text-[10px] text-muted-foreground">Mark as Decision</span>
          </label>
        </div>

        {/* Text input */}
        <div className="flex gap-2">
          {speakingAs && (
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg flex-shrink-0"
              style={{ background: speakingAs.color + "20", border: `1px solid ${speakingAs.color}44` }}>
              <div className="w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold"
                style={{ background: speakingAs.color + "33", color: speakingAs.color }}>
                {speakingAs.name[0]}
              </div>
              <span className="text-[10px] font-medium" style={{ color: speakingAs.color }}>
                {speakingAs.name}
              </span>
            </div>
          )}
          <input
            ref={inputRef}
            className="flex-1 bg-muted/40 border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 outline-none focus:border-primary/40 transition-colors"
            placeholder={
              speakingAs
                ? `${speakingAs.name}: type a message, command, or task…`
                : "Select an agent to speak as"
            }
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            disabled={!speakingAs || sendMutation.isPending}
            data-testid="input-room-message"
          />
          <Button size="sm" className="h-9 px-3 flex-shrink-0"
            style={{
              background: isDecision ? "hsl(48 96% 53%)" : "hsl(43 74% 52%)",
              color: "hsl(222 47% 8%)"
            }}
            onClick={send}
            disabled={!input.trim() || !speakingAs || sendMutation.isPending}
            data-testid="button-send-message"
          >
            <Send className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}
