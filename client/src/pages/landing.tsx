import { useEffect, useRef } from "react";
import { Brain, Wrench, CalendarClock, Mic, Shield, Globe } from "lucide-react";
import DemoChat from "@/components/DemoChat";
import logoSrc from "@assets/kioku-logo.jpg";

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

export default function LandingPage() {
  const observerRef = useRef<IntersectionObserver | null>(null);

  useEffect(() => {
    observerRef.current = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("landing-visible");
          }
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
      {/* ── Nav ──────────────────────────────────────────── */}
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

      {/* ── Hero ──────────────────────────────────────────── */}
      <section className="landing-hero">
        <div className="landing-hero-inner landing-fade-in">
          <img
            src={logoSrc}
            alt="KIOKU"
            width={80}
            height={80}
            className="landing-hero-logo gold-glow-strong"
            style={{ borderRadius: 16, objectFit: "cover" }}
          />
          <h1 className="landing-hero-title">KIOKU™</h1>
          <p className="landing-hero-tagline">Your AI Companion That Actually Remembers</p>
          <p className="landing-hero-sub">
            Not just another chatbot. Luca is an AI agent with persistent memory,
            24+ tools, and a personality that grows with you.
          </p>
          <div className="landing-hero-btns">
            <button onClick={() => scrollTo("demo")} className="landing-btn-primary">
              Try Luca →
            </button>
            <a href="#/login" className="landing-btn-secondary">
              Sign Up Free
            </a>
          </div>
        </div>
      </section>

      {/* ── Features ──────────────────────────────────────── */}
      <section id="features" className="landing-features landing-fade-in">
        <h2 className="landing-section-title">What Makes Luca Different</h2>
        <div className="landing-features-grid">
          {FEATURES.map((f) => (
            <div key={f.title} className="landing-feature-card">
              <f.icon className="landing-feature-icon" />
              <h3 className="landing-feature-title">{f.title}</h3>
              <p className="landing-feature-desc">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Live Demo ─────────────────────────────────────── */}
      <section id="demo" className="landing-demo landing-fade-in">
        <h2 className="landing-section-title">Talk to Luca Right Now</h2>
        <p className="landing-demo-sub">No sign-up required. Ask anything about KIOKU™.</p>
        <div className="landing-demo-widget">
          <DemoChat />
        </div>
      </section>

      {/* ── CTA ───────────────────────────────────────────── */}
      <section className="landing-final-cta landing-fade-in">
        <h2 className="landing-cta-title">Ready for the Full Experience?</h2>
        <p className="landing-cta-sub">
          Persistent memory, 24+ tools, scheduling, voice — all free during beta.
        </p>
        <a href="#/login" className="landing-btn-primary" style={{ display: "inline-block" }}>
          Sign Up Free — It's Beta
        </a>
      </section>

      {/* ── Footer ─────────────────────────────────────────── */}
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
