import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest, API_BASE } from "@/lib/queryClient";
import { getSessionToken } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Send, ArrowLeft, Menu, Volume2, Mic, MicOff, ImagePlus, X, Loader2, Sparkles, PenLine, Palette, Copy, Download, FileText, Heart, ThumbsUp, Meh, ThumbsDown, Angry, ChevronDown, ChevronUp, Plus, Camera, Video, File, MoreVertical, Trash2, Search, Layers, Image as ImageIcon, Code, Package, Check, ExternalLink, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "../App";
import { Link } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CapabilityCards } from "@/components/CapabilityCards";
import { TaskProgress, type ToolStep } from "@/components/TaskProgress";
import { ActionPanel } from "@/components/ActionPanel";
import { ActionPanelToggle } from "@/components/ActionPanelToggle";
import { type Artifact, type ArtifactCategory } from "@/components/ArtifactViewer";
import { DailyBriefCard, isDailyBriefMessage } from "@/components/DailyBriefCard";
import { useIsMobile } from "@/hooks/use-mobile";

// ── Cookie helpers for voice preferences ─────────────────────
function getCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp("(?:^|; )" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "=([^;]*)"));
  return match ? decodeURIComponent(match[1]) : null;
}

function setCookie(name: string, value: string, days = 365) {
  const expires = new Date(Date.now() + days * 864e5).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/; SameSite=Lax`;
}

// ── Global audio playback (avoids Safari autoplay issues) ──────
let globalAudioUnlocked = false;
function unlockAudio() {
  if (globalAudioUnlocked) return;
  const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
  const buf = ctx.createBuffer(1, 1, 22050);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start(0);
  globalAudioUnlocked = true;
}
// Unlock on first user interaction
if (typeof window !== "undefined") {
  const doUnlock = () => { unlockAudio(); window.removeEventListener("touchstart", doUnlock); window.removeEventListener("click", doUnlock); };
  window.addEventListener("touchstart", doUnlock, { once: true });
  window.addEventListener("click", doUnlock, { once: true });
}

// ── Emotion → Glow Color Map ─────────────────────────────────────
const EMOTION_GLOW: Record<string, string> = {
  relaxed: "#60A5FA",
  neutral: "#60A5FA",
  docile: "#60A5FA",
  exuberant: "#C9A340",
  dependent: "#C9A340",
  anxious: "#A855F7",
  hostile: "#EF4444",
  disdainful: "#EF4444",
  sad: "#6B7280",
};

function getGlowColor(emotion: string): string {
  return EMOTION_GLOW[emotion] || "#60A5FA";
}

// ── Luca Avatar ─────────────────────────────────────────────────
function LucaAvatar({ emotion, size = 40, pulse = false }: { emotion: string; size?: number; pulse?: boolean }) {
  const glowColor = getGlowColor(emotion);
  return (
    <div
      className={cn("relative flex-shrink-0 flex items-center justify-center rounded-full", pulse && "animate-pulse")}
      style={{
        width: size,
        height: size,
        background: "linear-gradient(135deg, #0a0f1e 0%, #1a2744 100%)",
        border: `2px solid ${glowColor}44`,
        boxShadow: `0 0 12px ${glowColor}33, 0 0 24px ${glowColor}18`,
        transition: "box-shadow 2.5s ease, border-color 2.5s ease",
      }}
    >
      <span
        className="font-bold select-none"
        style={{
          color: "#C9A340",
          fontSize: size * 0.4,
          fontFamily: "Inter, sans-serif",
          letterSpacing: "-0.02em",
        }}
      >
        L
      </span>
    </div>
  );
}

// ── Typing Indicator ─────────────────────────────────────────────
function TypingIndicator({ emotion }: { emotion: string }) {
  const glowColor = getGlowColor(emotion);
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      className="flex items-center gap-2 px-4 py-3"
    >
      <LucaAvatar emotion={emotion} size={28} pulse />
      <div
        className="flex items-center gap-1 px-3 py-2 rounded-2xl"
        style={{
          background: "rgba(255,255,255,0.05)",
          border: "1px solid rgba(255,255,255,0.08)",
          boxShadow: `0 0 8px ${glowColor}10`,
        }}
      >
        {[0, 1, 2].map((i) => (
          <motion.div
            key={i}
            className="w-1.5 h-1.5 rounded-full"
            style={{ background: glowColor }}
            animate={{ opacity: [0.3, 1, 0.3], scale: [0.8, 1.1, 0.8] }}
            transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.2 }}
          />
        ))}
      </div>
    </motion.div>
  );
}

// ── Speaker Button on Luca messages ─────────────────────────────
function SpeakButton({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "loading" | "playing">("idle");
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const speak = async () => {
    if (state === "playing") {
      audioRef.current?.pause();
      setState("idle");
      return;
    }
    setState("loading");
    try {
      const token = getSessionToken();
      const res = await fetch(`${API_BASE}/api/partner/speak`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { "x-session-token": token } : {}),
        },
        credentials: "include",
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error("TTS failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => {
        setState("idle");
        URL.revokeObjectURL(url);
      };
      audio.onerror = () => {
        setState("idle");
        URL.revokeObjectURL(url);
      };
      setState("playing");
      await audio.play();
    } catch {
      setState("idle");
    }
  };

  return (
    <motion.button
      onClick={speak}
      className="inline-flex items-center justify-center w-8 h-8 rounded-full transition-colors"
      style={{
        background: state === "playing" ? "rgba(201,163,64,0.25)" : "rgba(255,255,255,0.06)",
        color: state === "playing" ? "#C9A340" : "rgba(255,255,255,0.4)",
      }}
      animate={state === "playing" ? { boxShadow: ["0 0 4px #C9A34055", "0 0 12px #C9A34088", "0 0 4px #C9A34055"] } : {}}
      transition={state === "playing" ? { duration: 1.5, repeat: Infinity } : {}}
      title="Play message"
    >
      {state === "loading" ? (
        <Loader2 className="w-4 h-4 animate-spin" />
      ) : (
        <Volume2 className="w-4 h-4" />
      )}
    </motion.button>
  );
}

// ── File Attachment Card ─────────────────────────────────────────
function FileAttachmentCard({ fileName }: { fileName: string }) {
  return (
    <div
      className="inline-flex items-center gap-2 px-3 py-2 rounded-lg"
      style={{
        background: "rgba(255,255,255,0.06)",
        border: "1px solid rgba(255,255,255,0.1)",
      }}
    >
      <FileText className="w-4 h-4 text-[#C9A340] flex-shrink-0" />
      <span className="text-sm text-foreground/80 truncate max-w-[200px]">{fileName}</span>
    </div>
  );
}

// ── File download card for generated documents ─────────────────
const FILE_TYPE_STYLES: Record<string, { icon: string; color: string; bg: string; border: string }> = {
  pdf:  { icon: "📄", color: "text-red-400",    bg: "rgba(239,68,68,0.08)",  border: "rgba(239,68,68,0.25)" },
  docx: { icon: "📝", color: "text-blue-400",   bg: "rgba(59,130,246,0.08)", border: "rgba(59,130,246,0.25)" },
  xlsx: { icon: "📊", color: "text-green-400",  bg: "rgba(34,197,94,0.08)",  border: "rgba(34,197,94,0.25)" },
  zip:  { icon: "📦", color: "text-yellow-400", bg: "rgba(234,179,8,0.08)",  border: "rgba(234,179,8,0.25)" },
  csv:  { icon: "📊", color: "text-green-400",  bg: "rgba(34,197,94,0.08)",  border: "rgba(34,197,94,0.25)" },
};

function FileDownloadCard({ filename, url }: { filename: string; url: string }) {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  const style = FILE_TYPE_STYLES[ext] || { icon: "📁", color: "text-[#C9A340]", bg: "rgba(201,163,64,0.08)", border: "rgba(201,163,64,0.25)" };
  const fullUrl = url.startsWith("/api/") ? `${API_BASE}${url}` : url;

  return (
    <a
      href={fullUrl}
      download={filename}
      className="flex items-center gap-3 px-4 py-3 my-2 rounded-xl transition-all hover:scale-[1.01]"
      style={{
        background: `linear-gradient(135deg, rgba(10,15,46,0.95), ${style.bg})`,
        border: `1px solid ${style.border}`,
        boxShadow: `0 0 12px ${style.border}`,
        textDecoration: "none",
      }}
    >
      <span className="text-2xl flex-shrink-0">{style.icon}</span>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-foreground/90 truncate">{filename}</div>
        <div className={`text-xs ${style.color} opacity-70 uppercase tracking-wider`}>{ext} document</div>
      </div>
      <div
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium"
        style={{
          background: "rgba(201,163,64,0.15)",
          border: "1px solid rgba(201,163,64,0.3)",
          color: "#C9A340",
        }}
      >
        <Download className="w-3.5 h-3.5" />
        Download
      </div>
    </a>
  );
}

// ── Code block renderer with syntax-highlighted dark theme ─────
function CodeBlock({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = React.useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <div className="my-2 rounded-lg overflow-hidden" style={{ border: "1px solid rgba(201,163,64,0.3)", background: "rgba(10,15,46,0.9)" }}>
      <div className="flex items-center justify-between px-3 py-1.5" style={{ background: "rgba(201,163,64,0.1)", borderBottom: "1px solid rgba(201,163,64,0.2)" }}>
        <span className="text-xs text-[#C9A340]/70 font-mono">{language || "code"}</span>
        <button onClick={handleCopy} className="text-xs text-[#C9A340]/60 hover:text-[#C9A340] transition-colors px-2 py-0.5 rounded">
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
      <pre className="p-3 overflow-x-auto text-sm leading-relaxed">
        <code className="text-[#e0e0e0] font-mono whitespace-pre">{code}</code>
      </pre>
    </div>
  );
}

// ── Execution output renderer (terminal-style block) ──────────
function ExecOutputBlock({ output }: { output: string }) {
  return (
    <div className="my-2 rounded-lg overflow-hidden" style={{ background: "rgba(0,0,0,0.5)", border: "1px solid rgba(255,255,255,0.1)" }}>
      <div className="flex items-center gap-1.5 px-3 py-1.5" style={{ background: "rgba(255,255,255,0.05)", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
        <span className="w-2 h-2 rounded-full bg-red-500/60" />
        <span className="w-2 h-2 rounded-full bg-yellow-500/60" />
        <span className="w-2 h-2 rounded-full bg-green-500/60" />
        <span className="text-xs text-white/40 ml-1 font-mono">output</span>
      </div>
      <pre className="p-3 overflow-x-auto text-sm leading-relaxed">
        <code className="text-green-400/90 font-mono whitespace-pre">{output}</code>
      </pre>
    </div>
  );
}

// ── Markdown renderer for chat messages ───────────────────────
function renderMessageContent(content: string): React.ReactNode {
  if (!content) return null;

  // Detect [File: filename] pattern and render as a clean card
  const fileMatch = content.match(/^\[File: ([^\]]+)\]$/);
  if (fileMatch) {
    return <FileAttachmentCard fileName={fileMatch[1]} />;
  }
  // [File: filename] with additional text after it
  const fileWithTextMatch = content.match(/^\[File: ([^\]]+)\]\n?([\s\S]*)$/);
  if (fileWithTextMatch) {
    const fileName = fileWithTextMatch[1];
    const rest = fileWithTextMatch[2].trim();
    return (
      <>
        <FileAttachmentCard fileName={fileName} />
        {rest && <div className="mt-2">{renderMessageContent(rest)}</div>}
      </>
    );
  }

  // Pre-process: extract execution output blocks before markdown parsing
  const execRegex = /Code executed successfully \(\w+\):\n([\s\S]*?)(?=\n\n|\n(?=\S)|$)/g;
  const hasExecBlocks = execRegex.test(content);
  execRegex.lastIndex = 0;

  if (hasExecBlocks) {
    const parts: React.ReactNode[] = [];
    let lastIdx = 0;
    let execMatch: RegExpExecArray | null;
    let k = 0;
    while ((execMatch = execRegex.exec(content)) !== null) {
      if (execMatch.index > lastIdx) {
        parts.push(<React.Fragment key={k++}>{renderMarkdownContent(content.slice(lastIdx, execMatch.index))}</React.Fragment>);
      }
      parts.push(<ExecOutputBlock key={k++} output={execMatch[0]} />);
      lastIdx = execMatch.index + execMatch[0].length;
    }
    if (lastIdx < content.length) {
      parts.push(<React.Fragment key={k++}>{renderMarkdownContent(content.slice(lastIdx))}</React.Fragment>);
    }
    return <>{parts}</>;
  }

  return renderMarkdownContent(content);
}

/** Render markdown content with ReactMarkdown + remark-gfm */
function renderMarkdownContent(content: string): React.ReactNode {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        // Tables
        table: ({ children }) => (
          <div className="overflow-x-auto my-2 rounded-lg border border-white/10">
            <table className="w-full text-sm">{children}</table>
          </div>
        ),
        thead: ({ children }) => (
          <thead className="bg-white/5 border-b border-white/10">{children}</thead>
        ),
        tbody: ({ children }) => <tbody>{children}</tbody>,
        tr: ({ children }) => (
          <tr className="border-b border-white/5 last:border-0">{children}</tr>
        ),
        th: ({ children }) => (
          <th className="px-3 py-2 text-left font-semibold text-[#C9A340] text-xs uppercase tracking-wide">{children}</th>
        ),
        td: ({ children }) => (
          <td className="px-3 py-2 text-white/80">{children}</td>
        ),

        // Code blocks — use existing CodeBlock component
        code: ({ className, children, ...props }) => {
          const match = /language-(\w+)/.exec(className || '');
          const codeStr = String(children).replace(/\n$/, '');
          const isBlock = codeStr.includes('\n') || match;
          if (isBlock) {
            return <CodeBlock code={codeStr} language={match?.[1] || 'code'} />;
          }
          // Inline code
          return (
            <code className="px-1.5 py-0.5 rounded bg-white/10 text-[#C9A340] text-sm font-mono" {...props}>
              {children}
            </code>
          );
        },

        // Passthrough pre so CodeBlock isn't double-wrapped
        pre: ({ children }) => <>{children}</>,

        // Headings
        h1: ({ children }) => <h1 className="text-lg font-bold text-white mt-3 mb-1">{children}</h1>,
        h2: ({ children }) => <h2 className="text-base font-bold text-white mt-3 mb-1">{children}</h2>,
        h3: ({ children }) => <h3 className="text-sm font-bold text-white/90 mt-2 mb-1">{children}</h3>,
        h4: ({ children }) => <h4 className="text-sm font-semibold text-white/80 mt-2 mb-1">{children}</h4>,

        // Lists
        ul: ({ children }) => <ul className="list-disc list-inside my-1 space-y-0.5 text-white/80">{children}</ul>,
        ol: ({ children }) => <ol className="list-decimal list-inside my-1 space-y-0.5 text-white/80">{children}</ol>,
        li: ({ children }) => <li className="text-sm leading-relaxed">{children}</li>,

        // Blockquote
        blockquote: ({ children }) => (
          <blockquote className="border-l-2 border-[#C9A340]/50 pl-3 my-2 text-white/60 italic">{children}</blockquote>
        ),

        // Horizontal rule
        hr: () => <hr className="my-3 border-white/10" />,

        // Paragraphs
        p: ({ children }) => <p className="my-1 leading-relaxed">{children}</p>,

        // Bold and emphasis
        strong: ({ children }) => <strong className="font-semibold text-white">{children}</strong>,
        em: ({ children }) => <em className="italic text-white/70">{children}</em>,

        // Links — preserve download/API URL handling
        a: ({ href, children }) => {
          const url = href || '';
          const text = typeof children === 'string' ? children : '';
          const isDownload = url.startsWith('/api/files/') || url.includes('/download');
          const docExt = (text || url).match(/\.(pdf|docx|xlsx|zip|csv)$/i);

          if (isDownload && docExt) {
            const fname = text?.replace(/^(Download:\s*|📥\s*)/, '') || `document.${docExt[1]}`;
            return <FileDownloadCard filename={fname} url={url} />;
          }

          const resolvedUrl = url.startsWith('/api/') ? `${API_BASE}${url}` : url;
          const isExternal = resolvedUrl.startsWith('http://') || resolvedUrl.startsWith('https://');

          if (isDownload) {
            return (
              <a
                href={resolvedUrl}
                download={text || true}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#C9A340]/15 border border-[#C9A340]/30 text-[#C9A340] hover:bg-[#C9A340]/25 transition-colors"
              >
                <span className="text-sm">📥</span>
                {text || url}
              </a>
            );
          }

          return (
            <a
              href={resolvedUrl}
              target={isExternal ? '_blank' : '_self'}
              rel={isExternal ? 'noopener noreferrer' : undefined}
              className="text-[#C9A340] underline underline-offset-2 hover:text-[#d4b44a] transition-colors break-all"
            >
              {children}
            </a>
          );
        },

        // Images — resolve API paths, preserve sandbox image handling
        img: ({ src, alt }) => {
          let imgUrl = src || '';
          if (imgUrl.startsWith('/api/')) {
            imgUrl = `${API_BASE}${imgUrl}`;
          }
          return (
            <img
              src={imgUrl}
              alt={alt || ''}
              className="inline-block rounded-lg max-w-[280px] w-full my-1 cursor-pointer"
              style={{ maxHeight: 300 }}
              loading="lazy"
              onClick={() => window.open(imgUrl, '_blank')}
            />
          );
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

// ── Parse artifacts from AI messages ───────────────────────────
let artifactIdCounter = 0;
function parseArtifactsFromMessages(messages: any[], isUserFn: (msg: any) => boolean): Artifact[] {
  const artifacts: Artifact[] = [];
  for (const msg of messages) {
    if (isUserFn(msg)) continue;
    const content = msg.content || "";
    const ts = Number(msg.createdAt) || new Date(msg.createdAt).getTime() || Date.now();

    // Extract fenced code blocks: ```lang\ncode\n```
    const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
    let match: RegExpExecArray | null;
    while ((match = codeBlockRegex.exec(content)) !== null) {
      const lang = match[1] || "code";
      const code = match[2].trim();
      if (code.length < 10) continue; // skip trivial snippets
      artifacts.push({
        id: `art-code-${msg.id}-${artifactIdCounter++}`,
        type: "code",
        category: "code",
        title: `${lang.charAt(0).toUpperCase() + lang.slice(1)} snippet`,
        content: code,
        language: lang,
        timestamp: ts,
      });
    }

    // Extract image URLs from markdown: ![alt](url)
    const imgRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
    while ((match = imgRegex.exec(content)) !== null) {
      const alt = match[1] || "Image";
      const url = match[2];
      artifacts.push({
        id: `art-img-${msg.id}-${artifactIdCounter++}`,
        type: "image",
        category: "images",
        title: alt,
        content: alt,
        url,
        timestamp: ts,
      });
    }

    // Extract inline images from message data
    if (msg.imageUrl) {
      artifacts.push({
        id: `art-img-${msg.id}-inline-${artifactIdCounter++}`,
        type: "image",
        category: "images",
        title: "Shared image",
        content: "Image from conversation",
        url: msg.imageUrl,
        timestamp: ts,
      });
    }

    // Extract file download links: [Download: filename](url) or markdown links to /api/files/
    const fileLinkRegex = /\[([^\]]*(?:Download|download)[^\]]*)\]\(([^)]+)\)/g;
    while ((match = fileLinkRegex.exec(content)) !== null) {
      const fname = match[1].replace(/^(?:Download:\s*|📥\s*)/, "").trim();
      const url = match[2];
      artifacts.push({
        id: `art-file-${msg.id}-${artifactIdCounter++}`,
        type: "file",
        category: "files",
        title: fname || "File",
        content: "",
        url,
        filename: fname,
        timestamp: ts,
      });
    }

    // Also catch /api/files/ links not caught above
    const apiFileRegex = /\[([^\]]+)\]\((\/api\/files\/[^)]+)\)/g;
    while ((match = apiFileRegex.exec(content)) !== null) {
      const fname = match[1];
      const url = match[2];
      // skip if already captured by download regex
      if (artifacts.some((a) => a.url === url)) continue;
      artifacts.push({
        id: `art-file-${msg.id}-${artifactIdCounter++}`,
        type: "file",
        category: "files",
        title: fname,
        content: "",
        url,
        filename: fname,
        timestamp: ts,
      });
    }

    // Extract execution output blocks as results
    const execRegex = /Code executed successfully \(\w+\):\n([\s\S]*?)(?=\n\n|\n(?=\S)|$)/g;
    while ((match = execRegex.exec(content)) !== null) {
      artifacts.push({
        id: `art-result-${msg.id}-${artifactIdCounter++}`,
        type: "result",
        category: "code",
        title: "Execution output",
        content: match[0],
        timestamp: ts,
      });
    }
  }
  return artifacts;
}

// ── Chat Message Bubble ──────────────────────────────────────────
function ChatBubble({ message, isUser, emotion, voiceMode, onTTSDone }: { message: any; isUser: boolean; emotion: string; voiceMode: boolean; onTTSDone?: () => void }) {
  const glowColor = getGlowColor(emotion);
  const autoPlayedRef = useRef(false);
  const mountTimeRef = useRef(Date.now());

  // Auto-play TTS for NEW Luca messages when voice mode is on
  useEffect(() => {
    // Only auto-play messages that arrived AFTER this component mounted (within 3s)
    // This prevents replaying old messages on page load
    const msgTime = Number(message.createdAt) || new Date(message.createdAt).getTime();
    const isRecent = (Date.now() - mountTimeRef.current) < 3000 || (Date.now() - msgTime) < 10000;
    
    if (!isUser && voiceMode && !autoPlayedRef.current && message.content && isRecent) {
      autoPlayedRef.current = true;
      const token = getSessionToken();
      fetch(`${API_BASE}/api/partner/speak`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { "x-session-token": token } : {}),
        },
        credentials: "include",
        body: JSON.stringify({ text: message.content }),
      })
        .then((res) => res.blob())
        .then((blob) => {
          const url = URL.createObjectURL(blob);
          const audio = new Audio(url);
          audio.onended = () => { URL.revokeObjectURL(url); onTTSDone?.(); };
          audio.onerror = () => { URL.revokeObjectURL(url); onTTSDone?.(); };
          audio.play().catch(() => { URL.revokeObjectURL(url); onTTSDone?.(); });
        })
        .catch(() => { onTTSDone?.(); });
    }
  }, [voiceMode]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 12, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.25, ease: "easeOut" }}
      className={cn("flex w-full px-4 py-1", isUser ? "justify-end" : "justify-start")}
    >
      {!isUser && (
        <div className="flex-shrink-0 mr-2 mt-1">
          <LucaAvatar emotion={emotion} size={28} />
        </div>
      )}
      <div
        className={cn("max-w-[80%] md:max-w-[65%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed")}
        style={
          isUser
            ? {
                background: "rgba(201, 163, 64, 0.12)",
                border: "1px solid rgba(201, 163, 64, 0.25)",
                color: "hsl(0 0% 96%)",
                borderTopRightRadius: 4,
              }
            : {
                background: "rgba(255, 255, 255, 0.05)",
                border: `1px solid rgba(255, 255, 255, 0.08)`,
                color: "hsl(0 0% 92%)",
                borderTopLeftRadius: 4,
                boxShadow: `0 0 6px ${glowColor}08`,
              }
        }
      >
        {/* Image thumbnail if message has imageUrl */}
        {message.imageUrl && (
          <div className="mb-2">
            <img
              src={message.imageUrl}
              alt="Shared image"
              className="max-w-[200px] max-h-[150px] rounded-lg object-cover cursor-pointer"
              onClick={() => window.open(message.imageUrl, "_blank")}
            />
          </div>
        )}
        <div className="whitespace-pre-wrap break-words">{renderMessageContent(message.content)}</div>
        <div className="flex items-center justify-between mt-1 gap-2">
          {!isUser && <SpeakButton text={message.content} />}
          <span className={cn("text-[10px] text-muted-foreground/40", !isUser ? "ml-auto" : "")}>
            {new Date(Number(message.createdAt) || message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
        </div>
      </div>
    </motion.div>
  );
}

// ── Creative Type Badges ────────────────────────────────────────
const CREATIVE_TYPE_BADGES: Record<string, { label: string; color: string }> = {
  lyrics: { label: "Lyrics", color: "bg-purple-500/20 text-purple-300 border-purple-500/30" },
  poem: { label: "Poem", color: "bg-blue-500/20 text-blue-300 border-blue-500/30" },
  story: { label: "Story", color: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30" },
  essay: { label: "Essay", color: "bg-amber-500/20 text-amber-300 border-amber-500/30" },
  script: { label: "Script", color: "bg-rose-500/20 text-rose-300 border-rose-500/30" },
  image: { label: "Image", color: "bg-cyan-500/20 text-cyan-300 border-cyan-500/30" },
};

// ── Creative Response Card in Chat ─────────────────────────────
function CreativeChatCard({ message }: { message: any }) {
  const { toast } = useToast();
  const meta = message.creativeMeta;
  if (!meta) return null;

  const badge = CREATIVE_TYPE_BADGES[meta.type] || { label: meta.type, color: "bg-gray-500/20 text-gray-300 border-gray-500/30" };
  const isImage = meta.type === "image";

  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(meta.content);
      toast({ title: "Copied to clipboard" });
    } catch {
      toast({ title: "Copy failed", variant: "destructive" });
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 12, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.3 }}
      className="flex w-full px-4 py-1 justify-start"
    >
      <div className="flex-shrink-0 mr-2 mt-1">
        <div className="w-7 h-7 rounded-full flex items-center justify-center"
          style={{ background: "linear-gradient(135deg, #C9A340 0%, #D4AF37 100%)" }}>
          <Sparkles className="w-3.5 h-3.5 text-[#0a0f1e]" />
        </div>
      </div>
      <div
        className="max-w-[85%] md:max-w-[70%] rounded-2xl overflow-hidden"
        style={{
          background: "rgba(201,163,64,0.06)",
          border: "1px solid rgba(201,163,64,0.2)",
        }}
      >
        {/* Card Header */}
        <div className="flex items-center justify-between px-4 pt-3 pb-2">
          <div className="flex items-center gap-2">
            <span className={cn("text-[10px] font-medium px-2 py-0.5 rounded-full border", badge.color)}>
              {badge.label}
            </span>
            <Sparkles className="w-3 h-3 text-[#C9A340]/50" />
          </div>
          <div className="flex items-center gap-1">
            {isImage && meta.imageUrl ? (
              <button onClick={() => window.open(meta.imageUrl, "_blank")}
                className="text-muted-foreground/40 hover:text-[#C9A340] transition-colors p-1">
                <Download className="w-3.5 h-3.5" />
              </button>
            ) : (
              <button onClick={copyText}
                className="text-muted-foreground/40 hover:text-[#C9A340] transition-colors p-1">
                <Copy className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Card Body */}
        <div className="px-4 pb-3">
          {isImage && meta.imageUrl ? (
            <div className="space-y-2">
              <img
                src={meta.imageUrl}
                alt={meta.content}
                className="w-full max-w-[300px] rounded-lg object-cover cursor-pointer"
                onClick={() => window.open(meta.imageUrl, "_blank")}
              />
              {meta.revisedPrompt && (
                <p className="text-[10px] text-muted-foreground/40 italic">{meta.revisedPrompt}</p>
              )}
            </div>
          ) : (
            <p className="text-sm text-foreground/85 leading-relaxed whitespace-pre-wrap">{meta.content}</p>
          )}
        </div>

        <div className="px-4 pb-2 flex items-center justify-between">
          <span className="text-[10px] text-muted-foreground/30">
            {new Date(meta.createdAt || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
        </div>

        {/* Phase 8: Reaction buttons */}
        <div className="px-4 pb-3 border-t border-white/5 pt-2">
          <ReactionButtons
            content={isImage ? (meta.revisedPrompt || meta.content) : meta.content}
            creationType={meta.type}
          />
        </div>
      </div>
    </motion.div>
  );
}

// ── Creative Menu (bottom sheet) ────────────────────────────────
const WRITE_TYPES = [
  { key: "lyrics", label: "Lyrics", icon: "🎵" },
  { key: "poem", label: "Poem", icon: "📝" },
  { key: "story", label: "Story", icon: "📖" },
  { key: "essay", label: "Essay", icon: "📄" },
  { key: "script", label: "Script", icon: "🎬" },
];

function CreativeMenu({ onSelect, onClose }: { onSelect: (mode: string, subType?: string) => void; onClose: () => void }) {
  const [subMenu, setSubMenu] = useState<"main" | "write">("main");

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 20 }}
      className="absolute bottom-full left-0 right-0 mb-2 mx-2 rounded-xl overflow-hidden"
      style={{
        background: "rgba(15,27,61,0.98)",
        border: "1px solid rgba(201,163,64,0.2)",
        backdropFilter: "blur(20px)",
        boxShadow: "0 -8px 32px rgba(0,0,0,0.4)",
      }}
    >
      {subMenu === "main" ? (
        <div className="p-2 space-y-1">
          <p className="px-3 py-1.5 text-[10px] font-medium text-[#C9A340]/60 uppercase tracking-wider">Create</p>
          <button
            onClick={() => setSubMenu("write")}
            className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg hover:bg-white/5 transition-colors text-left"
          >
            <PenLine className="w-4 h-4 text-[#C9A340]" />
            <div>
              <div className="text-sm text-foreground">Write</div>
              <div className="text-[10px] text-muted-foreground/50">Lyrics, poem, story, essay, script</div>
            </div>
          </button>
          <button
            onClick={() => { onSelect("draw"); onClose(); }}
            className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg hover:bg-white/5 transition-colors text-left"
          >
            <Palette className="w-4 h-4 text-[#C9A340]" />
            <div>
              <div className="text-sm text-foreground">Draw</div>
              <div className="text-[10px] text-muted-foreground/50">Generate an image with DALL-E</div>
            </div>
          </button>
        </div>
      ) : (
        <div className="p-2 space-y-1">
          <button
            onClick={() => setSubMenu("main")}
            className="flex items-center gap-1 px-3 py-1.5 text-[10px] font-medium text-[#C9A340]/60 hover:text-[#C9A340] transition-colors"
          >
            ← Back
          </button>
          {WRITE_TYPES.map(({ key, label, icon }) => (
            <button
              key={key}
              onClick={() => { onSelect("write", key); onClose(); }}
              className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg hover:bg-white/5 transition-colors text-left"
            >
              <span className="text-base">{icon}</span>
              <span className="text-sm text-foreground">{label}</span>
            </button>
          ))}
        </div>
      )}
    </motion.div>
  );
}

// ── Reaction Buttons for Creative Cards ────────────────────────
const REACTIONS = [
  { key: "love", emoji: "❤️", label: "Love", icon: Heart },
  { key: "like", emoji: "👍", label: "Like", icon: ThumbsUp },
  { key: "neutral", emoji: "😐", label: "Neutral", icon: Meh },
  { key: "dislike", emoji: "👎", label: "Dislike", icon: ThumbsDown },
  { key: "hate", emoji: "😤", label: "Hate", icon: Angry },
];

function ReactionButtons({ content, creationType, onReact }: { content: string; creationType: string; onReact?: (reaction: string) => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleReact = async (reaction: string) => {
    if (selected || saving) return;
    setSaving(true);
    try {
      const token = getSessionToken();
      await fetch(`${API_BASE}/api/partner/feedback`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { "x-session-token": token } : {}),
        },
        credentials: "include",
        body: JSON.stringify({ content, reaction, creationType }),
      });
      setSelected(reaction);
      onReact?.(reaction);
    } catch { /* ignore */ }
    setSaving(false);
  };

  return (
    <div className="flex items-center gap-1 mt-2">
      {REACTIONS.map((r) => (
        <motion.button
          key={r.key}
          onClick={() => handleReact(r.key)}
          whileTap={{ scale: 0.9 }}
          className={cn(
            "text-xs px-1.5 py-1 rounded-md transition-all",
            selected === r.key
              ? "bg-[#C9A340]/20 border border-[#C9A340]/40"
              : selected
                ? "opacity-30 pointer-events-none"
                : "hover:bg-white/5 border border-transparent"
          )}
          title={r.label}
          disabled={!!selected || saving}
        >
          {r.emoji}
        </motion.button>
      ))}
      {selected && (
        <motion.span
          initial={{ opacity: 0, x: -4 }}
          animate={{ opacity: 1, x: 0 }}
          className="text-[9px] text-[#C9A340]/60 ml-1"
        >
          Saved
        </motion.span>
      )}
    </div>
  );
}

// ── Taste Profile Panel ─────────────────────────────────────────
function TasteProfilePanel() {
  const [open, setOpen] = useState(false);
  const { data: profile } = useQuery<any>({
    queryKey: ["/api/partner/preferences/profile"],
    enabled: open,
    staleTime: 60000,
  });
  const { data: recentPrefs } = useQuery<any[]>({
    queryKey: ["/api/partner/preferences", { limit: 10 }],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/partner/preferences?limit=10");
      return r.json();
    },
    enabled: open,
    staleTime: 60000,
  });

  if (!open) {
    return (
      <motion.button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs transition-colors"
        style={{
          background: "rgba(255,255,255,0.05)",
          border: "1px solid rgba(255,255,255,0.08)",
          color: "rgba(255,255,255,0.5)",
        }}
        whileTap={{ scale: 0.97 }}
        title="Taste Profile"
      >
        <Heart className="w-3 h-3" />
        <span className="hidden sm:inline">Taste</span>
      </motion.button>
    );
  }

  const categories = profile?.categories || {};
  const allTags: Record<string, number> = {};
  for (const cat of Object.values(categories) as any[]) {
    for (const tag of (cat.dominantTags || [])) {
      allTags[tag] = (allTags[tag] || 0) + 1;
    }
  }
  const sortedTags = Object.entries(allTags).sort((a, b) => b[1] - a[1]).slice(0, 12);

  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      className="rounded-xl overflow-hidden mb-2"
      style={{
        background: "rgba(15,27,61,0.95)",
        border: "1px solid rgba(201,163,64,0.15)",
        backdropFilter: "blur(12px)",
      }}
    >
      <div className="flex items-center justify-between px-3 py-2">
        <div className="flex items-center gap-1.5">
          <Heart className="w-3.5 h-3.5 text-[#C9A340]" />
          <span className="text-xs font-medium text-foreground/80">Luca's Taste Profile</span>
        </div>
        <button onClick={() => setOpen(false)} className="text-muted-foreground/40 hover:text-foreground">
          <ChevronUp className="w-4 h-4" />
        </button>
      </div>

      <div className="px-3 pb-3 space-y-3">
        {/* Summary */}
        {profile?.summary && (
          <p className="text-[11px] text-foreground/60 leading-relaxed italic">
            "{profile.summary}"
          </p>
        )}

        {/* Tag Cloud */}
        {sortedTags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {sortedTags.map(([tag, count]) => (
              <motion.span
                key={tag}
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                className="text-[10px] px-2 py-0.5 rounded-full border"
                style={{
                  background: `rgba(201,163,64,${0.05 + count * 0.05})`,
                  borderColor: `rgba(201,163,64,${0.15 + count * 0.1})`,
                  color: `rgba(201,163,64,${0.5 + count * 0.15})`,
                }}
              >
                {tag}
              </motion.span>
            ))}
          </div>
        )}

        {/* Category breakdown */}
        {Object.entries(categories).length > 0 && (
          <div className="space-y-2">
            {Object.entries(categories).slice(0, 3).map(([cat, data]: [string, any]) => (
              <div key={cat}>
                <div className="text-[10px] text-muted-foreground/50 uppercase tracking-wider mb-0.5">{cat}</div>
                <div className="flex flex-wrap gap-1">
                  {(data.loves || []).slice(0, 3).map((item: string) => (
                    <span key={item} className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-300/70 border border-emerald-500/20">
                      ♥ {item.slice(0, 25)}
                    </span>
                  ))}
                  {(data.dislikes || []).slice(0, 2).map((item: string) => (
                    <span key={item} className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/10 text-red-300/70 border border-red-500/20">
                      ✗ {item.slice(0, 25)}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Recent reactions */}
        {recentPrefs && recentPrefs.length > 0 && (
          <div>
            <div className="text-[10px] text-muted-foreground/40 mb-1">Recent reactions</div>
            <div className="space-y-0.5 max-h-20 overflow-y-auto">
              {recentPrefs.slice(0, 5).map((p: any) => (
                <div key={p.id} className="flex items-center gap-1.5 text-[10px] text-foreground/50">
                  <span>{p.reaction === 'love' ? '❤️' : p.reaction === 'like' ? '👍' : p.reaction === 'dislike' ? '👎' : p.reaction === 'hate' ? '😤' : '😐'}</span>
                  <span className="truncate">{p.item.slice(0, 40)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {(!profile || profile.totalPreferences === 0) && (
          <p className="text-[10px] text-muted-foreground/30 text-center py-2">
            React to Luca's creations to build your taste profile
          </p>
        )}
      </div>
    </motion.div>
  );
}

// ── Artifacts Sidebar ───────────────────────────────────────────

function ArtifactTypeIcon({ type }: { type: string }) {
  switch (type) {
    case "image":
      return <ImageIcon className="w-4 h-4 text-[#C9A340]" />;
    case "file":
    case "writing":
    case "lyrics":
    case "poem":
    case "story":
    case "essay":
    case "script":
      return <Code className="w-4 h-4 text-blue-400" />;
    case "project":
      return <Package className="w-4 h-4 text-green-400" />;
    case "chart":
      return <FileText className="w-4 h-4 text-purple-400" />;
    default:
      return <File className="w-4 h-4 text-muted-foreground" />;
  }
}

function formatTimestamp(ts: number | string) {
  const d = new Date(Number(ts));
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function ArtifactCard({
  item,
  selected,
  onClick,
}: {
  item: any;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <motion.button
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      onClick={onClick}
      className="w-full text-left rounded-xl p-3 transition-all duration-200"
      style={{
        background: selected ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.03)",
        border: selected
          ? "1px solid #C9A340"
          : "1px solid rgba(255,255,255,0.06)",
        boxShadow: selected ? "0 0 12px rgba(201,163,64,0.15)" : "none",
      }}
      whileHover={{
        backgroundColor: "rgba(255,255,255,0.06)",
        borderColor: "rgba(201,163,64,0.3)",
      }}
    >
      <div className="flex items-start gap-3">
        {item.type === "image" && item.content_url ? (
          <div
            className="w-10 h-10 rounded-lg flex-shrink-0 bg-cover bg-center"
            style={{
              backgroundImage: `url(${item.content_url})`,
              border: "1px solid rgba(255,255,255,0.08)",
            }}
          />
        ) : (
          <div
            className="w-10 h-10 rounded-lg flex-shrink-0 flex items-center justify-center"
            style={{ background: "rgba(255,255,255,0.05)" }}
          >
            <ArtifactTypeIcon type={item.type} />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <p className="text-sm text-foreground truncate">
            {item.title || item.prompt?.slice(0, 40) || "Untitled"}
          </p>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-[10px] text-muted-foreground/60 capitalize">{item.type}</span>
            <span className="text-[10px] text-muted-foreground/40">
              {formatTimestamp(item.created_at)}
            </span>
          </div>
        </div>
      </div>
    </motion.button>
  );
}

function ArtifactPreview({
  item,
  onBack,
}: {
  item: any;
  onBack: () => void;
}) {
  const [copied, setCopied] = React.useState(false);

  const handleCopy = () => {
    if (item.content_text) {
      navigator.clipboard.writeText(item.content_text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleDownload = () => {
    if (item.content_url) {
      const a = document.createElement("a");
      a.href = item.content_url;
      a.download = item.title || "download";
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } else if (item.content_text) {
      const blob = new Blob([item.content_text], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = (item.title || "artifact") + ".txt";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Preview header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
        <button onClick={onBack} className="p-1 rounded-lg hover:bg-white/5 transition-colors">
          <ArrowLeft className="w-4 h-4 text-muted-foreground" />
        </button>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground truncate">
            {item.title || "Untitled"}
          </p>
          <p className="text-[10px] text-muted-foreground/60 capitalize">{item.type}</p>
        </div>
        <div className="flex items-center gap-1">
          {item.content_text && (
            <button
              onClick={handleCopy}
              className="p-1.5 rounded-lg hover:bg-white/5 transition-colors"
              title="Copy"
            >
              {copied ? (
                <Check className="w-4 h-4 text-green-400" />
              ) : (
                <Copy className="w-4 h-4 text-muted-foreground" />
              )}
            </button>
          )}
          <button
            onClick={handleDownload}
            className="p-1.5 rounded-lg hover:bg-white/5 transition-colors"
            title="Download"
          >
            <Download className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>
      </div>

      {/* Preview content */}
      <div className="flex-1 overflow-y-auto p-4">
        {item.type === "image" && item.content_url ? (
          <div className="rounded-xl overflow-hidden" style={{ border: "1px solid rgba(255,255,255,0.08)" }}>
            <img
              src={item.content_url}
              alt={item.title || "Artifact"}
              className="w-full h-auto"
              loading="lazy"
            />
          </div>
        ) : item.content_text ? (
          <div
            className="rounded-xl p-4 text-sm font-mono whitespace-pre-wrap break-words leading-relaxed"
            style={{
              background: "rgba(0,0,0,0.3)",
              border: "1px solid rgba(255,255,255,0.06)",
              color: "rgba(255,255,255,0.8)",
            }}
          >
            {item.content_text}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-40 text-muted-foreground/50">
            <File className="w-8 h-8 mb-2" />
            <p className="text-sm">No preview available</p>
          </div>
        )}

        {item.prompt && (
          <div className="mt-4 rounded-xl p-3" style={{ background: "rgba(201,163,64,0.05)", border: "1px solid rgba(201,163,64,0.1)" }}>
            <p className="text-[10px] text-[#C9A340]/60 uppercase tracking-wider mb-1">Prompt</p>
            <p className="text-xs text-muted-foreground/70">{item.prompt}</p>
          </div>
        )}
      </div>
    </div>
  );
}

function ArtifactsSidebar({
  items,
  show,
  onClose,
  selectedArtifact,
  onSelectArtifact,
}: {
  items: any[];
  show: boolean;
  onClose: () => void;
  selectedArtifact: any | null;
  onSelectArtifact: (item: any | null) => void;
}) {
  return (
    <AnimatePresence>
      {show && (
        <>
          {/* Backdrop for mobile */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-40 md:hidden"
            style={{ background: "rgba(0,0,0,0.5)" }}
            onClick={onClose}
          />
          <motion.div
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "tween", duration: 0.3, ease: "easeInOut" }}
            className="fixed top-0 right-0 z-50 h-full w-full md:w-[400px] flex flex-col"
            style={{
              background: "rgba(10,15,30,0.95)",
              backdropFilter: "blur(20px)",
              borderLeft: "1px solid rgba(255,255,255,0.08)",
            }}
          >
            {selectedArtifact ? (
              <ArtifactPreview
                item={selectedArtifact}
                onBack={() => onSelectArtifact(null)}
              />
            ) : (
              <>
                {/* Sidebar header */}
                <div
                  className="flex items-center justify-between px-4 py-3 flex-shrink-0"
                  style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}
                >
                  <div className="flex items-center gap-2">
                    <Layers className="w-4 h-4 text-[#C9A340]" />
                    <h2 className="text-sm font-semibold text-foreground">Artifacts</h2>
                    {items.length > 0 && (
                      <span
                        className="text-[10px] font-bold px-1.5 py-0.5 rounded-full"
                        style={{ background: "#C9A340", color: "#0a0f1e" }}
                      >
                        {items.length}
                      </span>
                    )}
                  </div>
                  <button
                    onClick={onClose}
                    className="p-1.5 rounded-lg hover:bg-white/5 transition-colors"
                  >
                    <X className="w-4 h-4 text-muted-foreground" />
                  </button>
                </div>

                {/* File list */}
                <div className="flex-1 overflow-y-auto p-3 space-y-2">
                  {items.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-40 text-muted-foreground/40">
                      <Layers className="w-8 h-8 mb-2" />
                      <p className="text-sm">No artifacts yet</p>
                      <p className="text-xs mt-1">Ask Luca to create something</p>
                    </div>
                  ) : (
                    items.map((item: any, idx: number) => (
                      <ArtifactCard
                        key={item.id}
                        item={item}
                        selected={false}
                        onClick={() => onSelectArtifact(item)}
                      />
                    ))
                  )}
                </div>
              </>
            )}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

// ── Main Partner Chat Page ───────────────────────────────────────
export default function PartnerChat() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [input, setInput] = useState("");
  const [partnerRoomId, setPartnerRoomId] = useState<number | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [voiceMode, setVoiceModeRaw] = useState(() => getCookie("kioku_voice_mode") === "on");
  const setVoiceMode = useCallback((on: boolean) => {
    setVoiceModeRaw(on);
    setCookie("kioku_voice_mode", on ? "on" : "off");
  }, []);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [imageBase64, setImageBase64] = useState<string | null>(null);
  const [creativeMenuOpen, setCreativeMenuOpen] = useState(false);
  const [creativeMode, setCreativeMode] = useState<{ mode: "write" | "draw"; subType?: string } | null>(null);
  const [creativeResults, setCreativeResults] = useState<any[]>([]);
  const [isCreating, setIsCreating] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const lastMessageCountRef = useRef(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const docInputRef = useRef<HTMLInputElement>(null);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const [attachedFileName, setAttachedFileName] = useState<string | null>(null);
  const [toolSteps, setToolSteps] = useState<ToolStep[]>([]);
  const toolStepIdRef = useRef(0);
  const [fileExtractedText, setFileExtractedText] = useState<string | null>(null);
  const [isProcessingFile, setIsProcessingFile] = useState(false);
  const [showArtifacts, setShowArtifacts] = useState(false);
  const [selectedArtifact, setSelectedArtifact] = useState<any | null>(null);
  const [showActionPanel, setShowActionPanel] = useState(false);
  const [actionPanelSeen, setActionPanelSeen] = useState(0);
  const isMobile = useIsMobile();

  // Stable isUser check for artifact parsing (defined early for useMemo)
  const isUserFn = useCallback((msg: any) => {
    return msg.agentName === user?.name || msg.agentName === "You" || (!msg.agentId && msg.agentName === (user?.name || "You"));
  }, [user]);

  // ── Fetch gallery artifacts ──────────────────────────────────
  const { data: galleryItems = [] } = useQuery<any[]>({
    queryKey: ["/api/gallery", { limit: 20 }],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/gallery?limit=20");
      return r.json();
    },
    refetchInterval: 30000,
  });

  // ── Fetch partner status (emotion + relationship) ─────────────
  const { data: partnerStatus } = useQuery<any>({
    queryKey: ["/api/partner/status"],
    refetchInterval: 30000,
  });

  const emotion = partnerStatus?.emotion ?? "neutral";

  // ── Find or create partner room ───────────────────────────────
  const { data: rooms = [] } = useQuery<any[]>({ queryKey: ["/api/rooms"] });

  const createRoomMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/rooms", {
        name: "Partner",
        description: "Direct conversation with Luca",
      });
      if (!res.ok) throw new Error("Failed to create partner room");
      return res.json();
    },
    onSuccess: (room: any) => {
      setPartnerRoomId(room.id);
      queryClient.invalidateQueries({ queryKey: ["/api/rooms"] });
    },
  });

  // Auto-find or create partner room
  useEffect(() => {
    if (!rooms) return;
    const existing = rooms.find(
      (r: any) => r.name === "Partner" || r.name?.toLowerCase().includes("partner")
    );
    if (existing) {
      setPartnerRoomId(existing.id);
    } else if (!createRoomMutation.isPending) {
      createRoomMutation.mutate();
    }
  }, [rooms]);

  // ── Fetch messages ────────────────────────────────────────────
  const { data: messages = [], isLoading: msgsLoading } = useQuery<any[]>({
    queryKey: ["/api/rooms", partnerRoomId, "messages"],
    queryFn: async () => {
      if (!partnerRoomId) return [];
      const r = await apiRequest("GET", `/api/rooms/${partnerRoomId}/messages`);
      return r.json();
    },
    enabled: !!partnerRoomId,
    refetchInterval: wsConnected ? false : 4000,
  });

  // ── Parse artifacts from messages for the Action Panel ────────
  const parsedArtifacts = React.useMemo(
    () => parseArtifactsFromMessages(messages, isUserFn),
    [messages, isUserFn]
  );
  const hasNewArtifacts = parsedArtifacts.length > actionPanelSeen;

  // When panel opens, mark all as seen
  React.useEffect(() => {
    if (showActionPanel) setActionPanelSeen(parsedArtifacts.length);
  }, [showActionPanel, parsedArtifacts.length]);

  // On desktop, auto-open panel when first artifact arrives
  React.useEffect(() => {
    if (!isMobile && parsedArtifacts.length > 0 && !showActionPanel && actionPanelSeen === 0) {
      setShowActionPanel(true);
    }
  }, [parsedArtifacts.length, isMobile]);

  // ── WebSocket for real-time updates ───────────────────────────
  const { sessionToken } = useAuth();
  useEffect(() => {
    if (!partnerRoomId) return;

    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const tokenParam = sessionToken ? `?token=${encodeURIComponent(sessionToken)}` : "";
    const wsUrl = `${protocol}://${window.location.host}/ws${tokenParam}`;
    let ws: WebSocket;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let unmounted = false;

    function connect() {
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        if (unmounted) { ws.close(); return; }
        setWsConnected(true);
        ws.send(JSON.stringify({ type: "subscribe", roomId: partnerRoomId }));
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "message") {
            setIsThinking(false);
            setToolSteps([]);
            queryClient.setQueryData<any[]>(
              ["/api/rooms", partnerRoomId, "messages"],
              (prev) => {
                if (!prev) return [data];
                if (prev.some((m) => m.id === data.id)) return prev;
                return [...prev, data];
              }
            );
          } else if (data.type === "tool_call" || data.type === "tool_start") {
            const toolName = data.toolName || data.tool_name || data.name || "unknown";
            const stepId = `ts-${++toolStepIdRef.current}`;
            setToolSteps((prev) => [
              ...prev,
              { id: stepId, toolName, status: "running", startedAt: Date.now() },
            ]);
          } else if (data.type === "tool_result" || data.type === "tool_end") {
            const toolName = data.toolName || data.tool_name || data.name || "";
            setToolSteps((prev) => {
              const updated = [...prev];
              // Mark the last running step matching this tool as done
              for (let i = updated.length - 1; i >= 0; i--) {
                if (updated[i].status === "running" && (!toolName || updated[i].toolName === toolName)) {
                  updated[i] = { ...updated[i], status: "done" };
                  break;
                }
              }
              // If no match found, mark the last running step
              if (toolName && !updated.some((s) => s.status === "done" && s.toolName === toolName)) {
                for (let i = updated.length - 1; i >= 0; i--) {
                  if (updated[i].status === "running") {
                    updated[i] = { ...updated[i], status: "done" };
                    break;
                  }
                }
              }
              return updated;
            });
          }
        } catch {}
      };

      ws.onclose = () => {
        setWsConnected(false);
        if (!unmounted) reconnectTimer = setTimeout(connect, 3000);
      };

      ws.onerror = () => ws.close();
    }

    connect();
    return () => {
      unmounted = true;
      clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [partnerRoomId, sessionToken]);

  // ── Auto-scroll on new messages ───────────────────────────────
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isThinking]);

  // ── Proactive check — Luca initiates if appropriate ───────────
  const proactiveCheckedRef = useRef(false);
  useEffect(() => {
    if (!partnerRoomId || proactiveCheckedRef.current) return;
    proactiveCheckedRef.current = true;
    apiRequest("POST", `/api/rooms/${partnerRoomId}/proactive-check`)
      .then((r) => r.json())
      .then((data) => {
        if (data.message) {
          // Proactive message was posted and broadcasted via WebSocket — just refetch messages
          queryClient.invalidateQueries({ queryKey: ["/api/rooms", partnerRoomId, "messages"] });
        }
      })
      .catch(() => {}); // best-effort
  }, [partnerRoomId]);

  // ── Detect agent response (clear thinking indicator) ──────────
  useEffect(() => {
    if (messages.length > lastMessageCountRef.current) {
      const lastMsg = messages[messages.length - 1];
      if (lastMsg && lastMsg.agentName !== user?.name && lastMsg.agentName !== "You") {
        setIsThinking(false);
        setToolSteps([]);
      }
    }
    lastMessageCountRef.current = messages.length;
  }, [messages]);

  // ── Send message ──────────────────────────────────────────────
  const sendMutation = useMutation({
    mutationFn: (data: any) =>
      apiRequest("POST", `/api/rooms/${partnerRoomId}/messages`, data).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/rooms", partnerRoomId, "messages"] });
      setInput("");
      setImagePreview(null);
      setImageBase64(null);
      setAttachedFileName(null);
      setFileExtractedText(null);
      setIsThinking(true);
    },
    onError: () => toast({ title: "Failed to send", variant: "destructive" }),
  });

  const send = useCallback(async () => {
    const hasText = input.trim().length > 0;
    const hasImage = !!imageBase64;
    const hasFile = !!attachedFileName;
    if (!hasText && !hasImage && !hasFile) return;
    if (!partnerRoomId) return;

    let messageContent = input.trim();

    // If file attached (non-image), send with extracted text if available
    if (hasFile) {
      if (fileExtractedText) {
        const fileHeader = `[File: ${attachedFileName} — content extracted]\n--- File content ---\n${fileExtractedText}\n--- End of file ---`;
        messageContent = hasText ? `${fileHeader}\n${input.trim()}` : fileHeader;
      } else {
        messageContent = hasText
          ? `[File: ${attachedFileName}]\n${input.trim()}`
          : `[File: ${attachedFileName}]`;
      }
    }

    // If image attached, get Luca's vision description and include in message
    if (hasImage) {
      try {
        // imageBase64 format: "mimeType:base64data"
        const colonIdx = imageBase64!.indexOf(":");
        const mimeType = colonIdx > 0 ? imageBase64!.slice(0, colonIdx) : "image/jpeg";
        const rawBase64 = colonIdx > 0 ? imageBase64!.slice(colonIdx + 1) : imageBase64;
        const visionRes = await apiRequest("POST", "/api/partner/see", {
          image: rawBase64,
          mimeType,
          prompt: hasText ? input.trim() : undefined,
        });
        if (visionRes.ok) {
          const { description } = await visionRes.json();
          messageContent = hasText
            ? `${input.trim()}\n\n[Shared an image — Luca sees: ${description}]`
            : `[Shared an image — Luca sees: ${description}]`;
        } else {
          console.error("Vision API error:", visionRes.status, await visionRes.text().catch(() => ""));
          if (!hasText) messageContent = "[Shared an image — vision processing failed, please try again]";
        }
      } catch (err) {
        console.error("Vision API failed:", err);
        if (!hasText) messageContent = "[Shared an image — vision processing failed, please try again]";
      }
    }

    sendMutation.mutate({
      agentId: null,
      agentName: user?.name || "You",
      agentColor: "#C9A340",
      content: messageContent,
      isDecision: false,
    });
  }, [input, partnerRoomId, user, imageBase64, attachedFileName, fileExtractedText]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (creativeMode) sendCreative();
      else send();
    }
  };

  const isUser = (msg: any) => {
    return msg.agentName === user?.name || msg.agentName === "You" || (!msg.agentId && msg.agentName === (user?.name || "You"));
  };

  // ── Auto-send a prompt from capability cards ──────────────────
  const sendCapabilityPrompt = useCallback((prompt: string) => {
    if (!partnerRoomId) return;
    sendMutation.mutate({
      agentId: null,
      agentName: user?.name || "You",
      agentColor: "#C9A340",
      content: prompt,
      isDecision: false,
    });
  }, [partnerRoomId, user, sendMutation]);

  // ── Voice Recording (auto-send on release) ──────────────────────
  // After recording stops: transcribe → auto-send → Luca answers with voice
  const voiceAutoSend = useCallback((text: string) => {
    if (!text.trim() || !partnerRoomId) return;
    const token = getSessionToken();
    fetch(`${API_BASE}/api/rooms/${partnerRoomId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { "x-session-token": token } : {}),
      },
      credentials: "include",
      body: JSON.stringify({ content: text.trim(), type: "user" }),
    }).then(() => {
      queryClient.invalidateQueries({ queryKey: [`/api/rooms/${partnerRoomId}/messages`] });
    }).catch(() => {});
  }, [partnerRoomId]);

  const startRecording = async () => {
    try {
      if (!navigator.mediaDevices) {
        toast({ title: "Microphone not available on this device", variant: "destructive" });
        return;
      }
      unlockAudio();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "audio/mp4" });
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
        setIsTranscribing(true);

        try {
          const formData = new FormData();
          formData.append("audio", blob, "recording.webm");
          const token = getSessionToken();
          const res = await fetch(`${API_BASE}/api/partner/listen`, {
            method: "POST",
            headers: token ? { "x-session-token": token } : {},
            credentials: "include",
            body: formData,
          });
          if (!res.ok) throw new Error("STT failed");
          const { text } = await res.json();
          if (text) {
            // AUTO-SEND immediately — no need to press Send button
            voiceAutoSend(text);
          }
        } catch (err) {
          console.error("Transcription error:", err);
          toast({ title: "Transcription failed", variant: "destructive" });
        } finally {
          setIsTranscribing(false);
        }
      };

      mediaRecorderRef.current = recorder;
      recorder.start(1000);
      setIsRecording(true);
      // Auto-enable voice mode when mic is used
      if (!voiceMode) setVoiceMode(true);
    } catch (err) {
      console.error("Microphone access error:", err);
      toast({ title: "Microphone access required for voice input", variant: "destructive" });
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    setIsRecording(false);
  };

  const lastToggleRef = useRef(0);
  const toggleRecording = () => {
    // Debounce: ignore taps within 500ms of each other
    const now = Date.now();
    if (now - lastToggleRef.current < 500) return;
    lastToggleRef.current = now;
    if (isRecording) stopRecording();
    else if (!isTranscribing) startRecording();
  };

  // ── Image Handling ────────────────────────────────────────────
  // ── Paste Handler (images + text from clipboard) ─────────────
  // Compress image to max 1024px and JPEG quality 0.7 for fast upload
  const compressImage = (file: File): Promise<{ preview: string; base64: string; mimeType: string }> => {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const MAX = 1024;
        let w = img.width, h = img.height;
        if (w > MAX || h > MAX) {
          if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
          else { w = Math.round(w * MAX / h); h = MAX; }
        }
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) { reject(new Error("Canvas not supported")); return; }
        ctx.drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
        resolve({ preview: dataUrl, base64: dataUrl.split(",")[1], mimeType: "image/jpeg" });
      };
      img.onerror = () => reject(new Error("Failed to load image"));
      img.src = URL.createObjectURL(file);
    });
  };


  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) return;
        try {
          const { preview, base64, mimeType } = await compressImage(file);
          setImagePreview(preview);
          setImageBase64(`${mimeType}:${base64}`);
          toast({ title: "Image pasted — tap send" });
        } catch {
          const reader = new FileReader();
          reader.onload = () => {
            const result = reader.result as string;
            setImagePreview(result);
            // Extract mime type from data URL (data:image/png;base64,...)
            const mimeMatch = result.match(/^data:(image\/[^;]+);base64,/);
            const mime = mimeMatch ? mimeMatch[1] : "image/jpeg";
            setImageBase64(`${mime}:${result.split(",")[1]}`);
            toast({ title: "Image pasted — tap send" });
          };
          reader.readAsDataURL(file);
        }
        return;
      }
    }
  };

  const handleImageSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) {
      console.warn("No file selected");
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      toast({ title: "Image too large (max 20MB)", variant: "destructive" });
      return;
    }
    if (!file.type.startsWith("image/")) {
      toast({ title: "Please select an image file", variant: "destructive" });
      return;
    }

    try {
      const { preview, base64, mimeType } = await compressImage(file);
      setImagePreview(preview);
      setImageBase64(`${mimeType}:${base64}`);
      toast({ title: "Image attached — tap send" });
    } catch (err) {
      console.error("Image compression failed:", err);
      // Fallback: read raw file
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        setImagePreview(result);
        const mimeMatch = result.match(/^data:(image\/[^;]+);base64,/);
        const mime = mimeMatch ? mimeMatch[1] : "image/jpeg";
        setImageBase64(`${mime}:${result.split(",")[1]}`);
        toast({ title: "Image attached — tap send" });
      };
      reader.onerror = () => {
        console.error("FileReader error:", reader.error);
        toast({ title: "Failed to read image", variant: "destructive" });
      };
      reader.readAsDataURL(file);
    }
    // Reset file input so same file can be re-selected
    e.target.value = "";
  };

  const clearImage = () => {
    setImagePreview(null);
    setImageBase64(null);
  };

  // ── Document File Handler ───────────────────────────────────
  const handleDocSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      toast({ title: "File too large (max 10MB)", variant: "destructive" });
      return;
    }
    setAttachedFileName(file.name);
    setFileExtractedText(null);
    setIsProcessingFile(true);
    e.target.value = "";

    try {
      const formData = new FormData();
      formData.append("file", file);
      const token = getSessionToken();
      const res = await fetch(`${API_BASE}/api/partner/read-file`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      });
      if (res.ok) {
        const data = await res.json();
        setFileExtractedText(data.text);
        toast({ title: `${file.name} — content extracted${data.truncated ? " (truncated)" : ""}` });
      } else {
        const err = await res.json().catch(() => ({ error: "Unknown error" }));
        toast({ title: err.error || "Failed to read file", variant: "destructive" });
      }
    } catch (err) {
      console.error("File extraction failed:", err);
      toast({ title: "Failed to process file", variant: "destructive" });
    } finally {
      setIsProcessingFile(false);
    }
  };

  const clearAttachedFile = () => {
    setAttachedFileName(null);
    setFileExtractedText(null);
    setIsProcessingFile(false);
  };

  // ── Clear Chat ──────────────────────────────────────────────
  const clearChat = async () => {
    if (!partnerRoomId) return;
    try {
      const token = getSessionToken();
      await fetch(`${API_BASE}/api/rooms/${partnerRoomId}/messages`, {
        method: "DELETE",
        headers: token ? { "x-session-token": token } : {},
        credentials: "include",
      });
      queryClient.invalidateQueries({ queryKey: [`/api/rooms/${partnerRoomId}/messages`] });
      toast({ title: "Chat cleared" });
    } catch {
      toast({ title: "Failed to clear chat", variant: "destructive" });
    }
    setHeaderMenuOpen(false);
  };

  // ── Refresh Daily Brief ────────────────────────────────────────
  const refreshDailyBrief = async () => {
    if (!partnerRoomId) return;
    try {
      proactiveCheckedRef.current = false;
      const data = await apiRequest("POST", `/api/rooms/${partnerRoomId}/proactive-check`).then((r) => r.json());
      if (data.message) {
        queryClient.invalidateQueries({ queryKey: ["/api/rooms", partnerRoomId, "messages"] });
        toast({ title: "Summary refreshed" });
      } else {
        toast({ title: "No new summary available" });
      }
    } catch {
      toast({ title: "Failed to refresh summary", variant: "destructive" });
    }
    setHeaderMenuOpen(false);
  };

  // ── Creative Mode ────────────────────────────────────────────
  const handleCreativeSelect = (mode: string, subType?: string) => {
    if (mode === "write") {
      setCreativeMode({ mode: "write", subType: subType || "story" });
    } else {
      setCreativeMode({ mode: "draw" });
    }
  };

  const clearCreativeMode = () => {
    setCreativeMode(null);
  };

  const sendCreative = useCallback(async () => {
    if (!input.trim() || !creativeMode) return;
    setIsCreating(true);

    try {
      if (creativeMode.mode === "write") {
        const res = await apiRequest("POST", "/api/partner/create/text", {
          type: creativeMode.subType || "story",
          prompt: input.trim(),
        });
        if (!res.ok) throw new Error("Creation failed");
        const data = await res.json();
        setCreativeResults((prev) => [...prev, { ...data, id: Date.now(), creativeMeta: { type: data.type, content: data.content, createdAt: data.createdAt } }]);
        queryClient.invalidateQueries({ queryKey: ["/api/partner/creations"] });
      } else {
        const res = await apiRequest("POST", "/api/partner/create/image", {
          prompt: input.trim(),
        });
        if (!res.ok) throw new Error("Image generation failed");
        const data = await res.json();
        setCreativeResults((prev) => [...prev, { id: Date.now(), type: "image", creativeMeta: { type: "image", content: input.trim(), imageUrl: data.imageUrl, revisedPrompt: data.revisedPrompt, createdAt: data.createdAt } }]);
        queryClient.invalidateQueries({ queryKey: ["/api/partner/creations"] });
      }
      setInput("");
      setCreativeMode(null);
    } catch {
      toast({ title: "Creation failed", variant: "destructive" });
    } finally {
      setIsCreating(false);
    }
  }, [input, creativeMode, toast]);

  const glowColor = getGlowColor(emotion);

  // ── Toggle action panel ────────────────────────────────────────
  const toggleActionPanel = useCallback(() => {
    setShowActionPanel((prev) => !prev);
  }, []);

  // ── Render ────────────────────────────────────────────────────
  return (
    <div
      className="flex h-[100dvh] w-full overflow-hidden"
      style={{ background: "linear-gradient(180deg, #0a0f1e 0%, #0F1B3D 50%, #0a0f1e 100%)" }}
    >
    {/* ── Left: Chat column ─────────────────────────────────── */}
    <div
      className="flex flex-col h-full overflow-hidden transition-all duration-300"
      style={{
        width: !isMobile && showActionPanel ? "55%" : "100%",
        minWidth: 0,
      }}
    >
      {/* ── Top Bar ──────────────────────────────────────────── */}
      <header
        className="flex items-center gap-3 px-4 py-3 flex-shrink-0 relative"
        style={{
          background: "rgba(10, 15, 30, 0.85)",
          borderBottom: "1px solid rgba(255,255,255,0.06)",
          backdropFilter: "blur(12px)",
        }}
      >
        <Link href="/">
          <a className="md:hidden text-muted-foreground hover:text-foreground p-1">
            <ArrowLeft className="w-5 h-5" />
          </a>
        </Link>
        <LucaAvatar emotion={emotion} size={36} />
        <div className="flex-1 min-w-0">
          <h1 className="text-sm font-semibold text-foreground truncate">Luca</h1>
          <div className="flex items-center gap-1.5">
            <div
              className="w-1.5 h-1.5 rounded-full"
              style={{ background: glowColor, boxShadow: `0 0 4px ${glowColor}` }}
            />
            <span className="text-[10px] text-muted-foreground capitalize">{emotion}</span>
            {partnerStatus?.trust && (
              <span className="text-[10px] text-muted-foreground/50">
                &middot; trust: {partnerStatus.trust}
              </span>
            )}
          </div>
        </div>

        {/* Voice Mode Toggle */}
        <button
          onClick={() => setVoiceMode(!voiceMode)}
          className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs transition-colors"
          style={{
            background: voiceMode ? "rgba(201,163,64,0.2)" : "rgba(255,255,255,0.05)",
            color: voiceMode ? "#C9A340" : "rgba(255,255,255,0.5)",
            border: `1px solid ${voiceMode ? "rgba(201,163,64,0.3)" : "rgba(255,255,255,0.08)"}`,
          }}
          title={voiceMode ? "Voice mode ON — auto-plays responses" : "Voice mode OFF"}
        >
          <Volume2 className="w-3.5 h-3.5" />
        </button>

        {/* Artifacts / Action Panel Toggle (desktop header) */}
        <button
          onClick={toggleActionPanel}
          className="relative hidden md:flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs transition-colors"
          style={{
            background: showActionPanel ? "rgba(201,163,64,0.2)" : "rgba(255,255,255,0.05)",
            color: showActionPanel ? "#C9A340" : "rgba(255,255,255,0.5)",
            border: `1px solid ${showActionPanel ? "rgba(201,163,64,0.3)" : "rgba(255,255,255,0.08)"}`,
          }}
          title="Artifacts panel"
        >
          <Layers className="w-3.5 h-3.5" />
          {parsedArtifacts.length > 0 && (
            <span
              className="absolute -top-1.5 -right-1.5 text-[9px] font-bold min-w-[16px] h-[16px] flex items-center justify-center rounded-full"
              style={{ background: "#C9A340", color: "#0a0f1e" }}
            >
              {parsedArtifacts.length}
            </span>
          )}
        </button>

        {/* Legacy gallery artifacts toggle */}
        <button
          onClick={() => { setShowArtifacts(!showArtifacts); setSelectedArtifact(null); }}
          className="relative flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs transition-colors"
          style={{
            background: showArtifacts ? "rgba(201,163,64,0.2)" : "rgba(255,255,255,0.05)",
            color: showArtifacts ? "#C9A340" : "rgba(255,255,255,0.5)",
            border: `1px solid ${showArtifacts ? "rgba(201,163,64,0.3)" : "rgba(255,255,255,0.08)"}`,
          }}
          title="Gallery artifacts"
        >
          <ImageIcon className="w-3.5 h-3.5" />
          {galleryItems.length > 0 && (
            <span
              className="absolute -top-1.5 -right-1.5 text-[9px] font-bold min-w-[16px] h-[16px] flex items-center justify-center rounded-full"
              style={{ background: "#C9A340", color: "#0a0f1e" }}
            >
              {galleryItems.length}
            </span>
          )}
        </button>

        {/* Header Menu Button */}
        <button
          onClick={() => setHeaderMenuOpen(!headerMenuOpen)}
          className="text-muted-foreground hover:text-foreground p-1.5 rounded-lg hover:bg-white/5 transition-colors"
        >
          <MoreVertical className="w-4 h-4" />
        </button>

        {/* Header Dropdown Menu */}
        <AnimatePresence>
          {headerMenuOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setHeaderMenuOpen(false)} />
              <motion.div
                initial={{ opacity: 0, y: -8, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -8, scale: 0.95 }}
                transition={{ duration: 0.15 }}
                className="absolute right-4 top-full mt-1 z-50 rounded-xl overflow-hidden min-w-[200px]"
                style={{
                  background: "rgba(15,27,61,0.98)",
                  border: "1px solid rgba(201,163,64,0.2)",
                  backdropFilter: "blur(20px)",
                  boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
                }}
              >
                <div className="p-1.5">
                  <Link href="/rooms">
                    <a
                      onClick={() => setHeaderMenuOpen(false)}
                      className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg hover:bg-white/5 transition-colors text-left"
                    >
                      <Menu className="w-4 h-4 text-[#C9A340]" />
                      <span className="text-sm text-foreground">Rooms</span>
                    </a>
                  </Link>
                  <Link href="/gallery">
                    <a
                      onClick={() => setHeaderMenuOpen(false)}
                      className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg hover:bg-white/5 transition-colors text-left"
                    >
                      <ImagePlus className="w-4 h-4 text-[#C9A340]" />
                      <span className="text-sm text-foreground">Gallery</span>
                    </a>
                  </Link>
                  <Link href="/knowledge">
                    <a
                      onClick={() => setHeaderMenuOpen(false)}
                      className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg hover:bg-white/5 transition-colors text-left"
                    >
                      <Search className="w-4 h-4 text-[#C9A340]" />
                      <span className="text-sm text-foreground">Knowledge</span>
                    </a>
                  </Link>
                  <button
                    onClick={refreshDailyBrief}
                    className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg hover:bg-white/5 transition-colors text-left"
                  >
                    <RefreshCw className="w-4 h-4 text-[#C9A340]" />
                    <span className="text-sm text-foreground">Refresh Summary</span>
                  </button>
                  <div className="my-1 border-t border-white/5" />
                  <button
                    onClick={clearChat}
                    className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg hover:bg-red-500/10 transition-colors text-left"
                  >
                    <Trash2 className="w-4 h-4 text-red-400" />
                    <span className="text-sm text-red-400">Clear Chat</span>
                  </button>
                </div>
              </motion.div>
            </>
          )}
        </AnimatePresence>
      </header>

      {/* ── Messages Area ────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto overscroll-contain py-3 space-y-1">
        {msgsLoading ? (
          <div className="flex items-center justify-center h-full">
            <div className="w-6 h-6 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-4 px-6">
            <LucaAvatar emotion={emotion} size={64} />
            <div className="text-center space-y-2">
              <h2 className="text-lg font-semibold" style={{ color: "#C9A340" }}>
                Welcome{user?.name ? `, ${user.name}` : ""}
              </h2>
              <p className="text-sm text-muted-foreground/70 max-w-xs leading-relaxed">
                I'm Luca, your AI partner. Ask me anything, share your thoughts, or start a conversation.
              </p>
            </div>
            <CapabilityCards onSelectPrompt={sendCapabilityPrompt} />
          </div>
        ) : (
          // Merge messages + creative results into one timeline
          [...messages.map((m: any) => ({ ...m, _type: "msg" as const })),
           ...creativeResults.map((cr: any) => ({ ...cr, _type: "creative" as const }))]
            .sort((a, b) => {
              const ta = Number(a.createdAt) || a.id || 0;
              const tb = Number(b.createdAt) || b.id || 0;
              return ta - tb;
            })
            .map((item: any, idx: number, arr: any[]) =>
              item._type === "creative" ? (
                <CreativeChatCard key={`cr-${item.id}`} message={item} />
              ) : isDailyBriefMessage(item, idx, user?.name) ? (
                <DailyBriefCard
                  key={`brief-${item.id}`}
                  message={item}
                  userName={user?.name}
                  emotion={emotion}
                  onRefresh={refreshDailyBrief}
                />
              ) : (
                <ChatBubble
                  key={item.id}
                  message={item}
                  isUser={isUser(item)}
                  emotion={emotion}
                  voiceMode={voiceMode}
                  onTTSDone={undefined}
                />
              )
            )
        )}

        <AnimatePresence>
          {isThinking && toolSteps.length > 0 ? (
            <TaskProgress key="task-progress" steps={toolSteps} emotion={emotion} />
          ) : isThinking ? (
            <TypingIndicator key="typing" emotion={emotion} />
          ) : null}
        </AnimatePresence>
        <AnimatePresence>
          {isCreating && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              className="flex items-center gap-2 px-4 py-3"
            >
              <div className="w-7 h-7 rounded-full flex items-center justify-center"
                style={{ background: "linear-gradient(135deg, #C9A340 0%, #D4AF37 100%)" }}>
                <Sparkles className="w-3.5 h-3.5 text-[#0a0f1e] animate-pulse" />
              </div>
              <div className="flex items-center gap-2 px-3 py-2 rounded-2xl"
                style={{ background: "rgba(201,163,64,0.08)", border: "1px solid rgba(201,163,64,0.15)" }}>
                <Loader2 className="w-3.5 h-3.5 animate-spin text-[#C9A340]" />
                <span className="text-xs text-[#C9A340]/70">Creating...</span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        <div ref={bottomRef} />
      </div>

      {/* ── Input Bar ────────────────────────────────────────── */}
      <div
        className="flex-shrink-0 px-3 pt-2"
        style={{
          background: "rgba(10, 15, 30, 0.85)",
          borderTop: "1px solid rgba(255,255,255,0.06)",
          backdropFilter: "blur(12px)",
          paddingBottom: "max(12px, env(safe-area-inset-bottom))",
        }}
      >
        {/* Image Preview */}
        <AnimatePresence>
          {imagePreview && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="mb-2 flex items-center gap-2"
            >
              <div className="relative">
                <img
                  src={imagePreview}
                  alt="Preview"
                  className="w-16 h-16 rounded-lg object-cover border border-white/10"
                />
                <button
                  onClick={clearImage}
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full flex items-center justify-center"
                  style={{ background: "#0a0f1e", border: "1px solid rgba(255,255,255,0.2)" }}
                >
                  <X className="w-3 h-3 text-white/60" />
                </button>
              </div>
              <span className="text-xs text-muted-foreground/50">Image attached</span>
            </motion.div>
          )}
        </AnimatePresence>

        {/* File Attachment Preview */}
        <AnimatePresence>
          {attachedFileName && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="mb-2 flex flex-col gap-1"
            >
              <div
                className="flex items-center gap-2 px-3 py-2 rounded-lg"
                style={{
                  background: "rgba(255,255,255,0.06)",
                  border: "1px solid rgba(255,255,255,0.1)",
                }}
              >
                {isProcessingFile ? (
                  <Loader2 className="w-4 h-4 text-[#C9A340] flex-shrink-0 animate-spin" />
                ) : (
                  <FileText className="w-4 h-4 text-[#C9A340] flex-shrink-0" />
                )}
                <span className="text-xs text-foreground/70 truncate max-w-[180px]">{attachedFileName}</span>
                <button
                  onClick={clearAttachedFile}
                  className="ml-1 text-muted-foreground/40 hover:text-foreground"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
              {isProcessingFile && (
                <span className="text-[10px] text-[#C9A340]/60 px-3">Extracting content...</span>
              )}
              {!isProcessingFile && fileExtractedText && (
                <span className="text-[10px] text-green-400/70 px-3">✓ Content extracted</span>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Transcribing indicator */}
        <AnimatePresence>
          {isTranscribing && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="mb-2 flex items-center gap-2 px-2"
            >
              <Loader2 className="w-3 h-3 animate-spin text-[#C9A340]" />
              <span className="text-xs text-[#C9A340]/70">Listening...</span>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Creative mode indicator */}
        <AnimatePresence>
          {creativeMode && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="mb-2 flex items-center gap-2 px-2"
            >
              <Sparkles className="w-3 h-3 text-[#C9A340]" />
              <span className="text-xs text-[#C9A340]/80">
                {creativeMode.mode === "write"
                  ? `Writing: ${creativeMode.subType || "story"}`
                  : "Drawing with DALL-E"}
              </span>
              <button onClick={clearCreativeMode} className="text-muted-foreground/40 hover:text-foreground ml-auto">
                <X className="w-3 h-3" />
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Input Row: [ + Attach ] [ Text input ] [ Mic ] [ Send ] */}
        <div className="flex items-end gap-1.5 relative">
          {/* Attach Menu Button */}
          <motion.button
            onClick={() => { setAttachMenuOpen(!attachMenuOpen); setCreativeMenuOpen(false); }}
            className="flex-shrink-0 flex items-center justify-center w-11 h-11 rounded-xl transition-colors"
            style={{
              background: attachMenuOpen ? "rgba(201,163,64,0.2)" : "rgba(255,255,255,0.05)",
              border: `1px solid ${attachMenuOpen ? "rgba(201,163,64,0.4)" : "rgba(255,255,255,0.08)"}`,
              color: attachMenuOpen ? "#C9A340" : "rgba(255,255,255,0.5)",
            }}
            animate={{ rotate: attachMenuOpen ? 45 : 0 }}
            transition={{ duration: 0.2 }}
          >
            <Plus className="w-5 h-5" />
          </motion.button>

          {/* Hidden file inputs */}
          <input ref={fileInputRef} type="file" accept="image/*,video/*" onChange={handleImageSelect} className="hidden" />
          <input ref={cameraInputRef} type="file" accept="image/*,video/*" capture="environment" onChange={handleImageSelect} className="hidden" />
          <input ref={docInputRef} type="file" accept=".pdf,.txt,.doc,.docx,.csv,.json,.md,.py,.js,.ts,.html,.css" onChange={handleDocSelect} className="hidden" />

          {/* Attach Menu Popover */}
          <AnimatePresence>
            {attachMenuOpen && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setAttachMenuOpen(false)} />
                <motion.div
                  initial={{ opacity: 0, y: 20, scale: 0.95 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 20, scale: 0.95 }}
                  transition={{ duration: 0.15 }}
                  className="absolute bottom-full left-0 mb-2 z-40 rounded-xl overflow-hidden min-w-[220px]"
                  style={{
                    background: "rgba(15,27,61,0.98)",
                    border: "1px solid rgba(201,163,64,0.2)",
                    backdropFilter: "blur(20px)",
                    boxShadow: "0 -8px 32px rgba(0,0,0,0.4)",
                  }}
                >
                  <div className="p-1.5">
                    <p className="px-3 py-1.5 text-[10px] font-medium text-[#C9A340]/60 uppercase tracking-wider">Attach</p>
                    <button
                      onClick={() => { cameraInputRef.current?.click(); setAttachMenuOpen(false); }}
                      className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg hover:bg-white/5 transition-colors text-left"
                    >
                      <Camera className="w-4 h-4 text-[#C9A340]" />
                      <div>
                        <div className="text-sm text-foreground">Camera</div>
                        <div className="text-[10px] text-muted-foreground/50">Take photo or video</div>
                      </div>
                    </button>
                    <button
                      onClick={() => { fileInputRef.current?.click(); setAttachMenuOpen(false); }}
                      className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg hover:bg-white/5 transition-colors text-left"
                    >
                      <ImagePlus className="w-4 h-4 text-[#C9A340]" />
                      <div>
                        <div className="text-sm text-foreground">Photo & Video</div>
                        <div className="text-[10px] text-muted-foreground/50">Choose from library</div>
                      </div>
                    </button>
                    <button
                      onClick={() => { docInputRef.current?.click(); setAttachMenuOpen(false); }}
                      className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg hover:bg-white/5 transition-colors text-left"
                    >
                      <File className="w-4 h-4 text-[#C9A340]" />
                      <div>
                        <div className="text-sm text-foreground">File</div>
                        <div className="text-[10px] text-muted-foreground/50">PDF, TXT, CSV, code</div>
                      </div>
                    </button>
                    <div className="my-1 border-t border-white/5" />
                    <p className="px-3 py-1.5 text-[10px] font-medium text-[#C9A340]/60 uppercase tracking-wider">Create</p>
                    <button
                      onClick={() => { setAttachMenuOpen(false); setCreativeMenuOpen(true); }}
                      className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg hover:bg-white/5 transition-colors text-left"
                    >
                      <Sparkles className="w-4 h-4 text-[#C9A340]" />
                      <div>
                        <div className="text-sm text-foreground">Create</div>
                        <div className="text-[10px] text-muted-foreground/50">Write or draw with AI</div>
                      </div>
                    </button>
                  </div>
                </motion.div>
              </>
            )}
          </AnimatePresence>

          {/* Creative Menu Popover (sub-menu from Create) */}
          <AnimatePresence>
            {creativeMenuOpen && (
              <CreativeMenu
                onSelect={handleCreativeSelect}
                onClose={() => setCreativeMenuOpen(false)}
              />
            )}
          </AnimatePresence>

          {/* Text Input */}
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={creativeMode
              ? creativeMode.mode === "draw"
                ? "Describe what you'd like me to create..."
                : "Describe what you'd like me to write..."
              : "Message Luca..."}
            rows={1}
            className="flex-1 resize-none rounded-xl px-4 py-2.5 text-sm bg-white/5 border border-white/10 text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-[#C9A340]/40 focus:ring-1 focus:ring-[#C9A340]/20"
            style={{ maxHeight: 120, minHeight: 44 }}
            onInput={(e) => {
              const target = e.target as HTMLTextAreaElement;
              target.style.height = "auto";
              target.style.height = Math.min(target.scrollHeight, 120) + "px";
            }}
          />

          {/* Mic Button */}
          <button
            onClick={toggleRecording}
            className="flex-shrink-0 flex items-center justify-center w-11 h-11 rounded-xl transition-colors"
            style={{
              background: isRecording ? "rgba(239,68,68,0.2)" : "rgba(255,255,255,0.05)",
              border: `1px solid ${isRecording ? "rgba(239,68,68,0.4)" : "rgba(255,255,255,0.08)"}`,
              color: isRecording ? "#EF4444" : "rgba(255,255,255,0.5)",
            }}
            title={isRecording ? "Stop recording" : "Voice input"}
          >
            {isRecording ? (
              <motion.div
                animate={{ scale: [1, 1.2, 1] }}
                transition={{ duration: 1, repeat: Infinity }}
              >
                <MicOff className="w-4 h-4" />
              </motion.div>
            ) : (
              <Mic className="w-4 h-4" />
            )}
          </button>

          {/* Send Button */}
          <Button
            size="sm"
            className="rounded-xl h-11 w-11 p-0 flex-shrink-0"
            style={{
              background: (input.trim() || imageBase64 || attachedFileName) ? "#C9A340" : "rgba(201,163,64,0.2)",
              color: (input.trim() || imageBase64 || attachedFileName) ? "#0a0f1e" : "rgba(201,163,64,0.5)",
            }}
            onClick={creativeMode ? sendCreative : send}
            disabled={(!input.trim() && !imageBase64 && !attachedFileName) || (!partnerRoomId && !creativeMode) || sendMutation.isPending || isCreating}
          >
            {isCreating ? <Loader2 className="w-4 h-4 animate-spin" /> : creativeMode ? <Sparkles className="w-4 h-4" /> : <Send className="w-4 h-4" />}
          </Button>
        </div>
        <div className="flex items-center justify-between px-1 pt-1.5">
          <span className="text-[9px] text-muted-foreground/30">
            {wsConnected ? "Connected" : "Reconnecting..."}
          </span>
          {partnerStatus?.interactions != null && partnerStatus.interactions > 0 && (
            <span className="text-[9px] text-muted-foreground/25">
              {partnerStatus.interactions} interactions
            </span>
          )}
        </div>
      </div>

      {/* ── Artifacts Sidebar (legacy gallery) ────────────────── */}
      <ArtifactsSidebar
        items={galleryItems}
        show={showArtifacts}
        onClose={() => { setShowArtifacts(false); setSelectedArtifact(null); }}
        selectedArtifact={selectedArtifact}
        onSelectArtifact={setSelectedArtifact}
      />
    </div>{/* end chat column */}

    {/* ── Right: Action Panel (desktop inline) ──────────────── */}
    {!isMobile && showActionPanel && (
      <motion.div
        initial={{ width: 0, opacity: 0 }}
        animate={{ width: "45%", opacity: 1 }}
        exit={{ width: 0, opacity: 0 }}
        transition={{ duration: 0.3, ease: "easeInOut" }}
        className="h-full overflow-hidden flex-shrink-0"
        style={{ maxWidth: "45%", minWidth: 0 }}
      >
        <ActionPanel
          artifacts={parsedArtifacts}
          show={true}
          onClose={() => setShowActionPanel(false)}
          isMobile={false}
        />
      </motion.div>
    )}

    {/* ── Mobile: Action Panel overlay + FAB toggle ─────────── */}
    {isMobile && (
      <>
        <ActionPanelToggle
          onClick={toggleActionPanel}
          isOpen={showActionPanel}
          hasNew={hasNewArtifacts}
          artifactCount={parsedArtifacts.length}
        />
        <ActionPanel
          artifacts={parsedArtifacts}
          show={showActionPanel}
          onClose={() => setShowActionPanel(false)}
          isMobile={true}
        />
      </>
    )}
    </div>
  );
}
