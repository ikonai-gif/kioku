import React, { useState, useRef } from "react";
import { Volume2, VolumeX, Loader2, Pause } from "lucide-react";
import { getSessionToken } from "@/lib/auth";
import { API_BASE } from "@/lib/queryClient";
import { motion } from "framer-motion";

interface VoiceOutputProps {
  text: string;
  compact?: boolean;
  className?: string;
}

export function VoiceOutput({ text, compact, className }: VoiceOutputProps) {
  const [state, setState] = useState<"idle" | "loading" | "playing" | "paused">("idle");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);

  const cleanup = () => {
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
    audioRef.current = null;
  };

  const speak = async () => {
    if (state === "playing") {
      audioRef.current?.pause();
      setState("paused");
      return;
    }

    if (state === "paused" && audioRef.current) {
      setState("playing");
      await audioRef.current.play();
      return;
    }

    setState("loading");
    try {
      const token = getSessionToken();
      const res = await fetch(`${API_BASE}/api/voice/synthesize`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { "x-session-token": token } : {}),
        },
        credentials: "include",
        body: JSON.stringify({ text, voice: "alloy" }),
      });
      if (!res.ok) throw new Error("TTS failed");
      const blob = await res.blob();
      cleanup();
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => {
        setState("idle");
        cleanup();
      };
      audio.onerror = () => {
        setState("idle");
        cleanup();
      };
      setState("playing");
      await audio.play();
    } catch {
      setState("idle");
      cleanup();
    }
  };

  const stop = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    setState("idle");
    cleanup();
  };

  if (compact) {
    return (
      <motion.button
        onClick={state === "idle" || state === "loading" ? speak : state === "playing" ? speak : stop}
        className={`inline-flex items-center justify-center w-8 h-8 rounded-full transition-colors ${className || ""}`}
        style={{
          background: state === "playing" || state === "paused"
            ? "rgba(201,163,64,0.25)"
            : "rgba(255,255,255,0.06)",
          color: state === "playing" || state === "paused"
            ? "#C9A340"
            : "rgba(255,255,255,0.4)",
        }}
        animate={state === "playing" ? {
          boxShadow: ["0 0 4px #C9A34055", "0 0 12px #C9A34088", "0 0 4px #C9A34055"],
        } : {}}
        transition={state === "playing" ? { duration: 1.5, repeat: Infinity } : {}}
        title={
          state === "idle" ? "Listen" :
          state === "loading" ? "Loading..." :
          state === "playing" ? "Pause" : "Resume"
        }
      >
        {state === "loading" ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : state === "playing" ? (
          <Pause className="w-4 h-4" />
        ) : (
          <Volume2 className="w-4 h-4" />
        )}
      </motion.button>
    );
  }

  return (
    <div className={`inline-flex items-center gap-2 ${className || ""}`}>
      <motion.button
        onClick={speak}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-all text-xs font-medium"
        style={{
          background: state === "playing" || state === "paused"
            ? "rgba(201,163,64,0.2)"
            : "rgba(255,255,255,0.06)",
          border: `1px solid ${
            state === "playing" || state === "paused"
              ? "rgba(201,163,64,0.3)"
              : "rgba(255,255,255,0.1)"
          }`,
          color: state === "playing" || state === "paused"
            ? "#C9A340"
            : "rgba(255,255,255,0.5)",
        }}
        animate={state === "playing" ? {
          boxShadow: ["0 0 4px #C9A34033", "0 0 10px #C9A34066", "0 0 4px #C9A34033"],
        } : {}}
        transition={state === "playing" ? { duration: 1.5, repeat: Infinity } : {}}
      >
        {state === "loading" ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : state === "playing" ? (
          <Pause className="w-3.5 h-3.5" />
        ) : (
          <Volume2 className="w-3.5 h-3.5" />
        )}
        <span>
          {state === "idle" ? "Listen" :
           state === "loading" ? "Loading" :
           state === "playing" ? "Pause" : "Resume"}
        </span>
      </motion.button>

      {(state === "playing" || state === "paused") && (
        <motion.button
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          onClick={stop}
          className="inline-flex items-center justify-center w-7 h-7 rounded-full transition-colors"
          style={{
            background: "rgba(239,68,68,0.15)",
            color: "#EF4444",
            border: "1px solid rgba(239,68,68,0.2)",
          }}
          title="Stop"
        >
          <VolumeX className="w-3.5 h-3.5" />
        </motion.button>
      )}
    </div>
  );
}
