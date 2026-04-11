import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Plus, Trash2, MessageSquare, ArrowRight } from "lucide-react";
import { Link } from "wouter";
import { cn, safeParseIds } from "@/lib/utils";

const FLOW_COLORS = [
  "#D4AF37", "#3B82F6", "#A855F7", "#10B981",
  "#F97316", "#EF4444", "#06B6D4", "#EC4899",
];

const statusColors: Record<string, string> = {
  active: "bg-green-400/10 text-green-400 border-green-400/20",
  standby: "bg-yellow-400/10 text-yellow-400 border-yellow-400/20",
  idle: "bg-muted text-muted-foreground border-border",
};

export default function RoomsPage() {
  const { toast } = useToast();
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", description: "" });
  const [selectedAgents, setSelectedAgents] = useState<number[]>([]);

  const { data: rooms = [], isLoading } = useQuery<any[]>({ queryKey: ["/api/rooms"] });
  const { data: agents = [] } = useQuery<any[]>({ queryKey: ["/api/agents"] });
  const { data: flows = [] } = useQuery<any[]>({ queryKey: ["/api/flows"] });

  const nextRoomName = `Room ${(rooms as any[]).length + 1}`;

  const createMutation = useMutation({
    mutationFn: (data: any) => apiRequest("POST", "/api/rooms", data).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/rooms"] });
      setCreating(false);
      setForm({ name: "", description: "" });
      setSelectedAgents([]);
      toast({ title: "Room created" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/rooms/${id}`).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/rooms"] });
      toast({ title: "Room deleted" });
    },
  });

  const updateStatusMutation = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) =>
      apiRequest("PATCH", `/api/rooms/${id}`, { status }).then(r => r.json()),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/rooms"] }),
  });

  const agentById = (id: number) => (agents as any[]).find((a: any) => a.id === id);

  // Get flow color for a set of agents
  const flowColorForAgents = (agentIds: number[]) => {
    const idx = (flows as any[]).findIndex((f: any) => {
      const fIds: number[] = safeParseIds(f.agentIds);
      return agentIds.some(id => fIds.includes(id));
    });
    return idx >= 0 ? FLOW_COLORS[idx % FLOW_COLORS.length] : "#D4AF37";
  };

  const toggleAgent = (id: number) => {
    setSelectedAgents(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  // Add entire flow's agents at once
  const addFlow = (f: any) => {
    const ids: number[] = safeParseIds(f.agentIds);
    setSelectedAgents(prev => Array.from(new Set([...prev, ...ids])));
  };

  return (
    <div className="p-4 md:p-6 max-w-4xl mx-auto space-y-4 md:space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-foreground">Deliberation Rooms</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Spaces where agents discuss, deliberate, and reach decisions
          </p>
        </div>
        <Button size="sm" className="h-8 text-xs gap-1.5"
          style={{ background: "hsl(43 74% 52%)", color: "hsl(222 47% 8%)" }}
          onClick={() => setCreating(true)}
          data-testid="button-new-room"
        >
          <Plus className="w-3.5 h-3.5" /> New Room
        </Button>
      </div>

      {isLoading && (
        <div className="space-y-3">
          {[1, 2].map(i => <div key={i} className="bg-card border border-border rounded-xl h-28 animate-pulse" />)}
        </div>
      )}

      {!isLoading && (rooms as any[]).length === 0 && (
        <div className="bg-card border border-border rounded-xl p-12 text-center">
          <MessageSquare className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">No rooms yet</p>
          <p className="text-xs text-muted-foreground/60 mt-1">Create a room and invite agents from your flows</p>
          <Button size="sm" variant="ghost" className="mt-3 text-xs" onClick={() => setCreating(true)}>
            Create first room
          </Button>
        </div>
      )}

      <div className="space-y-3">
        {(rooms as any[]).map((room: any) => {
          const roomAgentIds: number[] = safeParseIds(room.agentIds);
          const roomColor = flowColorForAgents(roomAgentIds);

          return (
            <div key={room.id}
              className="bg-card border border-border rounded-xl p-5 hover:border-primary/30 transition-colors"
              data-testid={`card-room-${room.id}`}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  {/* Room name + color dot */}
                  <div className="flex items-center gap-2 mb-1">
                    <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: roomColor }} />
                    <h3 className="text-sm font-semibold text-foreground">{room.name}</h3>
                  </div>
                  {room.description && (
                    <p className="text-xs text-muted-foreground mb-3 pl-4">{room.description}</p>
                  )}

                  {/* Agents */}
                  <div className="flex items-center gap-2 pl-4 flex-wrap">
                    <span className="text-[10px] text-muted-foreground">Agents:</span>
                    {roomAgentIds.length === 0 && (
                      <span className="text-[10px] text-muted-foreground/50">none</span>
                    )}
                    {roomAgentIds.map(id => {
                      const a = agentById(id);
                      if (!a) return null;
                      return (
                        <span key={id}
                          className="text-[10px] px-2 py-0.5 rounded-full font-medium"
                          style={{ background: a.color + "22", color: a.color, border: `1px solid ${a.color}44` }}
                        >
                          {a.name}
                        </span>
                      );
                    })}
                  </div>
                </div>

                {/* Right side */}
                <div className="flex items-center gap-2 flex-shrink-0">
                  {/* Status */}
                  <div className="flex gap-1">
                    {["active", "standby", "idle"].map(s => (
                      <button key={s}
                        className={cn("text-[10px] px-2 py-0.5 rounded-full font-medium border transition-all",
                          room.status === s ? statusColors[s] : "border-transparent text-muted-foreground hover:text-foreground")}
                        onClick={() => updateStatusMutation.mutate({ id: room.id, status: s })}
                        data-testid={`button-room-status-${room.id}-${s}`}
                      >{s}</button>
                    ))}
                  </div>

                  <Link href={`/rooms/${room.id}`}>
                    <a className="flex items-center gap-1 text-[10px] font-medium text-primary hover:text-primary/80">
                      Open <ArrowRight className="w-3 h-3" />
                    </a>
                  </Link>

                  <button
                    className="text-muted-foreground/40 hover:text-red-400 transition-colors"
                    onClick={() => deleteMutation.mutate(room.id)}
                    data-testid={`button-delete-room-${room.id}`}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Create dialog */}
      <Dialog open={creating} onOpenChange={() => { setCreating(false); setSelectedAgents([]); setForm({ name: "", description: "" }); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm">New Deliberation Room</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-xs font-medium">Room Name</label>
              <Input placeholder={nextRoomName} value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                className="h-9 text-sm" data-testid="input-room-name" />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium">Purpose (optional)</label>
              <Input placeholder="What will they deliberate on?" value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                className="h-9 text-sm" />
            </div>

            {/* Add from flow */}
            {(flows as any[]).length > 0 && (
              <div className="space-y-1.5">
                <label className="text-xs font-medium">Add from Flow</label>
                <div className="flex flex-wrap gap-1.5">
                  {(flows as any[]).map((f: any, i: number) => {
                    const color = FLOW_COLORS[i % FLOW_COLORS.length];
                    return (
                      <button key={f.id}
                        className="text-[10px] px-2.5 py-1 rounded-full font-medium border transition-all hover:opacity-80"
                        style={{ background: color + "22", color, border: `1px solid ${color}44` }}
                        onClick={() => addFlow(f)}
                      >+ {f.name}</button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Agent selector */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium">Select Agents</label>
              <div className="flex flex-wrap gap-1.5">
                {(agents as any[]).map((a: any) => {
                  const sel = selectedAgents.includes(a.id);
                  return (
                    <button key={a.id}
                      className={cn("text-[10px] px-2.5 py-1 rounded-full font-medium border transition-all",
                        sel ? "text-[hsl(222_47%_8%)]" : "border-border text-muted-foreground hover:border-muted-foreground/50")}
                      style={sel ? { background: a.color, border: `1px solid ${a.color}` } : {}}
                      onClick={() => toggleAgent(a.id)}
                      data-testid={`button-select-agent-${a.id}`}
                    >{a.name}</button>
                  );
                })}
              </div>
              {selectedAgents.length > 0 && (
                <p className="text-[10px] text-muted-foreground">{selectedAgents.length} agent{selectedAgents.length > 1 ? "s" : ""} selected</p>
              )}
            </div>

            <Button className="w-full h-9 text-sm"
              style={{ background: "hsl(43 74% 52%)", color: "hsl(222 47% 8%)" }}
              onClick={() => createMutation.mutate({
                name: form.name || nextRoomName,
                description: form.description,
                agentIds: selectedAgents,
              })}
              disabled={createMutation.isPending}
              data-testid="button-create-room-submit"
            >
              {createMutation.isPending ? "Creating…" : "Create Room"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
