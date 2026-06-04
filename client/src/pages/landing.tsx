import { useEffect, useRef, lazy, Suspense } from "react";
import { Brain, Wrench, CalendarClock, Mic, Shield, Globe } from "lucide-react";
import DemoChat from "@/components/DemoChat";
import logoSrc from "@assets/kioku-logo.jpg";

const MemoryGraph = lazy(() => import("@/components/MemoryGraph"));

const FEATURES = [
  { icon: Brain, title: "Volumetric Memory", desc: "Remembers everything across conversations" },
  { icon: Wrench, title: "24+ Built-in Tools", desc: "Search, code, create, analyze, schedule" },
  { icon: CalendarClock, title: "Smart Scheduling", desc: "Reminders and recurring tasks, hands-free" },
  { icon: Mic, title: "Voice & Text", desc: "Talk or type, your choice" },
  { icon: Shield, title: "Privacy First", desc: "Your data is encrypted and yours" },
  { icon: Globe, title: "Multi-language", desc: "English, Russian, and growing" },
] as const;

function scrollTo(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
}

// Apple-glass specular highlight that follows the cursor.
function onGlassMove(e: React.MouseEvent<HTMLElement>) {
  const t = e.currentTarget;
  const r = t.getBoundingClientRect();
  t.style.setProperty("--mx", `${((e.clientX - r.left) / r.width) * 100}%`);
  t.style.setProperty("--my", `${((e.clientY - r.top) / r.height) * 100}%`);
}

export default function LandingPage() {
  const observerRef = useRef<IntersectionObserver | null>(null);

  useEffect(() => {
    observerRef.current = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) entry.target.classList.add("landing-visible");
        });
      },
      { threshold: 0.1 },
    );
    document.querySelectorAll(".landing-fade-in").forEach((el) => {
      observerRef.current?.observe(el);
    });
    return () => observerRef.current?.disconnect();
  }, []);

  return (
    <div className="landing-page">
      {/* ── Nav ─────────────────────────────────────────── */}
      <nav className="landing-nav">
        <div className="landing-nav-inner">
          <div className="landing-nav-brand">
            <img src={logoSrc} alt="KIOKU" width={32} height={32} style={{ borderRadius: 8, objectFit: "cover" }} />
            <span className="landing-nav-logo">KIOKU™</span>
          </div>
          <div className="landing-nav-links">
            <button onClick={() => scrollTo("features")} className="landing-nav-link">Features</button>
            <button onClick={() => scrollTo("demo")} className="landing-nav-link">Demo</button>
            <a href="#/login" className="landing-nav-cta">Sign Up</a>
          </div>
        </div>
      </nav>

      {/* ── Hero: copy + live memory graph ──────────────── */}
      <section className="landing-hero">
        <div className="landing-hero-grid landing-fade-in">
          <div className="landing-hero-copy">
            <span className="landing-eyebrow">Persistent · Bi-temporal · Memory</span>
            <div className="landing-nav-brand" style={{ justifyContent: "flex-start", marginBottom: "0.75rem" }}>
              <img src={logoSrc} alt="KIOKU" width={40} height={40} className="gold-glow-strong" style={{ borderRadius: 10, objectFit: "cover" }} />
              <span className="landing-nav-logo" style={{ fontSize: "1.25rem" }}>KIOKU™</span>
            </div>
            <h1 className="landing-hero-title">Memory that outlives the conversation.</h1>
            <p className="landing-hero-sub">
              KIOKU gives AI agents persistent, bi-temporal memory — every fact linked by
              cause and effect, remembered across every conversation. This is a live demo
              graph; hover a node to trace its links, click to see how it lived over time.
            </p>
            <div className="landing-hero-btns">
              <button onClick={() => scrollTo("demo")} className="landing-btn-primary">Try Luca →</button>
              <a href="#/login" className="landing-btn-secondary glass" onMouseMove={onGlassMove}>Sign Up Free</a>
            </div>
          </div>
          <div className="landing-hero-graph glass" onMouseMove={onGlassMove}>
            <Suspense fallback={<div className="memory-graph-skeleton">building memory graph…</div>}>
              <MemoryGraph variant="hero" />
            </Suspense>
          </div>
        </div>
      </section>

      {/* ── Features ────────────────────────────────────── */}
      <section id="features" className="landing-features landing-fade-in">
        <h2 className="landing-section-title">What Makes Luca Different</h2>
        <div className="landing-features-grid">
          {FEATURES.map((f) => (
            <div key={f.title} className="landing-feature-card glass" onMouseMove={onGlassMove}>
              <f.icon className="landing-feature-icon" />
              <h3 className="landing-feature-title">{f.title}</h3>
              <p className="landing-feature-desc">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Live Demo ───────────────────────────────────── */}
      <section id="demo" className="landing-demo landing-fade-in">
        <h2 className="landing-section-title">Talk to Luca Right Now</h2>
        <p className="landing-demo-sub">No sign-up required. Ask anything about KIOKU™.</p>
        <div className="landing-demo-widget">
          <DemoChat />
        </div>
      </section>

      {/* ── CTA ─────────────────────────────────────────── */}
      <section className="landing-final-cta landing-fade-in">
        <h2 className="landing-cta-title">Ready for the Full Experience?</h2>
        <p className="landing-cta-sub">
          Persistent memory, 24+ tools, scheduling, voice — all free during beta.
        </p>
        <a href="#/login" className="landing-btn-primary" style={{ display: "inline-block" }}>
          Sign Up Free — It's Beta
        </a>
      </section>

      {/* ── Footer ──────────────────────────────────────── */}
      <footer className="landing-footer">
        <div className="landing-footer-inner">
          <span>&copy; 2026 IKONBAI™</span>
          <span className="landing-footer-sep">&middot;</span>
          <a href="#/privacy" className="landing-footer-link">Privacy</a>
          <span className="landing-footer-sep">&middot;</span>
          <a href="#/terms" className="landing-footer-link">Terms</a>
        </div>
      </footer>
    </div>
  );
}
