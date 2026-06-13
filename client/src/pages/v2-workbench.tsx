/**
 * [BRO2 / UI V2 — Kimi-style rewrite] Luca workbench at `/v2`.
 *
 * Kimi-first redesign (Moonshot AI K2 / kimi.com pattern, June 2026):
 *   IDLE   → centered logo + single input; no panels, no tabs
 *   ACTIVE → chat thread + slim sidecar (steps + canvas) slides in
 *
 * Inline patterns (no permanent UI):
 *   - plan      → posted in chat as an editable Luca message before execution
 *   - guard b2  → posted in chat as a Luca message with approve/decline
 *   - canvas    → small preview inside the sidecar (right), grows on click
 *
 * Reuses KIOKU design tokens (`bg-background`, `bg-card`, `bg-primary`, dark
 * class) so light/dark switching works without extra CSS.
 *
 * Behind VITE_UI_V2_CANVAS_ENABLED. Legacy /partner UI untouched.
 */

import { useState } from "react";
import { Link } from "wouter";
import {
  ArrowLeft,
  ArrowUp,
  Plus,
  Mic,
  MicOff,
  PanelLeft,
  Sun,
  Moon,
  Languages,
  Loader2,
  Check,
  Smile,
  ShieldHalf,
} from "lucide-react";
import { useTheme } from "../App";
import { useI18n } from "@/i18n";

interface ChatMsg {
  id: number;
  role: "user" | "luca";
  text: string;
  kind?: "text" | "progress" | "guard";
  guardChoices?: string[];
}

interface ActiveTask {
  title: string;
  messages: ChatMsg[];
  steps: { label: string; status: "done" | "running" | "pending" }[];
  canvas: { name: string; rating: string; selected?: boolean }[];
}

function buildMockTask(query: string, t: (k: string) => string): ActiveTask {
  const reply = t("v2.luca.openingMap");
  return {
    title: query.length > 40 ? query.slice(0, 40) + "…" : query,
    messages: [
      { id: 1, role: "user", text: query, kind: "text" },
      { id: 2, role: "luca", text: reply, kind: "text" },
      {
        id: 3,
        role: "luca",
        text: t("v2.luca.checkingHours"),
        kind: "progress",
      },
    ],
    steps: [
      { label: t("v2.step.map"), status: "done" },
      { label: t("v2.step.candidates"), status: "done" },
      { label: t("v2.step.hours"), status: "running" },
    ],
    canvas: [
      { name: "Catch LA", rating: "★ 4.6", selected: true },
      { name: "Gracias Madre", rating: "★ 4.5" },
      { name: "The Henry", rating: "★ 4.4" },
    ],
  };
}

export default function V2WorkbenchPage() {
  const { t, lang, setLang } = useI18n();
  const { dark, toggle: toggleTheme } = useTheme();
  const [task, setTask] = useState<ActiveTask | null>(null);
  const [input, setInput] = useState("");
  const [micOn, setMicOn] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  function handleSend() {
    const q = input.trim();
    if (!q) return;
    if (task) {
      setTask({
        ...task,
        messages: [
          ...task.messages,
          { id: Date.now(), role: "user", text: q, kind: "text" },
        ],
      });
    } else {
      setTask(buildMockTask(q, t));
    }
    setInput("");
  }

  return (
    <div className="flex h-screen w-screen bg-background text-foreground">
      <SidebarLeft
        open={sidebarOpen}
        onToggle={() => setSidebarOpen((v) => !v)}
        t={t}
      />
      <div className="flex flex-1 min-w-0 flex-col">
        <TopBar
          dark={dark}
          onToggleTheme={toggleTheme}
          lang={lang}
          onCycleLang={() => setLang(lang === "ru" ? "en" : "ru")}
          taskTitle={task?.title}
          onCloseTask={() => setTask(null)}
        />
        <div className="flex flex-1 min-h-0">
          {!task ? (
            <IdleView
              t={t}
              input={input}
              onInput={setInput}
              onSend={handleSend}
              micOn={micOn}
              onMicToggle={() => setMicOn((v) => !v)}
            />
          ) : (
            <ActiveView
              t={t}
              task={task}
              input={input}
              onInput={setInput}
              onSend={handleSend}
              micOn={micOn}
              onMicToggle={() => setMicOn((v) => !v)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function SidebarLeft({
  open,
  onToggle,
  t,
}: {
  open: boolean;
  onToggle: () => void;
  t: (k: string) => string;
}) {
  return (
    <div
      className={`${
        open ? "w-56" : "w-12"
      } shrink-0 border-r border-border bg-card transition-[width] duration-200 ease-out flex flex-col`}
    >
      <button
        onClick={onToggle}
        className="m-2 flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label="toggle sidebar"
        data-testid="v2-sidebar-toggle"
      >
        <PanelLeft className="h-4 w-4" />
      </button>
      {open && (
        <div className="flex-1 overflow-y-auto px-2 pb-3 pt-1">
          <div className="mb-2 px-2 text-[10px] uppercase tracking-wider text-muted-foreground">
            {t("v2.sidebar.history")}
          </div>
          <div className="space-y-0.5 text-xs">
            <div className="cursor-pointer rounded-md px-2 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
              {t("v2.sidebar.example1")}
            </div>
            <div className="cursor-pointer rounded-md px-2 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
              {t("v2.sidebar.example2")}
            </div>
            <div className="cursor-pointer rounded-md px-2 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
              {t("v2.sidebar.example3")}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TopBar({
  dark,
  onToggleTheme,
  lang,
  onCycleLang,
  taskTitle,
  onCloseTask,
}: {
  dark: boolean;
  onToggleTheme: () => void;
  lang: string;
  onCycleLang: () => void;
  taskTitle?: string;
  onCloseTask: () => void;
}) {
  return (
    <div className="flex items-center gap-2 border-b border-border px-3 py-2">
      <Link href="/">
        <button
          className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="back"
          data-testid="v2-back"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
      </Link>
      {taskTitle ? (
        <div className="flex flex-1 min-w-0 items-center gap-2">
          <span className="truncate text-xs text-muted-foreground">
            {taskTitle}
          </span>
          <button
            onClick={onCloseTask}
            className="ml-auto rounded-md px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
            data-testid="v2-close-task"
          >
            {/* keeps the label tiny on purpose; matches Kimi */}
            ✕
          </button>
        </div>
      ) : (
        <div className="flex-1" />
      )}
      <button
        onClick={onCycleLang}
        className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        data-testid="v2-lang-toggle"
        aria-label="toggle language"
      >
        <Languages className="h-3.5 w-3.5" />
        <span className="uppercase">{lang}</span>
      </button>
      <button
        onClick={onToggleTheme}
        className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label="toggle theme"
        data-testid="v2-theme-toggle"
      >
        {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      </button>
      <div className="ml-1 flex h-7 w-7 items-center justify-center rounded-full bg-primary/15 text-xs font-medium text-primary">
        К
      </div>
    </div>
  );
}

function IdleView({
  t,
  input,
  onInput,
  onSend,
  micOn,
  onMicToggle,
}: {
  t: (k: string) => string;
  input: string;
  onInput: (v: string) => void;
  onSend: () => void;
  micOn: boolean;
  onMicToggle: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6">
      <div className="mb-8 font-mono text-5xl font-medium tracking-wider text-foreground">
        LUCA
      </div>
      <InputCard
        t={t}
        input={input}
        onInput={onInput}
        onSend={onSend}
        micOn={micOn}
        onMicToggle={onMicToggle}
        wide
      />
      <div className="mt-5 flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary" />
        <span>{t("v2.idle.status")}</span>
      </div>
    </div>
  );
}

function ActiveView({
  t,
  task,
  input,
  onInput,
  onSend,
  micOn,
  onMicToggle,
}: {
  t: (k: string) => string;
  task: ActiveTask;
  input: string;
  onInput: (v: string) => void;
  onSend: () => void;
  micOn: boolean;
  onMicToggle: () => void;
}) {
  return (
    <>
      <div className="flex flex-1 min-w-0 flex-col">
        <div className="flex-1 overflow-y-auto px-6 py-6">
          <div className="mx-auto flex max-w-2xl flex-col gap-3">
            {task.messages.map((m) => (
              <ChatLine key={m.id} msg={m} t={t} />
            ))}
            <GuardLine t={t} />
          </div>
        </div>
        <div className="border-t border-border px-6 py-4">
          <div className="mx-auto max-w-2xl">
            <InputCard
              t={t}
              input={input}
              onInput={onInput}
              onSend={onSend}
              micOn={micOn}
              onMicToggle={onMicToggle}
            />
          </div>
        </div>
      </div>
      <Sidecar t={t} task={task} />
    </>
  );
}

function ChatLine({ msg, t }: { msg: ChatMsg; t: (k: string) => string }) {
  if (msg.role === "user") {
    return (
      <div className="self-end max-w-[80%] rounded-2xl bg-primary/15 px-3.5 py-2 text-sm text-foreground">
        {msg.text}
      </div>
    );
  }
  if (msg.kind === "progress") {
    return (
      <div className="self-start flex items-center gap-2 text-xs text-primary">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span>{msg.text}</span>
        <button className="ml-1 rounded border border-border bg-card px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground">
          {t("v2.luca.details")} ›
        </button>
      </div>
    );
  }
  return (
    <div className="self-start max-w-[88%] text-sm leading-relaxed text-foreground">
      {msg.text}
    </div>
  );
}

function GuardLine({ t }: { t: (k: string) => string }) {
  return (
    <div className="self-start max-w-[88%] mt-2 rounded-2xl border border-primary/30 bg-primary/5 p-3">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-primary">
        <ShieldHalf className="h-3.5 w-3.5" />
        <span>{t("v2.guard.title")}</span>
      </div>
      <div className="mb-2.5 text-sm leading-snug text-foreground">
        {t("v2.guard.subtitle")}
      </div>
      <div className="flex gap-2">
        <button className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90">
          {t("v2.guard.approve")}
        </button>
        <button className="rounded-md border border-border bg-card px-3 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
          {t("v2.guard.decline")}
        </button>
      </div>
    </div>
  );
}

function InputCard({
  t,
  input,
  onInput,
  onSend,
  micOn,
  onMicToggle,
  wide,
}: {
  t: (k: string) => string;
  input: string;
  onInput: (v: string) => void;
  onSend: () => void;
  micOn: boolean;
  onMicToggle: () => void;
  wide?: boolean;
}) {
  return (
    <div
      className={`${
        wide ? "w-full max-w-xl" : "w-full"
      } rounded-2xl border border-border bg-card p-3`}
    >
      <input
        type="text"
        value={input}
        onChange={(e) => onInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSend();
          }
        }}
        placeholder={t("v2.input.placeholder")}
        className="w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
        data-testid="v2-input"
      />
      <div className="mt-2 flex items-center gap-2">
        <button
          className="rounded-full p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="attach"
          data-testid="v2-attach"
        >
          <Plus className="h-4 w-4" />
        </button>
        <button
          onClick={onMicToggle}
          className={
            micOn
              ? "rounded-full bg-primary p-1.5 text-primary-foreground"
              : "rounded-full p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          }
          aria-label="toggle voice"
          data-testid="v2-mic"
        >
          {micOn ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
        </button>
        <div className="ml-auto">
          <button
            onClick={onSend}
            disabled={!input.trim()}
            className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-40"
            aria-label="send"
            data-testid="v2-send"
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

function Sidecar({
  t,
  task,
}: {
  t: (k: string) => string;
  task: ActiveTask;
}) {
  return (
    <div className="w-60 shrink-0 border-l border-border bg-card flex flex-col">
      <div className="border-b border-border px-3 py-2.5">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {t("v2.steps.title")}
        </div>
        <div className="mt-2 flex flex-col gap-1.5">
          {task.steps.map((s, i) => (
            <div key={i} className="flex items-center gap-2 text-xs">
              {s.status === "done" ? (
                <Check className="h-3.5 w-3.5 shrink-0 text-emerald-500 dark:text-emerald-400" />
              ) : s.status === "running" ? (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
              ) : (
                <Smile className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              )}
              <span
                className={
                  s.status === "running"
                    ? "text-primary"
                    : "text-foreground"
                }
              >
                {s.label}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2.5">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {t("v2.canvas.title")}
        </div>
        <div className="mt-2 flex flex-col gap-2">
          {task.canvas.map((c, i) => (
            <div
              key={i}
              className={
                c.selected
                  ? "rounded-md border border-primary/40 bg-primary/5 px-2.5 py-1.5"
                  : "rounded-md border border-border bg-background/50 px-2.5 py-1.5"
              }
            >
              <div className="flex items-baseline justify-between gap-1">
                <div className="text-xs font-medium">{c.name}</div>
                <div className="text-[10px] text-muted-foreground">
                  {c.rating}
                </div>
              </div>
              {c.selected && (
                <div className="mt-1 text-[10px] text-primary">
                  {t("v2.canvas.selectedPending")}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
