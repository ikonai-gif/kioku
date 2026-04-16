import { useState, useRef, useEffect, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest, API_BASE } from "@/lib/queryClient";
import { getSessionToken } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Send, ArrowLeft, Menu, Volume2, Mic, MicOff, ImagePlus, X, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "../App";
import { Link } from "wouter";
import { motion, AnimatePresence } from "framer-motion";

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

// ── Agent O Avatar ───────────────────────────────────────────────
function AgentOAvatar({ emotion, size = 40, pulse = false }: { emotion: string; size?: number; pulse?: boolean }) {
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
        O
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
      <AgentOAvatar emotion={emotion} size={28} pulse />
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

// ── Speaker Button on Agent O messages ───────────────────────────
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
      className="inline-flex items-center justify-center w-6 h-6 rounded-full transition-colors"
      style={{
        background: state === "playing" ? "rgba(201,163,64,0.25)" : "rgba(255,255,255,0.06)",
        color: state === "playing" ? "#C9A340" : "rgba(255,255,255,0.4)",
      }}
      animate={state === "playing" ? { boxShadow: ["0 0 4px #C9A34055", "0 0 12px #C9A34088", "0 0 4px #C9A34055"] } : {}}
      transition={state === "playing" ? { duration: 1.5, repeat: Infinity } : {}}
      title="Play message"
    >
      {state === "loading" ? (
        <Loader2 className="w-3 h-3 animate-spin" />
      ) : (
        <Volume2 className="w-3 h-3" />
      )}
    </motion.button>
  );
}

// ── Chat Message Bubble ──────────────────────────────────────────
function ChatBubble({ message, isUser, emotion, voiceMode }: { message: any; isUser: boolean; emotion: string; voiceMode: boolean }) {
  const glowColor = getGlowColor(emotion);
  const autoPlayedRef = useRef(false);

  // Auto-play TTS for new Agent O messages when voice mode is on
  useEffect(() => {
    if (!isUser && voiceMode && !autoPlayedRef.current && message.content) {
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
          audio.onended = () => URL.revokeObjectURL(url);
          audio.play().catch(() => URL.revokeObjectURL(url));
        })
        .catch(() => {});
    }
  }, []);

  return (
    <motion.div
      initial={{ opacity: 0, y: 12, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.25, ease: "easeOut" }}
      className={cn("flex w-full px-4 py-1", isUser ? "justify-end" : "justify-start")}
    >
      {!isUser && (
        <div className="flex-shrink-0 mr-2 mt-1">
          <AgentOAvatar emotion={emotion} size={28} />
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
        <p className="whitespace-pre-wrap break-words">{message.content}</p>
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
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const lastMessageCountRef = useRef(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
        description: "Direct conversation with Agent O",
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
    if (!rooms || rooms.length === 0) return;
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
  useEffect(() => {
    if (!partnerRoomId) return;

    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const wsUrl = `${protocol}://${window.location.host}/ws`;
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
  }, [partnerRoomId]);

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

    // If image attached, get Agent O's vision description and include in message
    if (hasImage) {
      try {
        const visionRes = await apiRequest("POST", "/api/partner/see", {
          image: imageBase64,
          prompt: hasText ? input.trim() : undefined,
        });
        if (visionRes.ok) {
          const { description } = await visionRes.json();
          messageContent = hasText
            ? `${input.trim()}\n\n[Shared an image — Agent O sees: ${description}]`
            : `[Shared an image — Agent O sees: ${description}]`;
        }
      } catch {
        // If vision fails, still send the text
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
      send();
    }
  };

  const isUser = (msg: any) => {
    return msg.agentName === user?.name || msg.agentName === "You" || (!msg.agentId && msg.agentName === (user?.name || "You"));
  };

  // ── Voice Recording ───────────────────────────────────────────
  const startRecording = async () => {
    try {
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
        } catch {
          toast({ title: "Transcription failed", variant: "destructive" });
        } finally {
          setIsTranscribing(false);
        }
      };

      mediaRecorderRef.current = recorder;
      recorder.start();
      setIsRecording(true);
    } catch {
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
  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      toast({ title: "Image too large (max 10MB)", variant: "destructive" });
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      setImagePreview(result);
      // Extract base64 data without the data URL prefix
      const base64 = result.split(",")[1];
      setImageBase64(base64);
    };
    reader.readAsDataURL(file);
    // Reset file input so same file can be re-selected
    e.target.value = "";
  };

  const clearImage = () => {
    setImagePreview(null);
    setImageBase64(null);
  };

  const glowColor = getGlowColor(emotion);

  // ── Render ────────────────────────────────────────────────────
  return (
    <div
      className="flex flex-col h-[100dvh] w-full overflow-hidden"
      style={{ background: "linear-gradient(180deg, #0a0f1e 0%, #0F1B3D 50%, #0a0f1e 100%)" }}
    >
      {/* ── Top Bar ──────────────────────────────────────────── */}
      <header
        className="flex items-center gap-3 px-4 py-3 flex-shrink-0"
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
        <AgentOAvatar emotion={emotion} size={36} />
        <div className="flex-1 min-w-0">
          <h1 className="text-sm font-semibold text-foreground truncate">Agent O</h1>
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
          {voiceMode ? <Volume2 className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
          <span className="hidden sm:inline">{voiceMode ? "Voice" : "Voice"}</span>
        </button>

        <Link href="/rooms">
          <a className="text-muted-foreground hover:text-foreground p-1.5 rounded-lg hover:bg-white/5">
            <Menu className="w-4 h-4" />
          </a>
        </Link>
      </header>

      {/* ── Messages Area ────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto overscroll-contain py-3 space-y-1">
        {msgsLoading ? (
          <div className="flex items-center justify-center h-full">
            <div className="w-6 h-6 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-4 px-6">
            <AgentOAvatar emotion={emotion} size={64} />
            <div className="text-center space-y-2">
              <h2 className="text-lg font-semibold" style={{ color: "#C9A340" }}>
                Welcome{user?.name ? `, ${user.name}` : ""}
              </h2>
              <p className="text-sm text-muted-foreground/70 max-w-xs leading-relaxed">
                I'm Agent O, your AI partner. Ask me anything, share your thoughts, or start a conversation.
              </p>
            </div>
          </div>
        ) : (
          messages.map((msg: any) => (
            <ChatBubble key={msg.id} message={msg} isUser={isUser(msg)} emotion={emotion} voiceMode={voiceMode} />
          ))
        )}

        <AnimatePresence>{isThinking && <TypingIndicator emotion={emotion} />}</AnimatePresence>
        <div ref={bottomRef} />
      </div>

      {/* ── Input Bar ────────────────────────────────────────── */}
      <div
        className="flex-shrink-0 px-3 pb-3 pt-2"
        style={{
          background: "rgba(10, 15, 30, 0.85)",
          borderTop: "1px solid rgba(255,255,255,0.06)",
          backdropFilter: "blur(12px)",
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

        {/* Input Row: [ Mic ] [ Image ] [ Text input ] [ Send ] */}
        <div className="flex items-end gap-1.5">
          {/* Mic Button */}
          <button
            onClick={toggleRecording}
            className="flex-shrink-0 flex items-center justify-center w-10 h-10 rounded-xl transition-colors"
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

          {/* Image Button */}
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex-shrink-0 flex items-center justify-center w-10 h-10 rounded-xl transition-colors"
            style={{
              background: imagePreview ? "rgba(201,163,64,0.15)" : "rgba(255,255,255,0.05)",
              border: `1px solid ${imagePreview ? "rgba(201,163,64,0.3)" : "rgba(255,255,255,0.08)"}`,
              color: imagePreview ? "#C9A340" : "rgba(255,255,255,0.5)",
            }}
            title="Attach image"
          >
            <ImagePlus className="w-4 h-4" />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={handleImageSelect}
            className="hidden"
          />

          {/* Text Input */}
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message Agent O..."
            rows={1}
            className="flex-1 resize-none rounded-xl px-4 py-2.5 text-sm bg-white/5 border border-white/10 text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-[#C9A340]/40 focus:ring-1 focus:ring-[#C9A340]/20"
            style={{ maxHeight: 120, minHeight: 40 }}
            onInput={(e) => {
              const target = e.target as HTMLTextAreaElement;
              target.style.height = "auto";
              target.style.height = Math.min(target.scrollHeight, 120) + "px";
            }}
          />

          {/* Send Button */}
          <Button
            size="sm"
            className="rounded-xl h-10 w-10 p-0 flex-shrink-0"
            style={{
              background: (input.trim() || imageBase64) ? "#C9A340" : "rgba(201,163,64,0.2)",
              color: (input.trim() || imageBase64) ? "#0a0f1e" : "rgba(201,163,64,0.5)",
            }}
            onClick={send}
            disabled={(!input.trim() && !imageBase64) || !partnerRoomId || sendMutation.isPending}
          >
            <Send className="w-4 h-4" />
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
