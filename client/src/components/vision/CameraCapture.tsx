import React, { useState, useRef, useCallback, useEffect } from "react";
import { Camera, X, Send, Loader2, ImageIcon, SwitchCamera } from "lucide-react";
import { getSessionToken } from "@/lib/auth";
import { API_BASE } from "@/lib/queryClient";
import { motion, AnimatePresence } from "framer-motion";

interface CameraCaptureProps {
  onAnalysis: (result: { analysis: string; suggestions: Array<{ type: string; label: string; payload: string }> }) => void;
  onImageAttach?: (preview: string, base64: string, mimeType: string) => void;
  disabled?: boolean;
  className?: string;
}

export function CameraCapture({ onAnalysis, onImageAttach, disabled, className }: CameraCaptureProps) {
  const [preview, setPreview] = useState<string | null>(null);
  const [base64Data, setBase64Data] = useState<string | null>(null);
  const [mimeType, setMimeType] = useState("image/jpeg");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [showCamera, setShowCamera] = useState(false);
  const [facingMode, setFacingMode] = useState<"environment" | "user">("environment");
  const [stream, setStream] = useState<MediaStream | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const compressImage = useCallback((file: File): Promise<{ preview: string; base64: string; mimeType: string }> => {
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
        const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
        resolve({ preview: dataUrl, base64: dataUrl.split(",")[1], mimeType: "image/jpeg" });
      };
      img.onerror = () => reject(new Error("Failed to load image"));
      img.src = URL.createObjectURL(file);
    });
  }, []);

  const stopCamera = useCallback(() => {
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      setStream(null);
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, [stream]);

  const startCamera = useCallback(async (facing: "environment" | "user") => {
    stopCamera();
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      setStream(mediaStream);
      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream;
      }
    } catch {
      // getUserMedia failed — close overlay and fall back to file picker
      setShowCamera(false);
      inputRef.current?.click();
    }
  }, [stopCamera]);

  // Attach stream to video element when it mounts or stream changes
  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream, showCamera]);

  // Cleanup stream on unmount
  useEffect(() => {
    return () => {
      stream?.getTracks().forEach(t => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const captureFrame = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Mirror front camera capture to match viewfinder
    if (facingMode === "user") {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0);

    // Compress to max 1024px
    const MAX = 1024;
    let w = canvas.width, h = canvas.height;
    if (w > MAX || h > MAX) {
      if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
      else { w = Math.round(w * MAX / h); h = MAX; }
      const tmpCanvas = document.createElement("canvas");
      tmpCanvas.width = w;
      tmpCanvas.height = h;
      const tmpCtx = tmpCanvas.getContext("2d");
      if (tmpCtx) {
        tmpCtx.drawImage(canvas, 0, 0, w, h);
        const dataUrl = tmpCanvas.toDataURL("image/jpeg", 0.8);
        setPreview(dataUrl);
        setBase64Data(dataUrl.split(",")[1]);
        setMimeType("image/jpeg");
      }
    } else {
      const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
      setPreview(dataUrl);
      setBase64Data(dataUrl.split(",")[1]);
      setMimeType("image/jpeg");
    }

    stopCamera();
    setShowCamera(false);
    setShowPreview(true);
  }, [facingMode, stopCamera]);

  const flipCamera = useCallback(() => {
    const next = facingMode === "environment" ? "user" : "environment";
    setFacingMode(next);
    startCamera(next);
  }, [facingMode, startCamera]);

  const handleCapture = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const result = await compressImage(file);
      setPreview(result.preview);
      setBase64Data(result.base64);
      setMimeType(result.mimeType);
      setShowPreview(true);
    } catch (err) {
      console.error("Image processing error:", err);
    }
    if (inputRef.current) inputRef.current.value = "";
  }, [compressImage]);

  const analyzeImage = useCallback(async () => {
    if (!base64Data) return;
    setIsAnalyzing(true);
    try {
      const token = getSessionToken();
      const res = await fetch(`${API_BASE}/api/vision/analyze`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { "x-session-token": token } : {}),
        },
        credentials: "include",
        body: JSON.stringify({ image: base64Data, mimeType }),
      });
      if (!res.ok) throw new Error("Vision analysis failed");
      const data = await res.json();
      onAnalysis(data);
      setShowPreview(false);
      clearPreview();
    } catch (err) {
      console.error("Vision analysis error:", err);
    } finally {
      setIsAnalyzing(false);
    }
  }, [base64Data, mimeType, onAnalysis]);

  const attachToChat = useCallback(() => {
    if (!preview || !base64Data || !onImageAttach) return;
    onImageAttach(preview, base64Data, mimeType);
    setShowPreview(false);
    clearPreview();
  }, [preview, base64Data, mimeType, onImageAttach]);

  const clearPreview = () => {
    setPreview(null);
    setBase64Data(null);
    setShowPreview(false);
  };

  const openCamera = useCallback(async () => {
    if (disabled) return;
    // Try getUserMedia for live camera; fall back to file picker
    if (navigator.mediaDevices?.getUserMedia) {
      setShowCamera(true);
      startCamera(facingMode);
    } else {
      inputRef.current?.click();
    }
  }, [disabled, facingMode, startCamera]);

  const closeCamera = useCallback(() => {
    stopCamera();
    setShowCamera(false);
  }, [stopCamera]);

  return (
    <>
      {/* Hidden file input — fallback for when getUserMedia is unavailable */}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handleCapture}
        className="hidden"
      />

      {/* Hidden canvas for frame capture */}
      <canvas ref={canvasRef} className="hidden" />

      {/* Camera trigger button */}
      <button
        onClick={openCamera}
        disabled={disabled}
        className={`flex-shrink-0 flex items-center justify-center w-11 h-11 rounded-xl transition-colors ${className || ""}`}
        style={{
          background: "rgba(255,255,255,0.05)",
          border: "1px solid rgba(255,255,255,0.08)",
          color: "rgba(255,255,255,0.5)",
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.4 : 1,
        }}
        title="Camera — Take photo for AI analysis"
      >
        <Camera className="w-4 h-4" />
      </button>

      {/* Live camera viewfinder overlay */}
      <AnimatePresence>
        {showCamera && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-50 flex flex-col"
            style={{
              background: "rgba(5,10,30,0.95)",
            }}
          >
            {/* Camera header controls */}
            <div
              className="relative z-10 flex items-center justify-between px-4 py-3 safe-area-top"
              style={{ background: "rgba(5,10,30,0.6)", backdropFilter: "blur(12px)" }}
            >
              <button
                onClick={closeCamera}
                className="flex items-center justify-center w-10 h-10 rounded-full"
                style={{ background: "rgba(255,255,255,0.1)" }}
              >
                <X className="w-5 h-5 text-white" />
              </button>
              <span className="text-sm font-medium text-white/80">Camera</span>
              <button
                onClick={flipCamera}
                className="flex items-center justify-center w-10 h-10 rounded-full"
                style={{ background: "rgba(255,255,255,0.1)" }}
              >
                <SwitchCamera className="w-5 h-5 text-white" />
              </button>
            </div>

            {/* Live video feed */}
            <div className="flex-1 flex items-center justify-center overflow-hidden">
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className="w-full h-full object-cover"
                style={{
                  transform: facingMode === "user" ? "scaleX(-1)" : "none",
                }}
              />
            </div>

            {/* Shutter button area */}
            <div
              className="relative z-10 flex items-center justify-center px-4 pb-8 pt-5 safe-area-bottom"
              style={{ background: "rgba(5,10,30,0.6)", backdropFilter: "blur(12px)" }}
            >
              <button
                onClick={captureFrame}
                className="shutter-btn flex items-center justify-center rounded-full transition-transform active:scale-90"
                style={{
                  width: 72,
                  height: 72,
                  background: "#C9A340",
                  border: "4px solid rgba(201,163,64,0.4)",
                  boxShadow: "0 0 24px rgba(201,163,64,0.4), 0 0 48px rgba(201,163,64,0.15)",
                }}
              >
                <div
                  className="rounded-full"
                  style={{
                    width: 56,
                    height: 56,
                    background: "#C9A340",
                    border: "2px solid rgba(255,255,255,0.3)",
                  }}
                />
              </button>
            </div>

            {/* Shutter pulse animation */}
            <style>{`
              .shutter-btn {
                animation: shutter-pulse 2s ease-in-out infinite;
              }
              @keyframes shutter-pulse {
                0%, 100% { box-shadow: 0 0 24px rgba(201,163,64,0.4), 0 0 48px rgba(201,163,64,0.15); }
                50% { box-shadow: 0 0 32px rgba(201,163,64,0.6), 0 0 64px rgba(201,163,64,0.25); }
              }
            `}</style>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Image preview overlay (after capture) */}
      <AnimatePresence>
        {showPreview && preview && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex flex-col"
            style={{
              background: "rgba(5,10,30,0.95)",
              backdropFilter: "blur(20px)",
            }}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 safe-area-top">
              <button
                onClick={clearPreview}
                className="flex items-center justify-center w-10 h-10 rounded-full"
                style={{ background: "rgba(255,255,255,0.1)" }}
              >
                <X className="w-5 h-5 text-white" />
              </button>
              <span className="text-sm font-medium text-white/80">Preview</span>
              <button
                onClick={() => { clearPreview(); openCamera(); }}
                className="flex items-center justify-center w-10 h-10 rounded-full"
                style={{ background: "rgba(255,255,255,0.1)" }}
              >
                <Camera className="w-5 h-5 text-white" />
              </button>
            </div>

            {/* Image preview */}
            <div className="flex-1 flex items-center justify-center p-4 overflow-hidden">
              <img
                src={preview}
                alt="Captured"
                className="max-w-full max-h-full rounded-xl object-contain"
                style={{
                  border: "1px solid rgba(201,163,64,0.2)",
                  boxShadow: "0 0 40px rgba(201,163,64,0.1)",
                }}
              />
            </div>

            {/* Action buttons */}
            <div className="px-4 pb-6 safe-area-bottom">
              <div className="flex gap-3">
                {onImageAttach && (
                  <button
                    onClick={attachToChat}
                    className="flex-1 flex items-center justify-center gap-2 py-3.5 rounded-xl text-sm font-medium transition-all"
                    style={{
                      background: "rgba(255,255,255,0.08)",
                      border: "1px solid rgba(255,255,255,0.15)",
                      color: "rgba(255,255,255,0.8)",
                    }}
                  >
                    <ImageIcon className="w-4 h-4" />
                    Attach to Chat
                  </button>
                )}
                <button
                  onClick={analyzeImage}
                  disabled={isAnalyzing}
                  className="flex-1 flex items-center justify-center gap-2 py-3.5 rounded-xl text-sm font-medium transition-all"
                  style={{
                    background: isAnalyzing ? "rgba(201,163,64,0.3)" : "#C9A340",
                    color: isAnalyzing ? "rgba(255,255,255,0.7)" : "#0a0f1e",
                    boxShadow: "0 0 20px rgba(201,163,64,0.3)",
                  }}
                >
                  {isAnalyzing ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Analyzing...
                    </>
                  ) : (
                    <>
                      <Send className="w-4 h-4" />
                      Analyze with AI
                    </>
                  )}
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
