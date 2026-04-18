import { storage, pool } from "./storage";
import { broadcastToRoom } from "./ws";
import logger from "./logger";

const CHECK_INTERVAL = 60_000; // every minute

// ── Inline Cron Parser ───────────────────────────────────────────────────────
// Supports: minute hour day-of-month month day-of-week
// Fields: *, N, N-M, */N, N,M,P

function parseCronField(field: string, min: number, max: number): number[] {
  const values: number[] = [];
  for (const part of field.split(",")) {
    if (part === "*") {
      for (let i = min; i <= max; i++) values.push(i);
    } else if (part.includes("/")) {
      const [range, stepStr] = part.split("/");
      const step = parseInt(stepStr, 10);
      let start = min;
      let end = max;
      if (range !== "*") {
        if (range.includes("-")) {
          [start, end] = range.split("-").map(Number);
        } else {
          start = parseInt(range, 10);
        }
      }
      for (let i = start; i <= end; i += step) values.push(i);
    } else if (part.includes("-")) {
      const [a, b] = part.split("-").map(Number);
      for (let i = a; i <= b; i++) values.push(i);
    } else {
      values.push(parseInt(part, 10));
    }
  }
  return Array.from(new Set(values)).sort((a, b) => a - b);
}

export function calculateNextRun(cronExpr: string, timezone: string = "UTC", fromTime?: number): number {
  const now = fromTime || Date.now();
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return now + 60_000; // fallback: 1 minute

  const minutes = parseCronField(parts[0], 0, 59);
  const hours = parseCronField(parts[1], 0, 23);
  const doms = parseCronField(parts[2], 1, 31);
  const months = parseCronField(parts[3], 1, 12);
  const dows = parseCronField(parts[4], 0, 6);

  // Compute timezone offset — use Intl where available, fallback to UTC
  let offsetMs = 0;
  if (timezone && timezone !== "UTC") {
    try {
      const utcStr = new Date(now).toLocaleString("en-US", { timeZone: "UTC" });
      const tzStr = new Date(now).toLocaleString("en-US", { timeZone: timezone });
      offsetMs = new Date(tzStr).getTime() - new Date(utcStr).getTime();
    } catch {
      // Invalid timezone — use UTC
    }
  }

  // Start searching from 1 minute after `now` in local time
  const localNow = new Date(now + offsetMs);
  const candidate = new Date(localNow);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  // Search up to 400 days
  const limit = 400 * 24 * 60;
  for (let i = 0; i < limit; i++) {
    const m = candidate.getMinutes();
    const h = candidate.getHours();
    const dom = candidate.getDate();
    const mon = candidate.getMonth() + 1;
    const dow = candidate.getDay();

    if (
      minutes.includes(m) &&
      hours.includes(h) &&
      doms.includes(dom) &&
      months.includes(mon) &&
      dows.includes(dow)
    ) {
      // Convert back to UTC
      return candidate.getTime() - offsetMs;
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  // Fallback: 24 hours from now
  return now + 86_400_000;
}

// ── Natural Language → Cron Expression ────────────────────────────────────────

export function naturalLanguageToCron(schedule: string): string | null {
  const s = schedule.toLowerCase().trim();

  // Already a cron expression (5 fields with digits, *, -, /, commas)
  if (/^[\d\*\/\-,]+(\s+[\d\*\/\-,]+){4}$/.test(s)) return s;

  // "every N minutes"
  const everyMins = s.match(/every\s+(\d+)\s*min/);
  if (everyMins) return `*/${everyMins[1]} * * * *`;

  // "every hour" / "hourly"
  if (/every\s+hour|^hourly$/i.test(s)) return "0 * * * *";

  // "every day at Xam/pm" / "daily at X"
  const dailyAt = s.match(/(?:every\s+day|daily)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (dailyAt) {
    let h = parseInt(dailyAt[1], 10);
    const m = dailyAt[2] ? parseInt(dailyAt[2], 10) : 0;
    if (dailyAt[3]?.toLowerCase() === "pm" && h < 12) h += 12;
    if (dailyAt[3]?.toLowerCase() === "am" && h === 12) h = 0;
    return `${m} ${h} * * *`;
  }

  // "every morning at X" / "every morning"
  const morningAt = s.match(/every\s+morning\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (morningAt) {
    let h = parseInt(morningAt[1], 10);
    const m = morningAt[2] ? parseInt(morningAt[2], 10) : 0;
    if (morningAt[3]?.toLowerCase() === "pm" && h < 12) h += 12;
    return `${m} ${h} * * *`;
  }
  if (/every\s+morning/.test(s)) return "0 9 * * *";

  // "every evening" / "every night"
  if (/every\s+(evening|night)/.test(s)) return "0 21 * * *";

  // Day-of-week patterns
  const dayMap: Record<string, string> = {
    sunday: "0", monday: "1", tuesday: "2", wednesday: "3",
    thursday: "4", friday: "5", saturday: "6",
    sun: "0", mon: "1", tue: "2", wed: "3", thu: "4", fri: "5", sat: "6",
  };

  // "every Monday at 9am"
  const weekdayAt = s.match(/every\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (weekdayAt) {
    const dow = dayMap[weekdayAt[1].toLowerCase()] || "1";
    let h = parseInt(weekdayAt[2], 10);
    const m = weekdayAt[3] ? parseInt(weekdayAt[3], 10) : 0;
    if (weekdayAt[4]?.toLowerCase() === "pm" && h < 12) h += 12;
    if (weekdayAt[4]?.toLowerCase() === "am" && h === 12) h = 0;
    return `${m} ${h} * * ${dow}`;
  }

  // "every Monday" (no time — default 9am)
  const weekdayOnly = s.match(/every\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)$/i);
  if (weekdayOnly) {
    const dow = dayMap[weekdayOnly[1].toLowerCase()] || "1";
    return `0 9 * * ${dow}`;
  }

  // "every weekday at 8am"
  const weekdayTimeMatch = s.match(/every\s+weekday\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (weekdayTimeMatch) {
    let h = parseInt(weekdayTimeMatch[1], 10);
    const m = weekdayTimeMatch[2] ? parseInt(weekdayTimeMatch[2], 10) : 0;
    if (weekdayTimeMatch[3]?.toLowerCase() === "pm" && h < 12) h += 12;
    if (weekdayTimeMatch[3]?.toLowerCase() === "am" && h === 12) h = 0;
    return `${m} ${h} * * 1-5`;
  }
  if (/every\s+weekday/.test(s)) return "0 9 * * 1-5";

  // "every weekend"
  if (/every\s+weekend/.test(s)) return "0 10 * * 0,6";

  return null;
}

// ── Natural Language Time Parsing (for set_reminder) ─────────────────────────

export function parseRelativeTime(when: string, timezone: string = "UTC"): number | null {
  const s = when.toLowerCase().trim();
  const now = Date.now();

  // ISO date string
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const parsed = new Date(s).getTime();
    if (!isNaN(parsed)) return parsed;
  }

  // "in X minutes/hours/days"
  const relMatch = s.match(/in\s+(\d+)\s*(minute|min|hour|hr|day|week|month)s?/i);
  if (relMatch) {
    const amount = parseInt(relMatch[1], 10);
    const unit = relMatch[2].toLowerCase();
    const multipliers: Record<string, number> = {
      minute: 60_000, min: 60_000,
      hour: 3_600_000, hr: 3_600_000,
      day: 86_400_000,
      week: 604_800_000,
      month: 2_592_000_000,
    };
    return now + amount * (multipliers[unit] || 60_000);
  }

  // "tomorrow at 9am"
  const tomorrowMatch = s.match(/tomorrow\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (tomorrowMatch) {
    let h = parseInt(tomorrowMatch[1], 10);
    const m = tomorrowMatch[2] ? parseInt(tomorrowMatch[2], 10) : 0;
    if (tomorrowMatch[3]?.toLowerCase() === "pm" && h < 12) h += 12;
    if (tomorrowMatch[3]?.toLowerCase() === "am" && h === 12) h = 0;
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(h, m, 0, 0);
    return d.getTime();
  }

  // "tomorrow" (no time — default 9am)
  if (/^tomorrow$/.test(s)) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return d.getTime();
  }

  // "today at 3pm"
  const todayMatch = s.match(/today\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (todayMatch) {
    let h = parseInt(todayMatch[1], 10);
    const m = todayMatch[2] ? parseInt(todayMatch[2], 10) : 0;
    if (todayMatch[3]?.toLowerCase() === "pm" && h < 12) h += 12;
    if (todayMatch[3]?.toLowerCase() === "am" && h === 12) h = 0;
    const d = new Date(now);
    d.setHours(h, m, 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }

  // "at 3pm" / "3:30pm"
  const atTime = s.match(/(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (atTime) {
    let h = parseInt(atTime[1], 10);
    const m = atTime[2] ? parseInt(atTime[2], 10) : 0;
    if (atTime[3]?.toLowerCase() === "pm" && h < 12) h += 12;
    if (atTime[3]?.toLowerCase() === "am" && h === 12) h = 0;
    const d = new Date(now);
    d.setHours(h, m, 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }

  // "in half an hour"
  if (/in\s+(half\s+an?\s+hour|30\s*min)/i.test(s)) return now + 1_800_000;

  // "in an hour"
  if (/in\s+an?\s+hour/i.test(s)) return now + 3_600_000;

  return null;
}

// ── Task Execution ───────────────────────────────────────────────────────────

async function executeTask(task: any): Promise<void> {
  const payload = task.actionPayload ? JSON.parse(task.actionPayload) : {};

  switch (task.actionType) {
    case "message": {
      const message = payload.message || task.description || task.title;
      if (!task.roomId) {
        logger.warn({ taskId: task.id }, "[scheduler] task has no roomId, skipping message");
        return;
      }
      // Post message to room as Luca
      const msg = await storage.addRoomMessage({
        roomId: task.roomId,
        agentId: task.agentId,
        agentName: "Luca",
        agentColor: "#D4AF37",
        content: `**Reminder: ${task.title}**\n\n${message}`,
        isDecision: false,
      });
      if (msg) broadcastToRoom(task.roomId, msg);
      logger.info({ taskId: task.id, roomId: task.roomId }, "[scheduler] message task executed");
      break;
    }

    case "code": {
      const code = payload.code || "";
      const language = payload.language || "python";
      if (!code) return;
      try {
        const { Sandbox } = await import("@e2b/code-interpreter");
        const sbx = await Sandbox.create({ timeoutMs: 60_000 });
        const lang = language === "javascript" ? "js" : "python";
        const exec = await sbx.runCode(code, { language: lang as any });
        const output = (exec.logs?.stdout?.join("\n") || "") + (exec.logs?.stderr?.join("\n") || "");
        await sbx.kill();
        if (task.roomId) {
          const msg = await storage.addRoomMessage({
            roomId: task.roomId,
            agentId: task.agentId,
            agentName: "Luca",
            agentColor: "#D4AF37",
            content: `**Scheduled Code Result: ${task.title}**\n\`\`\`\n${output.slice(0, 2000)}\n\`\`\``,
            isDecision: false,
          });
          if (msg) broadcastToRoom(task.roomId, msg);
        }
      } catch (err: any) {
        logger.error({ taskId: task.id, err: err?.message }, "[scheduler] code task failed");
      }
      break;
    }

    case "search": {
      const query = payload.query || task.title;
      try {
        const OAI = (await import("openai")).default;
        const oaiClient = new OAI();
        const searchResponse = await oaiClient.chat.completions.create({
          model: "gpt-4o-mini-search-preview",
          web_search_options: { search_context_size: "medium" },
          messages: [{ role: "user", content: query }],
        } as any);
        const content = searchResponse.choices[0]?.message?.content || "No results found.";
        const annotations = (searchResponse.choices[0]?.message as any)?.annotations;
        let citations = "";
        if (annotations && Array.isArray(annotations)) {
          const urls = annotations
            .filter((a: any) => a.type === "url_citation" && a.url)
            .map((a: any) => a.url)
            .slice(0, 5);
          if (urls.length > 0) citations = "\n\nSources: " + urls.join(" | ");
        }
        if (task.roomId) {
          const msg = await storage.addRoomMessage({
            roomId: task.roomId,
            agentId: task.agentId,
            agentName: "Luca",
            agentColor: "#D4AF37",
            content: `**Scheduled Search: ${task.title}**\n\n${content}${citations}`,
            isDecision: false,
          });
          if (msg) broadcastToRoom(task.roomId, msg);
        }
      } catch (err: any) {
        logger.error({ taskId: task.id, err: err?.message }, "[scheduler] search task failed");
      }
      break;
    }

    default:
      logger.warn({ taskId: task.id, actionType: task.actionType }, "[scheduler] unknown action_type");
  }
}

// ── Main Loop ────────────────────────────────────────────────────────────────

async function processDueTasks() {
  const dueTasks = await storage.getDueScheduledTasks();
  for (const task of dueTasks) {
    try {
      await executeTask(task);
      // Calculate next run for recurring tasks
      let nextRunAt: number | null = null;
      if (task.taskType === "recurring" && task.cronExpression) {
        nextRunAt = calculateNextRun(task.cronExpression, task.timezone || "UTC");
      }
      await storage.markTaskRun(task.id, nextRunAt);
    } catch (err: any) {
      logger.error({ taskId: task.id, err: err?.message }, "[scheduler] task execution failed");
    }
  }
}

export function startScheduler() {
  setInterval(async () => {
    try {
      await processDueTasks();
    } catch (err: any) {
      logger.error({ err: err?.message }, "[scheduler] error processing due tasks");
    }
  }, CHECK_INTERVAL);
  logger.info("[scheduler] started — checking every 60s");
}
