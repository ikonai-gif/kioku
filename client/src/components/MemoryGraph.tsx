import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MEMORY_NODES, MEMORY_LINKS, type MemoryNode } from "./memory-demo-data";

/**
 * Memory graph — rendered on a plain <canvas>.
 *
 * Node positions are pre-baked (see memory-demo-data.ts), so there is NO
 * force simulation and NO graph library at runtime: just draw + hit-test.
 * This keeps the landing's main-thread work and JS payload tiny (the previous
 * react-force-graph dependency added ~195 kB + heavy on-load CPU).
 */

const TYPE_COLOR: Record<MemoryNode["type"], string> = {
  identity: "43 78% 60%",
  semantic: "221 83% 66%",
  episodic: "262 83% 70%",
  procedural: "173 58% 54%",
};
const GOLD = "43 74% 55%";
const NOW = Date.UTC(2026, 5, 1);

const fmt = (ms: number) =>
  new Date(ms).toLocaleDateString("en-US", { month: "short", year: "numeric" });

const prefersReduced = () =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

const byId: Record<string, MemoryNode> = Object.fromEntries(MEMORY_NODES.map((n) => [n.id, n]));

export default function MemoryGraph({ variant = "hero" }: { variant?: "hero" | "page" }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sizeRef = useRef({ w: 0, h: 0 });
  const rafRef = useRef(0);
  const [hover, setHover] = useState<MemoryNode | null>(null);
  const [selected, setSelected] = useState<MemoryNode | null>(null);
  const reduce = useMemo(prefersReduced, []);
  const active = hover ?? selected;
  const activeRef = useRef<MemoryNode | null>(null);
  activeRef.current = active;

  const bounds = useMemo(() => {
    const xs = MEMORY_NODES.map((n) => n.x ?? 0);
    const ys = MEMORY_NODES.map((n) => n.y ?? 0);
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  }, []);

  const neighbors = useMemo(() => {
    const m = new Map<string, Set<string>>();
    MEMORY_NODES.forEach((n) => m.set(n.id, new Set([n.id])));
    MEMORY_LINKS.forEach((l) => {
      m.get(l.source)?.add(l.target);
      m.get(l.target)?.add(l.source);
    });
    return m;
  }, []);

  const tx = useCallback(() => {
    const { w, h } = sizeRef.current;
    const pad = variant === "hero" ? 46 : 30;
    const spanX = bounds.maxX - bounds.minX || 1;
    const spanY = bounds.maxY - bounds.minY || 1;
    const s = Math.min((w - 2 * pad) / spanX, (h - 2 * pad) / spanY);
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cy = (bounds.minY + bounds.maxY) / 2;
    return { s, cx, cy, w, h };
  }, [bounds, variant]);

  const draw = useCallback((time = 0) => {
    const cv = canvasRef.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    const { w, h } = sizeRef.current;
    if (!w || !h) return;
    const t = tx();
    const SX = (n: MemoryNode) => ((n.x ?? 0) - t.cx) * t.s + w / 2;
    const SY = (n: MemoryNode) => ((n.y ?? 0) - t.cy) * t.s + h / 2;
    const act = activeRef.current;
    ctx.clearRect(0, 0, w, h);

    // links
    for (const l of MEMORY_LINKS) {
      const a = byId[l.source];
      const b = byId[l.target];
      const on = act && (act.id === l.source || act.id === l.target);
      ctx.beginPath();
      ctx.moveTo(SX(a), SY(a));
      ctx.lineTo(SX(b), SY(b));
      ctx.strokeStyle = on ? `hsl(${GOLD} / 0.8)` : `hsl(${GOLD} / ${act ? 0.06 : 0.16})`;
      ctx.lineWidth = on ? 1.6 : 0.7;
      ctx.stroke();
    }

    // animated particles along the active node's causal links ("memory flowing")
    if (act && !reduce) {
      for (const l of MEMORY_LINKS) {
        if (l.source !== act.id && l.target !== act.id) continue;
        const a = byId[l.source];
        const b = byId[l.target];
        for (let k = 0; k < 3; k++) {
          const p = ((time / 1000) * 0.6 + k / 3) % 1;
          ctx.beginPath();
          ctx.arc(SX(a) + (SX(b) - SX(a)) * p, SY(a) + (SY(b) - SY(a)) * p, 2, 0, 2 * Math.PI);
          ctx.fillStyle = `hsl(${GOLD} / 0.9)`;
          ctx.fill();
        }
      }
    }

    // nodes
    for (const n of MEMORY_NODES) {
      const x = SX(n);
      const y = SY(n);
      const expired = n.validTo != null && n.validTo < NOW;
      const r = 4 + n.importance * 7;
      const on = !act || neighbors.get(act.id)?.has(n.id);
      const alpha = (expired ? 0.3 : 0.55 + n.confidence * 0.45) * (on ? 1 : 0.18);
      if ((n.reinforcements >= 6 || act?.id === n.id) && on) {
        ctx.beginPath();
        ctx.arc(x, y, r + 5, 0, 2 * Math.PI);
        ctx.fillStyle = `hsl(${GOLD} / 0.10)`;
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(x, y, r, 0, 2 * Math.PI);
      ctx.fillStyle = `hsl(${TYPE_COLOR[n.type]} / ${alpha})`;
      ctx.fill();
      ctx.lineWidth = act?.id === n.id ? 1.8 : 1;
      ctx.strokeStyle = `hsl(${GOLD} / ${on ? 0.85 : 0.2})`;
      if (expired) ctx.setLineDash([2, 2]);
      ctx.stroke();
      ctx.setLineDash([]);
      if ((act?.id === n.id || (variant === "hero" && n.importance > 0.7)) && on) {
        ctx.font = "11px Inter, sans-serif";
        ctx.fillStyle = `hsl(0 0% 96% / ${act?.id === n.id ? 0.95 : 0.7})`;
        ctx.textAlign = "center";
        ctx.fillText(n.label, x, y + r + 13);
      }
    }
  }, [tx, neighbors, reduce, variant]);

  // size canvas to its container (DPR-aware) and redraw
  useEffect(() => {
    const wrap = wrapRef.current;
    const cv = canvasRef.current;
    if (!wrap || !cv) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      const w = Math.round(r.width);
      const h = Math.round(r.height);
      sizeRef.current = { w, h };
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      cv.width = w * dpr;
      cv.height = h * dpr;
      cv.style.width = `${w}px`;
      cv.style.height = `${h}px`;
      const ctx = cv.getContext("2d");
      ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw(0);
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [draw]);

  // static redraw when highlight changes; run the particle loop only while hovering
  useEffect(() => {
    if (hover && !reduce) {
      const loop = (ts: number) => {
        draw(ts);
        rafRef.current = requestAnimationFrame(loop);
      };
      rafRef.current = requestAnimationFrame(loop);
      return () => cancelAnimationFrame(rafRef.current);
    }
    draw(0);
    return undefined;
  }, [hover, selected, reduce, draw]);

  const pick = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const cv = canvasRef.current;
    if (!cv) return null;
    const rect = cv.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const t = tx();
    let best: MemoryNode | null = null;
    let bestD = Infinity;
    for (const n of MEMORY_NODES) {
      const x = ((n.x ?? 0) - t.cx) * t.s + t.w / 2;
      const y = ((n.y ?? 0) - t.cy) * t.s + t.h / 2;
      const r = 4 + n.importance * 7 + 6;
      const d = (mx - x) ** 2 + (my - y) ** 2;
      if (d <= r * r && d < bestD) {
        bestD = d;
        best = n;
      }
    }
    return best;
  }, [tx]);

  return (
    <div ref={wrapRef} className="memory-graph-wrap">
      <canvas
        ref={canvasRef}
        style={{ display: "block", touchAction: "none", cursor: hover ? "pointer" : "default" }}
        onPointerMove={(e) => setHover(pick(e))}
        onPointerLeave={() => setHover(null)}
        onPointerDown={(e) => {
          const n = pick(e);
          if (n) setSelected((s) => (s?.id === n.id ? null : n));
        }}
      />

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
