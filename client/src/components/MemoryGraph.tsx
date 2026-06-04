import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D from "react-force-graph-2d";
import { MEMORY_NODES, MEMORY_LINKS, type MemoryNode } from "./memory-demo-data";

type GNode = MemoryNode & { x?: number; y?: number };

const TYPE_COLOR: Record<MemoryNode["type"], string> = {
  identity: "43 78% 60%",
  semantic: "221 83% 66%",
  episodic: "262 83% 70%",
  procedural: "173 58% 54%",
};
const GOLD = "43 74% 55%";

const fmt = (ms: number) =>
  new Date(ms).toLocaleDateString("en-US", { month: "short", year: "numeric" });

function prefersReduced() {
  return typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

export default function MemoryGraph({ variant = "hero" }: { variant?: "hero" | "page" }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<any>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<GNode | null>(null);
  const [selected, setSelected] = useState<GNode | null>(null);
  const reduce = useMemo(prefersReduced, []);

  // Clone so the simulation never mutates the shared module data.
  const data = useMemo(
    () => ({
      nodes: MEMORY_NODES.map((n) => ({ ...n })),
      links: MEMORY_LINKS.map((l) => ({ ...l })),
    }),
    [],
  );

  // Neighbors for hover-highlight of causal chains.
  const neighbors = useMemo(() => {
    const m = new Map<string, Set<string>>();
    MEMORY_NODES.forEach((n) => m.set(n.id, new Set([n.id])));
    MEMORY_LINKS.forEach((l) => {
      m.get(l.source)?.add(l.target);
      m.get(l.target)?.add(l.source);
    });
    return m;
  }, []);

  useEffect(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setSize({ w: Math.round(r.width), h: Math.round(r.height) });
    });
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  const active = hover ?? selected;
  const lit = useCallback(
    (id: string) => !active || neighbors.get(active.id)?.has(id),
    [active, neighbors],
  );

  const drawNode = useCallback(
    (node: GNode, ctx: CanvasRenderingContext2D, scale: number) => {
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      const expired = node.validTo != null && node.validTo < Date.UTC(2026, 5, 1);
      const r = 3 + node.importance * 7;
      const on = lit(node.id);
      const alpha = (expired ? 0.28 : 0.55 + node.confidence * 0.45) * (on ? 1 : 0.18);

      // glow for reinforced / active nodes
      if ((node.reinforcements >= 6 || active?.id === node.id) && on) {
        ctx.beginPath();
        ctx.arc(x, y, r + 5, 0, 2 * Math.PI);
        ctx.fillStyle = `hsl(${GOLD} / 0.10)`;
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(x, y, r, 0, 2 * Math.PI);
      ctx.fillStyle = `hsl(${TYPE_COLOR[node.type]} / ${alpha})`;
      ctx.fill();
      ctx.lineWidth = active?.id === node.id ? 1.6 / scale : 1 / scale;
      ctx.strokeStyle = `hsl(${GOLD} / ${on ? 0.85 : 0.2})`;
      if (expired) ctx.setLineDash([2 / scale, 2 / scale]);
      ctx.stroke();
      ctx.setLineDash([]);

      // labels: when zoomed in, or for the active node, or important hero nodes
      const showLabel =
        active?.id === node.id || scale > 1.4 || (variant === "hero" && node.importance > 0.7);
      if (showLabel && on) {
        const fs = Math.max(9, 11 / scale);
        ctx.font = `${fs}px Inter, sans-serif`;
        ctx.fillStyle = `hsl(0 0% 96% / ${active?.id === node.id ? 0.95 : 0.7})`;
        ctx.textAlign = "center";
        ctx.fillText(node.label, x, y + r + fs + 1);
      }
    },
    [active, lit, variant],
  );

  const idOf = (e: any) => (typeof e === "object" ? e.id : e);
  const linkActive = useCallback(
    (l: any) => active != null && (idOf(l.source) === active.id || idOf(l.target) === active.id),
    [active],
  );

  return (
    <div ref={wrapRef} className="memory-graph-wrap">
      {size.w > 0 && (
        <ForceGraph2D
          ref={fgRef}
          width={size.w}
          height={size.h}
          graphData={data}
          backgroundColor="rgba(0,0,0,0)"
          nodeRelSize={1}
          nodeCanvasObject={drawNode as any}
          nodePointerAreaPaint={(node: any, color, ctx) => {
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(node.x ?? 0, node.y ?? 0, 6 + node.importance * 7, 0, 2 * Math.PI);
            ctx.fill();
          }}
          linkColor={(l: any) =>
            linkActive(l) ? `hsl(${GOLD} / 0.8)` : `hsl(${GOLD} / ${active ? 0.06 : 0.16})`
          }
          linkWidth={(l: any) => (linkActive(l) ? 1.6 : 0.6)}
          linkDirectionalParticles={(l: any) => (!reduce && linkActive(l) ? 3 : 0)}
          linkDirectionalParticleWidth={2}
          linkDirectionalParticleColor={() => `hsl(${GOLD} / 0.9)`}
          cooldownTicks={reduce ? 0 : undefined}
          warmupTicks={reduce ? 60 : 0}
          enableZoomInteraction={variant === "page"}
          enablePanInteraction={variant === "page"}
          onNodeHover={(n: any) => setHover(n ?? null)}
          onNodeClick={(n: any) => setSelected((s) => (s?.id === n.id ? null : n))}
          onEngineStop={() => fgRef.current?.zoomToFit(400, variant === "hero" ? 36 : 24)}
        />
      )}

      {selected && (
        <div className="memory-graph-card glass" role="dialog" aria-label="Memory detail">
          <button className="memory-graph-card-x" onClick={() => setSelected(null)} aria-label="Close">×</button>
          <div className="memory-graph-card-type">{selected.type}</div>
          <div className="memory-graph-card-label">{selected.label}</div>
          <div className="memory-graph-card-meters">
            <span>importance {selected.importance.toFixed(2)}</span>
            <span>confidence {(selected.confidence * 100).toFixed(0)}%</span>
            <span>reinforced {selected.reinforcements}×</span>
          </div>
          <div className="memory-graph-card-temporal">
            <span className="mgc-dot" />
            {fmt(selected.validFrom)} → {selected.validTo == null ? "now" : `${fmt(selected.validTo)} (expired)`}
          </div>
        </div>
      )}

      <div className="sr-only">
        Demo memory graph: {MEMORY_NODES.length} synthetic memories linked by cause and effect.
      </div>
    </div>
  );
}
