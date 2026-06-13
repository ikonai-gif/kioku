/**
 * [BRO2 / UI V2 PROTOTYPE] Luca workbench redesign at `/v2`.
 *
 * Browser-native layout grounded in:
 *  - ChatGPT Atlas dual-pane (browser left, agent panel right)
 *  - Perplexity Comet sidebar assistant + smart address bar
 *  - OpenAI Operator collapsible step panel
 *  - Claude Artifacts split-pane live preview
 *  - Microsoft Magentic-UI (arXiv 2507.22358) six interaction mechanisms:
 *    co-planning, co-tasking, multi-tasking, action guards, long-term memory.
 *
 * Behind VITE_UI_V2_CANVAS_ENABLED. Legacy /partner UI is untouched.
 *
 * Uses existing KIOKU design tokens (`bg-background`, `bg-card`, `bg-primary`,
 * `border-border`, etc.) so dark/light switching just works via the
 * `dark` class already managed by App.tsx ThemeContext.
 */

import { useState } from "react";
import { Link } from "wouter";
import {
  Search,
  Home,
  Hash,
  Bot,
  FileText,
  Plus,
  ListTree,
  Activity,
  ShieldHalf,
  MessageCircle,
  Mic,
  MicOff,
  Send,
  ListChecks,
  Loader2,
  Check,
  ArrowLeft,
  Sun,
  Moon,
  Languages,
} from "lucide-react";
import { useTheme } from "../App";
import { useI18n } from "@/i18n";

type StepStatus = "done" | "running" | "pending";
interface StepRow {
  label: string;
  status: StepStatus;
  time?: string;
}

const STEPS: StepRow[] = [
  { label: "8 кандидатов", status: "done", time: "12:03" },
  { label: "часы работы", status: "done", time: "12:05" },
  { label: "сводка", status: "running", time: "сейчас" },
];

const PLAN_ITEMS = [
  { idx: 1, text: "найти 8 кандидатов", emphasized: false },
  { idx: 2, text: "отфильтровать по часам", emphasized: false },
  { idx: 3, text: "собрать сводку", emphasized: false },
  { idx: 4, text: "забронировать выбранный", emphasized: true },
  { idx: 5, text: "отправить подтверждение", emphasized: false },
];

export default function V2WorkbenchPage() {
  const { t, lang, setLang } = useI18n();
  const { dark, toggle: toggleTheme } = useTheme();
  const [micOn, setMicOn] = useState(false);

  return (
    <div className="flex h-screen w-screen flex-col bg-background text-foreground">
      <TopBar
        cmdPlaceholder={t("v2.cmdPlaceholder")}
        dark={dark}
        onToggleTheme={toggleTheme}
        lang={lang}
        onCycleLang={() => setLang(lang === "ru" ? "en" : "ru")}
      />
      <TabsRow t={t} />
      <div className="flex flex-1 min-h-0">
        <CanvasPane t={t} />
        <RightRail
          t={t}
          micOn={micOn}
          onMicToggle={() => setMicOn((v) => !v)}
        />
      </div>
    </div>
  );
}

function TopBar({
  cmdPlaceholder,
  dark,
  onToggleTheme,
  lang,
  onCycleLang,
}: {
  cmdPlaceholder: string;
  dark: boolean;
  onToggleTheme: () => void;
  lang: string;
  onCycleLang: () => void;
}) {
  return (
    <div className="flex items-center gap-3 border-b border-border px-3 py-2">
      <Link href="/">
        <button
          className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="back"
          data-testid="v2-back"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
      </Link>
      <div className="flex flex-1 min-w-0 items-center gap-2 rounded-md bg-muted px-3 py-1.5">
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="truncate font-mono text-xs text-muted-foreground">
          {cmdPlaceholder}
        </span>
        <span className="ml-auto shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
          ⌘K
        </span>
      </div>
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
      <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/15 text-xs font-medium text-primary">
        К
      </div>
    </div>
  );
}

function TabsRow({ t }: { t: (k: string) => string }) {
  const tabs = [
    { icon: Home, label: t("v2.tab.home"), active: false },
    { icon: Hash, label: "voice-test", active: false },
    { icon: Bot, label: "@luca · " + t("v2.tab.workbench"), active: true },
    { icon: FileText, label: "SPEC-2", active: false },
  ];
  return (
    <div className="flex items-stretch gap-0.5 border-b border-border px-2">
      {tabs.map((tab, i) => {
        const Icon = tab.icon;
        return (
          <div
            key={i}
            className={
              tab.active
                ? "flex items-center gap-1.5 border-b-2 border-primary bg-primary/10 px-3 py-2 text-xs font-medium text-primary"
                : "flex items-center gap-1.5 px-3 py-2 text-xs text-muted-foreground"
            }
          >
            <Icon className="h-3.5 w-3.5" />
            <span>{tab.label}</span>
          </div>
        );
      })}
      <div className="flex items-center px-2 text-muted-foreground">
        <Plus className="h-3.5 w-3.5" />
      </div>
    </div>
  );
}

function CanvasPane({ t }: { t: (k: string) => string }) {
  return (
    <div className="flex flex-1 min-w-0 flex-col border-r border-border">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs text-muted-foreground">
        <ListTree className="h-3.5 w-3.5" />
        <span>canvas</span>
        <span className="text-foreground">›</span>
        <span className="font-medium text-foreground">
          {t("v2.canvas.draftLabel")}
        </span>
        <span className="ml-auto flex items-center gap-1.5 text-primary">
          <span className="h-1.5 w-1.5 rounded-full bg-primary" />
          live
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-3 overflow-y-auto bg-muted/50 p-4">
        <RestaurantCard
          name="Catch LA"
          rating="★ 4.6 · $$$"
          address="8265 Sunset Blvd · откр. до 2:00"
          pendingApproval
          t={t}
        />
        <RestaurantCard
          name="Gracias Madre"
          rating="★ 4.5 · $$"
          address="8905 Melrose Ave · откр. до 23:00"
          t={t}
        />
        <RestaurantCard
          name="The Henry"
          rating="★ 4.4 · $$$"
          address="117 N La Cienega · откр. до 00:00"
          loadingNote={t("v2.canvas.fetchingExtra")}
          t={t}
        />
        <div className="flex items-center justify-center gap-2 rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
          {t("v2.canvas.previewWillUpdate")}
        </div>
      </div>
    </div>
  );
}

function RestaurantCard({
  name,
  rating,
  address,
  pendingApproval,
  loadingNote,
  t,
}: {
  name: string;
  rating: string;
  address: string;
  pendingApproval?: boolean;
  loadingNote?: string;
  t: (k: string) => string;
}) {
  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <div className="text-sm font-medium">{name}</div>
        <div className="text-[11px] text-muted-foreground">{rating}</div>
      </div>
      <div className="text-xs text-muted-foreground">{address}</div>
      {pendingApproval && (
        <div className="mt-2">
          <span className="inline-block rounded-full bg-primary/15 px-2 py-0.5 text-[11px] text-primary">
            {t("v2.canvas.selectedPending")}
          </span>
        </div>
      )}
      {loadingNote && (
        <div className="mt-2 flex items-center gap-1.5 text-[11px] text-primary">
          <Loader2 className="h-3 w-3 animate-spin" />
          <span>{loadingNote}</span>
        </div>
      )}
    </div>
  );
}

function RightRail({
  t,
  micOn,
  onMicToggle,
}: {
  t: (k: string) => string;
  micOn: boolean;
  onMicToggle: () => void;
}) {
  return (
    <div className="flex w-80 shrink-0 flex-col bg-card">
      <RailSection
        icon={ListChecks}
        title={t("v2.plan.title")}
        rightSlot={
          <button className="text-[10px] text-muted-foreground hover:text-foreground">
            edit
          </button>
        }
      >
        <div className="space-y-0.5 text-xs leading-relaxed text-muted-foreground">
          {PLAN_ITEMS.map((item) => (
            <div key={item.idx}>
              {item.idx}.{" "}
              <span
                className={
                  item.emphasized ? "font-medium text-primary" : undefined
                }
              >
                {item.text}
              </span>
            </div>
          ))}
        </div>
      </RailSection>

      <RailSection icon={Activity} title={t("v2.steps.title")}>
        <div className="space-y-1.5">
          {STEPS.map((step, i) => (
            <StepLine key={i} step={step} />
          ))}
        </div>
      </RailSection>

      <ActionGuard t={t} />

      <ChatSection t={t} />

      <ChatInput micOn={micOn} onMicToggle={onMicToggle} t={t} />
    </div>
  );
}

function RailSection({
  icon: Icon,
  title,
  rightSlot,
  children,
}: {
  icon: typeof ListChecks;
  title: string;
  rightSlot?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-border px-3 py-2.5">
      <div className="mb-2 flex items-center gap-1.5">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
        <div className="text-[11px] tracking-wide text-muted-foreground">
          {title}
        </div>
        {rightSlot && <div className="ml-auto">{rightSlot}</div>}
      </div>
      {children}
    </div>
  );
}

function StepLine({ step }: { step: StepRow }) {
  const Icon =
    step.status === "done"
      ? Check
      : step.status === "running"
      ? Loader2
      : Check;
  const tone =
    step.status === "running"
      ? "text-primary"
      : step.status === "done"
      ? "text-emerald-500 dark:text-emerald-400"
      : "text-muted-foreground";
  const label =
    step.status === "running"
      ? "text-primary"
      : "text-foreground";
  return (
    <div className="flex items-center gap-2 text-xs">
      <Icon
        className={`h-3.5 w-3.5 shrink-0 ${tone} ${
          step.status === "running" ? "animate-spin" : ""
        }`}
      />
      <span className={`flex-1 ${label}`}>{step.label}</span>
      <span className="text-[10px] text-muted-foreground">{step.time}</span>
    </div>
  );
}

function ActionGuard({ t }: { t: (k: string) => string }) {
  return (
    <div className="border-b border-border bg-primary/10 px-3 py-2.5">
      <div className="mb-1.5 flex items-center gap-1.5">
        <ShieldHalf className="h-3.5 w-3.5 text-primary" />
        <div className="text-[11px] font-medium tracking-wide text-primary">
          {t("v2.guard.title")}
        </div>
      </div>
      <div className="mb-2 text-xs leading-snug text-primary">
        {t("v2.guard.subtitle")}
      </div>
      <div className="flex gap-1.5">
        <button
          className="flex-1 rounded-md bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground hover:bg-primary/90"
          data-testid="v2-guard-approve"
        >
          {t("v2.guard.approve")}
        </button>
        <button
          className="flex-1 rounded-md border border-border bg-card px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted"
          data-testid="v2-guard-decline"
        >
          {t("v2.guard.decline")}
        </button>
      </div>
    </div>
  );
}

function ChatSection({ t }: { t: (k: string) => string }) {
  return (
    <div className="flex flex-1 min-h-0 flex-col px-3 py-2.5">
      <div className="mb-2 flex items-center gap-1.5">
        <MessageCircle className="h-3.5 w-3.5 text-muted-foreground" />
        <div className="text-[11px] tracking-wide text-muted-foreground">
          {t("v2.chat.title")}
        </div>
        <span className="ml-auto h-1.5 w-1.5 rounded-full bg-emerald-500 dark:bg-emerald-400" />
      </div>
      <div className="flex flex-col gap-1.5 overflow-y-auto">
        <ChatBubble side="left" text="3 топ-варианта плюс резерв" />
        <ChatBubble side="left" text="жду решение по Catch LA 😏" />
      </div>
    </div>
  );
}

function ChatBubble({
  side,
  text,
}: {
  side: "left" | "right";
  text: string;
}) {
  return (
    <div
      className={
        side === "left"
          ? "max-w-[92%] self-start rounded-md bg-muted px-2.5 py-1.5 text-xs leading-relaxed"
          : "max-w-[92%] self-end rounded-md bg-primary px-2.5 py-1.5 text-xs leading-relaxed text-primary-foreground"
      }
    >
      {text}
    </div>
  );
}

function ChatInput({
  micOn,
  onMicToggle,
  t,
}: {
  micOn: boolean;
  onMicToggle: () => void;
  t: (k: string) => string;
}) {
  return (
    <div className="flex items-center gap-2 border-t border-border px-3 py-2">
      <div className="flex-1 truncate rounded-md bg-muted px-2.5 py-1.5 text-[11px] text-muted-foreground">
        {t("v2.chat.placeholder")}
      </div>
      <button
        onClick={onMicToggle}
        className={
          micOn
            ? "rounded-md bg-primary p-1.5 text-primary-foreground"
            : "rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        }
        aria-label="toggle voice"
        data-testid="v2-mic-toggle"
      >
        {micOn ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
      </button>
      <button
        className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label="send"
        data-testid="v2-send"
      >
        <Send className="h-4 w-4" />
      </button>
    </div>
  );
}
