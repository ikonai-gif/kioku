import React, { useState, useRef, useCallback, useEffect } from "react";
import { Mic, MicOff, Loader2 } from "lucide-react";
import { getSessionToken } from "@/lib/auth";
import { API_BASE } from "@/lib/queryClient";
import { motion, AnimatePresence } from "framer-motion";

interface VoiceInputProps {
  onTranscript: (text: string) => void;
  disabled?: boolean;
  size?: "sm" | "md" | "lg";
  className?: string;
}

export function VoiceInput({ onTranscript, disabled, size = "md", className }: VoiceInputProps) {
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastToggleRef = useRef(0);

  const sizeConfig = {
    sm: { btn: "w-9 h-9", icon: "w-3.5 h-3.5", ring: 36 },
    md: { btn: "w-11 h-11", icon: "w-4 h-4", ring: 44 },
    lg: { btn: "w-14 h-14", icon: "w-5 h-5", ring: 56 },
  }[size];

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.stop();
      }
    };
  }, []);

  const startRecording = useCallback(async () => {
    try {
      if (!navigator.mediaDevices) return;

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "audio/mp4";
      const recorder = new MediaRecorder(stream, { mimeType });
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
        setRecordingDuration(0);

        const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
        if (blob.size < 100) return; // too short

        setIsTranscribing(true);
        try {
          const formData = new FormData();
          formData.append("audio", blob, "recording.webm");
          const token = getSessionToken();
          const res = await fetch(`${API_BASE}/api/voice/transcribe`, {
            method: "POST",
            headers: token ? { "x-session-token": token } : {},
            credentials: "include",
            body: formData,
          });
          if (!res.ok) throw new Error("Transcription failed");
          const { text } = await res.json();
          if (text?.trim()) onTranscript(text.trim());
        } catch (err) {
          console.error("VoiceInput transcription error:", err);
        } finally {
          setIsTranscribing(false);
        }
      };

      mediaRecorderRef.current = recorder;
      recorder.start(1000);
      setIsRecording(true);
      setRecordingDuration(0);
      timerRef.current = setInterval(() => setRecordingDuration((d) => d + 1), 1000);
    } catch (err) {
      console.error("Microphone access error:", err);
    }
  }, [onTranscript]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    setIsRecording(false);
  }, []);

  const toggleRecording = useCallback(() => {
    const now = Date.now();
    if (now - lastToggleRef.current < 500) return;
    lastToggleRef.current = now;
    if (isRecording) stopRecording();
    else if (!isTranscribing && !disabled) startRecording();
  }, [isRecording, isTranscribing, disabled, startRecording, stopRecording]);

  const formatDuration = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  return (
    <div className={`relative inline-flex items-center ${className || ""}`}>
      {/* Pulsing ring when recording */}
      <AnimatePresence>
        {isRecording && (
          <motion.div
            className="absolute inset-0 rounded-xl"
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{
              opacity: [0.4, 0.8, 0.4],
              scale: [1, 1.15, 1],
            }}
            exit={{ opacity: 0, scale: 0.8 }}
            transition={{ duration: 1.5, repeat: Infinity }}
            style={{
              border: "2px solid rgba(239,68,68,0.5)",
              borderRadius: "0.75rem",
            }}
          />
        )}
      </AnimatePresence>

      <button
        onClick={toggleRecording}
        disabled={disabled || isTranscribing}
        className={`flex-shrink-0 flex items-center justify-center ${sizeConfig.btn} rounded-xl transition-all relative z-10`}
        style={{
          background: isRecording
            ? "rgba(239,68,68,0.2)"
            : isTranscribing
              ? "rgba(201,163,64,0.15)"
              : "rgba(255,255,255,0.05)",
          border: `1px solid ${
            isRecording
              ? "rgba(239,68,68,0.4)"
              : isTranscribing
                ? "rgba(201,163,64,0.3)"
                : "rgba(255,255,255,0.08)"
          }`,
          color: isRecording
            ? "#EF4444"
            : isTranscribing
              ? "#C9A340"
              : "rgba(255,255,255,0.5)",
          cursor: disabled || isTranscribing ? "not-allowed" : "pointer",
          opacity: disabled ? 0.4 : 1,
        }}
        title={isRecording ? "Stop recording" : isTranscribing ? "Transcribing..." : "Voice input"}
      >
        {isTranscribing ? (
          <Loader2 className={`${sizeConfig.icon} animate-spin`} />
        ) : isRecording ? (
          <motion.div
            animate={{ scale: [1, 1.2, 1] }}
            transition={{ duration: 1, repeat: Infinity }}
          >
            <MicOff className={sizeConfig.icon} />
          </motion.div>
        ) : (
          <Mic className={sizeConfig.icon} />
        )}
      </button>

      {/* Duration badge when recording */}
      <AnimatePresence>
        {isRecording && recordingDuration > 0 && (
          <motion.span
            initial={{ opacity: 0, x: -4 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -4 }}
            className="ml-1.5 text-[10px] font-mono tabular-nums"
            style={{ color: "#EF4444" }}
          >
            {formatDuration(recordingDuration)}
          </motion.span>
        )}
      </AnimatePresence>
    </div>
  );
}
