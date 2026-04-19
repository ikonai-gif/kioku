import React, { useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown, ChevronUp, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

// ── Section definition ─────────────────────────────────────────
interface BriefSection {
  icon: string;
  title: string;
  content: string;
}

// ── Time-of-day gradient ───────────────────────────────────────
function getTimeGradient(): string {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return "linear-gradient(135deg, rgba(30,58,138,0.15) 0%, rgba(201,163,64,0.12) 100%)";
  if (hour >= 12 && hour < 18) return "linear-gradient(135deg, rgba(201,163,64,0.15) 0%, rgba(234,179,8,0.08) 100%)";
  if (hour >= 18 && hour < 22) return "linear-gradient(135deg, rgba(126,34,206,0.12) 0%, rgba(15,23,42,0.15) 100%)";
  return "linear-gradient(135deg, rgba(10,15,30,0.2) 0%, rgba(15,23,42,0.18) 100%)";
}

// ── Section parsing ────────────────────────────────────────────
const SECTION_PATTERNS: { icon: string; title: string; pattern: RegExp }[] = [
  { icon: "📅", title: "Schedule", pattern: /(?:^|\n)#+?\s*(?:📅\s*)?(?:schedule|calendar|today'?s?\s*(?:schedule|events|agenda)|appointments?)/i },
  { icon: "📧", title: "Emails", pattern: /(?:^|\n)#+?\s*(?:📧\s*)?(?:emails?|inbox|messages?|mail)/i },
  { icon: "✅", title: "Tasks", pattern: /(?:^|\n)#+?\s*(?:✅\s*)?(?:tasks?|to-?dos?|action\s*items?)/i },
  { icon: "🔔", title: "Reminders", pattern: /(?:^|\n)#+?\s*(?:🔔\s*)?(?:reminders?|notifications?|alerts?)/i },
  { icon: "💡", title: "Suggestions", pattern: /(?:^|\n)#+?\s*(?:💡\s*)?(?:suggestions?|recommendations?|tips?|advice)/i },
];

function parseSections(content: string): { greeting: string; sections: BriefSection[] } {
  // Extract greeting (first line if it looks like a greeting)
  const lines = content.split("\n");
  let greeting = "";
  let body = content;

  const greetingPattern = /^(?:good\s+(?:morning|afternoon|evening)|hey|hello|hi)\b/i;
  if (lines.length > 0 && greetingPattern.test(lines[0].replace(/^[#*\s]+/, ""))) {
    greeting = lines[0].replace(/^[#*\s]+/, "").trim();
    body = lines.slice(1).join("\n").trim();
  }

  // Try to split into sections based on headers
  // Match lines that start with #, ##, ###, **, or emoji-prefixed headers
  const headerRegex = /(?:^|\n)(#{1,3}\s+.+|(?:\*\*[^*]+\*\*))/g;
  const matches: { index: number; header: string }[] = [];
  let match: RegExpExecArray | null;

  while ((match = headerRegex.exec(body)) !== null) {
    matches.push({ index: match.index, header: match[1].trim() });
  }

  if (matches.length === 0) {
    // No clear sections — check for section patterns in the body
    const detected: BriefSection[] = [];
    for (const sp of SECTION_PATTERNS) {
      const m = body.match(sp.pattern);
      if (m && m.index !== undefined) {
        detected.push({ icon: sp.icon, title: sp.title, content: "" });
      }
    }
    if (detected.length === 0) {
      // Return whole content as a single section
      return {
        greeting,
        sections: [{ icon: "📋", title: "Summary", content: body }],
      };
    }
  }

  // Parse sections from matched headers
  const sections: BriefSection[] = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index + matches[i].header.length + 1;
    const end = i + 1 < matches.length ? matches[i + 1].index : body.length;
    const sectionContent = body.slice(start, end).trim();
    const rawTitle = matches[i].header.replace(/^#+\s*/, "").replace(/^\*\*|\*\*$/g, "");

    // Match to known section type
    let icon = "📋";
    let title = rawTitle;
    for (const sp of SECTION_PATTERNS) {
      if (sp.pattern.test("\n" + matches[i].header)) {
        icon = sp.icon;
        title = sp.title;
        break;
      }
    }
    // Keep original title if it's more specific
    if (rawTitle.length > title.length + 5) title = rawTitle.replace(/^[📅📧✅🔔💡📋]\s*/, "");

    sections.push({ icon, title, content: sectionContent });
  }

  // If there's content before the first header, add it as an intro
  if (matches.length > 0 && matches[0].index > 0) {
    const intro = body.slice(0, matches[0].index).trim();
    if (intro) {
      sections.unshift({ icon: "📋", title: "Overview", content: intro });
    }
  }

  return { greeting, sections: sections.length > 0 ? sections : [{ icon: "📋", title: "Summary", content: body }] };
}

// ── Detect if a message is a daily-brief / proactive message ──
export function isDailyBriefMessage(message: any, idx: number, userName?: string): boolean {
  if (!message?.content) return false;
  // Must be from Luca (not the user)
  const agentName = message.agentName || "";
  if (agentName === userName || agentName === "You") return false;

  // One of the first 3 messages in conversation
  if (idx < 3 && agentName && agentName !== userName && agentName !== "You") {
    const content = message.content.toLowerCase();
    // Proactive messages typically have greeting + structured content
    if (/good\s+(morning|afternoon|evening)/i.test(content) || /here'?s\s+(your|a)/i.test(content)) {
      return true;
    }
  }

  // Content pattern match
  const briefPatterns = [
    /good\s+morning/i,
    /here'?s\s+your/i,
    /daily\s+brief/i,
    /today'?s?\s+schedule/i,
    /summary\s+for\s+today/i,
    /morning\s+summary/i,
    /your\s+(?:morning|daily)\s+(?:update|brief|summary)/i,
  ];

  return briefPatterns.some((p) => p.test(message.content));
}

// ── Section row component ──────────────────────────────────────
function BriefSectionRow({ section, defaultExpanded }: { section: BriefSection; defaultExpanded: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <div
      className="rounded-xl overflow-hidden transition-all"
      style={{
        background: "rgba(255,255,255,0.03)",
        border: "1px solid rgba(255,255,255,0.06)",
      }}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2.5 w-full px-3.5 py-2.5 text-left hover:bg-white/[0.03] transition-colors"
      >
        <span className="text-base flex-shrink-0">{section.icon}</span>
        <span
          className="text-sm font-semibold flex-1"
          style={{ color: "#C9A340" }}
        >
          {section.title}
        </span>
        {expanded ? (
          <ChevronUp className="w-3.5 h-3.5 text-white/30" />
        ) : (
          <ChevronDown className="w-3.5 h-3.5 text-white/30" />
        )}
      </button>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeInOut" }}
            className="overflow-hidden"
          >
            <div
              className="px-4 pb-3 text-sm leading-relaxed whitespace-pre-wrap"
              style={{ color: "rgba(255,255,255,0.75)", paddingLeft: "2.5rem" }}
            >
              {section.content}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Main DailyBriefCard component ──────────────────────────────
export function DailyBriefCard({
  message,
  userName,
  emotion,
  onRefresh,
}: {
  message: any;
  userName?: string;
  emotion: string;
  onRefresh?: () => void;
}) {
  const { greeting, sections } = useMemo(
    () => parseSections(message.content || ""),
    [message.content]
  );

  const timeGradient = useMemo(() => getTimeGradient(), []);

  const displayGreeting = greeting || `Good morning${userName ? `, ${userName}` : ""}! 👋`;

  return (
    <motion.div
      initial={{ opacity: 0, y: 16, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.35, ease: "easeOut" }}
      className={cn("flex w-full px-3 py-1 justify-start")}
    >
      {/* Luca avatar */}
      <div className="flex-shrink-0 mr-2 mt-1">
        <div
          className="relative flex items-center justify-center rounded-full"
          style={{
            width: 28,
            height: 28,
            background: "linear-gradient(135deg, #0a0f1e 0%, #1a2744 100%)",
            border: "2px solid rgba(201,163,64,0.25)",
            boxShadow: "0 0 12px rgba(201,163,64,0.15)",
          }}
        >
          <span
            className="font-bold select-none"
            style={{ color: "#C9A340", fontSize: 11, fontFamily: "Inter, sans-serif" }}
          >
            L
          </span>
        </div>
      </div>

      {/* Card */}
      <div
        className="max-w-[90%] md:max-w-[75%] rounded-2xl overflow-hidden"
        style={{
          background: timeGradient,
          border: "1px solid rgba(255,255,255,0.08)",
          borderTop: "2px solid rgba(201,163,64,0.6)",
          boxShadow: "0 4px 24px rgba(0,0,0,0.25), 0 0 16px rgba(201,163,64,0.06)",
        }}
      >
        {/* Greeting */}
        <div className="px-4 pt-4 pb-2">
          <h3
            className="text-base font-semibold"
            style={{ color: "rgba(255,255,255,0.95)" }}
          >
            {displayGreeting}
          </h3>
        </div>

        {/* Sections */}
        <div className="px-3 pb-2 space-y-1.5">
          {sections.map((section, i) => (
            <BriefSectionRow key={i} section={section} defaultExpanded={true} />
          ))}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-2.5 border-t border-white/5">
          <span className="text-[10px] text-white/30">
            {new Date(Number(message.createdAt) || message.createdAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
          {onRefresh && (
            <button
              onClick={onRefresh}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all hover:bg-white/5 active:scale-95"
              style={{ color: "#C9A340", border: "1px solid rgba(201,163,64,0.2)" }}
            >
              <RefreshCw className="w-3 h-3" />
              Refresh
            </button>
          )}
        </div>
      </div>
    </motion.div>
  );
}
