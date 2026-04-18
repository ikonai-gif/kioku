import { useState, useRef, useEffect, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest, API_BASE } from "@/lib/queryClient";
import { getSessionToken } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Send, ArrowLeft, Menu, Volume2, Mic, MicOff, ImagePlus, X, Loader2, Sparkles, PenLine, Palette, Copy, Download, FileText, Heart, ThumbsUp, Meh, ThumbsDown, Angry, ChevronDown, ChevronUp, Plus, Camera, Video, File, MoreVertical, Trash2, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "../App";
import { Link } from "wouter";
import { motion, AnimatePresence } from "framer-motion";

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

// ── Markdown-lite renderer for chat messages ────────────────────
function renderMessageContent(content: string): React.ReactNode {
  if (!content) return null;

  // Split on markdown images ![alt](url) and links [text](url)
  // Process images first, then links within remaining text segments
  const parts: React.ReactNode[] = [];
  let key = 0;

  // Regex that matches both ![alt](url) and [text](url)
  const mdRegex = /(!?\[([^\]]*)\]\(([^)]+)\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = mdRegex.exec(content)) !== null) {
    // Add text before this match
    if (match.index > lastIndex) {
      parts.push(<span key={key++}>{content.slice(lastIndex, match.index)}</span>);
    }

    const fullMatch = match[1];
    const altOrText = match[2];
    let url = match[3];
    const isImage = fullMatch.startsWith("!");

    if (isImage) {
      // Render as inline image
      parts.push(
        <img
          key={key++}
          src={url}
          alt={altOrText || "Image"}
          className="inline-block rounded-lg max-w-[280px] w-full my-1 cursor-pointer"
          style={{ maxHeight: 300 }}
          onClick={() => window.open(url, "_blank")}
        />
      );
    } else {
      // Resolve relative download links to full API URL
      const isDownload = url.startsWith("/api/files/") || url.includes("/download");
      if (url.startsWith("/api/")) {
        url = `${API_BASE}${url}`;
      }
      const isExternal = url.startsWith("http://") || url.startsWith("https://");
      parts.push(
        <a
          key={key++}
          href={url}
          target={isDownload ? "_self" : isExternal ? "_blank" : "_self"}
          rel={isExternal ? "noopener noreferrer" : undefined}
          download={isDownload ? (altOrText || true) : undefined}
          className={`inline-flex items-center gap-1.5 ${isDownload ? "px-3 py-1.5 rounded-lg bg-[#C9A340]/15 border border-[#C9A340]/30 text-[#C9A340] hover:bg-[#C9A340]/25" : "text-[#C9A340] underline underline-offset-2 hover:text-[#d4b44a]"} transition-colors`}
        >
          {isDownload && <span className="text-sm">📥</span>}
          {altOrText || url}
        </a>
      );
    }

    lastIndex = match.index + fullMatch.length;
  }

  // Add remaining text after last match
  if (lastIndex < content.length) {
    parts.push(<span key={key++}>{content.slice(lastIndex)}</span>);
  }

  // Second pass: detect raw URLs in text spans
  // Collect image URLs that were already rendered as <img> tags
  const renderedImageUrls = new Set<string>();
  for (const part of parts) {
    if (part && typeof part === "object" && (part as any).type === "img") {
      renderedImageUrls.add((part as any).props.src);
    }
  }

  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const finalParts: React.ReactNode[] = [];
  for (const part of parts) {
    if (part && typeof part === "object" && (part as any).type === "span") {
      const text = (part as any).props.children as string;
      if (typeof text === "string" && urlRegex.test(text)) {
        urlRegex.lastIndex = 0;
        let textLastIndex = 0;
        let urlMatch: RegExpExecArray | null;
        while ((urlMatch = urlRegex.exec(text)) !== null) {
          if (urlMatch.index > textLastIndex) {
            finalParts.push(<span key={key++}>{text.slice(textLastIndex, urlMatch.index)}</span>);
          }
          const rawUrl = urlMatch[1];
          if (renderedImageUrls.has(rawUrl)) {
            // Duplicate of an already-rendered image — skip it
          } else {
            finalParts.push(
              <a
                key={key++}
                href={rawUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[#C9A340] underline underline-offset-2 hover:text-[#d4b44a] transition-colors break-all"
              >
                {rawUrl.length > 60 ? rawUrl.slice(0, 60) + "…" : rawUrl}
              </a>
            );
          }
          textLastIndex = urlMatch.index + rawUrl.length;
        }
        if (textLastIndex < text.length) {
          finalParts.push(<span key={key++}>{text.slice(textLastIndex)}</span>);
        }
      } else {
        finalParts.push(part);
      }
    } else {
      finalParts.push(part);
    }
  }

  return finalParts.length > 0 ? finalParts : content;
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

// ── Main Partner Chat Page ───────────────────────────────────────
export default function PartnerChat() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [input, setInput] = useState("");
  const [partnerRoomId, setPartnerRoomId] = useState<number | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [voiceMode, setVoiceMode] = useState(false);
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
            queryClient.setQueryData<any[]>(
              ["/api/rooms", partnerRoomId, "messages"],
              (prev) => {
                if (!prev) return [data];
                if (prev.some((m) => m.id === data.id)) return prev;
                return [...prev, data];
              }
            );
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

  // ── Detect agent response (clear thinking indicator) ──────────
  useEffect(() => {
    if (messages.length > lastMessageCountRef.current) {
      const lastMsg = messages[messages.length - 1];
      if (lastMsg && lastMsg.agentName !== user?.name && lastMsg.agentName !== "You") {
        setIsThinking(false);
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
      setIsThinking(true);
    },
    onError: () => toast({ title: "Failed to send", variant: "destructive" }),
  });

  const send = useCallback(async () => {
    const hasText = input.trim().length > 0;
    const hasImage = !!imageBase64;
    if (!hasText && !hasImage) return;
    if (!partnerRoomId) return;

    let messageContent = input.trim();

    // If image attached, get Luca's vision description and include in message
    if (hasImage) {
      try {
        const visionRes = await apiRequest("POST", "/api/partner/see", {
          image: imageBase64,
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
  }, [input, partnerRoomId, user, imageBase64]);

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

  // ── Voice Recording ───────────────────────────────────────────
  const startRecording = async () => {
    try {
      if (!navigator.mediaDevices) {
        toast({ title: "Microphone not available on this device", variant: "destructive" });
        return;
      }
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
          if (text) setInput((prev) => (prev ? prev + " " + text : text));
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

  const toggleRecording = () => {
    if (isRecording) stopRecording();
    else startRecording();
  };

  // ── Image Handling ────────────────────────────────────────────
  // Compress image to max 1024px and JPEG quality 0.7 for fast upload
  const compressImage = (file: File): Promise<{ preview: string; base64: string }> => {
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
        resolve({ preview: dataUrl, base64: dataUrl.split(",")[1] });
      };
      img.onerror = () => reject(new Error("Failed to load image"));
      img.src = URL.createObjectURL(file);
    });
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
      const { preview, base64 } = await compressImage(file);
      setImagePreview(preview);
      setImageBase64(base64);
      toast({ title: "Image attached — tap send" });
    } catch (err) {
      console.error("Image compression failed:", err);
      // Fallback: read raw file
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        setImagePreview(result);
        setImageBase64(result.split(",")[1]);
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
  const handleDocSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      toast({ title: "File too large (max 10MB)", variant: "destructive" });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result as string;
      const truncated = text.length > 8000 ? text.slice(0, 8000) + "\n...(truncated)" : text;
      setInput(`[File: ${file.name}]\n${truncated}`);
      toast({ title: `${file.name} attached` });
    };
    reader.onerror = () => toast({ title: "Failed to read file", variant: "destructive" });
    reader.readAsText(file);
    e.target.value = "";
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

  // ── Render ────────────────────────────────────────────────────
  return (
    <div
      className="flex flex-col h-[100dvh] w-full overflow-hidden"
      style={{ background: "linear-gradient(180deg, #0a0f1e 0%, #0F1B3D 50%, #0a0f1e 100%)" }}
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
          </div>
        ) : (
          messages.map((msg: any, idx: number) => (
            <ChatBubble
              key={msg.id}
              message={msg}
              isUser={isUser(msg)}
              emotion={emotion}
              voiceMode={voiceMode}
              onTTSDone={idx === messages.length - 1 && voiceMode && !isUser(msg) ? () => {
                // Auto-start recording after Luca finishes speaking (continuous voice conversation)
                if (!isRecording && !isTranscribing) {
                  toggleRecording();
                }
              } : undefined}
            />
          ))
        )}

        {/* Creative results */}
        {creativeResults.map((cr: any) => (
          <CreativeChatCard key={cr.id} message={cr} />
        ))}

        <AnimatePresence>{isThinking && <TypingIndicator emotion={emotion} />}</AnimatePresence>
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
              background: (input.trim() || imageBase64) ? "#C9A340" : "rgba(201,163,64,0.2)",
              color: (input.trim() || imageBase64) ? "#0a0f1e" : "rgba(201,163,64,0.5)",
            }}
            onClick={creativeMode ? sendCreative : send}
            disabled={(!input.trim() && !imageBase64) || (!partnerRoomId && !creativeMode) || sendMutation.isPending || isCreating}
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
    </div>
  );
}
