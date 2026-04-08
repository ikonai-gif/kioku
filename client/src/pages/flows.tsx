import { useState, useRef, useCallback, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Plus, Trash2, ZoomIn, ZoomOut, Maximize2, X, Info, Save } from "lucide-react";
import { AgentAvatar } from "@/lib/agent-icon";
import { cn } from "@/lib/utils";

// ─── Flow palette — each flow gets one of these colors ───────────────────────
const FLOW_COLORS = [
  "#D4AF37", "#3B82F6", "#A855F7", "#10B981",
  "#F97316", "#EF4444", "#06B6D4", "#EC4899",
];

const CARD_W = 148;
const CARD_H = 76;

// ─── Canvas agent node ────────────────────────────────────────────────────────
function AgentNode({
  agent, x, y, flowColor, isConnecting,
  onMouseDown, onMouseUp, onConnectStart,
}: {
  agent: any; x: number; y: number; flowColor?: string;
  isConnecting: boolean;
  onMouseDown: (e: React.MouseEvent) => void;
  onMouseUp: () => void;
  onConnectStart: (e: React.MouseEvent) => void;
}) {
  const color = flowColor ?? agent.color;
  return (
    <g transform={`translate(${x},${y})`}
      onMouseDown={onMouseDown}
      onMouseUp={onMouseUp}
      style={{ cursor: isConnecting ? "crosshair" : "grab" }}
      data-testid={`canvas-agent-${agent.id}`}
    >
      {/* outer glow */}
      <rect x={-2} y={-2} width={CARD_W + 4} height={CARD_H + 4} rx={12}
        fill="none" stroke={color} strokeWidth={1.5} opacity={0.35} />
      {/* card */}
      <rect x={0} y={0} width={CARD_W} height={CARD_H} rx={10}
        fill="hsl(222 47% 10%)" stroke={color} strokeWidth={1} />
      {/* avatar */}
      <circle cx={30} cy={38} r={19} fill={color + "22"} />
      <text x={30} y={44} textAnchor="middle" fontSize={15} fontWeight="700" fill={color}>
        {agent.name[0]}
      </text>
      {/* name */}
      <text x={56} y={30} fontSize={11} fontWeight="600" fill="white" opacity={0.9}>
        {agent.name.length > 13 ? agent.name.slice(0, 13) + "…" : agent.name}
      </text>
      {/* status */}
      <circle cx={56} cy={46} r={3.5}
        fill={agent.status === "online" && agent.enabled ? "#4ade80"
          : agent.status === "idle" ? "#facc15" : "#6b7280"} />
      <text x={64} y={50} fontSize={9} fill="#888">
        {!agent.enabled ? "off" : agent.status}
      </text>
      {/* connect handle */}
      <circle cx={CARD_W} cy={CARD_H / 2} r={8} fill={color} opacity={0.9}
        onMouseDown={e => { e.stopPropagation(); onConnectStart(e); }}
        style={{ cursor: "crosshair" }} />
      <text x={CARD_W} y={CARD_H / 2 + 4.5} textAnchor="middle"
        fontSize={12} fill="white" fontWeight="bold" style={{ pointerEvents: "none" }}>+</text>
    </g>
  );
}

// ─── Curved arrow ─────────────────────────────────────────────────────────────
function Arrow({ fx, fy, tx, ty, color, label, selected, onClick }: {
  fx: number; fy: number; tx: number; ty: number;
  color: string; label: string; selected: boolean; onClick: () => void;
}) {
  const cp1x = fx + Math.abs(tx - fx) * 0.45;
  const cp2x = tx - Math.abs(tx - fx) * 0.45;
  const d = `M ${fx} ${fy} C ${cp1x} ${fy} ${cp2x} ${ty} ${tx} ${ty}`;
  const mx = (fx + tx) / 2;
  const my = (fy + ty) / 2 - 12;
  return (
    <g onClick={onClick} style={{ cursor: "pointer" }}>
      <path d={d} stroke="transparent" strokeWidth={18} fill="none" />
      <path d={d} stroke={selected ? color : color + "88"} strokeWidth={selected ? 2.5 : 1.5}
        fill="none" strokeDasharray={selected ? undefined : "7 3"} />
      <polygon points={`${tx},${ty} ${tx - 9},${ty - 5} ${tx - 9},${ty + 5}`} fill={selected ? color : color + "88"} />
      {label && (
        <foreignObject x={mx - 44} y={my - 10} width={88} height={22}>
          <div style={{ display: "flex", justifyContent: "center" }}>
            <span style={{
              fontSize: 9, fontWeight: 600, padding: "2px 7px",
              borderRadius: 999, background: color + "22", color,
              border: `1px solid ${color}44`, whiteSpace: "nowrap",
              maxWidth: 84, overflow: "hidden", textOverflow: "ellipsis",
            }}>{label}</span>
          </div>
        </foreignObject>
      )}
    </g>
  );
}

// ─── Main ────────────────────────────────────────────────────────────────────
export default function FlowsPage() {
  const { toast } = useToast();
  const svgRef = useRef<SVGSVGElement>(null);

  // canvas state
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 60, y: 40 });

  // positions of agents on canvas: { [agentId]: {x,y} }
  const [positions, setPositions] = useState<Record<number, { x: number; y: number }>>({});

  // connections: { id, fromAgentId, toAgentId, flowId, flowName, color }
  const [edges, setEdges] = useState<any[]>([]);

  // drag
  const dragRef = useRef<{ id: number; ox: number; oy: number } | null>(null);
  // pan
  const panRef = useRef({ active: false, sx: 0, sy: 0, ox: 0, oy: 0 });

  // connect mode
  const [connectFrom, setConnectFrom] = useState<number | null>(null);
  const [mouse, setMouse] = useState({ x: 0, y: 0 });

  // selected edge
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);

  // dialogs
  const [newFlowDialog, setNewFlowDialog] = useState<{ fromId: number; toId: number } | null>(null);
  const [flowName, setFlowName] = useState("");

  const { data: agents = [] } = useQuery<any[]>({ queryKey: ["/api/agents"] });
  const { data: flows = [] } = useQuery<any[]>({ queryKey: ["/api/flows"] });

  // agent roles state: { [agentId]: { role, task } }
  const [rolesEdit, setRolesEdit] = useState<Record<number, { role: string; task: string }>>({});
  const [rolesSaving, setRolesSaving] = useState(false);

  // ── Load roles when edge selected ────────────────────────────────────────
  useEffect(() => {
    if (!selectedEdge) return;
    const edgeData = edges.find(e => e.id === selectedEdge);
    if (!edgeData) return;
    const flow = (flows as any[]).find((f: any) => f.id === edgeData.flowId);
    if (!flow) return;
    try {
      const saved = JSON.parse(flow.agentRoles || "{}");
      const ids: number[] = JSON.parse(flow.agentIds || "[]");
      const init: Record<number, { role: string; task: string }> = {};
      ids.forEach(id => { init[id] = saved[id] ?? { role: "", task: "" }; });
      setRolesEdit(init);
    } catch {}
  }, [selectedEdge, flows]);

  // ── Load edges from flows ────────────────────────────────────────────────
  useEffect(() => {
    if (!flows.length) return;
    const newEdges: any[] = [];
    (flows as any[]).forEach((f: any, i: number) => {
      const ids: number[] = JSON.parse(f.agentIds || "[]");
      const color = FLOW_COLORS[i % FLOW_COLORS.length];
      // connect consecutive pairs
      for (let j = 0; j < ids.length - 1; j++) {
        newEdges.push({
          id: `${f.id}-${ids[j]}-${ids[j + 1]}`,
          fromId: ids[j], toId: ids[j + 1],
          flowId: f.id, flowName: f.name, color,
        });
      }
    });
    setEdges(newEdges);
  }, [flows]);

  // ── Load saved positions from flows ─────────────────────────────────────
  useEffect(() => {
    if (!flows.length) return;
    const merged: Record<number, { x: number; y: number }> = {};
    (flows as any[]).forEach((f: any) => {
      try {
        const pos = JSON.parse(f.positions || "{}");
        Object.assign(merged, pos);
      } catch {}
    });
    if (Object.keys(merged).length) {
      setPositions(prev => ({ ...merged, ...prev }));
    }
  }, [flows]);

  // ── SVG coordinate helper ────────────────────────────────────────────────
  const toSVG = (cx: number, cy: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: (cx - rect.left - pan.x) / scale, y: (cy - rect.top - pan.y) / scale };
  };

  // ── Drag agent from sidebar onto canvas ──────────────────────────────────
  const handleSidebarDragStart = (e: React.DragEvent, agentId: number) => {
    e.dataTransfer.setData("agentId", String(agentId));
  };

  const handleCanvasDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const id = Number(e.dataTransfer.getData("agentId"));
    if (!id) return;
    const pos = toSVG(e.clientX, e.clientY);
    setPositions(prev => ({ ...prev, [id]: { x: pos.x - CARD_W / 2, y: pos.y - CARD_H / 2 } }));
  };

  // ── Node drag ────────────────────────────────────────────────────────────
  const startDrag = (e: React.MouseEvent, id: number) => {
    if (connectFrom !== null) return;
    e.stopPropagation();
    const sv = toSVG(e.clientX, e.clientY);
    const pos = positions[id] || { x: 0, y: 0 };
    dragRef.current = { id, ox: sv.x - pos.x, oy: sv.y - pos.y };
  };

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const sv = toSVG(e.clientX, e.clientY);
    setMouse(sv);
    if (dragRef.current) {
      const { id, ox, oy } = dragRef.current;
      setPositions(prev => ({ ...prev, [id]: { x: sv.x - ox, y: sv.y - oy } }));
    }
    if (panRef.current.active) {
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPan({ x: panRef.current.ox + e.clientX - panRef.current.sx, y: panRef.current.oy + e.clientY - panRef.current.sy });
    }
  }, [pan, scale]);

  const handleMouseUp = () => { dragRef.current = null; panRef.current.active = false; };

  // ── Connect ──────────────────────────────────────────────────────────────
  const startConnect = (e: React.MouseEvent, id: number) => {
    e.stopPropagation();
    setConnectFrom(id);
  };

  const endConnect = (toId: number) => {
    if (connectFrom === null || connectFrom === toId) { setConnectFrom(null); return; }
    const exists = edges.find(e => e.fromId === connectFrom && e.toId === toId);
    if (!exists) setNewFlowDialog({ fromId: connectFrom, toId });
    setConnectFrom(null);
  };

  // ── Create flow mutation ─────────────────────────────────────────────────
  const createMutation = useMutation({
    mutationFn: (data: any) => apiRequest("POST", "/api/flows", data).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/flows"] });
      setNewFlowDialog(null);
      setFlowName("");
      toast({ title: "Flow created" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/flows/${id}`).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/flows"] });
      setSelectedEdge(null);
      toast({ title: "Flow deleted" });
    },
  });

  // helpers
  const agentById = (id: number) => (agents as any[]).find((a: any) => a.id === id);
  const canvasAgents = (agents as any[]).filter((a: any) => positions[a.id] !== undefined);
  const nextFlowName = `Flow ${(flows as any[]).length + 1}`;
  const fromAgent = connectFrom != null ? agentById(connectFrom) : null;
  const fromPos = connectFrom != null ? positions[connectFrom] : null;
  const pendingLine = fromPos ? {
    fx: fromPos.x + CARD_W, fy: fromPos.y + CARD_H / 2,
  } : null;

  const selectedEdgeData = selectedEdge ? edges.find(e => e.id === selectedEdge) : null;

  const zoom = (d: number) => setScale(s => Math.max(0.3, Math.min(2.5, s + d)));
  const resetView = () => { setScale(1); setPan({ x: 60, y: 40 }); };

  return (
    <div className="flex h-screen overflow-hidden">

      {/* ── Left sidebar: agent palette ─────────────────────────────────── */}
      <div className="hidden md:flex w-52 flex-shrink-0 border-r border-border bg-card flex-col">
        <div className="px-4 py-3 border-b border-border">
          <p className="text-xs font-semibold text-foreground">Agents</p>
          <p className="text-[10px] text-muted-foreground mt-0.5">Drag onto canvas →</p>
        </div>
        <div className="flex-1 overflow-auto p-3 space-y-2">
          {(agents as any[]).length === 0 && (
            <p className="text-[10px] text-muted-foreground text-center py-6">
              No agents yet.<br />Create them in Agents.
            </p>
          )}
          {(agents as any[]).map((agent: any) => {
            const onCanvas = !!positions[agent.id];
            return (
              <div
                key={agent.id}
                draggable={!onCanvas}
                onDragStart={e => handleSidebarDragStart(e, agent.id)}
                className={cn(
                  "flex items-center gap-2 px-3 py-2.5 rounded-lg border transition-all select-none",
                  onCanvas
                    ? "border-border opacity-40 cursor-default"
                    : "border-border hover:border-primary/40 cursor-grab active:cursor-grabbing hover:bg-muted/30"
                )}
                data-testid={`sidebar-agent-${agent.id}`}
              >
                <AgentAvatar name={agent.name} color={agent.color} size="sm" />
                <span className="text-xs text-foreground truncate">{agent.name}</span>
                {onCanvas && <span className="text-[9px] text-muted-foreground ml-auto">placed</span>}
              </div>
            );
          })}
        </div>

        {/* Flows list */}
        <div className="border-t border-border px-4 py-3">
          <p className="text-xs font-semibold text-foreground mb-2">Flows ({(flows as any[]).length})</p>
          <div className="space-y-1.5">
            {(flows as any[]).map((f: any, i: number) => {
              const color = FLOW_COLORS[i % FLOW_COLORS.length];
              const ids: number[] = JSON.parse(f.agentIds || "[]");
              return (
                <div key={f.id} className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: color }} />
                  <span className="text-[10px] text-foreground truncate flex-1">{f.name}</span>
                  <span className="text-[9px] text-muted-foreground">{ids.length}a</span>
                </div>
              );
            })}
            {(flows as any[]).length === 0 && (
              <p className="text-[10px] text-muted-foreground">Connect agents to create flows</p>
            )}
          </div>
        </div>
      </div>

      {/* ── Canvas area ─────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Toolbar */}
        <div className="px-5 py-3 border-b border-border flex items-center justify-between bg-background flex-shrink-0">
          <div>
            <h1 className="text-sm font-semibold text-foreground">Agent Flows</h1>
            <p className="text-[10px] text-muted-foreground">Drag agents → canvas. Click <strong>+</strong> handle → draw connection → create flow.</p>
          </div>
          <div className="flex items-center gap-1.5">
            <button onClick={() => zoom(0.15)} className="p-1.5 rounded hover:bg-muted transition-colors" title="Zoom in"><ZoomIn className="w-3.5 h-3.5" /></button>
            <button onClick={() => zoom(-0.15)} className="p-1.5 rounded hover:bg-muted transition-colors" title="Zoom out"><ZoomOut className="w-3.5 h-3.5" /></button>
            <button onClick={resetView} className="p-1.5 rounded hover:bg-muted transition-colors" title="Reset"><Maximize2 className="w-3.5 h-3.5" /></button>
            <span className="text-[10px] text-muted-foreground w-8 text-right">{Math.round(scale * 100)}%</span>
          </div>
        </div>

        {/* Connect mode hint */}
        {connectFrom !== null && (
          <div className="px-5 py-2 bg-primary/10 border-b border-border text-[11px] flex items-center gap-2 flex-shrink-0">
            <div className="w-2 h-2 rounded-full animate-pulse" style={{ background: fromAgent?.color }} />
            <span>Connecting from <strong style={{ color: fromAgent?.color }}>{fromAgent?.name}</strong> — click <strong>+</strong> on another agent. Press <kbd className="bg-muted px-1 rounded text-[10px]">Esc</kbd> to cancel.</span>
          </div>
        )}

        {/* Canvas */}
        <div
          className="flex-1 relative overflow-hidden"
          style={{ background: "hsl(222 47% 5.5%)", cursor: connectFrom ? "crosshair" : "default" }}
          onDragOver={e => e.preventDefault()}
          onDrop={handleCanvasDrop}
        >
          {/* Dot grid */}
          <svg className="absolute inset-0 w-full h-full pointer-events-none">
            <defs>
              <pattern id="dots" x={pan.x % (24 * scale)} y={pan.y % (24 * scale)}
                width={24 * scale} height={24 * scale} patternUnits="userSpaceOnUse">
                <circle cx={1} cy={1} r={0.9} fill="hsl(222 47% 18%)" />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="url(#dots)" />
          </svg>

          {/* Empty state */}
          {canvasAgents.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="text-center opacity-50">
                <div className="w-14 h-14 rounded-2xl border border-dashed border-border flex items-center justify-center mx-auto mb-3">
                  <Plus className="w-6 h-6 text-muted-foreground" />
                </div>
                <p className="text-xs text-muted-foreground">Drag agents from the left panel</p>
              </div>
            </div>
          )}

          <svg
            ref={svgRef}
            className="absolute inset-0 w-full h-full"
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseDown={e => {
              if (e.button === 1 || (e.button === 0 && e.altKey)) {
                panRef.current = { active: true, sx: e.clientX, sy: e.clientY, ox: pan.x, oy: pan.y };
                e.preventDefault();
              }
              if (connectFrom !== null) { setConnectFrom(null); setSelectedEdge(null); }
            }}
            onClick={() => setSelectedEdge(null)}
            tabIndex={0}
            onKeyDown={e => { if (e.key === "Escape") { setConnectFrom(null); setSelectedEdge(null); } }}
          >
            <g transform={`translate(${pan.x},${pan.y}) scale(${scale})`}>

              {/* Edges */}
              {edges.map(edge => {
                const fp = positions[edge.fromId];
                const tp = positions[edge.toId];
                if (!fp || !tp) return null;
                return (
                  <Arrow key={edge.id}
                    fx={fp.x + CARD_W} fy={fp.y + CARD_H / 2}
                    tx={tp.x} ty={tp.y + CARD_H / 2}
                    color={edge.color} label={edge.flowName}
                    selected={selectedEdge === edge.id}
                    onClick={() => setSelectedEdge(edge.id)}
                  />
                );
              })}

              {/* Pending line */}
              {pendingLine && fromAgent && (
                <line x1={pendingLine.fx} y1={pendingLine.fy} x2={mouse.x} y2={mouse.y}
                  stroke={fromAgent.color} strokeWidth={2} strokeDasharray="7 3" opacity={0.7} />
              )}

              {/* Agent nodes */}
              {canvasAgents.map((agent: any) => {
                const pos = positions[agent.id]!;
                // find flow color for this agent
                const flowEdge = edges.find(e => e.fromId === agent.id || e.toId === agent.id);
                return (
                  <AgentNode key={agent.id} agent={agent}
                    x={pos.x} y={pos.y}
                    flowColor={flowEdge?.color}
                    isConnecting={connectFrom !== null}
                    onMouseDown={e => startDrag(e, agent.id)}
                    onMouseUp={() => { if (connectFrom !== null) endConnect(agent.id); }}
                    onConnectStart={e => startConnect(e, agent.id)}
                  />
                );
              })}
            </g>
          </svg>
        </div>
      </div>

      {/* ── Right panel: selected edge/flow info ─────────────────────────── */}
      {selectedEdgeData && (() => {
        const fa = agentById(selectedEdgeData.fromId);
        const ta = agentById(selectedEdgeData.toId);
        const flow = (flows as any[]).find((f: any) => f.id === selectedEdgeData.flowId);
        const agentIds: number[] = flow ? JSON.parse(flow.agentIds || "[]") : [];
        return (
          <div className="w-64 border-l border-border bg-card flex flex-col flex-shrink-0">
            <div className="px-4 py-3 border-b border-border flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-2.5 h-2.5 rounded-full" style={{ background: selectedEdgeData.color }} />
                <span className="text-xs font-semibold text-foreground">{selectedEdgeData.flowName}</span>
              </div>
              <button onClick={() => setSelectedEdge(null)} className="text-muted-foreground hover:text-foreground">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="px-4 py-3 space-y-3 flex-1">
              <div>
                <p className="text-[10px] text-muted-foreground mb-1.5">Agents in this flow</p>
                <div className="space-y-1.5">
                  {agentIds.map(id => {
                    const a = agentById(id);
                    if (!a) return null;
                    return (
                      <div key={id} className="flex items-center gap-2">
                        <div className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold"
                          style={{ background: a.color + "33", color: a.color }}>{a.name[0]}</div>
                        <span className="text-xs text-foreground">{a.name}</span>
                        <div className={cn("w-1.5 h-1.5 rounded-full ml-auto",
                          a.status === "online" && a.enabled ? "bg-green-400" : "bg-yellow-400")} />
                      </div>
                    );
                  })}
                </div>
              </div>

              {flow?.description && (
                <p className="text-[10px] text-muted-foreground">{flow.description}</p>
              )}

              {/* ── Role & Task per agent ── */}
              <div className="pt-1 space-y-3">
                <p className="text-[10px] font-semibold text-foreground">Roles & Tasks</p>
                {agentIds.map(id => {
                  const a = agentById(id);
                  if (!a) return null;
                  const entry = rolesEdit[id] ?? { role: "", task: "" };
                  return (
                    <div key={id} className="space-y-1.5 p-2.5 rounded-lg border border-border">
                      <div className="flex items-center gap-1.5 mb-1">
                        <div className="w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold"
                          style={{ background: a.color + "33", color: a.color }}>{a.name[0]}</div>
                        <span className="text-[10px] font-semibold" style={{ color: a.color }}>{a.name}</span>
                      </div>
                      <Input
                        placeholder="Role (e.g. Orchestrator)"
                        value={entry.role}
                        onChange={e => setRolesEdit(r => ({ ...r, [id]: { ...entry, role: e.target.value } }))}
                        className="h-7 text-[11px] px-2"
                        data-testid={`input-role-${id}`}
                      />
                      <Input
                        placeholder="Task (e.g. Review outputs)"
                        value={entry.task}
                        onChange={e => setRolesEdit(r => ({ ...r, [id]: { ...entry, task: e.target.value } }))}
                        className="h-7 text-[11px] px-2"
                        data-testid={`input-task-${id}`}
                      />
                    </div>
                  );
                })}
                <Button
                  size="sm"
                  className="w-full h-8 text-xs gap-1.5"
                  style={{ background: "hsl(43 74% 52%)", color: "hsl(222 47% 8%)" }}
                  disabled={rolesSaving}
                  data-testid="button-save-roles"
                  onClick={async () => {
                    setRolesSaving(true);
                    try {
                      await apiRequest("PATCH", `/api/flows/${selectedEdgeData.flowId}`, { agentRoles: rolesEdit });
                      await queryClient.invalidateQueries({ queryKey: ["/api/flows"] });
                      toast({ title: "Roles saved" });
                    } finally { setRolesSaving(false); }
                  }}
                >
                  <Save className="w-3 h-3" />
                  {rolesSaving ? "Saving…" : "Save Roles"}
                </Button>
              </div>
            </div>

            <div className="px-4 py-3 border-t border-border">
              <Button
                size="sm" variant="ghost"
                className="w-full h-8 text-xs text-red-400 hover:text-red-400 hover:bg-red-400/10"
                onClick={() => deleteMutation.mutate(selectedEdgeData.flowId)}
                disabled={deleteMutation.isPending}
                data-testid={`button-delete-flow-${selectedEdgeData.flowId}`}
              >
                <Trash2 className="w-3 h-3 mr-1.5" /> Delete Flow
              </Button>
            </div>
          </div>
        );
      })()}

      {/* ── Create flow dialog ────────────────────────────────────────────── */}
      <Dialog open={!!newFlowDialog} onOpenChange={() => { setNewFlowDialog(null); setFlowName(""); }}>
        <DialogContent className="sm:max-w-xs">
          <DialogHeader>
            <DialogTitle className="text-sm">Name this Flow</DialogTitle>
          </DialogHeader>
          {newFlowDialog && (() => {
            const fa = agentById(newFlowDialog.fromId);
            const ta = agentById(newFlowDialog.toId);
            const previewColor = FLOW_COLORS[(flows as any[]).length % FLOW_COLORS.length];
            return (
              <div className="space-y-4">
                {/* Preview */}
                <div className="flex items-center gap-2 rounded-lg p-3 border border-border">
                  <div className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold"
                    style={{ background: fa?.color + "33", color: fa?.color }}>{fa?.name[0]}</div>
                  <span className="text-xs">{fa?.name}</span>
                  <div className="flex-1 h-px" style={{ background: previewColor + "66" }} />
                  <div className="w-2 h-2 rounded-full" style={{ background: previewColor }} />
                  <div className="flex-1 h-px" style={{ background: previewColor + "66" }} />
                  <span className="text-xs">{ta?.name}</span>
                  <div className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold"
                    style={{ background: ta?.color + "33", color: ta?.color }}>{ta?.name[0]}</div>
                </div>
                <Input
                  placeholder={nextFlowName}
                  value={flowName}
                  onChange={e => setFlowName(e.target.value)}
                  className="h-9 text-sm"
                  autoFocus
                  onKeyDown={e => { if (e.key === "Enter") {
                    createMutation.mutate({ name: flowName || nextFlowName, agentIds: [newFlowDialog.fromId, newFlowDialog.toId] });
                  }}}
                  data-testid="input-flow-name"
                />
                <Button className="w-full h-9 text-sm"
                  style={{ background: "hsl(43 74% 52%)", color: "hsl(222 47% 8%)" }}
                  onClick={() => createMutation.mutate({ name: flowName || nextFlowName, agentIds: [newFlowDialog.fromId, newFlowDialog.toId] })}
                  disabled={createMutation.isPending}
                  data-testid="button-create-flow-submit"
                >
                  {createMutation.isPending ? "Creating…" : "Create Flow"}
                </Button>
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>
    </div>
  );
}
