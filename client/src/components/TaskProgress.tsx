import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Check, Loader2 } from "lucide-react";

// ── Tool name → friendly Russian label + icon ───────────────────
const TOOL_MAP: Record<string, { icon: string; label: string }> = {
  web_search:              { icon: "🔍", label: "Ищу в интернете" },
  browse_website:          { icon: "🌐", label: "Открываю страницу" },
  code_execution:          { icon: "💻", label: "Выполняю код" },
  composio_gmail:          { icon: "📧", label: "Читаю Gmail" },
  composio_calendar:       { icon: "📅", label: "Смотрю календарь" },
  composio_notion:         { icon: "📝", label: "Читаю Notion" },
  composio_sheets:         { icon: "📊", label: "Читаю Google Sheets" },
  generate_image:          { icon: "🎨", label: "Рисую кадр" },
  image_generation:        { icon: "🎨", label: "Создаю картинку" },
  generate_video:          { icon: "🎬", label: "Снимаю сцену" },
  generate_image_to_video: { icon: "✨", label: "Оживляю кадр" },
  generate_speech:         { icon: "🎤", label: "Озвучка" },
  clone_voice:             { icon: "🗣️", label: "Клонирую голос" },
  generate_sfx:            { icon: "🔊", label: "Звуковые эффекты" },
  generate_music:          { icon: "🎵", label: "Сочиняю музыку" },
  stitch_media:            { icon: "🧵", label: "Склейка клипов" },
  add_subtitles:           { icon: "💬", label: "Добавляю субтитры" },
  add_title_cards:         { icon: "🎦", label: "Заставки" },
  series_bible:            { icon: "📖", label: "Библия сериала" },
  produce_episode:         { icon: "🎥", label: "Произвожу эпизод" },
  creative_writing:        { icon: "✍️", label: "Пишу сценарий" },
  plan_steps:              { icon: "🧠", label: "Планирую шаги" },
  delegate_task:           { icon: "👥", label: "Делегирую агенту" },
  delegate_parallel:       { icon: "👥", label: "Параллельные агенты" },
  analyze_image:           { icon: "👁️", label: "Смотрю изображение" },
  tts:                     { icon: "🔊", label: "Генерирую речь" },
  deliberation:            { icon: "🤝", label: "Совещаюсь с командой" },
};

function getFriendlyTool(toolName: string): { icon: string; label: string } {
  if (TOOL_MAP[toolName]) return TOOL_MAP[toolName];
  for (const key of Object.keys(TOOL_MAP)) {
    if (toolName.startsWith(key)) return TOOL_MAP[key];
  }
  const label = toolName.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return { icon: "⚙️", label };
}

export interface ToolStep {
  id: string;
  toolName: string;
  status: "running" | "done" | "error";
  startedAt: number;
  /** Live/server-sent description — e.g. "Терминал: npm install → added 124 packages". */
  description?: string;
  /** Short preview of the tool result (shown when status=done). */
  preview?: string;
}

interface TaskProgressProps {
  steps: ToolStep[];
  emotion?: string;
  startTime?: number;
}

// ── Living eyes — cheerful, with sparkle и улыбкой ────────────────
function LivingEyes() {
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [blink, setBlink] = useState(false);

  useEffect(() => {
    const positions = [
      { x: 0, y: 0 }, { x: -1, y: 0 }, { x: 1, y: 0 },
      { x: 0, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 },
    ];
    let i = 0;
    const t = setInterval(() => {
      i = (i + 1) % positions.length;
      setPos(positions[i]);
    }, 700 + Math.random() * 400);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const t = setInterval(() => {
      setBlink(true);
      setTimeout(() => setBlink(false), 140);
    }, 2200 + Math.random() * 1600);
    return () => clearInterval(t);
  }, []);

  // Bigger rounder eyes, warm white base + golden sparkle highlight
  const eyeBase = (dx: number): React.CSSProperties => ({
    position: "absolute",
    width: 7,
    height: blink ? 1.5 : 7,
    borderRadius: 999,
    background: "#FFF6DC",
    boxShadow: "0 0 4px rgba(255,246,220,0.6), inset 0 -1px 2px rgba(201,163,64,0.35)",
    top: 10 + pos.y,
    left: `calc(50% + ${dx + pos.x}px - 3.5px)`,
    transition: "height 0.12s ease, left 0.22s ease, top 0.22s ease",
  });
  // Pupil with sparkle dot
  const pupil = (dx: number): React.CSSProperties => ({
    position: "absolute",
    width: 3,
    height: blink ? 0 : 3,
    borderRadius: 999,
    background: "#1a2744",
    top: 12 + pos.y,
    left: `calc(50% + ${dx + pos.x}px - 1.5px)`,
    transition: "height 0.12s ease, left 0.22s ease, top 0.22s ease",
  });
  const sparkle = (dx: number): React.CSSProperties => ({
    position: "absolute",
    width: 1.5,
    height: blink ? 0 : 1.5,
    borderRadius: 999,
    background: "#FFFFFF",
    boxShadow: "0 0 3px #FFFFFF",
    top: 11.5 + pos.y,
    left: `calc(50% + ${dx + pos.x}px - 0.25px)`,
    transition: "height 0.12s ease, left 0.22s ease, top 0.22s ease",
  });

  return (
    <>
      {/* Left eye: white base + dark pupil + white sparkle */}
      <div style={eyeBase(-6)} />
      <div style={pupil(-6)} />
      <div style={sparkle(-5)} />
      {/* Right eye */}
      <div style={eyeBase(6)} />
      <div style={pupil(6)} />
      <div style={sparkle(7)} />
      {/* Warm cheek blushes */}
      <div style={{
        position: "absolute", top: 18, left: 2,
        width: 5, height: 3, borderRadius: 999,
        background: "rgba(255,140,160,0.35)", filter: "blur(1px)",
      }} />
      <div style={{
        position: "absolute", top: 18, right: 2,
        width: 5, height: 3, borderRadius: 999,
        background: "rgba(255,140,160,0.35)", filter: "blur(1px)",
      }} />
      {/* Curved smile (SVG arc) */}
      <svg
        width="14" height="6" viewBox="0 0 14 6"
        style={{ position: "absolute", top: 21, left: "calc(50% - 7px)" }}
      >
        <path
          d="M 1 1 Q 7 6 13 1"
          stroke="#C9A340"
          strokeWidth="1.4"
          strokeLinecap="round"
          fill="none"
          style={{ filter: "drop-shadow(0 0 2px rgba(201,163,64,0.7))" }}
        />
      </svg>
    </>
  );
}

function TotalTimer({ startTime }: { startTime: number }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const tick = () => setElapsed(Date.now() - startTime);
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [startTime]);
  const s = Math.floor(elapsed / 1000);
  const label = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
  return (
    <span className="text-[10px] text-[#C9A340]/70 tabular-nums font-medium">
      {label}
    </span>
  );
}

function ElapsedTime({ startedAt, running }: { startedAt: number; running: boolean }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!running) return;
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [startedAt, running]);

  useEffect(() => {
    if (!running) {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }
  }, [running, startedAt]);

  if (elapsed < 1) return null;
  return (
    <span className="text-[10px] text-muted-foreground/40 tabular-nums ml-auto flex-shrink-0">
      {elapsed}s
    </span>
  );
}

export function TaskProgress({ steps, emotion, startTime }: TaskProgressProps) {
  if (steps.length === 0) return null;
  const runningCount = steps.filter(s => s.status === "running").length;
  const doneCount = steps.filter(s => s.status === "done").length;
  const errorCount = steps.filter(s => s.status === "error").length;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex items-start gap-2 px-4 py-2"
    >
      {/* Living Luca avatar with darting eyes */}
      <div className="flex flex-col items-center pt-1 flex-shrink-0" style={{ width: 32 }}>
        <div
          className="relative w-8 h-8 rounded-full overflow-hidden"
          style={{
            background: "linear-gradient(135deg, #0a0f1e 0%, #1a2744 100%)",
            border: "2px solid rgba(201,163,64,0.4)",
            boxShadow: "0 0 12px rgba(201,163,64,0.3), inset 0 0 6px rgba(201,163,64,0.1)",
          }}
        >
          <LivingEyes />
        </div>
        {steps.length > 1 && (
          <div
            className="w-px flex-1 mt-1"
            style={{ background: "rgba(201,163,64,0.15)", minHeight: 8 }}
          />
        )}
      </div>

      {/* Steps list */}
      <div
        className="flex-1 rounded-2xl overflow-hidden"
        style={{
          background: "rgba(201,163,64,0.04)",
          border: "1px solid rgba(201,163,64,0.12)",
        }}
      >
        {/* Header: global progress + total timer */}
        <div
          className="flex items-center gap-2 px-3 py-1.5"
          style={{
            borderBottom: "1px solid rgba(255,255,255,0.04)",
            background: "rgba(201,163,64,0.04)",
          }}
        >
          <span className="text-[10px] uppercase tracking-wider text-[#C9A340]/80 font-semibold">
            {errorCount > 0 && `${errorCount} ошибка · `}
            {runningCount > 0 ? `Работаю · ${doneCount}/${steps.length}` : `Готово · ${steps.length}`}
          </span>
          <div className="flex-1" />
          {startTime && <TotalTimer startTime={startTime} />}
        </div>

        <AnimatePresence initial={false}>
          {steps.map((step, idx) => {
            const tool = getFriendlyTool(step.toolName);
            const isRunning = step.status === "running";
            const isDone = step.status === "done";
            const isError = step.status === "error";
            const isLast = idx === steps.length - 1;

            return (
              <motion.div
                key={step.id}
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                transition={{ duration: 0.25, ease: "easeOut" }}
                className="flex items-center gap-2.5 px-3 py-2"
                style={{
                  borderBottom: isLast ? "none" : "1px solid rgba(255,255,255,0.04)",
                }}
              >
                <span className="text-sm flex-shrink-0 select-none">{tool.icon}</span>

                <div className="flex-1 min-w-0">
                  <span
                    className="text-xs block truncate"
                    style={{
                      color: isRunning
                        ? "rgba(201,163,64,0.9)"
                        : isDone
                        ? "rgba(255,255,255,0.5)"
                        : "rgba(239,68,68,0.8)",
                    }}
                  >
                    {step.description || tool.label}
                    {isRunning && (
                      <motion.span
                        animate={{ opacity: [1, 0.3, 1] }}
                        transition={{ duration: 1.5, repeat: Infinity }}
                      >
                        ...
                      </motion.span>
                    )}
                  </span>
                  {step.preview && (isDone || isError) && (
                    <span
                      className="text-[10px] block truncate mt-0.5 font-mono"
                      style={{ color: isError ? "rgba(239,68,68,0.55)" : "rgba(255,255,255,0.32)" }}
                      title={step.preview}
                    >
                      {step.preview.replace(/\s+/g, " ").slice(0, 120)}
                    </span>
                  )}
                </div>

                <ElapsedTime startedAt={step.startedAt} running={isRunning} />

                <div className="flex-shrink-0 w-4 h-4 flex items-center justify-center">
                  {isRunning && (
                    <Loader2
                      className="w-3.5 h-3.5 animate-spin"
                      style={{ color: "#C9A340" }}
                    />
                  )}
                  {isDone && (
                    <motion.div
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      transition={{ type: "spring", stiffness: 400, damping: 15 }}
                    >
                      <Check className="w-3.5 h-3.5 text-green-400" />
                    </motion.div>
                  )}
                  {isError && (
                    <span className="text-xs text-red-400">!</span>
                  )}
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
