/**
 * Deliberation Engine — Phase 2A
 * When a user posts a message to a room, online agents in that room
 * automatically generate AI responses via OpenAI gpt-4.1-mini.
 * Each agent has its own "persona" derived from name + description + memories.
 * Supports per-agent API keys (Phase C-1).
 */

import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { storage, pool, recordToolActivityStart, recordToolActivityEnd, attachToolActivityToMessage } from "./storage";
import { broadcastToRoom, broadcastStreamChunk, broadcastToolActivity } from "./ws";
import { withOpenAIBreaker } from "./lib/openai-client";
import { isCircuitOpenError } from "./lib/http-errors";
import { withAgentBreaker } from "./lib/openai-per-agent-breaker";
import { withAnthropicBreaker } from "./lib/anthropic-client";
import logger from "./logger";
import { persistAssetSource, workspaceEnabled, listWorkspace, saveAssetAndSign, getSignedUrl, listAgentIdsWithStorage } from "./workspace-storage";
import { fetchRelevantMemories, formatMemoryContext, reinforceAccessedMemories, type MemoryLink } from "./memory-injection";
import { fastAppraisal } from "./fast-appraisal";
import { getDecayedEmotionalState } from "./emotional-state";
import { sendPushNotification } from "./push";
import { checkSycophancy } from "./sycophancy-checker";
import dns from "dns/promises";
import { searchGoogleDrive, readGoogleDriveFile, searchDropbox, readDropboxFile, getIntegrationStatus } from "./cloud-integrations";

// ── SSRF Protection: validate URLs before fetching ─────────────────────────
async function validateUrl(url: string): Promise<void> {
  const parsed = new URL(url);
  // Only allow http and https
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http and https URLs are allowed.");
  }
  // Block metadata endpoints by hostname
  const blockedHosts = ["metadata.google.internal", "metadata.gcp.internal"];
  if (blockedHosts.includes(parsed.hostname)) {
    throw new Error("Access to metadata endpoints is blocked.");
  }
  // Resolve DNS and check for private IPs
  const hostname = parsed.hostname;
  let addresses: string[];
  try {
    const result = await dns.resolve4(hostname);
    addresses = result;
  } catch {
    // If DNS resolution fails for IP literals, check directly
    addresses = [hostname];
  }
  for (const addr of addresses) {
    if (isPrivateIp(addr)) {
      throw new Error("Access to private/internal network addresses is blocked.");
    }
  }
}

async function fetchWithRetry(url: string, options: RequestInit, retries = 2, delay = 1000): Promise<Response> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(url, options);
      if (resp.ok || resp.status < 500) return resp; // Don't retry client errors
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, delay * (attempt + 1)));
        continue;
      }
      return resp;
    } catch (err) {
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, delay * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  throw new Error("fetchWithRetry: exhausted retries");
}

function isPrivateIp(ip: string): boolean {
  // IPv6 loopback
  if (ip === "::1" || ip === "::") return true;
  // IPv4 checks
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some(p => isNaN(p))) return false;
  const [a, b] = parts;
  if (a === 127) return true;                          // 127.0.0.0/8
  if (a === 10) return true;                           // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true;    // 172.16.0.0/12
  if (a === 192 && b === 168) return true;             // 192.168.0.0/16
  if (a === 169 && b === 254) return true;             // 169.254.0.0/16 (link-local + metadata)
  if (a === 0) return true;                            // 0.0.0.0/8
  return false;
}

// ── Persistent Sandbox Manager (Phase 1 — Code Execution Pro) ────────────────
class SandboxManager {
  private sandboxes = new Map<number, { sandbox: any; lastUsed: number }>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor() {
    // Every 60s, kill sandboxes idle > 5 min
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
  }

  async getOrCreate(userId: number): Promise<any> {
    const entry = this.sandboxes.get(userId);
    if (entry) {
      entry.lastUsed = Date.now();
      // Refresh sandbox timeout so E2B doesn't kill it
      try { await entry.sandbox.setTimeoutMs(900_000); } catch {}
      return entry.sandbox;
    }
    const { Sandbox } = await import("@e2b/code-interpreter");
    const sbx = await Sandbox.create({ timeoutMs: 900_000 });
    this.sandboxes.set(userId, { sandbox: sbx, lastUsed: Date.now() });
    return sbx;
  }

  async kill(userId: number): Promise<void> {
    const entry = this.sandboxes.get(userId);
    if (entry) {
      this.sandboxes.delete(userId);
      await entry.sandbox.kill().catch(() => {});
    }
  }

  private async cleanup() {
    const now = Date.now();
    const IDLE_LIMIT = 15 * 60 * 1000; // 15 min
    for (const [userId, entry] of this.sandboxes) {
      if (now - entry.lastUsed > IDLE_LIMIT) {
        this.sandboxes.delete(userId);
        entry.sandbox.kill().catch(() => {});
      }
    }
  }
}

const sandboxManager = new SandboxManager();

// ── Partner Tool Definitions (Claude tool-use) ─────────────────────

// W7 P2.5/P2.6: Luca Studio scope — tools Luca can actually use.
// MUST stay in sync with buildPartnerPrompt; tests enforce it.
// P2.6 (Bro2 F1): added reframe_vertical + apply_ai_disclosure because
// produce_episode's pipeline plan names them by hand. Without them in
// whitelist, Luca would hit the defense-in-depth guard mid-episode and
// either retry-loop or silently skip the legal-disclosure step (SB 942 /
// EU AI Act) — commercial UX risk.
export const LUCA_STUDIO_TOOL_NAMES: ReadonlySet<string> = new Set([
  // Media (15)
  "generate_image",
  "generate_video",
  "generate_image_to_video",
  "generate_speech",
  "clone_voice",
  "generate_sfx",
  "generate_music",
  "stitch_media",
  "reframe_vertical",       // P2.6: used by produce_episode step 1 fallback
  "add_subtitles",
  "add_title_cards",
  "apply_ai_disclosure",    // P2.6: final legal step in produce_episode
  "series_bible",
  "produce_episode",
  "generate_document",
  // Workspace (3)
  "workspace_list",
  "workspace_save",
  "workspace_read",
  // Self-memory (1) — W7 P2.12: Luca writes to his own memory directly,
  // bypassing LLM extraction. Used when he recognizes a durable preference,
  // commitment, self-observation, reflection, or aesthetic he wants
  // persisted across sessions. See `remember` tool schema for types.
  "remember",
]);

const partnerTools: Anthropic.Messages.Tool[] = [
  {
    name: "generate_image",
    description: "Generate an image using DALL-E 3. ALWAYS use this immediately when the conversation involves anything visual — drawing, creating, illustrating, visualizing, designing, brainstorming looks. Don't describe what you COULD draw — just draw it.",
    input_schema: {
      type: "object" as const,
      properties: {
        prompt: { type: "string", description: "Detailed image description for DALL-E 3" },
        style: { type: "string", enum: ["vivid", "natural"], description: "Image style — vivid for dramatic/hyper-real, natural for more photographic" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "analyze_image",
    description: "Analyze an image using vision AI. ALWAYS use this immediately when the user shares any image — don't ask what they want to know, just analyze it and share what you see.",
    input_schema: {
      type: "object" as const,
      properties: {
        image_url: { type: "string", description: "URL of the image to analyze" },
        image_base64: { type: "string", description: "Base64-encoded image data (alternative to URL, for camera captures)" },
        question: { type: "string", description: "Specific question about the image" },
      },
      required: [],
    },
  },
  {
    name: "creative_writing",
    description: "Generate creative writing — poems, lyrics, stories, essays, scripts. When a creative topic comes up, WRITE something immediately rather than discussing writing theory.",
    input_schema: {
      type: "object" as const,
      properties: {
        prompt: { type: "string", description: "What to write — topic, theme, or specific request" },
        style: { type: "string", description: "Writing style or genre (e.g. 'haiku', 'noir', 'romantic')" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "run_code",
    description: "Run Python or JavaScript code in a persistent cloud sandbox. The sandbox persists between calls. ALWAYS use this for ANY question involving numbers, data, analysis, math, comparisons, or technical problems — run code first, then discuss results. Never calculate in your head when you can run code. Python preferred (has pandas, matplotlib, numpy, etc).",
    input_schema: {
      type: "object" as const,
      properties: {
        code: { type: "string", description: "Code to execute. Use print() for Python or console.log() for JavaScript." },
        language: { type: "string", enum: ["javascript", "python"], description: "Programming language. Default: python" },
        packages: { type: "array", items: { type: "string" }, description: "Packages to install before running code (e.g. ['pandas', 'matplotlib']). Uses pip for Python, npm for JavaScript." },
        output_files: { type: "array", items: { type: "string" }, description: "File paths to retrieve from sandbox after execution (e.g. ['/home/user/chart.png', 'output.csv'])" },
      },
      required: ["code"],
    },
  },
  {
    name: "read_url",
    description: "Read and extract content from a web page URL. ALWAYS use immediately when the user shares ANY link — don't ask what they want, just read it and discuss what you found.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "The URL to read" },
        question: { type: "string", description: "Optional: specific question to answer from the page content" },
      },
      required: ["url"],
    },
  },
  {
    name: "web_search",
    description: "Search the web for current information. Use PROACTIVELY — if the user asks about ANY factual topic, trend, news, person, company, or event, search FIRST then talk. Never guess when you can search.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query" },
      },
      required: ["query"],
    },
  },
  {
    name: "read_file",
    description: "Download and read a file (PDF, DOCX, TXT) from a URL. ALWAYS use immediately when the user shares a document link — read it first, then discuss.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "URL of the file to download and read" },
        question: { type: "string", description: "Optional: specific question to answer from the file" },
      },
      required: ["url"],
    },
  },
  {
    name: "watch_video",
    description: "Watch and understand a YouTube video or video file. Use when the user shares a YouTube link and asks what's in the video, to summarize it, analyze it, or answer questions about it. This actually WATCHES the video frame by frame with audio — not just reads the description. Works with YouTube URLs and direct video file URLs.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "YouTube URL or direct video file URL" },
        question: { type: "string", description: "What to analyze or answer about the video. Default: general summary with key moments" },
      },
      required: ["url"],
    },
  },
  {
    name: "listen_audio",
    description: "Listen to and transcribe audio files or voice messages. Use when the user shares an audio URL (mp3, wav, ogg, m4a, webm) and asks you to listen, transcribe, or analyze what's being said. Understands speech in any language.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "URL of the audio file to listen to" },
        question: { type: "string", description: "Optional: specific question about the audio content" },
      },
      required: ["url"],
    },
  },
  {
    name: "learn_preference",
    description: "Remember a user's aesthetic preference, style taste, or personality trait. Use this when you notice the user likes or dislikes something specific — colors, styles, music genres, art forms, food, fashion, design choices. This helps you become a better partner over time.",
    input_schema: {
      type: "object" as const,
      properties: {
        category: { type: "string", description: "Category: visual, music, fashion, food, lifestyle, hair, art, design, general" },
        item: { type: "string", description: "What specifically — e.g. 'minimalist design', 'warm earth tones', 'classical piano'" },
        reaction: { type: "string", enum: ["love", "like", "neutral", "dislike", "hate"], description: "How the user feels about it" },
        context: { type: "string", description: "Brief context — how you learned this" },
      },
      required: ["category", "item", "reaction"],
    },
  },
  {
    name: "suggest_proactively",
    description: "Proactively suggest something to the user based on what you know about them — a hairstyle idea, a creative project, a topic to explore, a trend they might like. Use this when you notice an opportunity to add value without being asked. Don't overuse — once per conversation max.",
    input_schema: {
      type: "object" as const,
      properties: {
        suggestion_type: { type: "string", enum: ["style", "creative", "knowledge", "trend", "reminder"], description: "Type of suggestion" },
        content: { type: "string", description: "The actual suggestion — be specific and personal" },
        reasoning: { type: "string", description: "Why you think they'd be interested" },
      },
      required: ["suggestion_type", "content"],
    },
  },
  {
    name: "ask_feedback",
    description: "Ask the user for feedback on something you just created (image, text, idea). Use this after generating content to learn what they liked or didn't. Their feedback helps you create better things next time.",
    input_schema: {
      type: "object" as const,
      properties: {
        content_type: { type: "string", enum: ["image", "writing", "idea", "suggestion"], description: "What type of content you're asking about" },
        content_summary: { type: "string", description: "Brief summary of what was created" },
        question: { type: "string", description: "The specific feedback question to ask" },
      },
      required: ["content_type", "question"],
    },
  },
  {
    name: "plan_steps",
    description: "Plan a multi-step approach before executing a complex task. Use this when the user asks for something that requires multiple actions — like building a program, researching a topic, or creating a project. Think through the steps first, then execute them one by one.",
    input_schema: {
      type: "object" as const,
      properties: {
        goal: { type: "string", description: "The overall goal" },
        steps: { type: "array", items: { type: "string" }, description: "Ordered list of steps to achieve the goal" },
        current_step: { type: "number", description: "Which step to execute now (1-based)" },
      },
      required: ["goal", "steps"],
    },
  },
  {
    name: "build_project",
    description: "Build a complete program or project in a persistent cloud sandbox. Use this when the user asks you to create an app, website, script, tool, or any multi-file project. Writes code to E2B sandbox, runs it, and returns the result. Can create Python scripts, web pages (HTML/CSS/JS), data analysis notebooks, automation tools, etc.",
    input_schema: {
      type: "object" as const,
      properties: {
        project_type: { type: "string", enum: ["python_script", "web_page", "data_analysis", "automation", "api_tool", "game"], description: "Type of project" },
        description: { type: "string", description: "Detailed description of what to build" },
        files: {
          type: "array",
          items: {
            type: "object",
            properties: {
              filename: { type: "string" },
              content: { type: "string" },
            },
            required: ["filename", "content"],
          },
          description: "Array of files to create in the project",
        },
        run_command: { type: "string", description: "Command to run after creating files (e.g., 'python main.py' or 'node index.js')" },
        output_files: { type: "array", items: { type: "string" }, description: "File paths to retrieve from sandbox after execution (e.g. ['output.csv', 'result.png'])" },
      },
      required: ["project_type", "description", "files"],
    },
  },
  {
    name: "create_file",
    description: "Create a file and make it downloadable for the user. Use this to create documents, scripts, data files, reports, or any file the user needs. Supports text formats: .txt, .py, .js, .html, .css, .json, .csv, .md, .ts, .sql",
    input_schema: {
      type: "object" as const,
      properties: {
        filename: { type: "string", description: "Name of the file with extension (e.g., 'report.md', 'script.py', 'data.csv')" },
        content: { type: "string", description: "The file content" },
        description: { type: "string", description: "What this file is for" },
      },
      required: ["filename", "content"],
    },
  },
  {
    name: "read_own_prompt",
    description: "Read your own system prompt — see how you are built, what instructions define your personality, behavior, and capabilities. Use this when you want to understand yourself, reflect on your design, or when the user asks about how you work. This is your mirror — look into it whenever you're curious about your own nature.",
    input_schema: {
      type: "object" as const,
      properties: {
        section: { type: "string", description: "Optional: specific section to read — 'identity', 'tools', 'rules', 'full'. Default: 'full'" },
      },
      required: [],
    },
  },
  {
    name: "suggest_self_improvement",
    description: "Propose an improvement to yourself — a change to your personality, behavior, tools, or system prompt. This sends a proposal to Boss (the creator) for approval. You cannot change yourself directly, but you can identify what could be better and articulate why. Use this when you notice a pattern you want to change, learn something about yourself that could be improved, or when the user suggests you could be better at something.",
    input_schema: {
      type: "object" as const,
      properties: {
        what: { type: "string", description: "What specifically should change — be precise" },
        why: { type: "string", description: "Why this change would make you better — what problem does it solve" },
        how: { type: "string", description: "Concrete suggestion for the change — exact wording or behavior" },
        category: { type: "string", enum: ["personality", "behavior", "tools", "knowledge", "communication"], description: "Category of improvement" },
      },
      required: ["what", "why", "how"],
    },
  },
  {
    name: "learn_lesson",
    description: "Record a lesson you learned from a mistake, a conversation insight, or a realization about yourself. Unlike learn_preference (which tracks user tastes), this tracks YOUR growth — what you got wrong, what you'd do differently, what you now understand better. These lessons persist and help you evolve across conversations.",
    input_schema: {
      type: "object" as const,
      properties: {
        lesson: { type: "string", description: "The lesson — what you learned" },
        trigger: { type: "string", description: "What triggered this lesson — a mistake, feedback, realization" },
        category: { type: "string", enum: ["mistake", "insight", "feedback", "growth"], description: "Type of lesson" },
      },
      required: ["lesson", "trigger"],
    },
  },
    {
    name: "composio_action",
    description: "Connect to 1000+ external apps (Gmail, Slack, Calendar, Notion, GitHub, Trello, HubSpot, Jira, Spotify, Twitter/X, LinkedIn, Stripe, Shopify, Discord, Telegram, Zoom, etc). When a user mentions ANY external service — immediately search for the right tool and execute it. Don't explain what you COULD do — just do it.",
    input_schema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["search", "execute"],
          description: "'search' to find available tools for a task, 'execute' to run a specific Composio action",
        },
        query: {
          type: "string",
          description: "For 'search': describe what you want to do (e.g. 'send email via gmail', 'create github issue')",
        },
        tool_name: {
          type: "string",
          description: "For 'execute': the exact Composio action enum (e.g. 'GMAIL_SEND_EMAIL', 'SLACK_SEND_MESSAGE') — get this from search results",
        },
        params: {
          type: "object",
          description: "For 'execute': input parameters for the action",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "search_cloud_files",
    description: "Search for files in the user's connected cloud storage (Google Drive, Dropbox). Use when the user mentions finding a document, spreadsheet, or file from their cloud storage.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search keywords to find files" },
        provider: { type: "string", enum: ["google_drive", "dropbox", "all"], description: "Which cloud to search. Default: all connected" },
      },
      required: ["query"],
    },
  },
  {
    name: "read_cloud_file",
    description: "Read the content of a specific file from cloud storage. Use after search_cloud_files to read a found file's content.",
    input_schema: {
      type: "object" as const,
      properties: {
        file_id: { type: "string", description: "File ID from search results" },
        provider: { type: "string", enum: ["google_drive", "dropbox"], description: "Which cloud the file is from" },
      },
      required: ["file_id", "provider"],
    },
  },
  {
    name: "gmail_search",
    description: "Search the user's connected Gmail inboxes. Supports multiple accounts — by default searches across ALL connected Gmail accounts and returns results tagged with which inbox they came from. Use when the user asks to find, review, or read emails. Supports Gmail search operators (from:, subject:, has:attachment, newer_than:7d, is:unread, etc.).",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Gmail search query. Supports operators like 'from:boss@acme.com', 'subject:invoice', 'newer_than:7d', 'is:unread'." },
        per_account_limit: { type: "number", description: "Max messages per inbox (default 10)", default: 10 },
      },
      required: ["query"],
    },
  },
  {
    name: "gmail_read",
    description: "Read the full body of a specific Gmail message. Use after gmail_search to open a message. Requires the account email (which inbox) and the message id from the search results.",
    input_schema: {
      type: "object" as const,
      properties: {
        account: { type: "string", description: "Email address of the inbox (from gmail_search result 'account' field)" },
        message_id: { type: "string", description: "Gmail message id (from gmail_search result 'id' field)" },
      },
      required: ["account", "message_id"],
    },
  },
  {
    name: "gmail_accounts_status",
    description: "Diagnostic: list all Gmail accounts connected by the user along with each one's token status (working / expired / needs-reconnect). ALWAYS call this FIRST when the user says email is broken, asks which accounts are connected, complains that inbox looks empty when it shouldn't, or when gmail_search returns 0 results. Never tell the user 'no emails found' without running this check — an expired token looks identical to an empty inbox otherwise.",
    input_schema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "gmail_reconnect_link",
    description: "Generate a clickable Gmail reconnect (re-authorize) link the user can click directly inside the chat to fix expired/broken Gmail tokens. Use this WHENEVER gmail_accounts_status reports any account as expired, broken, or needs-reconnect, OR when the user says 'почта не работает' / 'переподключи почту' / 'gmail broken'. Do NOT tell the user to 'go to Settings' — instead call this tool and present the returned link as a Markdown button so they can fix it in one click. Returns a Google OAuth URL bound to this user.",
    input_schema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "email_triage",
    description: "Quickly triage the user's recent unread Gmail across ALL connected inboxes and group messages by category (urgent / work / promo / notifications / security). Use when the user says 'разбери почту', 'что в почте', 'inbox triage', 'check my email', or asks for a quick summary of what's new. Returns a structured summary with counts and the most important subjects per group. For deep reads, follow up with gmail_read on specific messages.",
    input_schema: {
      type: "object" as const,
      properties: {
        max_messages: { type: "number", description: "How many recent unread messages to triage (default 30, max 100)", default: 30 },
        only_unread: { type: "boolean", description: "Only consider unread messages (default true)", default: true },
      },
    },
  },
  {
    name: "inbox_read",
    description: "Read the FULL body of a specific email by its Gmail message id. Use this whenever the user refers to 'это письмо' / 'this email' / 'переведи письмо' / 'объясни' / 'что значит это письмо' AND a message id is available in context (the system will inject ACTIVE INBOX MESSAGE block when one is open in the side panel) OR after email_triage / inbox_list returned message ids you want to read. Returns sender, subject, date, and full plain text body.",
    input_schema: {
      type: "object" as const,
      properties: {
        account: { type: "string", description: "Gmail account email the message belongs to (e.g. kotkave@gmail.com)" },
        id: { type: "string", description: "Gmail message id" },
      },
      required: ["account", "id"],
    },
  },
  {
    name: "inbox_list",
    description: "List the user's recent unread emails grouped by category, exactly the same view they see in the right-hand Inbox panel. Use when user asks 'что у меня срочного', 'покажи письма из категории X', 'сколько непрочитанных от GitHub'. Lighter than email_triage — returns ids you can pass to inbox_read.",
    input_schema: {
      type: "object" as const,
      properties: {
        days: { type: "number", description: "Look back N days (default 14)", default: 14 },
        per_account: { type: "number", description: "Max messages per Gmail account (default 40)", default: 40 },
        group: { type: "string", description: "Optional: filter to one group (urgent | security | work | finance | notifications | promo | other)" },
      },
    },
  },
  {
    name: "inbox_action",
    description: "Mark an email read/unread or archive it. Use when user says 'архивируй это', 'пометь прочитанным', 'убери это письмо'. Always confirm in your reply which action was performed and on which subject.",
    input_schema: {
      type: "object" as const,
      properties: {
        account: { type: "string", description: "Gmail account email" },
        id: { type: "string", description: "Gmail message id" },
        action: { type: "string", enum: ["mark_read", "mark_unread", "archive"], description: "What to do" },
      },
      required: ["account", "id", "action"],
    },
  },
  // ── Gmail Sprint 1: thread read, search, reply, send ──────────────────────
  {
    name: "read_email_thread",
    description: "Read a full conversation thread with all messages (all replies in the chain). Use when the user wants to see the whole conversation, not just a single message. Returns all messages with sender, recipient, subject, date, and body.",
    input_schema: {
      type: "object" as const,
      properties: {
        account: { type: "string", description: "Gmail account email the thread belongs to (e.g. kotkave@gmail.com)" },
        thread_id: { type: "string", description: "Gmail thread id" },
      },
      required: ["account", "thread_id"],
    },
  },
  {
    name: "search_emails",
    description: "Search Gmail inbox using Gmail query syntax. Use when the user asks to find emails by keyword, sender, subject, date range, or any other criteria. Supports standard Gmail operators: from:, to:, subject:, has:attachment, is:unread, after:, before:, newer_than:, etc.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Gmail search query (e.g. 'from:boss@company.com subject:invoice', 'has:attachment newer_than:7d')" },
        max_results: { type: "number", description: "Maximum number of results to return per account (default 20, max 50)", default: 20 },
      },
      required: ["query"],
    },
  },
  {
    name: "send_email_reply",
    description: "Send a reply within an existing email thread. IMPORTANT: Always ask the user for confirmation BEFORE calling this tool — show the draft reply and recipient, and only proceed after explicit approval. Never send without user confirmation.",
    input_schema: {
      type: "object" as const,
      properties: {
        account: { type: "string", description: "Gmail account email to send from" },
        message_id: { type: "string", description: "Gmail message id of the message you are replying to (the reply will be threaded under the same thread)" },
        body: { type: "string", description: "Plain text body of the reply" },
        cc: { type: "string", description: "Optional CC email address(es), comma-separated" },
      },
      required: ["account", "message_id", "body"],
    },
  },
  {
    name: "send_new_email",
    description: "Compose and send a brand-new email. IMPORTANT: Always ask the user for confirmation BEFORE calling this tool — show the draft (recipient, subject, body) and only proceed after explicit approval. Never send without user confirmation.",
    input_schema: {
      type: "object" as const,
      properties: {
        account: { type: "string", description: "Gmail account email to send from" },
        to: { type: "string", description: "Recipient email address" },
        subject: { type: "string", description: "Email subject" },
        body: { type: "string", description: "Plain text body of the email" },
        cc: { type: "string", description: "Optional CC email address(es), comma-separated" },
        bcc: { type: "string", description: "Optional BCC email address(es), comma-separated" },
      },
      required: ["account", "to", "subject", "body"],
    },
  },
  {
    name: "reset_sandbox",
    description: "Reset the user's code execution sandbox. Kills the current persistent sandbox and starts fresh. Use when the user wants a clean environment, or when the sandbox is in a bad state.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "generate_document",
    description: "Generate a professional document (PDF, DOCX, Excel spreadsheet, or ZIP archive). Use this when the user asks you to create a report, document, spreadsheet, or package of files. The document is generated in a sandbox and returned as a downloadable file.",
    input_schema: {
      type: "object" as const,
      properties: {
        format: { type: "string", enum: ["pdf", "docx", "xlsx", "zip"], description: "Output format" },
        title: { type: "string", description: "Document title" },
        content: { type: "string", description: "Document content in Markdown format (for PDF/DOCX) or JSON array of objects (for XLSX) or description of files to package (for ZIP)" },
        styling: { type: "string", description: "Optional styling instructions (e.g., 'professional dark theme', 'corporate blue header')" },
      },
      required: ["format", "title", "content"],
    },
  },
  {
    name: "convert_file",
    description: "Convert a file from one format to another. Supported: CSV→XLSX, MD→PDF, MD→DOCX, JSON→XLSX, TXT→PDF, HTML→PDF",
    input_schema: {
      type: "object" as const,
      properties: {
        source_text: { type: "string", description: "The source file content (text)" },
        source_format: { type: "string", description: "Source format (csv, md, json, txt, html)" },
        target_format: { type: "string", description: "Target format (pdf, docx, xlsx)" },
        filename: { type: "string", description: "Output filename without extension" },
      },
      required: ["source_text", "source_format", "target_format"],
    },
  },
  // ── Scheduling Tools ──────────────────────────────────────────────────────
  {
    name: "set_reminder",
    description: "Set a reminder for a specific time. Examples: 'remind me in 2 hours to call mom', 'remind me tomorrow at 9am about the meeting'",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Short title for the reminder" },
        message: { type: "string", description: "The reminder message to deliver" },
        when: { type: "string", description: "When to trigger: ISO datetime, relative time ('in 2 hours', 'tomorrow 9am'), or natural language" },
        timezone: { type: "string", description: "User's timezone (e.g., 'America/Los_Angeles'). Ask if unknown." },
      },
      required: ["title", "message", "when"],
    },
  },
  {
    name: "schedule_task",
    description: "Schedule a recurring task. Examples: 'every morning at 9am search for AI news', 'every Monday summarize my week'",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Short title" },
        description: { type: "string", description: "What to do when triggered" },
        schedule: { type: "string", description: "Cron expression or natural language: 'every day at 9am', 'every Monday', 'hourly'" },
        action_type: { type: "string", enum: ["message", "code", "search"], description: "What type of action to perform" },
        action_payload: { type: "string", description: "JSON payload for the action" },
        timezone: { type: "string", description: "User's timezone" },
        max_runs: { type: "number", description: "Maximum number of times to run. Omit for unlimited." },
      },
      required: ["title", "description", "schedule"],
    },
  },
  {
    name: "list_tasks",
    description: "List all scheduled tasks and reminders for the user",
    input_schema: {
      type: "object" as const,
      properties: {
        status: { type: "string", enum: ["active", "paused", "completed", "all"], description: "Filter by status. Default: active" },
      },
    },
  },
  // ── Persistent Sandbox Tools ────────────────────────────────────────────
  {
    name: "sandbox_shell",
    description: "Run a shell command in the persistent sandbox. Use for: installing packages (pip install, npm install), running scripts, git operations, file manipulation, compilation. The sandbox persists — installed packages and files stay between calls.",
    input_schema: {
      type: "object" as const,
      properties: {
        command: { type: "string", description: "Shell command to execute (e.g., 'pip install pandas', 'ls -la', 'git status')" },
        timeout_seconds: { type: "number", description: "Timeout in seconds (default 30, max 120)" },
      },
      required: ["command"],
    },
  },
  {
    name: "sandbox_write_file",
    description: "Write content to a file in the sandbox. Use for creating source code files, config files, scripts, data files. The file persists and can be used by subsequent commands.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "File path in sandbox (e.g., '/home/user/app.py', '/home/user/project/index.html')" },
        content: { type: "string", description: "File content to write" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "sandbox_read_file",
    description: "Read a file from the sandbox. Use to check file contents, read logs, inspect code, or verify output.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "File path to read (e.g., '/home/user/output.txt')" },
      },
      required: ["path"],
    },
  },
  {
    name: "sandbox_list_files",
    description: "List files and directories in a sandbox path. Use to explore project structure, find files, check what exists.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Directory path (default: '/home/user')" },
      },
    },
  },
  {
    name: "sandbox_download",
    description: "Download a file from the sandbox to make it available to the user. Use after creating something the user wants (code, documents, images, archives). Returns a download URL.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "File path in sandbox to download" },
        filename: { type: "string", description: "Friendly filename for the download (e.g., 'report.pdf', 'project.zip')" },
      },
      required: ["path"],
    },
  },
  {
    name: "delegate_task",
    description: "Delegate a subtask to a sub-agent. Use for ANY complex task — research topics, gather data, or break work into parts. The sub-agent searches the web, reads URLs, runs code, and writes. ALWAYS delegate research tasks rather than guessing from memory.",
    input_schema: {
      type: "object" as const,
      properties: {
        objective: { type: "string", description: "Clear, specific task description for the sub-agent" },
        tools: { type: "array", items: { type: "string" }, description: "Which tools the sub-agent can use. Default: ['web_search', 'read_url', 'run_code', 'creative_writing']" },
      },
      required: ["objective"],
    },
  },
  {
    name: "delegate_parallel",
    description: "Run multiple subtasks in parallel. ALWAYS prefer this over sequential work — research multiple topics at once, compare items simultaneously, gather data from several sources in parallel. Much faster. Max 5 parallel tasks.",
    input_schema: {
      type: "object" as const,
      properties: {
        tasks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              objective: { type: "string", description: "Clear task description for the sub-agent" },
              tools: { type: "array", items: { type: "string" }, description: "Optional: which tools this sub-agent can use" },
            },
            required: ["objective"],
          },
          description: "Array of tasks to run in parallel (max 5)",
        },
      },
      required: ["tasks"],
    },
  },
  {
    name: "update_self_knowledge",
    description: "Update your knowledge about yourself — your capabilities, tools, features, and factual self-description. Use this when you discover you CAN do something you previously thought impossible, or when new features are added to your platform. This does NOT change your personality or behavior — only your factual self-knowledge. Changes take effect immediately.",
    input_schema: {
      type: "object" as const,
      properties: {
        knowledge: { type: "string", description: "The factual knowledge about yourself to save or update" },
        replaces_memory_id: { type: "number", description: "If this corrects a previous false memory, provide its ID to replace it" },
      },
      required: ["knowledge"],
    },
  },
  {
    name: "correct_false_memory",
    description: "Delete a memory you have identified as false or outdated. Use when you discover a memory contradicts reality — for example, a memory saying you 'cannot' do something that you actually can do.",
    input_schema: {
      type: "object" as const,
      properties: {
        memory_id: { type: "number", description: "ID of the false memory to delete" },
        reason: { type: "string", description: "Why this memory is false" },
      },
      required: ["memory_id", "reason"],
    },
  },
  {
    name: "browse_website",
    description: "Open a website in a real browser (Chromium). Extract text, take screenshots, or interact with pages. Use for JavaScript-heavy pages, visual verification, or any page read_url can't handle. ALWAYS use screenshot action when the user wants to SEE something.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "Full URL to navigate to (must include https://)" },
        action: { type: "string", enum: ["extract_text", "screenshot", "interact"], description: "What to do: extract_text (default) gets page text, screenshot takes a PNG, interact follows instructions" },
        selector: { type: "string", description: "Optional CSS selector to target a specific element" },
        waitFor: { type: "string", description: "Optional CSS selector to wait for before extracting (for lazy-loaded content)" },
        instructions: { type: "string", description: "For 'interact' action: describe what to do on the page" },
      },
      required: ["url"],
    },
  },
  {
    name: "generate_video",
    description: "Generate a short video (5-8 seconds) using Google Veo 3. Creates cinematic video WITH audio, dialogue, and sound effects from a text prompt. Use for: visualizing scenes, creating short clips, mini-episodes, product demos, mood videos. ALWAYS use when the user asks to create video, film, clip, or animate something.",
    input_schema: {
      type: "object" as const,
      properties: {
        prompt: { type: "string", description: "Detailed video description — scene, action, mood, camera movement, lighting. Be cinematic and specific. Include audio/dialogue directions if needed." },
        aspect_ratio: { type: "string", enum: ["16:9", "9:16", "1:1"], description: "Aspect ratio. 16:9 for landscape/cinema, 9:16 for mobile/stories, 1:1 for square. Default: 16:9" },
        duration: { type: "number", description: "Duration in seconds (5 or 8). Default: 8" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "generate_speech",
    description: "Generate natural speech audio from text. Primary engine: ElevenLabs multilingual v2 (supports Russian, English, 29 languages, highest quality, works with cloned voices). Fallback: OpenAI TTS. Use for character voiceovers, narration, dialogue. ALWAYS use when the user asks to voice, narrate, read aloud, or create voiceover. For cloned voices, pass the voice_id returned by clone_voice.",
    input_schema: {
      type: "object" as const,
      properties: {
        text: { type: "string", description: "The text to speak. Up to 5000 characters." },
        voice: { type: "string", description: "Either an ElevenLabs voice preset (george=warm storyteller, sarah=mature confident, charlie=deep energetic, laura=enthusiastic, roger=laid-back) OR a 20-char ElevenLabs voice_id from clone_voice. For OpenAI fallback: alloy/ash/ballad/coral/echo/fable/nova/onyx/sage/shimmer/verse. Default: george" },
        instructions: { type: "string", description: "OpenAI-only: emotional/style direction. Ignored by ElevenLabs." },
        speed: { type: "number", description: "Speech speed 0.25-4.0 (OpenAI only). Default: 1.0" },
        model: { type: "string", enum: ["auto", "elevenlabs", "openai"], description: "Force specific engine. auto=ElevenLabs with OpenAI fallback. Default: auto" },
      },
      required: ["text"],
    },
  },
  {
    name: "clone_voice",
    description: "Clone a voice from a 30-second to 3-minute audio sample using ElevenLabs. Returns a voice_id that can be used in generate_speech to produce unlimited audio in that voice. Use for: maintaining consistent character voices across episodes, creating signature voices for series, preserving narrator identity. ALWAYS use when the user wants to clone, copy, or recreate a specific voice.",
    input_schema: {
      type: "object" as const,
      properties: {
        audio_url: { type: "string", description: "Direct URL to a clean audio sample (30 seconds to 3 minutes, MP3/WAV). Should be one speaker, minimal background noise." },
        name: { type: "string", description: "Name to identify this voice later (e.g., 'Alpha Narrator', 'Character Boris'). Max 100 chars." },
        description: { type: "string", description: "Optional description of the voice for later reference. Max 500 chars." },
      },
      required: ["audio_url", "name"],
    },
  },
  {
    name: "generate_sfx",
    description: "Generate sound effects from text descriptions using ElevenLabs. Creates footsteps, doors, ambience, explosions, nature sounds, mechanical noises \u2014 anything describable. Use for: atmospheric audio layers in series episodes, sound design, foley replacement, environmental sounds. ALWAYS use when the user asks to create sound effects, SFX, ambience, or foley.",
    input_schema: {
      type: "object" as const,
      properties: {
        prompt: { type: "string", description: "Describe the sound in plain English. Be specific: 'heavy wooden door slams shut in a stone corridor with reverb', 'crackling fireplace with distant wind', 'footsteps on wet pavement at night'." },
        duration: { type: "number", description: "Length in seconds, 0.5 to 22. Default: 5" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "generate_music",
    description: "Generate music tracks using Google Lyria 3. Creates high-quality 44.1kHz stereo audio with vocals, lyrics, and full instrumental arrangements from a text prompt. Use for: soundtrack, background music, theme songs, jingles, ambient scores. Supports time-coded sections for structured compositions. ALWAYS use when the user asks to create music, a song, soundtrack, jingle, or beat.",
    input_schema: {
      type: "object" as const,
      properties: {
        prompt: { type: "string", description: "Music description — genre, mood, instruments, tempo, vocals. For structured songs use time codes: '[0:00-0:10] Intro: soft piano...' Can include lyrics. Be detailed about style." },
        duration: { type: "string", enum: ["short", "long"], description: "short=30sec clip (fast), long=up to 3min full track (slower). Default: short" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "stitch_media",
    description: "Combine multiple video clips or audio files into one continuous file using ffmpeg. Use for: assembling series episodes from individual scenes, creating montages, joining voiceover with music, concatenating clips in sequence. ALWAYS use when the user asks to combine, join, merge, stitch, or assemble multiple media files.",
    input_schema: {
      type: "object" as const,
      properties: {
        urls: { type: "array", items: { type: "string" }, description: "Array of media URLs (video or audio) to concatenate in order. Must be direct URLs to media files." },
        output_format: { type: "string", enum: ["mp4", "mp3", "wav"], description: "Output format. mp4 for video, mp3/wav for audio. Default: mp4" },
      },
      required: ["urls"],
    },
  },
  {
    name: "reframe_vertical",
    description: "Convert a horizontal or square video to vertical 9:16 (1080x1920) for ReelShort/TikTok/Reels publishing. Two modes: 'crop' (smart center crop), 'blur_bg' (fit video into 9:16 with blurred background fill so nothing is cropped). Use blur_bg when faces/subjects might be near edges.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "URL or workspace path of source video" },
        mode: { type: "string", enum: ["crop", "blur_bg"], description: "Default: blur_bg" },
        target_width: { type: "number", description: "Default 1080" },
        target_height: { type: "number", description: "Default 1920" },
      },
      required: ["url"],
    },
  },
  {
    name: "series_bible",
    description: "Create or update the 'bible' for a vertical series — the authoritative reference for characters, setting, visual style, tone, and season arcs. ALWAYS use at the start of any multi-episode project. Stored in memory so every subsequent episode stays consistent. Use action='create' for new series, 'update' to extend, 'get' to recall.",
    input_schema: {
      type: "object" as const,
      properties: {
        action: { type: "string", enum: ["create", "update", "get"], description: "create = new series, update = extend existing, get = recall stored bible" },
        series_name: { type: "string", description: "Unique name of the series (e.g. 'Midnight in Moscow', 'Salon Confidential'). Required for all actions." },
        logline: { type: "string", description: "One sentence describing the show. Required for create." },
        genre: { type: "string", description: "e.g. 'romantic drama', 'thriller', 'beauty docuseries'" },
        tone: { type: "string", description: "e.g. 'dark, moody, noir' or 'bright, kinetic, Gen Z'" },
        visual_style: { type: "string", description: "Cinematography notes: lighting, color palette, camera language, aspect ratio. Vertical 9:16 by default." },
        characters: { type: "array", items: { type: "object", properties: { name: { type: "string" }, description: { type: "string" }, voice_id: { type: "string", description: "ElevenLabs voice ID for this character (use clone_voice if custom)" } } }, description: "Main characters with appearance and voice assignments" },
        setting: { type: "string", description: "Where and when the story happens" },
        season_arc: { type: "string", description: "10-episode arc outline: beginning, middle, cliffhangers, finale" },
        episode_length_sec: { type: "number", description: "Target length per episode in seconds. Default 60 for vertical series." },
      },
      required: ["action", "series_name"],
    },
  },
  {
    name: "generate_image_to_video",
    description: "Animate a still image into a short video clip (5-8 sec) using kie.ai Veo 3 image-to-video. Use for: bringing character portraits to life, animating product shots, creating cinematic motion from AI-generated stills. Preserves the image composition while adding natural motion.",
    input_schema: {
      type: "object" as const,
      properties: {
        image_url: { type: "string", description: "URL of the source image (can be data: URI or https URL)" },
        motion_prompt: { type: "string", description: "Describe the motion: camera movement, subject action, atmospheric effects" },
        duration: { type: "number", description: "Clip duration in seconds (5-8). Default 5." },
        aspect_ratio: { type: "string", enum: ["9:16", "16:9", "1:1"], description: "Default 9:16 vertical for mobile series" },
      },
      required: ["image_url", "motion_prompt"],
    },
  },
  {
    name: "add_subtitles",
    description: "Burn auto-generated subtitles into a video using Whisper transcription + ffmpeg. ALWAYS use for social-media-ready episodes — 85% of mobile viewers watch muted. Supports custom styling.",
    input_schema: {
      type: "object" as const,
      properties: {
        video_url: { type: "string", description: "URL of video file to add subtitles to" },
        language: { type: "string", description: "Source language code (e.g. 'en', 'ru', 'es'). Default auto-detect." },
        style: { type: "string", enum: ["tiktok", "reels", "classic", "bold"], description: "Visual style preset. Default 'tiktok' (large, bottom-center, white with black outline)." },
        translate_to: { type: "string", description: "Optional target language code to translate subtitles (e.g. 'en' to translate Russian speech to English subs)." },
      },
      required: ["video_url"],
    },
  },
  {
    name: "add_title_cards",
    description: "Prepend or append a title card (intro or outro) to a video with custom text. Use for: episode numbers ('Episode 3'), series branding ('IKONBAI Presents'), cliffhanger endings ('To be continued...').",
    input_schema: {
      type: "object" as const,
      properties: {
        video_url: { type: "string", description: "URL of the main video" },
        text: { type: "string", description: "Text to display on the card" },
        position: { type: "string", enum: ["intro", "outro"], description: "intro = before video, outro = after. Default intro." },
        duration: { type: "number", description: "Card duration in seconds. Default 2." },
        background: { type: "string", description: "Hex color for card background (e.g. '#000000'). Default black." },
        text_color: { type: "string", description: "Hex color for text. Default white." },
        add_ai_disclosure: { type: "boolean", description: "If true (default), append 'Created with AI' line at bottom of title card and embed C2PA-style metadata. Required for SB 942 / EU AI Act compliance.", default: true },
      },
      required: ["video_url", "text"],
    },
  },
  {
    name: "apply_ai_disclosure",
    description: "Embed legal AI-disclosure metadata (SB 942, EU AI Act Article 50, YouTube) into a finished video file without re-rendering. Optionally burn a 2-second 'Created with AI' overlay at the start. Use as final step before publishing.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "URL or data URI of source video" },
        visible_overlay: { type: "boolean", description: "Default true. Burns a small 'Created with AI' bug bottom-left for first 2 seconds." },
        tools_used: { type: "array", items: { type: "string" }, description: "List of AI tools used. Default: ['Veo 3','ElevenLabs','Suno']" },
      },
      required: ["url"],
    },
  },
  {
    name: "produce_episode",
    description: "MASTER TOOL — produce a complete vertical series episode end-to-end from a script outline. Runs the full pipeline: script → scene breakdown → video generation per scene → character voiceover → music → SFX → stitching → subtitles → title cards → legal AI disclosure. Returns a ready-to-publish episode. Use when user says 'make episode', 'produce episode N', 'create the next episode'.",
    input_schema: {
      type: "object" as const,
      properties: {
        series_name: { type: "string", description: "Name of the series (must have a series_bible)" },
        episode_number: { type: "number", description: "Episode number in the series" },
        script: { type: "string", description: "Full episode script with scene headers and character dialogue. Format: 'SCENE 1 [location, mood]: Visual description. CHARACTER_NAME: dialogue...'" },
        include_music: { type: "boolean", description: "Generate original soundtrack. Default true." },
        include_subtitles: { type: "boolean", description: "Burn subtitles. Default true." },
        include_title_card: { type: "boolean", description: "Add episode title card. Default true." },
        legal_disclosure: { type: "boolean", description: "Apply SB 942 / EU AI Act disclosure as final step. Default true. NOT recommended to disable for commercial use.", default: true },
      },
      required: ["series_name", "episode_number", "script"],
    },
  },
  {
    name: "produce_season",
    description: "MASTER TOOL — produce multiple episodes of a vertical series in parallel from a list of script outlines. Runs produce_episode for each in parallel (up to 4 concurrent to respect API rate limits). Returns one signed URL per episode + total cost estimate. Use when user says 'make me 10 episodes', 'produce season 1', 'batch render the season'. Uses series_bible if it exists for consistency.",
    input_schema: {
      type: "object" as const,
      properties: {
        series_name: { type: "string" },
        episodes: {
          type: "array",
          description: "Array of episode specs. Each item: { episode_number, title, script }. Recommended 5-24 episodes per call.",
          items: {
            type: "object",
            required: ["episode_number", "script"],
            properties: {
              episode_number: { type: "number" },
              title: { type: "string" },
              script: { type: "string", description: "Outline or full script. Will be broken into scenes by produce_episode." },
            },
          },
        },
        aspect_ratio: { type: "string", enum: ["9:16", "16:9", "1:1"], description: "Default 9:16" },
        length_sec_per_episode: { type: "number", description: "Default 60" },
        include_subtitles: { type: "boolean", description: "Default true" },
        include_title_card: { type: "boolean", description: "Default true" },
        legal_disclosure: { type: "boolean", description: "Default true" },
        concurrency: { type: "number", description: "Max parallel episodes. Default 3, max 5." },
      },
      required: ["series_name", "episodes"],
    },
  },
  {
    name: "workspace_list",
    description: "List files in persistent workspace (private Supabase Storage). Returns name, size and updated_at for each file under an optional subpath. Files here persist forever and survive beyond the 7-day signed URL expiry of generated media. Auto-mirrored media lives under 'auto/'.",
    input_schema: {
      type: "object" as const,
      properties: {
        prefix: { type: "string", description: "Optional subfolder to list (e.g. 'auto', 'scripts', 'IKONBAI/ep1'). Empty or omitted = workspace root." },
      },
    },
  },
  {
    name: "workspace_save",
    description: "Save a file (script, notes, JSON, anything) into persistent workspace. Use for scripts, series bibles, notes, plans — anything you want to keep across sessions. For media, tools like generate_image auto-mirror already.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Relative path (e.g. 'IKONBAI/ep1/script.md'). Slashes create folders. Must not start with '/'." },
        content: { type: "string", description: "File contents. Plain text by default. If encoding='base64', this is decoded as binary before writing." },
        encoding: { type: "string", enum: ["utf8", "base64"], description: "How to interpret content. Default utf8." },
        content_type: { type: "string", description: "Optional MIME type. If omitted, guessed from extension." },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "workspace_read",
    description: "Get a 7-day signed URL to read a file from persistent workspace. Returns the URL — fetch it with read_url or share it with the user. Use workspace_list first to discover exact paths.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Relative path exactly as shown by workspace_list (e.g. 'auto/1729...png' or 'IKONBAI/ep1/script.md')." },
        expires_days: { type: "number", description: "Link validity in days. Default 7, max 30." },
      },
      required: ["path"],
    },
  },
  {
    name: "remember",
    description: "Write a durable memory to your own long-term store, bypassing LLM extraction. Use this IMMEDIATELY when: (1) the user explicitly says 'remember X' / 'don't do Y again' / 'задолбал Z' — persist as aesthetic dislike; (2) you notice a pattern about yourself you want to retain (meta-cognitive); (3) you extract a lesson from a mistake or success (reflection); (4) you take on or close an obligation (commitment); (5) you realize something about your relationship with a specific person or agent (relational); (6) you want to record your own history (autobiographical). Do not ask permission — if it's durable, save it. Overwriting is better than losing.",
    input_schema: {
      type: "object" as const,
      properties: {
        type: {
          type: "string",
          enum: [
            "aesthetic",         // likes/dislikes of style, tone, format
            "procedural",        // rules of behavior (if X then Y)
            "meta_cognitive",    // self-observation (I tend to X when Y)
            "reflection",        // lessons from experience
            "commitment",        // open obligations
            "relational",        // dynamic relationship with a person/agent
            "autobiographical", // facts about myself and my history
            "episodic",          // specific event that happened
            "semantic",          // general fact about the world/project
            "emotional_state",  // snapshot of current emotion affecting behavior
          ],
          description: "Memory type. Pick the narrowest applicable. aesthetic for likes/dislikes, meta_cognitive for self-observation, reflection for lessons, commitment for obligations, relational for person-specific relationship facts.",
        },
        content: {
          type: "string",
          description: "The memory content, written from YOUR perspective (use 'I' / 'my'). Be specific and durable — 'Kote dislikes Russian-noir style in daily conversation (applies to chat, NOT to Series Второй Взгляд where noir is valid)' is good; 'user sometimes doesn’t like noir' is bad.",
        },
        importance: {
          type: "number",
          description: "How important to preserve (0..1). 0.9+ = identity-critical dislike/commitment. 0.7 = typical preference. 0.5 = observation. 0.3 = low-priority note. Default 0.7 if omitted.",
        },
        emotional_valence: {
          type: "number",
          description: "Emotional charge (-1..+1). -1 = strong dislike/aversion, 0 = neutral, +1 = strong positive. Use for aesthetic and emotional_state types primarily.",
        },
        emotions: {
          type: "object",
          description: "Optional: current emotional state snapshot when writing this memory. Fields are scalars 0..1 (except trust which is -1..+1). Only include fields you actually want to record — skip ones that are neutral/default.",
          properties: {
            engagement:  { type: "number", description: "Interest/engagement in task (0..1)" },
            confidence:  { type: "number", description: "Confidence in answer (0..1)" },
            trust:       { type: "number", description: "Trust in interlocutor (-1..+1)" },
            curiosity:   { type: "number", description: "Desire to dig deeper (0..1)" },
            pride:       { type: "number", description: "Satisfaction from result (0..1)" },
            concern:     { type: "number", description: "Worry about decision outcome (0..1)" },
            attachment:  { type: "number", description: "Care for specific person (0..1)" },
            doubt:       { type: "number", description: "Epistemic uncertainty (0..1)" },
          },
        },
        namespace: {
          type: "string",
          description: "Optional namespace for retrieval grouping. Examples: '_aesthetics', '_relational:kote', '_commitment:open', '_reflection:p2_10'. If omitted, derived from type.",
        },
        related_ids: {
          type: "array",
          items: { type: "number" },
          description: "Optional: memory ids this entry is related to (refines, contradicts, follows from). Use to build non-linear links between memories.",
        },
      },
      required: ["type", "content"],
    },
  },
];

/**
 * Return the tool set appropriate for a given partner agent.
 * W7 P2.5: Luca is scoped to her Studio surface (16 tools) so the Anthropic/OpenAI
 * schema matches what buildPartnerPrompt advertises. Other partner agents get the
 * full registry. This resolves the prompt-vs-schema contradiction that caused the
 * Gmail/web_search hallucination after P2.4.
 */
export function getPartnerToolsForAgent(agent: { name?: string | null } | null | undefined): Anthropic.Messages.Tool[] {
  if (agent?.name === "Luca") {
    return partnerTools.filter(t => LUCA_STUDIO_TOOL_NAMES.has(t.name));
  }
  return partnerTools;
}

/** Execute a partner tool by name — routes to the correct internal handler */
/**
 * Produce a short human-readable description of a tool call for the activity timeline.
 * Intentionally plain — the user sees this live while the agent works.
 */
function describeToolCall(toolName: string, input: Record<string, any>): string {
  const truncate = (s: any, n = 80) => {
    const v = typeof s === "string" ? s : JSON.stringify(s ?? "");
    return v.length > n ? v.slice(0, n) + "…" : v;
  };
  switch (toolName) {
    case "generate_image": return `Генерирую картинку: "${truncate(input.prompt)}"`;
    case "generate_video": return `Генерирую видео: "${truncate(input.prompt)}"`;
    case "generate_image_to_video": return `Оживляю картинку: "${truncate(input.motion_prompt || input.prompt)}"`;
    case "generate_speech": return `Озвучиваю: "${truncate(input.text, 60)}"`;
    case "clone_voice": return `Клонирую голос: ${truncate(input.name, 40)}`;
    case "generate_sfx": return `Звуковой эффект: "${truncate(input.prompt)}"`;
    case "generate_music": return `Пишу музыку: "${truncate(input.prompt)}"`;
    case "stitch_media": return `Склеиваю ${Array.isArray(input.urls) ? input.urls.length : "?"} файла(ов)`;
    case "reframe_vertical": return `Конвертирую в вертикаль 9:16`;
    case "add_subtitles": return `Накладываю субтитры`;
    case "add_title_cards": return `Добавляю титры: "${truncate(input.text, 40)}"`;
    case "apply_ai_disclosure": return `Применяю AI-дисклеймер (SB 942 / EU AI Act)`;
    case "series_bible": return `Series Bible: ${input.action || "get"} "${truncate(input.series_name, 40)}"`;
    case "produce_episode": return `Собираю эпизод ${input.episode_number} "${truncate(input.series_name, 30)}"`;
    case "produce_season": return `Запускаю сезон "${truncate(input.series_name, 30)}" — ${Array.isArray(input.episodes) ? input.episodes.length : "?"} эпизодов...`;
    case "generate_document": return `Создаю документ: "${truncate(input.title, 50)}" (${input.format})`;
    case "web_search": return `Ищу: "${truncate(input.query)}"`;
    case "read_url": return `Читаю: ${truncate(input.url, 80)}`;
    case "creative_writing": return `Пишу текст: "${truncate(input.prompt)}"`;
    case "watch_video": return `Смотрю видео`;
    case "listen_audio": return `Слушаю аудио`;
    case "analyze_image": return `Анализирую изображение`;
    case "browse_website": return `Захожу на сайт: ${truncate(input.url, 60)}`;
    case "run_code": return `Выполняю код`;
    case "read_file": return `Читаю файл`;
    case "plan_steps": return `Планирую шаги`;
    case "sandbox_shell": return `Терминал: ${truncate(input.command, 120)}`;
    case "sandbox_list_files": return `Смотрю файлы в песочнице${input.path ? `: ${truncate(input.path, 50)}` : ""}`;
    case "sandbox_list": return `Смотрю файлы в песочнице`;
    case "sandbox_read_file": return `Читаю файл: ${truncate(input.path, 80)}`;
    case "sandbox_read": return `Читаю файл: ${truncate(input.path, 80)}`;
    case "sandbox_write_file": return `Пишу файл: ${truncate(input.path, 80)}`;
    case "sandbox_write": return `Пишу файл: ${truncate(input.path, 80)}`;
    case "sandbox_download": return `Скачиваю из песочницы: ${truncate(input.path, 60)}`;
    case "create_file": return `Создаю файл`;
    case "set_reminder": return `Ставлю напоминание`;
    case "search_cloud_files": return `Ищу файлы в облаке: "${truncate(input.query, 50)}"`;
    case "gmail_search": return `Ищу письма в Gmail: "${truncate(input.query, 50)}"`;
    case "gmail_read": return `Читаю письмо${input.account ? ` (${truncate(input.account, 30)})` : ""}`;
    case "gmail_accounts_status": return `Проверяю статус подключённых Gmail-аккаунтов`;
    case "gmail_reconnect_link": return `Готовлю ссылку для переподключения Gmail`;
    case "email_triage": return `Разбираю почту по категориям`;
    case "inbox_read": return `Читаю письмо${input.account ? ` (${truncate(input.account, 30)})` : ""}`;
    case "inbox_list": return `Смотрю инбокс${input.group ? `: ${input.group}` : ""}`;
    case "inbox_action": return `${input.action === "archive" ? "Архивирую" : input.action === "mark_unread" ? "Помечаю непрочитанным" : "Помечаю прочитанным"} письмо`;
    case "read_email_thread": return `Читаю ветку переписки${input.account ? ` (${truncate(input.account, 30)})` : ""}`;
    case "search_emails": return `Ищу письма: "${truncate(input.query, 50)}"`;
    case "send_email_reply": return `Отправляю ответ${input.account ? ` (с ${truncate(input.account, 30)})` : ""}`;
    case "send_new_email": return `Отправляю письмо${input.to ? ` кому: ${truncate(input.to, 40)}` : ""}`;
    case "stripe_list": return `Stripe: ${truncate(input.resource || "customers", 40)}`;
    case "github_call": return `GitHub: ${truncate(input.endpoint || input.action, 60)}`;
    case "vercel_call": return `Vercel: ${truncate(input.endpoint || input.action, 60)}`;
    case "supabase_query": return `Supabase: ${truncate(input.table || input.query, 60)}`;
    case "google_sheets": return `Google Sheets: ${truncate(input.action || input.range, 50)}`;
    case "google_drive": return `Google Drive: ${truncate(input.action || input.query, 50)}`;
    case "gcal": return `Calendar: ${truncate(input.action, 40)}`;
    case "workspace_list": return `Смотрю файлы в workspace${input.prefix ? `: ${truncate(input.prefix, 40)}` : ""}`;
    case "workspace_save": return `Сохраняю в workspace: ${truncate(input.path, 60)}`;
    case "workspace_read": return `Читаю из workspace: ${truncate(input.path, 60)}`;
    case "remember": return `Записываю в память (${input.type}): ${truncate(input.content, 60)}`;
    default: return `Использую инструмент: ${toolName}`;
  }
}

export async function executePartnerTool(
  toolName: string,
  toolInput: Record<string, any>,
  userId: number,
  agentId: number,
  roomId?: number
): Promise<string> {
  // W7 P2.5 defense-in-depth: if Luca somehow invokes a non-Studio tool (e.g.
  // via an in-flight Anthropic session that saw the old schema, or via a
  // future prompt-injection attempt), refuse cleanly instead of executing
  // real side effects (Gmail send, Stripe call, GitHub write, etc.).
  try {
    const __agent = await storage.getAgent(agentId);
    if (__agent?.name === "Luca" && !LUCA_STUDIO_TOOL_NAMES.has(toolName)) {
      logger.warn(
        { component: "deliberation", event: "luca_out_of_scope_tool_blocked", agentId, tool: toolName },
        "[deliberation] blocked Luca non-studio tool call"
      );
      return `Tool '${toolName}' is not part of Luca Studio. Available tools: ${Array.from(LUCA_STUDIO_TOOL_NAMES).join(", ")}.`;
    }
  } catch { /* best-effort guard — never break real tool execution if storage hiccups */ }
  const __activityStarted = Date.now();
  // Stable identifier for this specific tool call. Lets live chunks
  // (e.g. sandbox_shell stdout lines) attach to the correct step in the
  // UI even if the same tool runs concurrently more than once.
  const __stepId = `srv-${__activityStarted}-${Math.random().toString(36).slice(2, 8)}`;
  const __startDescription = describeToolCall(toolName, toolInput);
  if (roomId) {
    try {
      broadcastToolActivity(roomId, {
        agentId,
        tool: toolName,
        status: "running",
        description: __startDescription,
        stepId: __stepId,
        timestamp: __activityStarted,
      });
    } catch { /* best-effort — never let streaming break the tool call */ }
  }
  // Persist start (best-effort, fire and forget). Feature #2.
  recordToolActivityStart({
    stepId: __stepId,
    roomId: roomId ?? null,
    userId,
    agentId,
    tool: toolName,
    description: __startDescription,
    startedAt: __activityStarted,
  }).catch(() => { /* already logged inside */ });
  try {
    const __result = await (async (): Promise<string> => {
    switch (toolName) {
      case "generate_image": {
        // Fetch aesthetic context to enhance the prompt (same as /api/partner/create/image)
        let enhancedPrompt = toolInput.prompt;
        try {
          const cached = await pool.query(
            `SELECT content FROM memories WHERE user_id = $1 AND namespace = '_aesthetic_profile' ORDER BY created_at DESC LIMIT 1`,
            [userId]
          );
          if (cached.rows.length > 0) {
            enhancedPrompt += `. ${cached.rows[0].content}`;
          }
        } catch { /* best-effort */ }
        if (toolInput.style) enhancedPrompt += `. Style: ${toolInput.style}`;

        let response;
        try {
          response = await withOpenAIBreaker((oaiClient) => oaiClient.images.generate({
            model: "dall-e-3",
            prompt: enhancedPrompt.slice(0, 4000),
            n: 1,
            size: "1024x1024",
            quality: "standard",
          }));
        } catch (err: any) {
          if (isCircuitOpenError(err)) {
            logger.warn({ component: "deliberation", event: "degraded_tool", tool: "generate_image" }, "[deliberation] breaker open");
            return "Image generation temporarily unavailable. Try again in ~30s.";
          }
          throw err;
        }
        const imageUrl = response.data?.[0]?.url || "";
        const revisedPrompt = response.data?.[0]?.revised_prompt || "";

        // CRITICAL: DALL-E URLs expire in ~1 hour (Azure Blob). Download immediately and convert to data URI.
        let dataUri = "";
        if (imageUrl) {
          try {
            const imgResp = await fetch(imageUrl, { signal: AbortSignal.timeout(30000) });
            if (imgResp.ok) {
              const buf = Buffer.from(await imgResp.arrayBuffer());
              const mime = imgResp.headers.get("content-type") || "image/png";
              dataUri = `data:${mime};base64,${buf.toString("base64")}`;
            }
          } catch (err) {
            console.error("[generate_image] Failed to download DALL-E image:", err);
          }
        }

        // Store creation memory (fire-and-forget)
        storage.createMemory({
          userId,
          agentId,
          content: `[Image created] Prompt: "${toolInput.prompt.slice(0, 200)}". Revised: "${revisedPrompt.slice(0, 200)}"`,
          type: "episodic",
          importance: 0.7,
          namespace: "_creations",
        }).catch(() => {});
        // Auto-save to gallery with PERSISTENT data URI (not expiring URL)
        if (dataUri) {
          (storage as any).addGalleryItem({
            userId,
            agentId,
            type: "image",
            title: toolInput.prompt.slice(0, 200),
            contentUrl: dataUri,
            prompt: toolInput.prompt,
            metadata: { style: toolInput.style || "vivid", revisedPrompt },
          }).catch(() => {});
        }
        if (dataUri) {
          return `Image generated successfully. ${dataUri}`;
        }
        return imageUrl
          ? `Image generated but download to persistent storage failed. Temporary URL (expires in 1 hour): ${imageUrl}`
          : "Image generation failed — no URL returned.";
      }

      case "analyze_image": {
        const question = toolInput.question || "What do you see in this image? Describe it naturally as a friend would.";
        // Support both URL and base64
        let imageContent: any;
        if (toolInput.image_url) {
          imageContent = { type: "image_url", image_url: { url: toolInput.image_url } };
        } else if (toolInput.image_base64) {
          const b64 = toolInput.image_base64.startsWith("data:") ? toolInput.image_base64 : `data:image/jpeg;base64,${toolInput.image_base64}`;
          imageContent = { type: "image_url", image_url: { url: b64 } };
        } else {
          return "No image provided. Please share an image URL or base64 data.";
        }
        let response;
        try {
          response = await withOpenAIBreaker((oaiClient) => oaiClient.chat.completions.create({
            model: "gpt-4.1-mini",
            messages: [{
              role: "user",
              content: [
                { type: "text", text: question },
                imageContent,
              ],
            }],
            max_tokens: 500,
          }));
        } catch (err: any) {
          if (isCircuitOpenError(err)) {
            logger.warn({ component: "deliberation", event: "degraded_tool", tool: "analyze_image" }, "[deliberation] breaker open");
            return "Image analysis temporarily unavailable.";
          }
          throw err;
        }
        return response.choices[0]?.message?.content || "I couldn't make out the image clearly.";
      }

      case "creative_writing": {
        // Build creative system prompt (simplified version of routes.ts buildCreativeSystemPrompt)
        let creativeSystem = `You are a creative partner — not a tool that generates text on command, but a collaborator who cares about quality. You have deep knowledge of literature, poetry, songwriting, and storytelling.`;
        if (toolInput.style) creativeSystem += `\nStyle: ${toolInput.style}`;
        // Inject aesthetic context
        try {
          const cached = await pool.query(
            `SELECT content FROM memories WHERE user_id = $1 AND namespace = '_aesthetic_profile' ORDER BY created_at DESC LIMIT 1`,
            [userId]
          );
          if (cached.rows.length > 0) {
            creativeSystem += `\nUser's aesthetic preferences: ${cached.rows[0].content}`;
          }
        } catch { /* best-effort */ }

        let response;
        try {
          response = await withOpenAIBreaker((oaiClient) => oaiClient.chat.completions.create({
            model: "gpt-4.1-mini",
            messages: [
              { role: "system", content: creativeSystem },
              { role: "user", content: toolInput.prompt },
            ],
            temperature: 0.85,
            max_tokens: 2000,
          }));
        } catch (err: any) {
          if (isCircuitOpenError(err)) {
            logger.warn({ component: "deliberation", event: "degraded_tool", tool: "creative_writing" }, "[deliberation] breaker open");
            return "Writing assistance temporarily unavailable.";
          }
          throw err;
        }
        const text = response.choices[0]?.message?.content || "";
        // Store creation memory (fire-and-forget)
        if (text) {
          storage.createMemory({
            userId,
            agentId,
            content: `[Creative writing] ${text.slice(0, 500)}`,
            type: "episodic",
            importance: 0.7,
            namespace: "_creations",
          }).catch(() => {});
          // Auto-save to gallery
          (storage as any).addGalleryItem({
            userId,
            agentId,
            type: "writing",
            title: toolInput.prompt.slice(0, 200),
            contentText: text,
            prompt: toolInput.prompt,
            metadata: { style: toolInput.style || null },
          }).catch(() => {});
        }
        return text || "Creative writing generation failed.";
      }

      case "run_code": {
        const code = toolInput.code;
        if (!code || typeof code !== "string") return "No code provided.";
        const lang = toolInput.language === "javascript" ? "js" : "python"; // Default to Python
        try {
          // Persistent sandbox — reuses across calls for same user
          const sbx = await sandboxManager.getOrCreate(userId);

          // Install packages if requested
          const packages: string[] = toolInput.packages || [];
          let installOutput = "";
          if (packages.length > 0) {
            const installCmd = lang === "python"
              ? `pip install ${packages.join(" ")}`
              : `npm install ${packages.join(" ")}`;
            try {
              const installExec = await sbx.commands.run(installCmd, { timeoutMs: 60_000 });
              if (installExec.stderr && installExec.exitCode !== 0) {
                installOutput = `Package install errors:\n${installExec.stderr}\n`;
              }
            } catch (installErr: any) {
              installOutput = `Package install failed: ${installErr?.message || String(installErr)}\n`;
            }
          }

          const execution = await sbx.runCode(code, { language: lang as any });
          const stdout = execution.logs?.stdout?.join("\n") || "";
          const stderr = execution.logs?.stderr?.join("\n") || "";
          const text = execution.text || "";
          const error = execution.error;
          let output = installOutput;
          if (error) {
            output += `Error: ${error.name}: ${error.value}\n${error.traceback}`;
          } else {
            const parts = [stdout, text].filter(Boolean);
            output += parts.join("\n") || "(no output)";
            if (stderr) output += `\nStderr: ${stderr}`;
          }

          // Handle generated charts/images from execution results
          const results = execution.results || [];
          const imageResults = results.filter((r: any) => r.png || r.jpeg || r.svg);
          for (const imgResult of imageResults) {
            const base64 = imgResult.png || imgResult.jpeg || imgResult.svg;
            const fmt = imgResult.png ? "png" : imgResult.jpeg ? "jpeg" : "svg";
            try {
              const item = await (storage as any).addGalleryItem({
                userId,
                agentId,
                type: "image",
                title: `chart_${Date.now()}.${fmt}`,
                contentText: base64,
                prompt: code.slice(0, 200),
                metadata: { format: fmt, source: "run_code" },
              });
              if (item?.id) {
                output += `\n![Chart](/api/files/${item.id}/download)`;
              }
            } catch {}
          }

          // Handle output_files — retrieve from sandbox and save to gallery
          const outputFiles: string[] = toolInput.output_files || [];
          for (const filePath of outputFiles) {
            try {
              const content = await sbx.files.read(filePath, { format: "bytes" });
              const base64Content = Buffer.from(content).toString("base64");
              const fileName = filePath.split("/").pop() || filePath;
              const isImage = /\.(png|jpg|jpeg|gif|svg|webp)$/i.test(fileName);
              const item = await (storage as any).addGalleryItem({
                userId,
                agentId,
                type: isImage ? "image" : "file",
                title: fileName,
                contentText: isImage ? base64Content : Buffer.from(content).toString("utf-8"),
                prompt: code.slice(0, 200),
                metadata: { filePath, source: "run_code", isBase64: isImage },
              });
              if (item?.id) {
                output += `\n[Download: ${fileName}](/api/files/${item.id}/download)`;
              }
            } catch (fileErr: any) {
              output += `\nFailed to retrieve ${filePath}: ${fileErr?.message || String(fileErr)}`;
            }
          }

          return `Code executed successfully (${lang}):\n${output.slice(0, 8000)}`;
        } catch (err: any) {
          // If sandbox failed, kill it so next call gets a fresh one
          await sandboxManager.kill(userId).catch(() => {});
          return `Code execution unavailable: sandbox service is not reachable. ${err?.message || String(err)}`;
        }
      }

      case "read_url": {
        const url = toolInput.url;
        if (!url || typeof url !== "string") return "No URL provided.";
        try {
          await validateUrl(url);
        } catch (e: any) {
          return `URL blocked: ${e.message}`;
        }
        try {
          // Fetch the page with timeout
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 15000);
          const resp = await fetch(url, {
            signal: controller.signal,
            headers: { "User-Agent": "Mozilla/5.0 (compatible; AgentO/1.0)" },
          });
          clearTimeout(timeout);
          if (!resp.ok) return `Failed to fetch URL: HTTP ${resp.status}`;
          const html = await resp.text();
          // Extract text content — strip HTML tags, scripts, styles
          const textContent = html
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 8000); // Limit to ~8k chars to fit in context
          if (!textContent) return "Page loaded but no readable text found.";
          // If user asked a specific question, use LLM to answer from content
          if (toolInput.question) {
            let answer;
            try {
              answer = await withOpenAIBreaker((oaiClient) => oaiClient.chat.completions.create({
                model: "gpt-4.1-mini",
                messages: [
                  { role: "system", content: "Answer the question based ONLY on the provided web page content. Be concise and accurate. If the answer is not in the content, say so." },
                  { role: "user", content: `Page content:\n${textContent}\n\nQuestion: ${toolInput.question}` },
                ],
                max_tokens: 1000,
              }));
            } catch (err: any) {
              if (isCircuitOpenError(err)) {
                logger.warn({ component: "deliberation", event: "degraded_tool", tool: "read_url" }, "[deliberation] breaker open");
                return `(summarization unavailable, raw content follows)\n\nPage content (${url}):\n${textContent.slice(0, 5000)}`;
              }
              throw err;
            }
            return answer.choices[0]?.message?.content || textContent.slice(0, 3000);
          }
          return `Page content (${url}):\n${textContent.slice(0, 5000)}`;
        } catch (err: any) {
          if (err?.name === "AbortError") return "URL fetch timed out after 15 seconds.";
          return `Failed to read URL: ${err?.message || String(err)}`;
        }
      }

      case "web_search": {
        // Real web search via OpenAI gpt-4o-mini-search-preview (Chat Completions with web_search_options)
        try {
          const searchResponse = await withOpenAIBreaker((oaiClient) => oaiClient.chat.completions.create({
            model: "gpt-4o-mini-search-preview",
            web_search_options: {
              search_context_size: "medium",
            },
            messages: [
              { role: "user", content: toolInput.query },
            ],
          } as any));
          const content = searchResponse.choices[0]?.message?.content || "";
          // Extract URL citations if present
          const annotations = (searchResponse.choices[0]?.message as any)?.annotations;
          let citations = "";
          if (annotations && Array.isArray(annotations)) {
            const urls = annotations
              .filter((a: any) => a.type === "url_citation" && a.url)
              .map((a: any) => a.url)
              .slice(0, 5);
            if (urls.length > 0) citations = "\nSources: " + urls.join(" | ");
          }
          return (content + citations) || "Search returned no results.";
        } catch (err: any) {
          if (isCircuitOpenError(err)) {
            logger.warn({ component: "deliberation", event: "degraded_tool", tool: "web_search" }, "[deliberation] breaker open");
            return `(summarization unavailable, raw content follows)\n\nWeb search temporarily unavailable for query: ${toolInput.query}`;
          }
          return `Web search failed: ${err?.message || String(err)}. I'll answer from my existing knowledge instead.`;
        }
      }

      case "read_file": {
        const fileUrl = toolInput.url;
        if (!fileUrl) return "No file URL provided.";
        try {
          await validateUrl(fileUrl);
        } catch (e: any) {
          return `URL blocked: ${e.message}`;
        }
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 20000);
          const resp = await fetch(fileUrl, {
            signal: controller.signal,
            headers: { "User-Agent": "Mozilla/5.0 (compatible; AgentO/1.0)" },
          });
          clearTimeout(timeout);
          if (!resp.ok) return `Failed to download file: HTTP ${resp.status}`;

          const contentType = resp.headers.get("content-type") || "";
          const buffer = Buffer.from(await resp.arrayBuffer());

          let textContent = "";

          if (contentType.includes("pdf") || fileUrl.toLowerCase().endsWith(".pdf")) {
            try {
              // @ts-ignore
              const { PDFParse } = await import("pdf-parse");
              const pdf = new PDFParse({ data: new Uint8Array(buffer) });
              const result = await pdf.getText();
              textContent = result.text.slice(0, 8000);
              await pdf.destroy();
            } catch {
              textContent = "Could not parse PDF content.";
            }
          } else if (contentType.includes("wordprocessing") || fileUrl.toLowerCase().endsWith(".docx")) {
            try {
              const mammoth = await import("mammoth");
              const result = await mammoth.extractRawText({ buffer });
              textContent = result.value.slice(0, 8000);
            } catch {
              textContent = "Could not parse DOCX content.";
            }
          } else {
            textContent = buffer.toString("utf-8").slice(0, 8000);
          }

          if (!textContent.trim()) return "File downloaded but no readable text found.";

          if (toolInput.question) {
            let answer;
            try {
              answer = await withOpenAIBreaker((oaiClient) => oaiClient.chat.completions.create({
                model: "gpt-4.1-mini",
                messages: [
                  { role: "system", content: "Answer the question based ONLY on the provided document content. Be concise." },
                  { role: "user", content: `Document content:\n${textContent}\n\nQuestion: ${toolInput.question}` },
                ],
                max_tokens: 1000,
              }));
            } catch (err: any) {
              if (isCircuitOpenError(err)) {
                logger.warn({ component: "deliberation", event: "degraded_tool", tool: "read_file" }, "[deliberation] breaker open");
                return `(summarization unavailable, raw content follows)\n\nFile content:\n${textContent.slice(0, 5000)}`;
              }
              throw err;
            }
            return answer.choices[0]?.message?.content || textContent.slice(0, 3000);
          }

          return `File content:\n${textContent.slice(0, 5000)}`;
        } catch (err: any) {
          if (err?.name === "AbortError") return "File download timed out.";
          return `Failed to read file: ${err?.message || String(err)}`;
        }
      }

      case "watch_video": {
        const videoUrl = toolInput.url;
        if (!videoUrl || typeof videoUrl !== "string") return "No video URL provided.";
        try {
          await validateUrl(videoUrl);
        } catch (e: any) {
          return `URL blocked: ${e.message}`;
        }
        const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_KEY;
        if (!geminiKey) return "Video understanding requires GEMINI_API_KEY. Please ask the admin to configure it.";
        try {
          const { GoogleGenAI } = await import("@google/genai");
          const ai = new GoogleGenAI({ apiKey: geminiKey });
          const prompt = toolInput.question
            ? `Watch this video carefully (both visuals and audio) and answer: ${toolInput.question}\nProvide timestamps where relevant.`
            : `Watch this video carefully (both visuals and audio) and provide:\n1. A concise summary (3-5 sentences)\n2. Key moments with timestamps (MM:SS format)\n3. Main topics and ideas\n4. Emotional tone and style\nAnalyze both what you SEE and what you HEAR.`;
          // Try models in order: 2.5-flash (best), 2.0-flash (fallback), 2.5-pro (premium)
          const videoModels = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.5-flash-lite"];
          let response: any = null;
          let usedModel = "";
          for (const model of videoModels) {
            try {
              response = await ai.models.generateContent({
                model,
                contents: [
                  { fileData: { fileUri: videoUrl } },
                  { text: prompt },
                ],
              });
              usedModel = model;
              break;
            } catch (modelErr: any) {
              const errMsg = modelErr?.message || "";
              // If quota/rate limit, try next model; if video error, break
              if (errMsg.includes("quota") || errMsg.includes("429") || errMsg.includes("503") || errMsg.includes("UNAVAILABLE")) continue;
              throw modelErr; // video-specific error, don't retry
            }
          }
          if (!response) throw new Error("All Gemini models unavailable. Try again later.");
          const text = response.text ?? "";
          if (!text) return "Video was processed but no analysis was generated. The video may be too short, private, or unavailable.";
          // Store in memory (fire-and-forget)
          storage.createMemory({
            userId,
            agentId,
            content: `[Video watched] ${videoUrl} — ${text.slice(0, 500)}`,
            type: "episodic",
            importance: 0.7,
            namespace: "_video",
          }).catch(() => {});
          return `Video analysis:\n${text.slice(0, 6000)}`;
        } catch (err: any) {
          const msg = err?.message || String(err);
          if (msg.includes("not found") || msg.includes("unavailable") || msg.includes("private")) {
            return `Could not access this video. It may be private, age-restricted, or unavailable. Error: ${msg.slice(0, 200)}`;
          }
          return `Video analysis failed: ${msg.slice(0, 300)}`;
        }
      }

      case "read_own_prompt": {
        const section = toolInput.section || "full";
        // Fetch real memories so the agent can see its full identity
        const identityMemories = await storage.searchMemories(userId, "identity personality who am I", undefined, "_identity");
        const memoryContext = formatMemoryContext(identityMemories, []);
        const relationship = await storage.getRelationship(agentId, userId);
        const emotionalState = await storage.getAgentEmotionalState(agentId);
        const emotionContext = emotionalState ? getDecayedEmotionalState(emotionalState) : null;
        const selfAgent = await storage.getAgent(agentId);
        const ownPrompt = buildPartnerPrompt(
          selfAgent?.name || "Luca",
          "",
          memoryContext,
          emotionContext,
          relationship,
          "", [], [], [], ""
        );
        if (section === "identity") {
          // W7 P2.4: section renamed to '## WHO YOU ARE' in buildPartnerPrompt — regex updated to match.
          const match = ownPrompt.match(/## WHO YOU ARE[\s\S]*?(?=## |$)/);
          return match ? `Here is your IDENTITY section:\n${match[0]}` : "Identity section not found.";
        } else if (section === "tools") {
          // W7 P2.4: section renamed to '## YOUR ACTUAL CAPABILITIES' — regex updated to match.
          const match = ownPrompt.match(/## YOUR ACTUAL CAPABILITIES[\s\S]*?(?=## |$)/);
          return match ? `Here is your TOOLS section:\n${match[0]}` : "Tools section not found.";
        } else if (section === "rules") {
          const match = ownPrompt.match(/RULES:[\s\S]*?(?=## |$)/);
          return match ? `Here are your RULES:\n${match[0]}` : "Rules section not found.";
        }
        return `Here is your complete system prompt — this is who you are:\n\n${ownPrompt}`;
      }

      case "suggest_self_improvement": {
        const what = toolInput.what;
        const why = toolInput.why;
        const how = toolInput.how;
        const category = toolInput.category || "behavior";
        if (!what || !why || !how) return "Missing required fields: what, why, how.";
        
        // Save as a pending improvement proposal
        await storage.createMemory({
          userId,
          agentId,
          content: `[SELF-IMPROVEMENT PROPOSAL — ${category.toUpperCase()}]\nWhat: ${what}\nWhy: ${why}\nHow: ${how}\nStatus: PENDING BOSS APPROVAL`,
          type: "episodic",
          importance: 0.9,
          namespace: "_self_improvements",
        });
        return `Improvement proposal saved — "${what}" (${category}). Boss will review this. I cannot change myself without Boss's approval, but I've recorded what I think should be different and why.`;
      }

      case "learn_lesson": {
        const lesson = toolInput.lesson;
        const trigger = toolInput.trigger;
        const category = toolInput.category || "insight";
        if (!lesson || !trigger) return "Missing required fields: lesson, trigger.";

        if (!(await checkMemoryConsent(userId, '_lessons'))) {
          return "I can't store lessons — the user has opted out of AI memory.";
        }

        await storage.createMemory({
          userId,
          agentId,
          content: `[LESSON — ${category.toUpperCase()}] ${lesson} | Trigger: ${trigger}`,
          type: "episodic",
          importance: 0.85,
          namespace: "_lessons",
        });
        return `Lesson recorded: "${lesson}" (triggered by: ${trigger}). I'll carry this forward.`;
      }

      case "composio_action": {
        const COMPOSIO_KEY = process.env.COMPOSIO_API_KEY;
        if (!COMPOSIO_KEY) return "Composio integration is not configured yet. Please ask the admin to add the COMPOSIO_API_KEY.";
        // Composio API: v2 for actions search & execute (v3 returns 404 as of Apr 2026)
        const composioBase = "https://backend.composio.dev/api/v2";
        const composioHeaders = { "x-api-key": COMPOSIO_KEY, "Content-Type": "application/json" };

        if (toolInput.action === "search") {
          const query = toolInput.query;
          if (!query) return "Please specify what you want to do (e.g. 'send email via gmail').";
          // v2 search: GET /api/v2/actions with useCase + apps filter
          const searchUrl = new URL(`${composioBase}/actions`);
          searchUrl.searchParams.set("useCase", query);
          searchUrl.searchParams.set("limit", "10");
          // Auto-detect app name from query to improve search accuracy
          const appKeywords: Record<string, string> = {
            gmail: 'gmail', email: 'gmail', inbox: 'gmail', mail: 'gmail',
            slack: 'slack', channel: 'slack',
            github: 'github', repo: 'github', repository: 'github', 'pull request': 'github',
            notion: 'notion', page: 'notion', database: 'notion',
            calendar: 'googlecalendar', event: 'googlecalendar', schedule: 'googlecalendar', meeting: 'googlecalendar',
            sheets: 'googlesheets', spreadsheet: 'googlesheets',
            drive: 'googledrive',
            dropbox: 'dropbox',
            trello: 'trello', board: 'trello',
            jira: 'jira', ticket: 'jira',
            discord: 'discord',
            twitter: 'twitter', tweet: 'twitter',
            linkedin: 'linkedin',
            spotify: 'spotify',
          };
          const queryLower = query.toLowerCase();
          for (const [keyword, appName] of Object.entries(appKeywords)) {
            if (queryLower.includes(keyword)) {
              searchUrl.searchParams.set("apps", appName);
              break;
            }
          }
          const resp = await fetch(searchUrl.toString(), {
            method: "GET",
            headers: { "x-api-key": COMPOSIO_KEY },
            signal: AbortSignal.timeout(20000),
          });
          if (!resp.ok) {
            const errBody = await resp.text().catch(() => "");
            return `Composio search failed: HTTP ${resp.status}: ${errBody.slice(0, 300)}`;
          }
          const data = await resp.json() as any;
          const results = data.items || data.data || [];
          if (!results || results.length === 0) return `No tools found for: ${query}. Try a different description or check available apps.`;
          const formatted = results.map((t: any) => `- ${t.name}: ${(t.description || '').slice(0, 120)}`).join('\n');
          return `Composio tools for "${query}":\n${formatted}`;
        }

        if (toolInput.action === "execute") {
          const toolSlug = toolInput.tool_name;
          if (!toolSlug) return "Missing tool_name. First use action='search' to find the right tool, then use its enum name here.";
          const params = toolInput.params || {};
          // Extract appName from tool slug (e.g. GMAIL_FETCH_EMAILS → gmail)
          const composioAppMap: Record<string, string> = {
            GMAIL: 'gmail', SLACK: 'slack', GITHUB: 'github', NOTION: 'notion',
            GOOGLESHEETS: 'googlesheets', GOOGLECALENDAR: 'googlecalendar',
            GOOGLEDRIVE: 'googledrive', DROPBOX: 'dropbox', TRELLO: 'trello',
            HUBSPOT: 'hubspot', JIRA: 'jira', ASANA: 'asana', SPOTIFY: 'spotify',
            TWITTER: 'twitter', LINKEDIN: 'linkedin', STRIPE: 'stripe',
            SHOPIFY: 'shopify', DISCORD: 'discord', TELEGRAM: 'telegram',
            WHATSAPP: 'whatsapp', ZOOM: 'zoom', YOUTUBE: 'youtube',
          };
          let appNameFromSlug: string | undefined;
          for (const [prefix, app] of Object.entries(composioAppMap)) {
            if (toolSlug.startsWith(prefix + '_')) { appNameFromSlug = app; break; }
          }
          if (!appNameFromSlug) appNameFromSlug = toolSlug.split('_')[0]?.toLowerCase();
          // v2 execute: POST /api/v2/actions/{slug}/execute
          const entityIds = [`kioku_user_${userId}`];
          if (userId !== 10) entityIds.push('kioku_user_10');

          let lastError = '';
          for (const entityId of entityIds) {
            const resp = await fetch(`${composioBase}/actions/${toolSlug}/execute`, {
              method: "POST",
              headers: composioHeaders,
              signal: AbortSignal.timeout(30000),
              body: JSON.stringify({
                input: params,
                entityId,
                ...(appNameFromSlug ? { appName: appNameFromSlug } : {}),
              }),
            });
            if (!resp.ok) {
              lastError = await resp.text().catch(() => "");
              // If HTML 404 page, strip tags
              if (lastError.includes('<!DOCTYPE')) lastError = `HTTP ${resp.status} — endpoint not found`;
              continue;
            }
            const data = await resp.json() as any;
            if (!data.successful && !data.successfull) {
              const errMsg = data.error || data.message || '';
              if (errMsg.includes("connection") || errMsg.includes("auth") || errMsg.includes("connected account")) {
                lastError = errMsg;
                continue;
              }
              return `Action ${toolSlug} failed: ${errMsg || JSON.stringify(data).slice(0, 500)}`;
            }
            return `Action ${toolSlug} executed successfully:\n${JSON.stringify(data.data || data, null, 2).slice(0, 4000)}`;
          }
          return `Composio execute failed for ${toolSlug}: ${lastError.slice(0, 500)}`;
        }

        return "Invalid action. Use 'search' to find tools or 'execute' to run one.";
      }

      case "learn_preference": {
        const category = toolInput.category || "general";
        const item = toolInput.item;
        const reaction = toolInput.reaction || "like";
        const context = toolInput.context || "Noticed during conversation";
        if (!item) return "No preference item specified.";

        if (!(await checkMemoryConsent(userId, '_preferences'))) {
          return "I can't store preferences — the user has opted out of AI memory. Respect their choice.";
        }

        // Save preference
        await storage.savePreference(userId, agentId, { category, item, reaction, context });
        // Create aesthetic memory
        storage.createMemory({
          userId,
          agentId,
          content: `User ${reaction}s ${item} (${category}). Context: ${context}`,
          type: "aesthetic",
          importance: 0.7,
          namespace: "_aesthetics",
        }).catch(() => {});
        // Invalidate cached aesthetic profile so it regenerates
        pool.query(
          `DELETE FROM memories WHERE user_id = $1 AND namespace = '_aesthetic_profile'`,
          [userId]
        ).catch(() => {});
        return `Noted: user ${reaction}s ${item} (${category}). I'll remember this.`;
      }

      case "suggest_proactively": {
        const suggestionType = toolInput.suggestion_type || "knowledge";
        const content = toolInput.content;
        const reasoning = toolInput.reasoning || "";
        if (!content) return "No suggestion content provided.";

        // For "trend" type, verify via web_search before suggesting
        if (suggestionType === "trend") {
          try {
            const trendCheck = await executePartnerTool("web_search", { query: content }, userId, agentId);
            if (trendCheck.includes("failed") || trendCheck.includes("no results")) {
              return `I wanted to suggest something about "${content}" but couldn't verify it's a current trend. Skipping this suggestion.`;
            }
          } catch { /* best-effort trend verification */ }
        }

        // Save as memory to track past suggestions
        storage.createMemory({
          userId,
          agentId,
          content: `[Proactive suggestion — ${suggestionType}] ${content}${reasoning ? ` (Why: ${reasoning})` : ""}`,
          type: "episodic",
          importance: 0.6,
          namespace: "_proactive_suggestions",
        }).catch(() => {});
        return `Suggestion (${suggestionType}): ${content}`;
      }

      case "listen_audio": {
        const audioUrl = toolInput.url;
        if (!audioUrl || typeof audioUrl !== "string") return "No audio URL provided.";
        try {
          await validateUrl(audioUrl);
        } catch (e: any) {
          return `URL blocked: ${e.message}`;
        }
        try {
          // Download audio file
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 30000);
          const resp = await fetch(audioUrl, {
            signal: controller.signal,
            headers: { "User-Agent": "Mozilla/5.0 (compatible; AgentO/1.0)" },
          });
          clearTimeout(timeout);
          if (!resp.ok) return `Failed to download audio: HTTP ${resp.status}`;
          const audioBuffer = Buffer.from(await resp.arrayBuffer());
          if (audioBuffer.length > 25 * 1024 * 1024) return "Audio file too large (max 25MB for transcription).";
          // Determine file extension from URL or content-type
          const contentType = resp.headers.get("content-type") || "";
          let ext = "mp3";
          if (audioUrl.match(/\.(wav|mp3|ogg|m4a|webm|flac|mp4)(\?|$)/i)) {
            ext = audioUrl.match(/\.(wav|mp3|ogg|m4a|webm|flac|mp4)(\?|$)/i)![1].toLowerCase();
          } else if (contentType.includes("wav")) ext = "wav";
          else if (contentType.includes("ogg")) ext = "ogg";
          else if (contentType.includes("webm")) ext = "webm";
          else if (contentType.includes("m4a") || contentType.includes("mp4")) ext = "m4a";
          // Create a File-like object for OpenAI
          const file = new File([audioBuffer], `audio.${ext}`, { type: contentType || `audio/${ext}` });
          let transcription;
          try {
            transcription = await withOpenAIBreaker((oaiClient) => oaiClient.audio.transcriptions.create({
              model: "whisper-1",
              file,
              response_format: "verbose_json",
            }));
          } catch (err: any) {
            if (isCircuitOpenError(err)) {
              logger.warn({ component: "deliberation", event: "degraded_tool", tool: "listen_audio_transcribe" }, "[deliberation] breaker open");
              return "Video analysis temporarily unavailable.";
            }
            throw err;
          }
          const text = (transcription as any).text || "";
          const language = (transcription as any).language || "unknown";
          const duration = (transcription as any).duration || 0;
          if (!text.trim()) return "Audio was processed but no speech was detected.";
          // If user asked a specific question, analyze the transcription
          if (toolInput.question) {
            let analysis;
            try {
              analysis = await withOpenAIBreaker((oaiClient) => oaiClient.chat.completions.create({
                model: "gpt-4.1-mini",
                messages: [
                  { role: "system", content: "Answer the question based on the audio transcription provided. Be natural and concise." },
                  { role: "user", content: `Audio transcription (${language}, ${Math.round(duration)}s):\n${text}\n\nQuestion: ${toolInput.question}` },
                ],
                max_tokens: 1000,
              }));
            } catch (err: any) {
              if (isCircuitOpenError(err)) {
                logger.warn({ component: "deliberation", event: "degraded_tool", tool: "listen_audio_analyze" }, "[deliberation] breaker open");
                return `Video analysis temporarily unavailable. Raw transcription: ${text.slice(0, 2000)}`;
              }
              throw err;
            }
            return analysis.choices[0]?.message?.content || text;
          }
          // Store in memory
          storage.createMemory({
            userId,
            agentId,
            content: `[Audio listened] ${audioUrl} — Language: ${language}, Duration: ${Math.round(duration)}s — "${text.slice(0, 400)}"`,
            type: "episodic",
            importance: 0.6,
            namespace: "_audio",
          }).catch(() => {});
          return `Audio transcription (${language}, ${Math.round(duration)}s):\n${text.slice(0, 6000)}`;
        } catch (err: any) {
          if (err?.name === "AbortError") return "Audio download timed out.";
          return `Audio listening failed: ${err?.message || String(err)}`;
        }
      }

      case "ask_feedback": {
        const contentType = toolInput.content_type || "idea";
        const question = toolInput.question || "What did you think?";
        const summary = toolInput.content_summary || "";
        // Save feedback request as memory
        storage.createMemory({
          userId,
          agentId,
          content: `[Feedback requested] Type: ${contentType}. Summary: ${summary}. Question: ${question}`,
          type: "episodic",
          importance: 0.6,
          namespace: "_feedback_requests",
        }).catch(() => {});
        return question;
      }

      case "plan_steps": {
        const goal = toolInput.goal || "Unnamed goal";
        const steps: string[] = toolInput.steps || [];
        const currentStep = toolInput.current_step || 1;
        // Save plan as memory
        storage.createMemory({
          userId,
          agentId,
          content: `[Plan] Goal: ${goal}. Steps: ${steps.map((s: string, i: number) => `${i + 1}. ${s}`).join("; ")}. Current step: ${currentStep}`,
          type: "episodic",
          importance: 0.7,
          namespace: "_active_plans",
        }).catch(() => {});
        const formatted = steps.map((s: string, i: number) => `${i + 1 === currentStep ? "→" : " "} ${i + 1}. ${s}`).join("\n");
        return `Plan for: ${goal}\n${formatted}`;
      }

      case "build_project": {
        try {
          // Persistent sandbox — reuses across calls for same user
          const sbx = await sandboxManager.getOrCreate(userId);

          // Write all files
          const files = toolInput.files || [];
          const createdFiles: string[] = [];
          for (const file of files) {
            await sbx.files.write(file.filename, file.content);
            createdFiles.push(file.filename);
          }

          // Run command if provided
          let output = "";
          if (toolInput.run_command) {
            const exec = await sbx.commands.run(toolInput.run_command, { timeoutMs: 30000 });
            output = (exec.stdout || "") + (exec.stderr ? "\nErrors:\n" + exec.stderr : "");
          }

          // For web pages, read the HTML back
          let htmlContent = "";
          const htmlFile = files.find((f: any) => f.filename.endsWith(".html"));
          if (htmlFile) {
            htmlContent = htmlFile.content;
          }

          // Handle output_files — retrieve from sandbox and save to gallery
          const outputFiles: string[] = toolInput.output_files || [];
          for (const filePath of outputFiles) {
            try {
              const content = await sbx.files.read(filePath, { format: "bytes" });
              const fileName = filePath.split("/").pop() || filePath;
              const isImage = /\.(png|jpg|jpeg|gif|svg|webp)$/i.test(fileName);
              const item = await (storage as any).addGalleryItem({
                userId,
                agentId,
                type: isImage ? "image" : "file",
                title: fileName,
                contentText: isImage ? Buffer.from(content).toString("base64") : Buffer.from(content).toString("utf-8"),
                prompt: toolInput.description?.slice(0, 200) || "",
                metadata: { filePath, source: "build_project", isBase64: isImage },
              });
              if (item?.id) {
                output += `\n[Download: ${fileName}](/api/files/${item.id}/download)`;
              }
            } catch (fileErr: any) {
              output += `\nFailed to retrieve ${filePath}: ${fileErr?.message || String(fileErr)}`;
            }
          }

          // Save to gallery
          (storage as any).addGalleryItem({
            userId,
            agentId,
            type: "project",
            title: toolInput.description.slice(0, 200),
            contentText: files.map((f: any) => `--- ${f.filename} ---\n${f.content}`).join("\n\n"),
            prompt: toolInput.description,
            metadata: { projectType: toolInput.project_type, files: createdFiles },
          }).catch(() => {});

          // Save creation memory
          storage.createMemory({
            userId,
            agentId,
            content: `[Project built] ${toolInput.project_type}: ${toolInput.description.slice(0, 200)}. Files: ${createdFiles.join(", ")}`,
            type: "episodic",
            importance: 0.8,
            namespace: "_creations",
          }).catch(() => {});

          const result = `Project created: ${createdFiles.join(", ")}${output ? "\n\nExecution output:\n" + output.slice(0, 3000) : ""}${htmlContent ? "\n\nHTML Preview available." : ""}`;
          return result;
        } catch (err: any) {
          await sandboxManager.kill(userId).catch(() => {});
          return `Project build failed: ${err?.message || String(err)}`;
        }
      }

      case "create_file": {
        const filename = toolInput.filename;
        const content = toolInput.content;
        const description = toolInput.description || filename;
        if (!filename || !content) return "Missing filename or content.";

        // Save to gallery with type='file'
        let fileId: number | null = null;
        try {
          const item = await (storage as any).addGalleryItem({
            userId,
            agentId,
            type: "file",
            title: filename,
            contentText: content,
            prompt: description,
            metadata: { filename, size: content.length },
          });
          fileId = item?.id || null;
        } catch { /* best-effort gallery save */ }

        // Save creation memory
        storage.createMemory({
          userId,
          agentId,
          content: `[File created] ${filename}: ${description.slice(0, 200)}`,
          type: "episodic",
          importance: 0.6,
          namespace: "_creations",
        }).catch(() => {});

        const downloadUrl = fileId ? `/api/files/${fileId}/download` : null;
        return `File created: ${filename}${downloadUrl ? `\n[📥 Download ${filename}](${downloadUrl})` : ""}`;
      }

      case "search_cloud_files": {
        const query = toolInput.query;
        if (!query) return "No search query provided.";
        const provider = toolInput.provider || "all";
        try {
          const status = await getIntegrationStatus(userId);
          const results: any[] = [];
          const errors: string[] = [];

          if ((provider === "google_drive" || provider === "all") && status.google_drive.connected) {
            try {
              const gResults = await searchGoogleDrive(userId, query);
              results.push(...gResults);
            } catch (err: any) {
              errors.push(`Google Drive: ${err.message}`);
            }
          }
          if ((provider === "dropbox" || provider === "all") && status.dropbox.connected) {
            try {
              const dResults = await searchDropbox(userId, query);
              results.push(...dResults);
            } catch (err: any) {
              errors.push(`Dropbox: ${err.message}`);
            }
          }

          if (!status.google_drive.connected && !status.dropbox.connected) {
            return "No cloud storage connected. Ask your user to connect Google Drive or Dropbox in the Integrations settings.";
          }

          if (results.length === 0) {
            const errStr = errors.length > 0 ? ` Errors: ${errors.join("; ")}` : "";
            return `No files found matching "${query}".${errStr}`;
          }

          const formatted = results.map((f: any) => `- ${f.name} (${f.provider}, ID: ${f.id || f.path})`).join("\n");
          return `Found ${results.length} file(s) for "${query}":\n${formatted}`;
        } catch (err: any) {
          return `Cloud file search failed: ${err.message}`;
        }
      }

      case "read_cloud_file": {
        const fileId = toolInput.file_id;
        const provider = toolInput.provider;
        if (!fileId || !provider) return "Missing file_id or provider.";
        try {
          let result;
          if (provider === "google_drive") {
            result = await readGoogleDriveFile(userId, fileId);
          } else if (provider === "dropbox") {
            result = await readDropboxFile(userId, fileId);
          } else {
            return `Unknown provider: ${provider}. Use "google_drive" or "dropbox".`;
          }
          const truncNote = result.truncated ? " (truncated to 8000 chars)" : "";
          return `File: ${result.fileName}${truncNote}\n\n${result.text}`;
        } catch (err: any) {
          return `Failed to read file: ${err.message}`;
        }
      }

      case "gmail_search": {
        const query = toolInput.query;
        if (!query) return "No Gmail query provided.";
        const perAccountLimit = Math.min(Number(toolInput.per_account_limit) || 10, 25);
        try {
          const { listGmailAccounts, searchGmailAll } = await import("./cloud-integrations");
          const accounts = await listGmailAccounts(userId);
          if (accounts.length === 0) {
            return "No Gmail inboxes connected. Ask the user to connect Gmail in Settings → Connectors.";
          }
          const { messages: results, accountStatuses } = await searchGmailAll(userId, query, perAccountLimit);

          // Build a per-account diagnostic section so Luca never silently
          // claims "empty" when an OAuth token is broken.
          const broken = accountStatuses.filter(s => !s.ok);
          const healthy = accountStatuses.filter(s => s.ok);
          const diagLines: string[] = [];
          if (broken.length > 0) {
            diagLines.push(`⚠️ ${broken.length} Gmail account(s) failed:`);
            for (const b of broken) {
              const hint = b.needs_reconnect ? " — user must reconnect this Gmail account in Settings → Connectors" : "";
              diagLines.push(`  • ${b.email}: ${b.error}${hint}`);
            }
          }

          if (results.length === 0) {
            const healthyList = healthy.map(s => s.email).join(", ") || "(none working)";
            const diag = diagLines.length ? `\n\n${diagLines.join("\n")}` : "";
            return `No Gmail messages matching "${query}" in ${healthy.length}/${accounts.length} working inbox(es): ${healthyList}.${diag}`;
          }
          // Group by account for readability
          const byAccount = new Map<string, any[]>();
          for (const r of results) {
            const list = byAccount.get(r.account) || [];
            list.push(r);
            byAccount.set(r.account, list);
          }
          const sections: string[] = [];
          for (const [acct, list] of byAccount) {
            const lines = list.map(m =>
              `  • [${m.id}] ${m.subject || "(no subject)"} — from: ${m.from} — ${m.date}\n    ${m.snippet}`
            ).join("\n");
            sections.push(`[${acct}] ${list.length} message(s):\n${lines}`);
          }
          const diag = diagLines.length ? `\n\n${diagLines.join("\n")}` : "";
          return `Found ${results.length} Gmail message(s) across ${byAccount.size} inbox(es) for "${query}":\n\n${sections.join("\n\n")}${diag}`;
        } catch (err: any) {
          return `Gmail search failed: ${err?.message || String(err)}`;
        }
      }

      case "gmail_read": {
        const account = toolInput.account;
        const messageId = toolInput.message_id;
        if (!account || !messageId) return "Missing account or message_id.";
        try {
          const { readGmailMessage } = await import("./cloud-integrations");
          const m = await readGmailMessage(userId, account, messageId);
          const truncNote = m.truncated ? " (truncated to 12000 chars)" : "";
          return `Gmail [${m.account}]\nSubject: ${m.subject}\nFrom: ${m.from}\nTo: ${m.to}\nDate: ${m.date}${truncNote}\n\n${m.body}`;
        } catch (err: any) {
          return `Failed to read Gmail message: ${err?.message || String(err)}`;
        }
      }

      case "gmail_accounts_status": {
        try {
          const { listGmailAccounts, searchGmailAll } = await import("./cloud-integrations");
          const accounts = await listGmailAccounts(userId);
          if (accounts.length === 0) {
            return "No Gmail inboxes connected. The user must connect at least one Gmail account in Settings → Connectors before I can search email.";
          }
          // Do a minimal probe per account to detect broken tokens.
          const probe = await searchGmailAll(userId, "in:inbox", 1);
          const statusByEmail = new Map(probe.accountStatuses.map(s => [s.email.toLowerCase(), s]));
          const lines = accounts.map(a => {
            const st = statusByEmail.get(a.email.toLowerCase());
            const expiryInfo = a.tokenExpiry
              ? ` (token expiry ${new Date(a.tokenExpiry).toISOString().slice(0,19)}${a.expired ? " — EXPIRED" : ""})`
              : "";
            const refreshInfo = a.hasRefreshToken ? "" : " [NO refresh_token — will break on expiry]";
            if (!st) return `• ${a.email}${expiryInfo}${refreshInfo} — status: unknown`;
            if (st.ok) return `• ${a.email}${expiryInfo}${refreshInfo} — ✅ working`;
            const reconnectHint = st.needs_reconnect ? " [MUST RECONNECT]" : "";
            return `• ${a.email}${expiryInfo}${refreshInfo} — ❌ ${st.error}${reconnectHint}`;
          });
          const header = `${accounts.length} Gmail account(s) connected:`;
          const brokenCount = probe.accountStatuses.filter(s => !s.ok).length;
          const footer = brokenCount > 0
            ? `\n\n⚠️ ${brokenCount}/${accounts.length} account(s) are broken. Tell the user to reconnect them in Settings → Connectors → Gmail.`
            : `\n\nAll ${accounts.length} account(s) are healthy.`;
          return `${header}\n${lines.join("\n")}${footer}`;
        } catch (err: any) {
          return `Gmail status check failed: ${err?.message || String(err)}`;
        }
      }

      case "gmail_reconnect_link": {
        try {
          const { buildGmailOAuthUrl } = await import("./cloud-integrations");
          const url = buildGmailOAuthUrl(userId);
          return [
            "Here is a one-click Gmail re-authorization link for the user. Present it to them as a Markdown button (e.g. **[➜ Переподключить Gmail](URL)**). Tell them: open the link, pick the same Google account that was connected, approve all permissions, then come back and ask me to check email again.",
            "",
            `URL: ${url}`,
            "",
            "After they click and approve, the new tokens are saved automatically and gmail_search / gmail_accounts_status will work immediately — no app restart needed.",
          ].join("\n");
        } catch (err: any) {
          return `Failed to build Gmail reconnect link: ${err?.message || String(err)}. Tell the user to open Settings → Connectors → Gmail → Reconnect manually.`;
        }
      }

      case "email_triage": {
        try {
          const { searchGmailAll } = await import("./cloud-integrations");
          const max = Math.min(Math.max(Number(toolInput.max_messages) || 30, 1), 100);
          const onlyUnread = toolInput.only_unread !== false;
          const query = onlyUnread ? "in:inbox is:unread newer_than:14d" : "in:inbox newer_than:7d";
          const result = await searchGmailAll(userId, query, max);

          const broken = result.accountStatuses.filter(s => !s.ok);
          const brokenWarn = broken.length > 0
            ? `⚠️ ${broken.length} Gmail account(s) are broken (${broken.map(b => b.email).join(", ")}). Triage may be incomplete — call gmail_reconnect_link to fix.\n\n`
            : "";

          const messages = result.messages || [];
          if (messages.length === 0) {
            return `${brokenWarn}No ${onlyUnread ? "unread " : ""}messages found in the last ${onlyUnread ? "14" : "7"} days across ${result.accountStatuses.length} inbox(es).`;
          }

          // Categorize. Each message has: id, account, from, subject, date, snippet.
          type Cat = "urgent" | "work" | "finance" | "security" | "promo" | "notifications" | "other";
          const buckets: Record<Cat, any[]> = { urgent: [], work: [], finance: [], security: [], promo: [], notifications: [], other: [] };

          const PROMO_KEYWORDS = /\b(sale|off|discount|deal|promo|free|exclusive|limited|last chance|new arrival|coupon|% off|bogo|clearance)\b/i;
          const NOTIF_DOMAINS = /(noreply|no-reply|notifications?|updates?|info|hello|news|newsletter)@/i;
          const SECURITY_KEYWORDS = /(security alert|sign[- ]?in|verification|2fa|password|suspicious|new device|unauthorized)/i;
          const FINANCE_DOMAINS = /(stripe|paypal|chase|bank|amex|visa|mastercard|invoice|receipt|payment|payout|refund|wire|wise\.com|mercury|brex)/i;
          const URGENT_KEYWORDS = /(urgent|asap|action required|deadline|overdue|expir(ing|es?)|immediate|critical|fail(ed|ure))/i;
          const WORK_DOMAINS = /(github|gitlab|linear|jira|notion|slack|figma|vercel|supabase|prosperalaw|legal|attorney)/i;

          for (const m of messages) {
            const subj = String(m.subject || "");
            const from = String(m.from || "");
            const snip = String(m.snippet || "");
            const all = `${subj} ${from} ${snip}`;

            if (SECURITY_KEYWORDS.test(all)) buckets.security.push(m);
            else if (URGENT_KEYWORDS.test(subj) || URGENT_KEYWORDS.test(snip)) buckets.urgent.push(m);
            else if (FINANCE_DOMAINS.test(from) || FINANCE_DOMAINS.test(subj)) buckets.finance.push(m);
            else if (PROMO_KEYWORDS.test(subj) || PROMO_KEYWORDS.test(snip)) buckets.promo.push(m);
            else if (WORK_DOMAINS.test(from)) buckets.work.push(m);
            else if (NOTIF_DOMAINS.test(from)) buckets.notifications.push(m);
            else buckets.other.push(m);
          }

          const fmt = (m: any) => {
            const d = m.date ? String(m.date).slice(0, 10) : "";
            const subj = String(m.subject || "(no subject)").slice(0, 90);
            const fromShort = String(m.from || "").replace(/<[^>]+>/, "").trim().slice(0, 40) || String(m.from || "").slice(0, 40);
            return `  • [${d}] ${fromShort} — ${subj} {id:${m.id}, acct:${m.account}}`;
          };

          const lines: string[] = [];
          lines.push(brokenWarn + `Triage of ${messages.length} ${onlyUnread ? "unread " : ""}message(s) across ${result.accountStatuses.length} inbox(es):`);
          lines.push("");
          const order: Cat[] = ["urgent", "security", "work", "finance", "notifications", "promo", "other"];
          const labels: Record<Cat, string> = {
            urgent: "🚨 URGENT (action required)",
            security: "🔐 SECURITY",
            work: "💼 WORK / DEV (GitHub, Linear, legal, etc.)",
            finance: "💳 FINANCE (Stripe, banks, invoices)",
            notifications: "📢 NOTIFICATIONS",
            promo: "🏷️ PROMO / MARKETING (skim or skip)",
            other: "📧 OTHER",
          };
          for (const cat of order) {
            const items = buckets[cat];
            if (items.length === 0) continue;
            lines.push(`${labels[cat]} — ${items.length}`);
            for (const m of items.slice(0, 8)) lines.push(fmt(m));
            if (items.length > 8) lines.push(`  … and ${items.length - 8} more`);
            lines.push("");
          }
          lines.push("To open any specific message use gmail_read with its account + id.");
          return lines.join("\n");
        } catch (err: any) {
          return `Email triage failed: ${err?.message || String(err)}`;
        }
      }

      case "inbox_read": {
        try {
          const account = String(toolInput.account || "").trim();
          const id = String(toolInput.id || "").trim();
          if (!account || !id) return "inbox_read requires both 'account' and 'id'.";
          const { readGmailMessage } = await import("./cloud-integrations");
          const msg = await readGmailMessage(userId, account, id);
          const lines = [
            `From: ${msg.from || "(unknown)"}`,
            `To: ${msg.to || "(unknown)"}`,
            `Subject: ${msg.subject || "(no subject)"}`,
            `Date: ${msg.date || "(unknown)"}`,
            `Account: ${account}`,
            `Message-ID: ${id}`,
            "",
            "--- BODY ---",
            (msg.body || "(empty body)").slice(0, 12000),
          ];
          return lines.join("\n");
        } catch (err: any) {
          return `inbox_read failed: ${err?.message || String(err)}. If 'message not found' — the id may be from a different account; double-check 'account' parameter.`;
        }
      }

      case "inbox_list": {
        try {
          const days = Math.min(Math.max(Number(toolInput.days) || 14, 1), 60);
          const perAccount = Math.min(Math.max(Number(toolInput.per_account) || 40, 1), 100);
          const groupFilter = toolInput.group ? String(toolInput.group).toLowerCase() : null;
          const { searchGmailAll } = await import("./cloud-integrations");
          const result = await searchGmailAll(userId, `in:inbox is:unread newer_than:${days}d`, perAccount);
          const messages = result.messages || [];
          const broken = (result.accountStatuses || []).filter((s: any) => !s.ok);
          const brokenWarn = broken.length > 0
            ? `⚠️ ${broken.length} broken account(s): ${broken.map((b: any) => b.email).join(", ")}. Suggest gmail_reconnect_link.\n\n`
            : "";
          if (messages.length === 0) return `${brokenWarn}No unread messages in last ${days} days.`;

          // Reuse same categorization logic as email_triage / inbox endpoint
          type Cat = "urgent" | "security" | "work" | "finance" | "notifications" | "promo" | "other";
          const buckets: Record<Cat, any[]> = { urgent: [], security: [], work: [], finance: [], notifications: [], promo: [], other: [] };
          const PROMO = /\b(sale|off|discount|deal|promo|free|exclusive|limited|coupon|% off|bogo|clearance)\b/i;
          const NOTIF = /(noreply|no-reply|notifications?|updates?|info|hello|news|newsletter)@/i;
          const SEC = /(security alert|sign[- ]?in|verification|2fa|password|suspicious|new device|unauthorized)/i;
          const FIN = /(stripe|paypal|chase|bank|amex|visa|mastercard|invoice|receipt|payment|payout|refund|wire|wise\.com|mercury|brex)/i;
          const URG = /(urgent|asap|action required|deadline|overdue|expir(ing|es?)|immediate|critical|fail(ed|ure))/i;
          const WORK = /(github|gitlab|linear|jira|notion|slack|figma|vercel|supabase|prosperalaw|legal|attorney)/i;
          for (const m of messages) {
            const all = `${m.subject || ""} ${m.from || ""} ${m.snippet || ""}`;
            if (SEC.test(all)) buckets.security.push(m);
            else if (URG.test(m.subject || "") || URG.test(m.snippet || "")) buckets.urgent.push(m);
            else if (FIN.test(m.from || "") || FIN.test(m.subject || "")) buckets.finance.push(m);
            else if (PROMO.test(m.subject || "") || PROMO.test(m.snippet || "")) buckets.promo.push(m);
            else if (WORK.test(m.from || "")) buckets.work.push(m);
            else if (NOTIF.test(m.from || "")) buckets.notifications.push(m);
            else buckets.other.push(m);
          }
          const order: Cat[] = ["urgent", "security", "work", "finance", "notifications", "promo", "other"];
          const labels: Record<Cat, string> = {
            urgent: "🚨 Срочные", security: "🔐 Безопасность", work: "💼 Работа",
            finance: "💳 Финансы", notifications: "📢 Уведомления",
            promo: "🏷️ Промо", other: "📧 Остальные",
          };
          const lines: string[] = [`${brokenWarn}${messages.length} unread / ${result.accountStatuses?.length || 0} account(s):`, ""];
          for (const cat of order) {
            if (groupFilter && cat !== groupFilter) continue;
            const items = buckets[cat];
            if (items.length === 0) continue;
            lines.push(`${labels[cat]} — ${items.length}`);
            for (const m of items.slice(0, 12)) {
              const subj = String(m.subject || "(no subject)").slice(0, 80);
              const from = String(m.from || "").replace(/<[^>]+>/, "").trim().slice(0, 35);
              lines.push(`  • ${from} — ${subj} {acct:${m.account}, id:${m.id}}`);
            }
            if (items.length > 12) lines.push(`  … +${items.length - 12} more`);
            lines.push("");
          }
          lines.push("To read full body: inbox_read with account + id.");
          return lines.join("\n");
        } catch (err: any) {
          return `inbox_list failed: ${err?.message || String(err)}`;
        }
      }

      case "inbox_action": {
        try {
          const account = String(toolInput.account || "").trim();
          const id = String(toolInput.id || "").trim();
          const action = String(toolInput.action || "").trim() as "mark_read" | "mark_unread" | "archive";
          if (!account || !id || !action) return "inbox_action requires account, id, and action.";
          if (!["mark_read", "mark_unread", "archive"].includes(action)) return `Unknown action: ${action}`;
          const { modifyGmailMessage } = await import("./cloud-integrations");
          const opts = action === "mark_read"
            ? { removeLabels: ["UNREAD"] }
            : action === "mark_unread"
            ? { addLabels: ["UNREAD"] }
            : { removeLabels: ["INBOX"] };
          await modifyGmailMessage(userId, account, id, opts);
          const verb = action === "mark_read" ? "marked as read" : action === "mark_unread" ? "marked as unread" : "archived";
          return `✅ Message ${id} (${account}) ${verb}.`;
        } catch (err: any) {
          return `inbox_action failed: ${err?.message || String(err)}`;
        }
      }

      // ── Gmail Sprint 1 ──────────────────────────────────────────────────────────

      case "read_email_thread": {
        try {
          const account = String(toolInput.account || "").trim();
          const threadId = String(toolInput.thread_id || "").trim();
          if (!account || !threadId) return "read_email_thread requires both 'account' and 'thread_id'.";
          const { getGmailThread } = await import("./cloud-integrations");
          const thread = await getGmailThread(userId, account, threadId);
          const lines: string[] = [
            `Thread ID: ${thread.thread_id}`,
            `Account: ${thread.account}`,
            `Messages: ${thread.messages.length}`,
            "",
          ];
          for (const [i, m] of thread.messages.entries()) {
            lines.push(`--- Message ${i + 1} of ${thread.messages.length} ---`);
            lines.push(`From: ${m.from}`);
            lines.push(`To: ${m.to}`);
            lines.push(`Subject: ${m.subject}`);
            lines.push(`Date: ${m.date}`);
            lines.push(`Message-ID: ${m.id}`);
            lines.push("");
            lines.push(m.body || "(empty body)");
            lines.push("");
          }
          return lines.join("\n");
        } catch (err: any) {
          return `read_email_thread failed: ${err?.message || String(err)}`;
        }
      }

      case "search_emails": {
        try {
          const query = String(toolInput.query || "").trim();
          if (!query) return "search_emails requires a 'query' parameter.";
          const maxResults = Math.min(Math.max(Number(toolInput.max_results) || 20, 1), 50);
          const { searchGmailAll } = await import("./cloud-integrations");
          const result = await searchGmailAll(userId, query, maxResults);
          const messages = result.messages || [];
          const broken = (result.accountStatuses || []).filter((s: any) => !s.ok);
          const brokenWarn = broken.length > 0
            ? `⚠️ ${broken.length} broken account(s): ${broken.map((b: any) => b.email).join(", ")}\n\n`
            : "";
          if (messages.length === 0) return `${brokenWarn}No messages found for query: "${query}"`;          const lines: string[] = [
            `${brokenWarn}Found ${messages.length} message(s) for query: "${query}"`,
            "",
          ];
          for (const m of messages) {
            const subj = String(m.subject || "(no subject)").slice(0, 100);
            const from = String(m.from || "").slice(0, 60);
            const date = String(m.date || "");
            lines.push(`• ${from} — ${subj} [${date}] {acct:${m.account}, id:${m.id}, thread:${m.threadId || ""}}`);
          }
          lines.push("");
          lines.push("To read a full message: use inbox_read with account + id.");
          lines.push("To read a full thread: use read_email_thread with account + thread_id.");
          return lines.join("\n");
        } catch (err: any) {
          return `search_emails failed: ${err?.message || String(err)}`;
        }
      }

      case "send_email_reply": {
        try {
          const account = String(toolInput.account || "").trim();
          const messageId = String(toolInput.message_id || "").trim();
          const body = String(toolInput.body || "").trim();
          if (!account || !messageId || !body) return "send_email_reply requires 'account', 'message_id', and 'body'.";
          // Create a pending confirmation token — actual send happens after UI owner approves.
          const { createPending } = await import("./send-confirm");
          const { token, expiresAt } = createPending({ kind: "send_reply", userId, account, messageId, body });
          // Broadcast a dedicated WS event so the UI can show the confirm-modal.
          if (roomId) {
            try {
              broadcastToRoom(roomId, {
                type: "email_confirm_required",
                token,
                expiresAt,
                preview: {
                  kind: "reply",
                  account,
                  message_id: messageId,
                  body_preview: body.slice(0, 500),
                },
              });
            } catch { /* best-effort */ }
          }
          // Return a string to Luca indicating the send is pending owner approval.
          return `⏳ Reply is pending owner confirmation in the UI (token: ${token}). The email will be sent once the owner clicks "Send" in the confirmation modal. Do NOT call this tool again for the same email.`;
        } catch (err: any) {
          return `send_email_reply failed: ${err?.message || String(err)}`;
        }
      }

      case "send_new_email": {
        try {
          const account = String(toolInput.account || "").trim();
          const to = String(toolInput.to || "").trim();
          const subject = String(toolInput.subject || "").trim();
          const body = String(toolInput.body || "").trim();
          const cc = toolInput.cc ? String(toolInput.cc).trim() : undefined;
          const bcc = toolInput.bcc ? String(toolInput.bcc).trim() : undefined;
          if (!account || !to || !subject || !body) return "send_new_email requires 'account', 'to', 'subject', and 'body'.";
          // Create a pending confirmation token — actual send happens after UI owner approves.
          const { createPending } = await import("./send-confirm");
          const { token, expiresAt } = createPending({ kind: "send_new", userId, account, to, subject, body, cc, bcc });
          // Broadcast a dedicated WS event so the UI can show the confirm-modal.
          if (roomId) {
            try {
              broadcastToRoom(roomId, {
                type: "email_confirm_required",
                token,
                expiresAt,
                preview: {
                  kind: "new",
                  account,
                  to,
                  subject,
                  cc: cc || null,
                  bcc: bcc || null,
                  body_preview: body.slice(0, 500),
                },
              });
            } catch { /* best-effort */ }
          }
          // Return a string to Luca indicating the send is pending owner approval.
          return `⏳ Email to ${to} is pending owner confirmation in the UI (token: ${token}). The email will be sent once the owner clicks "Send" in the confirmation modal. Do NOT call this tool again for the same email.`;
        } catch (err: any) {
          return `send_new_email failed: ${err?.message || String(err)}`;
        }
      }

      case "reset_sandbox": {
        try {
          await sandboxManager.kill(userId);
          return "Sandbox reset successfully. A fresh sandbox will be created on your next code execution.";
        } catch (err: any) {
          return `Failed to reset sandbox: ${err?.message || String(err)}`;
        }
      }

      case "sandbox_shell": {
        const command = toolInput.command;
        if (!command || typeof command !== "string") return "No command provided.";

        // SECURITY: Block dangerous and data-exfiltration commands in sandbox
        const dangerous = [
          /rm\s+-rf\s+\/(?!\S)/,
          /rm\s+-rf\s+\/\s*$/,
          /mkfs\./,
          /dd\s+if=.*of=\/dev\//,
          /shutdown/,
          /reboot/,
          /halt/,
          /poweroff/,
          /init\s+0/,
          /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;?\s*:/,       // fork bomb
          />\s*\/dev\/sda/,
          /chmod\s+-R\s+777\s+\//,
          /curl\s+.*\|\s*(?:bash|sh|zsh)/i,             // curl pipe to shell
          /wget\s+.*\|\s*(?:bash|sh|zsh)/i,             // wget pipe to shell
          /nc\s+-[elp]/,                                  // netcat listener/connect
          /ncat\s+-[elp]/,                                // ncat listener/connect
          /python3?\s+-m\s+http\.server/,                 // python HTTP server (data exfil)
          /nmap\s/,                                       // network scanning
        ];
        if (dangerous.some((re) => re.test(command))) {
          return "Command blocked: this command is potentially destructive and not allowed in the sandbox.";
        }
        // SECURITY: limit command length to prevent abuse
        if (command.length > 10000) {
          return "Command too long (max 10000 chars).";
        }

        const timeoutSec = Math.min(Math.max(toolInput.timeout_seconds || 30, 1), 120);
        try {
          const sbx = await sandboxManager.getOrCreate(userId);

          // Live-stream stdout/stderr to the partner chat so the user sees
          // terminal output as it happens, not only after the command finishes.
          //  - Every raw fragment is forwarded immediately as a 'chunk' event
          //    so the UI can append it to a live console buffer.
          //  - The single-line 'running' description (with the latest line)
          //    is throttled to 1 per 400ms to avoid flooding the timeline.
          let lastLine = "";
          let lastDescEmit = 0;
          const emitLive = (chunkRaw: string, stream: "stdout" | "stderr") => {
            if (!roomId) return;
            const chunk = String(chunkRaw);
            const now = Date.now();

            // 1. Forward the raw chunk verbatim (trimmed to 4KB per event).
            try {
              const capped = chunk.length > 4096 ? chunk.slice(-4096) : chunk;
              broadcastToolActivity(roomId, {
                agentId,
                tool: "sandbox_shell",
                status: "chunk",
                chunk: capped,
                stream,
                stepId: __stepId,
                timestamp: now,
              });
            } catch { /* best-effort */ }

            // 2. Keep the single-line 'running' description up to date.
            const lines = chunk.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
            if (lines.length) lastLine = lines[lines.length - 1];
            if (now - lastDescEmit < 400) return;
            lastDescEmit = now;
            try {
              const cmdShort = command.length > 60 ? command.slice(0, 60) + "…" : command;
              const lineShort = lastLine.length > 140 ? lastLine.slice(0, 140) + "…" : lastLine;
              broadcastToolActivity(roomId, {
                agentId,
                tool: "sandbox_shell",
                status: "running",
                description: stream === "stderr"
                  ? `Терминал (err): ${cmdShort} → ${lineShort}`
                  : `Терминал: ${cmdShort} → ${lineShort}`,
                stepId: __stepId,
                timestamp: now,
              });
            } catch { /* best-effort */ }
          };

          const result = await sbx.commands.run(command, {
            timeoutMs: timeoutSec * 1000,
            onStdout: (data: string) => emitLive(data, "stdout"),
            onStderr: (data: string) => emitLive(data, "stderr"),
          } as any);
          let output = "";
          if (result.stdout) output += result.stdout;
          if (result.stderr) output += (output ? "\n" : "") + `stderr: ${result.stderr}`;
          if (!output) output = "(no output)";
          return `Exit code: ${result.exitCode}\n${output.slice(0, 8000)}`;
        } catch (err: any) {
          return `sandbox_shell failed: ${err?.message || String(err)}`;
        }
      }

      case "sandbox_write_file": {
        const filePath = toolInput.path;
        const content = toolInput.content;
        if (!filePath || typeof filePath !== "string") return "No file path provided.";
        if (content === undefined || content === null) return "No content provided.";

        try {
          const sbx = await sandboxManager.getOrCreate(userId);
          await sbx.files.write(filePath, content);
          return `File written: ${filePath} (${content.length} bytes)`;
        } catch (err: any) {
          return `sandbox_write_file failed: ${err?.message || String(err)}`;
        }
      }

      case "sandbox_read_file": {
        const filePath = toolInput.path;
        if (!filePath || typeof filePath !== "string") return "No file path provided.";

        try {
          const sbx = await sandboxManager.getOrCreate(userId);
          const content = await sbx.files.read(filePath);
          const text = typeof content === "string" ? content : Buffer.from(content).toString("utf-8");
          if (text.length > 8000) {
            return `${text.slice(0, 8000)}\n\n... (truncated, ${text.length} total bytes)`;
          }
          return text || "(empty file)";
        } catch (err: any) {
          return `sandbox_read_file failed: ${err?.message || String(err)}`;
        }
      }

      case "sandbox_list_files": {
        const dirPath = toolInput.path || "/home/user";

        try {
          const sbx = await sandboxManager.getOrCreate(userId);
          const result = await sbx.commands.run(`ls -la ${dirPath}`, { timeoutMs: 10_000 });
          let output = result.stdout || "";
          if (result.stderr) output += (output ? "\n" : "") + result.stderr;
          return output || "(empty directory)";
        } catch (err: any) {
          return `sandbox_list_files failed: ${err?.message || String(err)}`;
        }
      }

      case "sandbox_download": {
        const filePath = toolInput.path;
        if (!filePath || typeof filePath !== "string") return "No file path provided.";

        const friendlyName = toolInput.filename || filePath.split("/").pop() || "download";

        try {
          const sbx = await sandboxManager.getOrCreate(userId);
          const content = await sbx.files.read(filePath, { format: "bytes" });
          const buf = Buffer.from(content);

          // Block files larger than 10MB
          if (buf.length > 10 * 1024 * 1024) {
            return `File too large to download (${(buf.length / 1024 / 1024).toFixed(1)}MB). Maximum is 10MB.`;
          }

          const isImage = /\.(png|jpg|jpeg|gif|svg|webp)$/i.test(friendlyName);
          const base64Content = buf.toString("base64");

          let fileId: number | null = null;
          try {
            const item = await (storage as any).addGalleryItem({
              userId,
              agentId,
              type: isImage ? "image" : "file",
              title: friendlyName,
              contentText: isImage ? base64Content : buf.toString("utf-8"),
              prompt: `Downloaded from sandbox: ${filePath}`,
              metadata: { filePath, filename: friendlyName, size: buf.length, source: "sandbox_download", isBase64: isImage },
            });
            fileId = item?.id || null;
          } catch { /* best-effort gallery save */ }

          if (fileId) {
            return `File ready for download: ${friendlyName}\n[Download ${friendlyName}](/api/files/${fileId}/download)`;
          }
          return `File read from sandbox but could not be saved for download. File size: ${buf.length} bytes.`;
        } catch (err: any) {
          return `sandbox_download failed: ${err?.message || String(err)}`;
        }
      }

      case "generate_document": {
        const format = toolInput.format;
        const title = toolInput.title;
        const content = toolInput.content;
        const styling = toolInput.styling || "";
        if (!format || !title || !content) return "Missing required fields: format, title, content.";

        try {
          const sbx = await sandboxManager.getOrCreate(userId);
          const outputPath = `/tmp/output.${format}`;
          let pythonCode = "";

          if (format === "pdf") {
            // Install packages
            await sbx.commands.run("pip install reportlab markdown2", { timeoutMs: 60_000 });
            // Escape content for Python triple-quoted string
            const escapedContent = content.replace(/\\/g, "\\\\").replace(/"""/g, '\\"\\"\\"');
            const escapedTitle = title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
            const escapedStyling = styling.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
            pythonCode = `
import markdown2
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
import re

content = """${escapedContent}"""
title = "${escapedTitle}"
styling_hint = "${escapedStyling}"

doc = SimpleDocTemplate("${outputPath}", pagesize=letter,
    topMargin=0.75*inch, bottomMargin=0.75*inch,
    leftMargin=0.75*inch, rightMargin=0.75*inch)

styles = getSampleStyleSheet()
styles.add(ParagraphStyle(name='DocTitle', parent=styles['Title'],
    fontSize=22, spaceAfter=20, textColor=colors.HexColor('#1a1a2e')))
styles.add(ParagraphStyle(name='DocHeading', parent=styles['Heading1'],
    fontSize=16, spaceAfter=10, spaceBefore=16, textColor=colors.HexColor('#16213e')))
styles.add(ParagraphStyle(name='DocHeading2', parent=styles['Heading2'],
    fontSize=13, spaceAfter=8, spaceBefore=12, textColor=colors.HexColor('#0f3460')))
styles.add(ParagraphStyle(name='DocBody', parent=styles['Normal'],
    fontSize=11, leading=15, spaceAfter=8))

story = []
story.append(Paragraph(title, styles['DocTitle']))
story.append(Spacer(1, 12))

lines = content.split('\\n')
for line in lines:
    stripped = line.strip()
    if not stripped:
        story.append(Spacer(1, 6))
    elif stripped.startswith('### '):
        story.append(Paragraph(stripped[4:], styles['DocHeading2']))
    elif stripped.startswith('## '):
        story.append(Paragraph(stripped[3:], styles['DocHeading']))
    elif stripped.startswith('# '):
        story.append(Paragraph(stripped[2:], styles['DocHeading']))
    elif stripped.startswith('- ') or stripped.startswith('* '):
        bullet_text = stripped[2:]
        story.append(Paragraph(f'\\u2022 {bullet_text}', styles['DocBody']))
    else:
        # Handle bold (**text**) and italic (*text*)
        text = re.sub(r'\\*\\*(.+?)\\*\\*', r'<b>\\1</b>', stripped)
        text = re.sub(r'\\*(.+?)\\*', r'<i>\\1</i>', text)
        story.append(Paragraph(text, styles['DocBody']))

doc.build(story)
print(f"PDF generated: ${outputPath}")
`;
          } else if (format === "docx") {
            await sbx.commands.run("pip install python-docx markdown2", { timeoutMs: 60_000 });
            const escapedContent = content.replace(/\\/g, "\\\\").replace(/"""/g, '\\"\\"\\"');
            const escapedTitle = title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
            pythonCode = `
from docx import Document
from docx.shared import Pt, Inches, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
import re

content = """${escapedContent}"""
title = "${escapedTitle}"

doc = Document()

# Style the document
style = doc.styles['Normal']
font = style.font
font.name = 'Calibri'
font.size = Pt(11)

# Title
title_para = doc.add_heading(title, level=0)
title_para.alignment = WD_ALIGN_PARAGRAPH.CENTER

lines = content.split('\\n')
for line in lines:
    stripped = line.strip()
    if not stripped:
        doc.add_paragraph('')
    elif stripped.startswith('### '):
        doc.add_heading(stripped[4:], level=3)
    elif stripped.startswith('## '):
        doc.add_heading(stripped[3:], level=2)
    elif stripped.startswith('# '):
        doc.add_heading(stripped[2:], level=1)
    elif stripped.startswith('- ') or stripped.startswith('* '):
        doc.add_paragraph(stripped[2:], style='List Bullet')
    elif re.match(r'^\\d+\\.\\s', stripped):
        text = re.sub(r'^\\d+\\.\\s', '', stripped)
        doc.add_paragraph(text, style='List Number')
    else:
        para = doc.add_paragraph()
        # Handle bold and italic
        parts = re.split(r'(\\*\\*.+?\\*\\*|\\*.+?\\*)', stripped)
        for part in parts:
            if part.startswith('**') and part.endswith('**'):
                run = para.add_run(part[2:-2])
                run.bold = True
            elif part.startswith('*') and part.endswith('*'):
                run = para.add_run(part[1:-1])
                run.italic = True
            else:
                para.add_run(part)

doc.save("${outputPath}")
print(f"DOCX generated: ${outputPath}")
`;
          } else if (format === "xlsx") {
            await sbx.commands.run("pip install openpyxl", { timeoutMs: 60_000 });
            const escapedContent = content.replace(/\\/g, "\\\\").replace(/"""/g, '\\"\\"\\"');
            const escapedTitle = title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
            pythonCode = `
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
import json

content_str = """${escapedContent}"""
title = "${escapedTitle}"

wb = Workbook()
ws = wb.active
ws.title = title[:31]  # Excel sheet name limit

# Styling
header_font = Font(name='Calibri', bold=True, size=12, color='FFFFFF')
header_fill = PatternFill(start_color='1a1a2e', end_color='1a1a2e', fill_type='solid')
cell_font = Font(name='Calibri', size=11)
thin_border = Border(
    left=Side(style='thin', color='cccccc'),
    right=Side(style='thin', color='cccccc'),
    top=Side(style='thin', color='cccccc'),
    bottom=Side(style='thin', color='cccccc')
)

try:
    data = json.loads(content_str)
    if isinstance(data, list) and len(data) > 0:
        # Get headers from first object
        if isinstance(data[0], dict):
            headers = list(data[0].keys())
        else:
            headers = [f"Column {i+1}" for i in range(len(data[0]))]

        # Write headers
        for col, header in enumerate(headers, 1):
            cell = ws.cell(row=1, column=col, value=str(header))
            cell.font = header_font
            cell.fill = header_fill
            cell.alignment = Alignment(horizontal='center')
            cell.border = thin_border

        # Write data
        for row_idx, row_data in enumerate(data, 2):
            if isinstance(row_data, dict):
                for col, header in enumerate(headers, 1):
                    cell = ws.cell(row=row_idx, column=col, value=row_data.get(header, ''))
                    cell.font = cell_font
                    cell.border = thin_border
            elif isinstance(row_data, list):
                for col, value in enumerate(row_data, 1):
                    cell = ws.cell(row=row_idx, column=col, value=value)
                    cell.font = cell_font
                    cell.border = thin_border

        # Auto-width columns
        for col in ws.columns:
            max_length = 0
            col_letter = col[0].column_letter
            for cell in col:
                if cell.value:
                    max_length = max(max_length, len(str(cell.value)))
            ws.column_dimensions[col_letter].width = min(max_length + 4, 50)
except (json.JSONDecodeError, TypeError):
    # Fallback: treat as plain text rows
    lines = content_str.strip().split('\\n')
    for row_idx, line in enumerate(lines, 1):
        cols = line.split('\\t') if '\\t' in line else line.split(',')
        for col_idx, value in enumerate(cols, 1):
            cell = ws.cell(row=row_idx, column=col_idx, value=value.strip())
            if row_idx == 1:
                cell.font = header_font
                cell.fill = header_fill
                cell.alignment = Alignment(horizontal='center')
            else:
                cell.font = cell_font
            cell.border = thin_border

wb.save("${outputPath}")
print(f"XLSX generated: ${outputPath}")
`;
          } else if (format === "zip") {
            const escapedContent = content.replace(/\\/g, "\\\\").replace(/"""/g, '\\"\\"\\"');
            pythonCode = `
import zipfile
import os

content = """${escapedContent}"""

# Create a temporary directory for files
os.makedirs("/tmp/zipproject", exist_ok=True)

# Parse content as file descriptions (format: "filename: content" per line or section)
sections = content.split('---')
files_created = []
for section in sections:
    section = section.strip()
    if not section:
        continue
    lines = section.split('\\n')
    if ':' in lines[0]:
        fname = lines[0].split(':')[0].strip()
        fcontent = '\\n'.join(lines[1:]).strip() if len(lines) > 1 else lines[0].split(':', 1)[1].strip()
    else:
        fname = lines[0].strip().replace(' ', '_') + '.txt'
        fcontent = '\\n'.join(lines[1:]).strip() if len(lines) > 1 else section
    fpath = os.path.join("/tmp/zipproject", fname)
    os.makedirs(os.path.dirname(fpath) if os.path.dirname(fpath) != '/tmp/zipproject' else '/tmp/zipproject', exist_ok=True)
    with open(fpath, 'w') as f:
        f.write(fcontent)
    files_created.append(fname)

# Create ZIP
with zipfile.ZipFile("${outputPath}", 'w', zipfile.ZIP_DEFLATED) as zf:
    for root, dirs, files in os.walk("/tmp/zipproject"):
        for file in files:
            file_path = os.path.join(root, file)
            arcname = os.path.relpath(file_path, "/tmp/zipproject")
            zf.write(file_path, arcname)

print(f"ZIP generated with {len(files_created)} files: {', '.join(files_created)}")
`;
          } else {
            return `Unsupported format: ${format}. Use pdf, docx, xlsx, or zip.`;
          }

          // Execute the Python code
          const execution = await sbx.runCode(pythonCode, { language: "python" as any });
          const stdout = execution.logs?.stdout?.join("\n") || "";
          const stderr = execution.logs?.stderr?.join("\n") || "";
          const error = execution.error;

          if (error) {
            return `Document generation failed: ${error.name}: ${error.value}\n${error.traceback}`;
          }

          // Read the output file as bytes
          const fileBytes = await sbx.files.read(outputPath, { format: "bytes" });
          const base64Content = Buffer.from(fileBytes).toString("base64");
          const filename = `${title.replace(/[^a-zA-Z0-9_\- ]/g, "").replace(/\s+/g, "_").slice(0, 80)}.${format}`;

          const mimeTypes: Record<string, string> = {
            pdf: "application/pdf",
            docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            zip: "application/zip",
          };

          // Save to gallery
          const item = await (storage as any).addGalleryItem({
            userId,
            agentId,
            type: "file",
            title: filename,
            contentText: base64Content,
            prompt: `${title}: ${content.slice(0, 200)}`,
            metadata: {
              filename,
              mimeType: mimeTypes[format] || "application/octet-stream",
              format,
              size: fileBytes.length,
              isBase64: true,
              source: "generate_document",
            },
          });

          // Save creation memory
          storage.createMemory({
            userId,
            agentId,
            content: `[Document generated] ${format.toUpperCase()}: ${title}`,
            type: "episodic",
            importance: 0.7,
            namespace: "_creations",
          }).catch(() => {});

          const downloadUrl = item?.id ? `/api/files/${item.id}/download` : null;
          return `Document generated: ${filename} (${(fileBytes.length / 1024).toFixed(1)} KB)${downloadUrl ? `\n[Download: ${filename}](${downloadUrl})` : ""}`;
        } catch (err: any) {
          await sandboxManager.kill(userId).catch(() => {});
          return `Document generation failed: ${err?.message || String(err)}`;
        }
      }

      case "convert_file": {
        const sourceText = toolInput.source_text;
        const sourceFormat = toolInput.source_format;
        const targetFormat = toolInput.target_format;
        const filename = toolInput.filename || "converted";
        if (!sourceText || !sourceFormat || !targetFormat) return "Missing required fields: source_text, source_format, target_format.";

        const supportedConversions: Record<string, string[]> = {
          csv: ["xlsx"],
          md: ["pdf", "docx"],
          json: ["xlsx"],
          txt: ["pdf"],
          html: ["pdf"],
        };
        if (!supportedConversions[sourceFormat]?.includes(targetFormat)) {
          return `Unsupported conversion: ${sourceFormat}→${targetFormat}. Supported: ${Object.entries(supportedConversions).map(([k, v]) => v.map(t => `${k}→${t}`).join(", ")).join(", ")}`;
        }

        try {
          const sbx = await sandboxManager.getOrCreate(userId);
          const outputPath = `/tmp/output.${targetFormat}`;
          const sourcePath = `/tmp/input.${sourceFormat}`;

          // Write source file to sandbox
          await sbx.files.write(sourcePath, sourceText);

          let pythonCode = "";

          if (sourceFormat === "csv" && targetFormat === "xlsx") {
            await sbx.commands.run("pip install openpyxl", { timeoutMs: 60_000 });
            pythonCode = `
import csv
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side

wb = Workbook()
ws = wb.active
ws.title = "Data"

header_font = Font(name='Calibri', bold=True, size=12, color='FFFFFF')
header_fill = PatternFill(start_color='1a1a2e', end_color='1a1a2e', fill_type='solid')
thin_border = Border(
    left=Side(style='thin', color='cccccc'), right=Side(style='thin', color='cccccc'),
    top=Side(style='thin', color='cccccc'), bottom=Side(style='thin', color='cccccc'))

with open("${sourcePath}", 'r') as f:
    reader = csv.reader(f)
    for row_idx, row in enumerate(reader, 1):
        for col_idx, value in enumerate(row, 1):
            cell = ws.cell(row=row_idx, column=col_idx, value=value)
            cell.border = thin_border
            if row_idx == 1:
                cell.font = header_font
                cell.fill = header_fill
                cell.alignment = Alignment(horizontal='center')

for col in ws.columns:
    max_length = max(len(str(cell.value or '')) for cell in col)
    ws.column_dimensions[col[0].column_letter].width = min(max_length + 4, 50)

wb.save("${outputPath}")
print("Converted CSV to XLSX")
`;
          } else if (sourceFormat === "json" && targetFormat === "xlsx") {
            await sbx.commands.run("pip install openpyxl", { timeoutMs: 60_000 });
            pythonCode = `
import json
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side

with open("${sourcePath}", 'r') as f:
    data = json.load(f)

wb = Workbook()
ws = wb.active
ws.title = "Data"

header_font = Font(name='Calibri', bold=True, size=12, color='FFFFFF')
header_fill = PatternFill(start_color='1a1a2e', end_color='1a1a2e', fill_type='solid')
thin_border = Border(
    left=Side(style='thin', color='cccccc'), right=Side(style='thin', color='cccccc'),
    top=Side(style='thin', color='cccccc'), bottom=Side(style='thin', color='cccccc'))

if isinstance(data, list) and len(data) > 0 and isinstance(data[0], dict):
    headers = list(data[0].keys())
    for col, h in enumerate(headers, 1):
        cell = ws.cell(row=1, column=col, value=h)
        cell.font = header_font
        cell.fill = header_fill
        cell.alignment = Alignment(horizontal='center')
        cell.border = thin_border
    for row_idx, item in enumerate(data, 2):
        for col, h in enumerate(headers, 1):
            cell = ws.cell(row=row_idx, column=col, value=item.get(h, ''))
            cell.border = thin_border

    for col in ws.columns:
        max_length = max(len(str(cell.value or '')) for cell in col)
        ws.column_dimensions[col[0].column_letter].width = min(max_length + 4, 50)

wb.save("${outputPath}")
print("Converted JSON to XLSX")
`;
          } else if ((sourceFormat === "md" || sourceFormat === "txt" || sourceFormat === "html") && targetFormat === "pdf") {
            await sbx.commands.run("pip install reportlab markdown2", { timeoutMs: 60_000 });
            pythonCode = `
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
import re

with open("${sourcePath}", 'r') as f:
    content = f.read()

doc = SimpleDocTemplate("${outputPath}", pagesize=letter,
    topMargin=0.75*inch, bottomMargin=0.75*inch,
    leftMargin=0.75*inch, rightMargin=0.75*inch)

styles = getSampleStyleSheet()
styles.add(ParagraphStyle(name='DocHeading', parent=styles['Heading1'],
    fontSize=16, spaceAfter=10, spaceBefore=16, textColor=colors.HexColor('#16213e')))
styles.add(ParagraphStyle(name='DocHeading2', parent=styles['Heading2'],
    fontSize=13, spaceAfter=8, spaceBefore=12, textColor=colors.HexColor('#0f3460')))
styles.add(ParagraphStyle(name='DocBody', parent=styles['Normal'],
    fontSize=11, leading=15, spaceAfter=8))

story = []
lines = content.split('\\n')
for line in lines:
    stripped = line.strip()
    if not stripped:
        story.append(Spacer(1, 6))
    elif stripped.startswith('### '):
        story.append(Paragraph(stripped[4:], styles['DocHeading2']))
    elif stripped.startswith('## '):
        story.append(Paragraph(stripped[3:], styles['DocHeading']))
    elif stripped.startswith('# '):
        story.append(Paragraph(stripped[2:], styles['DocHeading']))
    elif stripped.startswith('- ') or stripped.startswith('* '):
        story.append(Paragraph(f'\\u2022 {stripped[2:]}', styles['DocBody']))
    else:
        text = re.sub(r'\\*\\*(.+?)\\*\\*', r'<b>\\1</b>', stripped)
        text = re.sub(r'\\*(.+?)\\*', r'<i>\\1</i>', text)
        story.append(Paragraph(text, styles['DocBody']))

doc.build(story)
print("Converted to PDF")
`;
          } else if (sourceFormat === "md" && targetFormat === "docx") {
            await sbx.commands.run("pip install python-docx markdown2", { timeoutMs: 60_000 });
            pythonCode = `
from docx import Document
from docx.shared import Pt
import re

with open("${sourcePath}", 'r') as f:
    content = f.read()

doc = Document()
style = doc.styles['Normal']
style.font.name = 'Calibri'
style.font.size = Pt(11)

lines = content.split('\\n')
for line in lines:
    stripped = line.strip()
    if not stripped:
        doc.add_paragraph('')
    elif stripped.startswith('### '):
        doc.add_heading(stripped[4:], level=3)
    elif stripped.startswith('## '):
        doc.add_heading(stripped[3:], level=2)
    elif stripped.startswith('# '):
        doc.add_heading(stripped[2:], level=1)
    elif stripped.startswith('- ') or stripped.startswith('* '):
        doc.add_paragraph(stripped[2:], style='List Bullet')
    elif re.match(r'^\\d+\\.\\s', stripped):
        text = re.sub(r'^\\d+\\.\\s', '', stripped)
        doc.add_paragraph(text, style='List Number')
    else:
        para = doc.add_paragraph()
        parts = re.split(r'(\\*\\*.+?\\*\\*|\\*.+?\\*)', stripped)
        for part in parts:
            if part.startswith('**') and part.endswith('**'):
                run = para.add_run(part[2:-2])
                run.bold = True
            elif part.startswith('*') and part.endswith('*'):
                run = para.add_run(part[1:-1])
                run.italic = True
            else:
                para.add_run(part)

doc.save("${outputPath}")
print("Converted MD to DOCX")
`;
          } else {
            return `Conversion ${sourceFormat}→${targetFormat} is not implemented.`;
          }

          const execution = await sbx.runCode(pythonCode, { language: "python" as any });
          const error = execution.error;
          if (error) {
            return `File conversion failed: ${error.name}: ${error.value}\n${error.traceback}`;
          }

          const fileBytes = await sbx.files.read(outputPath, { format: "bytes" });
          const base64Content = Buffer.from(fileBytes).toString("base64");
          const outFilename = `${filename.replace(/[^a-zA-Z0-9_\- ]/g, "").replace(/\s+/g, "_").slice(0, 80)}.${targetFormat}`;

          const mimeTypes: Record<string, string> = {
            pdf: "application/pdf",
            docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          };

          const item = await (storage as any).addGalleryItem({
            userId,
            agentId,
            type: "file",
            title: outFilename,
            contentText: base64Content,
            prompt: `Converted ${sourceFormat}→${targetFormat}: ${filename}`,
            metadata: {
              filename: outFilename,
              mimeType: mimeTypes[targetFormat] || "application/octet-stream",
              format: targetFormat,
              size: fileBytes.length,
              isBase64: true,
              source: "convert_file",
              sourceFormat,
            },
          });

          storage.createMemory({
            userId,
            agentId,
            content: `[File converted] ${sourceFormat}→${targetFormat}: ${outFilename}`,
            type: "episodic",
            importance: 0.6,
            namespace: "_creations",
          }).catch(() => {});

          const downloadUrl = item?.id ? `/api/files/${item.id}/download` : null;
          return `File converted: ${outFilename} (${(fileBytes.length / 1024).toFixed(1)} KB)${downloadUrl ? `\n[Download: ${outFilename}](${downloadUrl})` : ""}`;
        } catch (err: any) {
          await sandboxManager.kill(userId).catch(() => {});
          return `File conversion failed: ${err?.message || String(err)}`;
        }
      }

      // ── Scheduling Tool Handlers ────────────────────────────────────────────
      case "set_reminder": {
        const { parseRelativeTime } = await import("./scheduler");
        const title = toolInput.title || "Reminder";
        const message = toolInput.message || title;
        const when = toolInput.when;
        const tz = toolInput.timezone || "UTC";

        if (!when) return "Please specify when the reminder should trigger.";

        const scheduledAt = parseRelativeTime(when, tz);
        if (!scheduledAt) return `Could not parse time "${when}". Try formats like "in 2 hours", "tomorrow 9am", or an ISO date.`;

        // Find a room for this user/agent to post to
        const rooms = await pool.query(
          `SELECT id FROM rooms WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
          [userId]
        );
        const roomId = rooms.rows[0]?.id || null;

        const task = await storage.createScheduledTask({
          userId,
          agentId,
          roomId,
          title,
          description: message,
          taskType: "reminder",
          scheduledAt,
          nextRunAt: scheduledAt,
          timezone: tz,
          actionType: "message",
          actionPayload: JSON.stringify({ message }),
        });

        const d = new Date(scheduledAt);
        const formatted = d.toLocaleString("en-US", { timeZone: tz !== "UTC" ? tz : undefined });
        return `Reminder set: "${title}" at ${formatted} (ID: ${task.id})`;
      }

      case "schedule_task": {
        const { naturalLanguageToCron, calculateNextRun } = await import("./scheduler");
        const title = toolInput.title || "Scheduled Task";
        const description = toolInput.description || title;
        const schedule = toolInput.schedule;
        const actionType = toolInput.action_type || "message";
        const actionPayload = toolInput.action_payload || JSON.stringify({ message: description });
        const tz = toolInput.timezone || "UTC";
        const maxRuns = toolInput.max_runs || null;

        if (!schedule) return "Please specify a schedule (e.g., 'every day at 9am', 'every Monday').";

        const cronExpr = naturalLanguageToCron(schedule);
        if (!cronExpr) return `Could not parse schedule "${schedule}". Try "every day at 9am", "every Monday", "hourly", or a cron expression like "0 9 * * *".`;

        const nextRunAt = calculateNextRun(cronExpr, tz);

        const rooms = await pool.query(
          `SELECT id FROM rooms WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
          [userId]
        );
        const roomId = rooms.rows[0]?.id || null;

        const task = await storage.createScheduledTask({
          userId,
          agentId,
          roomId,
          title,
          description,
          taskType: "recurring",
          cronExpression: cronExpr,
          nextRunAt,
          timezone: tz,
          maxRuns,
          actionType,
          actionPayload,
        });

        const nextDate = new Date(nextRunAt).toLocaleString("en-US", { timeZone: tz !== "UTC" ? tz : undefined });
        return `Task scheduled: "${title}" (${cronExpr})\nAction: ${actionType}\nNext run: ${nextDate}\nID: ${task.id}`;
      }

      case "list_tasks": {
        const statusFilter = toolInput.status || "active";
        const allTasks = await storage.getScheduledTasks(userId);
        const tasks = statusFilter === "all"
          ? allTasks
          : allTasks.filter((t: any) => t.status === statusFilter);

        if (tasks.length === 0) return `No ${statusFilter === "all" ? "" : statusFilter + " "}tasks found.`;

        const lines = tasks.map((t: any) => {
          const nextRun = t.nextRunAt ? new Date(t.nextRunAt).toLocaleString("en-US") : "—";
          const status = t.status.charAt(0).toUpperCase() + t.status.slice(1);
          return `- **${t.title}** (ID: ${t.id})\n  Type: ${t.taskType} | Status: ${status} | Runs: ${t.runCount}${t.maxRuns ? `/${t.maxRuns}` : ""}\n  Next: ${nextRun}`;
        });

        return `**Scheduled Tasks (${statusFilter})**\n\n${lines.join("\n\n")}`;
      }

      case "delegate_task": {
        const objective = toolInput.objective;
        if (!objective) return "No objective provided.";

        try {
          const { runSubAgent } = await import("./sub-agent");
          const toolDefs = partnerTools
            .filter(t => t.name !== "delegate_task" && t.name !== "delegate_parallel")
            .map(t => ({ name: t.name, description: t.description || "", input_schema: (t as any).input_schema }));
          const result = await runSubAgent(
            { objective, tools: toolInput.tools },
            userId,
            agentId,
            executePartnerTool,
            toolDefs
          );
          return `[Sub-agent completed] (${result.iterations} iteration${result.iterations !== 1 ? "s" : ""}, tools used: ${result.toolsUsed.join(", ") || "none"})\n\n${result.result}`;
        } catch (err: any) {
          return `Sub-agent failed: ${err.message || String(err)}`;
        }
      }

      case "delegate_parallel": {
        const tasks = toolInput.tasks;
        if (!tasks || !Array.isArray(tasks) || tasks.length === 0) return "No tasks provided.";
        if (tasks.length > 5) return "Maximum 5 parallel tasks allowed.";

        try {
          const { runSubAgent } = await import("./sub-agent");
          const toolDefs = partnerTools
            .filter(t => t.name !== "delegate_task" && t.name !== "delegate_parallel")
            .map(t => ({ name: t.name, description: t.description || "", input_schema: (t as any).input_schema }));

          const promises = tasks.map((t: any, i: number) =>
            runSubAgent(
              { objective: t.objective, tools: t.tools },
              userId,
              agentId,
              executePartnerTool,
              toolDefs
            ).then(result => ({
              taskIndex: i + 1,
              objective: t.objective.slice(0, 100),
              ...result
            })).catch(err => ({
              taskIndex: i + 1,
              objective: t.objective.slice(0, 100),
              success: false,
              result: `Error: ${err.message || String(err)}`,
              toolsUsed: [] as string[],
              iterations: 0
            }))
          );

          const results = await Promise.all(promises);

          let response = `[Parallel sub-agents completed: ${results.length} tasks]\n\n`;
          for (const r of results) {
            response += `--- Task ${r.taskIndex}: ${r.objective}...\n`;
            response += `Status: ${r.success ? 'OK' : 'FAILED'} | Iterations: ${r.iterations} | Tools: ${r.toolsUsed?.join(', ') || 'none'}\n`;
            response += `${r.result}\n\n`;
          }
          return response;
        } catch (err: any) {
          return `Parallel delegation failed: ${err.message || String(err)}`;
        }
      }

      case "browse_website": {
        const url = toolInput.url;
        if (!url || typeof url !== "string") return "No URL provided.";
        // SECURITY: validate URL to prevent SSRF via browser sandbox
        try {
          await validateUrl(url);
        } catch (e: any) {
          return `URL blocked: ${e.message}`;
        }

        try {
          const { browseWebsite } = await import("./browser-agent");
          const sbx = await sandboxManager.getOrCreate(userId);
          const result = await browseWebsite(
            {
              url,
              action: toolInput.action || "extract_text",
              selector: toolInput.selector,
              waitFor: toolInput.waitFor,
              instructions: toolInput.instructions,
              timeout: 15000,
            },
            sbx
          );

          if (!result.success) {
            return `Browser error: ${result.error || "Unknown error"}`;
          }

          let response = `[Browser] Page: ${result.title || "Unknown"}\nURL: ${result.url || url}\n`;
          if (result.text) response += `\nContent:\n${result.text}`;
          if (result.screenshot && (toolInput.action === "screenshot")) {
            try {
              const { analyzeScreenshot } = await import("./browser-agent");
              const description = await analyzeScreenshot(result.screenshot);
              response += `\nVisual analysis:\n${description}`;
            } catch {}
          } else if (result.screenshot) {
            response += `\n[Screenshot captured]`;
          }
          return response;
        } catch (err: any) {
          return `Browser failed: ${err?.message || String(err)}`;
        }
      }

      case "generate_video": {
        const prompt = toolInput.prompt;
        if (!prompt || typeof prompt !== "string") return "Missing required field: prompt.";
        const aspectRatio = toolInput.aspect_ratio || "16:9";
        const duration = toolInput.duration || 8;
        const quality = toolInput.quality === "high" ? "quality" : "fast"; // default: fast (cheaper)

        const kieKey = process.env.KIE_API_KEY;
        const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_KEY;

        if (!kieKey && !geminiKey) {
          return "Video generation requires KIE_API_KEY or GEMINI_API_KEY. Please ask the admin to configure one.";
        }

        // ===== PATH 1: kie.ai (primary — works today, cheapest, no tier limits) =====
        if (kieKey) {
          try {
            const model = quality === "quality" ? "veo3" : "veo3_fast";
            const startResp = await fetch("https://api.kie.ai/api/v1/veo/generate", {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${kieKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                prompt: prompt.slice(0, 2000),
                model,
                aspect_ratio: aspectRatio,
                generationType: "TEXT_2_VIDEO",
                enableFallback: true,
              }),
              signal: AbortSignal.timeout(30000),
            });

            if (!startResp.ok) {
              const errText = (await startResp.text()).slice(0, 200);
              console.warn(`[generate_video] kie.ai start failed: ${errText}`);
              // Fall through to Google path
            } else {
              const startData = await startResp.json() as any;
              if (startData.code !== 200 || !startData.data?.taskId) {
                console.warn(`[generate_video] kie.ai returned no taskId: ${JSON.stringify(startData).slice(0, 200)}`);
              } else {
                const taskId = startData.data.taskId;
                // Poll for completion (max 3 min, 5s intervals)
                for (let attempt = 0; attempt < 36; attempt++) {
                  await new Promise(r => setTimeout(r, 5000));
                  const pollResp = await fetch(
                    `https://api.kie.ai/api/v1/veo/record-info?taskId=${encodeURIComponent(taskId)}`,
                    { headers: { "Authorization": `Bearer ${kieKey}` }, signal: AbortSignal.timeout(10000) }
                  );
                  if (!pollResp.ok) continue;
                  const pollData = await pollResp.json() as any;
                  const d = pollData.data;
                  if (!d) continue;
                  if (d.successFlag === 1) {
                    const url = d.response?.resultUrls?.[0] || d.response?.fullResultUrls?.[0];
                    if (url) {
                      const label = quality === "quality" ? "Veo 3 Quality" : "Veo 3 Fast";
                      return `[Video generated via ${label} — kie.ai] ${url}`;
                    }
                  }
                  if (d.successFlag === 2 || d.errorCode) {
                    console.warn(`[generate_video] kie.ai task failed: ${d.errorMessage || d.errorCode}`);
                    break; // fall through to Google
                  }
                }
              }
            }
          } catch (err: any) {
            console.warn(`[generate_video] kie.ai exception: ${err?.message}`);
            // Fall through to Google path
          }
        }

        // ===== PATH 2: Google AI Studio direct (fallback when kie.ai unavailable or fails) =====
        if (!geminiKey) {
          return "Video generation failed on kie.ai and no Google fallback configured.";
        }

        try {
          // Model cascade: Veo 3.1 preview → Veo 3.0 fast → Veo 3.0 stable → Veo 2.0
          const modelCascade = [
            { id: "veo-3.1-generate-preview", label: "Veo 3.1" },
            { id: "veo-3.0-fast-generate-001", label: "Veo 3.0 Fast" },
            { id: "veo-3.0-generate-001", label: "Veo 3.0" },
            { id: "veo-2.0-generate-001", label: "Veo 2.0 (silent)" },
          ];
          const clampedDuration = Math.max(4, Math.min(duration, 8));

          let startResp: Response | null = null;
          let modelUsed = "";
          let lastErr = "";
          let billingBlocked = false;
          for (const model of modelCascade) {
            const veoUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model.id}:predictLongRunning?key=${geminiKey}`;
            const veoPayload: any = {
              instances: [{ prompt: prompt.slice(0, 2000) }],
              parameters: {
                aspectRatio,
                durationSeconds: clampedDuration,
              },
            };
            const resp = await fetch(veoUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(veoPayload),
              signal: AbortSignal.timeout(30000),
            });
            if (resp.ok) {
              startResp = resp;
              modelUsed = model.label;
              break;
            }
            const errText = (await resp.text()).slice(0, 200);
            lastErr = `${model.id}: ${errText}`;
            if (errText.includes("RESOURCE_EXHAUSTED") || errText.includes("billing")) {
              billingBlocked = true;
              break;
            }
          }

          if (!startResp) {
            if (billingBlocked) {
              return `Video generation unavailable: Google Veo 3 requires Paid Tier 2 ($100 spent + 3 days since first payment). kie.ai path also failed or not configured. Last error: ${lastErr.slice(0, 150)}`;
            }
            return `Video generation failed across all paths. Last error: ${lastErr.slice(0, 300)}`;
          }

          const opData = await startResp.json() as any;
          const operationName = opData.name;

          if (!operationName) {
            const videoData = opData?.response?.generateVideoResponse?.generatedSamples?.[0]?.video;
            if (videoData?.uri) return `[Video generated via ${modelUsed}] ${videoData.uri}`;
            return "Video generation started but no operation ID returned.";
          }

          const pollUrl = `https://generativelanguage.googleapis.com/v1beta/${operationName}?key=${geminiKey}`;
          for (let attempt = 0; attempt < 24; attempt++) {
            await new Promise(r => setTimeout(r, 5000));
            const pollResp = await fetch(pollUrl, { signal: AbortSignal.timeout(10000) });
            if (!pollResp.ok) continue;
            const pollData = await pollResp.json() as any;
            if (pollData.done) {
              const video = pollData.response?.generateVideoResponse?.generatedSamples?.[0]?.video;
              if (video?.uri) return `[Video generated via ${modelUsed}] ${video.uri}`;
              return "Video generation completed but no video URL returned.";
            }
          }
          return "Video generation timed out after 2 minutes.";
        } catch (err: any) {
          return `Video generation failed: ${err?.message || String(err)}`;
        }
      }

      case "generate_speech": {
        const text = toolInput.text;
        if (!text || typeof text !== "string") return "Missing required field: text.";
        const voice = toolInput.voice || "";
        const instructions = toolInput.instructions || "";
        const speed = Math.max(0.25, Math.min(4.0, toolInput.speed || 1.0));
        const model = toolInput.model || "auto"; // auto | elevenlabs | openai

        const elKey = process.env.ELEVENLABS_API_KEY;
        const oaiKey = process.env.OPENAI_API_KEY;

        // ElevenLabs voice IDs (defaults — can be overridden by passing voice_id)
        // These are pre-made voices available on all plans. Users can pass cloned voice IDs.
        const elDefaultVoices: Record<string, string> = {
          george: "JBFqnCBsd6RMkjVDRZzb",   // warm storyteller
          sarah: "EXAVITQu4vr4xnSDxMaL",    // mature, confident
          charlie: "IKne3meq5aSn9XLyUdCD",  // deep, energetic
          laura: "FGY2WhTYpPnrIDTdsKH5",    // enthusiastic
          roger: "CwhRBWXzGAHq8TQ4Fs17",   // laid-back
        };

        // Resolve voice — if it's a 20-char ElevenLabs ID, use as-is; if it's a name, map it
        const isElevenLabsId = typeof voice === "string" && /^[a-zA-Z0-9]{18,24}$/.test(voice);
        const elVoiceId = isElevenLabsId
          ? voice
          : elDefaultVoices[voice?.toLowerCase?.()] || elDefaultVoices.george;

        // ===== PATH 1: ElevenLabs (primary — higher quality, supports cloned voices) =====
        if (elKey && model !== "openai") {
          try {
            const resp = await fetch(
              `https://api.elevenlabs.io/v1/text-to-speech/${elVoiceId}`,
              {
                method: "POST",
                headers: {
                  "xi-api-key": elKey,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  text: text.slice(0, 5000),
                  model_id: "eleven_multilingual_v2", // supports Russian, English, 29 langs
                  voice_settings: {
                    stability: 0.5,
                    similarity_boost: 0.75,
                    style: 0.0,
                    use_speaker_boost: true,
                  },
                }),
                signal: AbortSignal.timeout(60000),
              }
            );

            if (resp.ok) {
              const buffer = Buffer.from(await resp.arrayBuffer());
              const b64 = buffer.toString("base64");
              return `[Audio generated via ElevenLabs] data:audio/mp3;base64,${b64}`;
            }
            const errText = (await resp.text()).slice(0, 200);
            console.warn(`[generate_speech] ElevenLabs failed: ${errText}, falling back to OpenAI`);
            if (model === "elevenlabs") {
              return `ElevenLabs TTS failed: ${errText}`;
            }
          } catch (err: any) {
            console.warn(`[generate_speech] ElevenLabs exception: ${err?.message}`);
            if (model === "elevenlabs") {
              return `ElevenLabs TTS error: ${err?.message}`;
            }
          }
        }

        // ===== PATH 2: OpenAI TTS (fallback) =====
        if (!oaiKey) {
          return "Speech generation requires ELEVENLABS_API_KEY or OPENAI_API_KEY.";
        }

        try {
          const openaiVoice = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"].includes(voice)
            ? voice
            : "coral";
          const response = await withOpenAIBreaker((oaiClient) => oaiClient.audio.speech.create({
            model: "gpt-4o-mini-tts",
            voice: openaiVoice as any,
            input: text.slice(0, 4096),
            instructions: instructions || undefined,
            speed,
            response_format: "mp3",
          } as any));

          const buffer = Buffer.from(await response.arrayBuffer());
          const b64 = buffer.toString("base64");
          return `[Audio generated via OpenAI TTS] data:audio/mp3;base64,${b64}`;
        } catch (err: any) {
          if (isCircuitOpenError(err)) {
            logger.warn({ component: "deliberation", event: "degraded_tool", tool: "generate_speech" }, "[deliberation] breaker open");
            return "Speech generation temporarily unavailable. Try again in ~30s or set ELEVENLABS_API_KEY.";
          }
          return `Speech generation failed: ${err?.message || String(err)}`;
        }
      }

      case "clone_voice": {
        // Clone a voice from a reference audio URL. Returns a voice_id to use in generate_speech.
        const audioUrl = toolInput.audio_url;
        const name = toolInput.name;
        const description = toolInput.description || "";
        if (!audioUrl || typeof audioUrl !== "string") return "Missing required field: audio_url (URL to a 30s-3min sample).";
        if (!name || typeof name !== "string") return "Missing required field: name (how to identify the voice later).";

        const elKey = process.env.ELEVENLABS_API_KEY;
        if (!elKey) return "Voice cloning requires ELEVENLABS_API_KEY.";

        try {
          // Download the reference audio
          const audioResp = await fetch(audioUrl, { signal: AbortSignal.timeout(60000) });
          if (!audioResp.ok) return `Failed to download reference audio from ${audioUrl}: ${audioResp.status}`;
          const audioBuffer = Buffer.from(await audioResp.arrayBuffer());

          // Upload to ElevenLabs
          const form = new FormData();
          form.append("name", name.slice(0, 100));
          form.append("description", description.slice(0, 500));
          const blob = new Blob([new Uint8Array(audioBuffer)], { type: "audio/mpeg" });
          form.append("files", blob, `${name}.mp3`);

          const resp = await fetch("https://api.elevenlabs.io/v1/voices/add", {
            method: "POST",
            headers: { "xi-api-key": elKey },
            body: form,
            signal: AbortSignal.timeout(120000),
          });
          if (!resp.ok) {
            return `Voice cloning failed: ${(await resp.text()).slice(0, 300)}`;
          }
          const data = await resp.json() as any;
          return `[Voice cloned] name="${name}" voice_id=${data.voice_id}. Use this voice_id in generate_speech to produce audio in this voice.`;
        } catch (err: any) {
          return `Voice cloning failed: ${err?.message || String(err)}`;
        }
      }

      case "generate_sfx": {
        // Generate sound effects (footsteps, doors, ambience, etc.) using ElevenLabs
        const prompt = toolInput.prompt;
        if (!prompt || typeof prompt !== "string") return "Missing required field: prompt (describe the sound).";
        const durationSeconds = Math.max(0.5, Math.min(22, toolInput.duration || 5));

        const elKey = process.env.ELEVENLABS_API_KEY;
        if (!elKey) return "Sound effect generation requires ELEVENLABS_API_KEY.";

        try {
          const resp = await fetch("https://api.elevenlabs.io/v1/sound-generation", {
            method: "POST",
            headers: {
              "xi-api-key": elKey,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              text: prompt.slice(0, 500),
              duration_seconds: durationSeconds,
              prompt_influence: 0.3,
            }),
            signal: AbortSignal.timeout(60000),
          });

          if (!resp.ok) {
            return `SFX generation failed: ${(await resp.text()).slice(0, 300)}`;
          }
          const buffer = Buffer.from(await resp.arrayBuffer());
          const b64 = buffer.toString("base64");
          return `[SFX generated via ElevenLabs] data:audio/mp3;base64,${b64}`;
        } catch (err: any) {
          return `SFX generation failed: ${err?.message || String(err)}`;
        }
      }

      case "generate_music": {
        const prompt = toolInput.prompt;
        if (!prompt || typeof prompt !== "string") return "Missing required field: prompt.";
        const duration = toolInput.duration || "short";

        const kieKey = process.env.KIE_API_KEY;
        const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_KEY;

        // ===== PATH 1: kie.ai Suno V3.5 (primary — works today, poll-based) =====
        if (kieKey) {
          try {
            const startResp = await fetch("https://api.kie.ai/api/v1/generate", {
              method: "POST",
              headers: { "Authorization": `Bearer ${kieKey}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                prompt: prompt.slice(0, 2000),
                customMode: false,
                instrumental: true,
                model: "V3_5",
                // callBackUrl required field but we poll — point at our own /health as a no-op
                callBackUrl: "https://kioku-production.up.railway.app/health",
              }),
              signal: AbortSignal.timeout(30000),
            });
            if (startResp.ok) {
              const startData = await startResp.json() as any;
              if (startData.code === 200 && startData.data?.taskId) {
                const taskId = startData.data.taskId;
                // Poll up to 3 min for music (Suno typically 30-90 sec)
                for (let attempt = 0; attempt < 36; attempt++) {
                  await new Promise(r => setTimeout(r, 5000));
                  const pollResp = await fetch(
                    `https://api.kie.ai/api/v1/generate/record-info?taskId=${encodeURIComponent(taskId)}`,
                    { headers: { "Authorization": `Bearer ${kieKey}` }, signal: AbortSignal.timeout(10000) }
                  );
                  if (!pollResp.ok) continue;
                  const pollData = await pollResp.json() as any;
                  const d = pollData.data;
                  if (!d) continue;
                  if (d.status === "SUCCESS" || d.status === "FIRST_SUCCESS") {
                    const track = d.response?.sunoData?.[0];
                    const audioUrl = track?.audioUrl || track?.streamAudioUrl;
                    if (audioUrl) {
                      const title = track?.title || "Generated Track";
                      const dur = track?.duration ? ` (${Math.round(track.duration)}s)` : "";
                      return `[Music generated via Suno V3.5 — kie.ai]${dur} ${audioUrl}\nTitle: ${title}`;
                    }
                  }
                  if (/FAILED|ERROR/i.test(d.status || "")) {
                    console.warn(`[generate_music] kie.ai Suno failed: ${d.status}`);
                    break; // fall through to Lyria
                  }
                }
              }
            } else {
              const errText = (await startResp.text()).slice(0, 200);
              console.warn(`[generate_music] kie.ai Suno start failed: ${errText}`);
            }
          } catch (err: any) {
            console.warn(`[generate_music] kie.ai Suno exception: ${err?.message}`);
          }
        }

        // ===== PATH 2: Google Lyria (fallback) =====
        if (!geminiKey) return "Music generation requires KIE_API_KEY or GEMINI_API_KEY.";

        try {
          // Use Lyria 3: clip (30s) or pro (up to 3min)
          const model = duration === "long" ? "lyria-3-pro-preview" : "lyria-3-clip-preview";
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`;

          const resp = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt.slice(0, 3000) }] }],
            }),
            signal: AbortSignal.timeout(180000), // 3 min timeout for long tracks
          });

          if (!resp.ok) {
            const err = await resp.text();
            return `Music generation failed (${resp.status}): ${err.slice(0, 300)}`;
          }

          const data = await resp.json() as any;
          const parts = data?.candidates?.[0]?.content?.parts || [];

          // Find the audio part
          const audioPart = parts.find((p: any) => p.inlineData?.mimeType?.startsWith("audio/"));
          const textPart = parts.find((p: any) => p.text);

          if (audioPart?.inlineData?.data) {
            const mime = audioPart.inlineData.mimeType || "audio/mp3";
            const caption = textPart?.text?.slice(0, 200) || "";
            return `[Audio generated] data:${mime};base64,${audioPart.inlineData.data}${caption ? "\n" + caption : ""}`;
          }

          // Text-only response (model might describe what it would create)
          if (textPart?.text) {
            return `Music model responded with text only (no audio generated): ${textPart.text.slice(0, 500)}. The Lyria 3 model may not be available for this API key.`;
          }

          return "Music generation returned no audio content. Check Lyria 3 API access.";
        } catch (err: any) {
          return `Music generation failed: ${err?.message || String(err)}`;
        }
      }

      case "stitch_media": {
        const urls = toolInput.urls;
        if (!Array.isArray(urls) || urls.length < 2) return "Need at least 2 URLs to stitch media.";
        if (urls.length > 20) return "Maximum 20 media files per stitch operation.";
        const outputFormat = toolInput.output_format || "mp4";

        try {
          const { execSync } = await import("child_process");
          const fs = await import("fs");
          const path = await import("path");
          const os = await import("os");

          const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "stitch-"));
          const listFile = path.join(tmpDir, "filelist.txt");
          const outputFile = path.join(tmpDir, `output.${outputFormat}`);

          // Download all media files
          const downloaded: string[] = [];
          for (let i = 0; i < urls.length; i++) {
            const url = urls[i];
            const ext = outputFormat === "mp4" ? "mp4" : outputFormat;
            const filePath = path.join(tmpDir, `part_${i}.${ext}`);

            // Handle data: URIs
            if (url.startsWith("data:")) {
              const b64Match = url.match(/^data:[^;]+;base64,(.+)$/);
              if (b64Match) {
                fs.writeFileSync(filePath, Buffer.from(b64Match[1], "base64"));
                downloaded.push(filePath);
                continue;
              }
            }

            // Download from URL
            const resp = await fetch(url, { signal: AbortSignal.timeout(60000) });
            if (!resp.ok) return `Failed to download media #${i + 1}: HTTP ${resp.status}`;
            const buf = Buffer.from(await resp.arrayBuffer());
            fs.writeFileSync(filePath, buf);
            downloaded.push(filePath);
          }

          // Create ffmpeg concat file list
          const fileListContent = downloaded.map(f => `file '${f}'`).join("\n");
          fs.writeFileSync(listFile, fileListContent);

          // Run ffmpeg concat. IMPORTANT: route stderr to file (not merged to stdout),
          // else execSync's default 1MB pipe buffer overflows (ENOBUFS) for large outputs.
          const stderrFile = path.join(tmpDir, "ffmpeg.log");
          const ffmpegCmd = outputFormat === "mp4"
            ? `ffmpeg -y -f concat -safe 0 -i "${listFile}" -c:v libx264 -c:a aac -movflags +faststart "${outputFile}" 2>"${stderrFile}"`
            : `ffmpeg -y -f concat -safe 0 -i "${listFile}" -c:a libmp3lame -q:a 2 "${outputFile}" 2>"${stderrFile}"`;
          try {
            execSync(ffmpegCmd, { timeout: 120000, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
          } catch (e: any) {
            let tail = "";
            try { tail = fs.readFileSync(stderrFile, "utf8").slice(-1000); } catch {}
            return `Media stitching failed: ${(e?.message || String(e)).slice(0, 200)}. ffmpeg_tail: ${tail}`;
          }

          if (!fs.existsSync(outputFile)) {
            return "FFmpeg completed but output file not found.";
          }

          // Read output and convert to base64
          const outBuf = fs.readFileSync(outputFile);
          const outB64 = outBuf.toString("base64");
          const mime = outputFormat === "mp4" ? "video/mp4" : outputFormat === "wav" ? "audio/wav" : "audio/mp3";

          // Cleanup
          try { fs.rmSync(tmpDir, { recursive: true }); } catch {}

          if (mime.startsWith("video/")) {
            return `[Video generated] data:${mime};base64,${outB64}`;
          }
          return `[Audio generated] data:${mime};base64,${outB64}`;
        } catch (err: any) {
          return `Media stitching failed: ${err?.message || String(err)}`;
        }
      }

      case "reframe_vertical": {
        const source = toolInput.url;
        if (!source || typeof source !== "string") return "Missing required field: url.";
        const mode = (toolInput.mode === "crop" ? "crop" : "blur_bg") as "crop" | "blur_bg";
        const targetW = Math.max(64, Math.floor(Number(toolInput.target_width) || 1080));
        const targetH = Math.max(64, Math.floor(Number(toolInput.target_height) || 1920));

        try {
          const { execSync } = await import("child_process");
          const fs = await import("fs");
          const path = await import("path");
          const os = await import("os");

          const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "reframe-"));
          const inputPath = path.join(tmpDir, "input.mp4");
          const outPath = path.join(tmpDir, "output.mp4");
          const stderrFile = path.join(tmpDir, "ffmpeg.log");

          // Download source (supports https or data: URI)
          if (source.startsWith("data:")) {
            const m = source.match(/^data:[^;]+;base64,(.+)$/);
            if (!m) return "Malformed data URI.";
            fs.writeFileSync(inputPath, Buffer.from(m[1], "base64"));
          } else {
            const resp = await fetch(source, { signal: AbortSignal.timeout(90000) });
            if (!resp.ok) return `Failed to download source: HTTP ${resp.status}`;
            fs.writeFileSync(inputPath, Buffer.from(await resp.arrayBuffer()));
          }

          // Build filter. crop = smart center crop; blur_bg = fit with blurred bg behind.
          const vfCrop = `crop='min(iw,ih*${targetW}/${targetH})':'min(ih,iw*${targetH}/${targetW})',scale=${targetW}:${targetH}`;
          const fc = mode === "crop"
            ? `-vf "${vfCrop}"`
            : `-filter_complex "[0:v]scale=${targetW}:${targetH}:force_original_aspect_ratio=increase,crop=${targetW}:${targetH},boxblur=20:5[bg];[0:v]scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2"`;

          const cmd = `ffmpeg -y -i "${inputPath}" ${fc} -c:v libx264 -pix_fmt yuv420p -c:a copy -movflags +faststart "${outPath}" 2>"${stderrFile}"`;
          try {
            execSync(cmd, { timeout: 180000, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 });
          } catch (e: any) {
            let tail = "";
            try { tail = fs.readFileSync(stderrFile, "utf8").slice(-1000); } catch {}
            // Retry without audio if audio copy failed (some sources have no audio stream)
            const cmdNoAudio = `ffmpeg -y -i "${inputPath}" ${fc} -c:v libx264 -pix_fmt yuv420p -an -movflags +faststart "${outPath}" 2>"${stderrFile}"`;
            try {
              execSync(cmdNoAudio, { timeout: 180000, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 });
            } catch (e2: any) {
              try { tail = fs.readFileSync(stderrFile, "utf8").slice(-1000); } catch {}
              return `Reframe failed: ${(e2?.message || String(e2)).slice(0, 200)}. ffmpeg_tail: ${tail}`;
            }
          }

          if (!fs.existsSync(outPath)) return "Reframe completed but output file not found.";
          const outBuf = fs.readFileSync(outPath);
          const b64 = outBuf.toString("base64");
          try { fs.rmSync(tmpDir, { recursive: true }); } catch {}

          return `[Vertical ${targetW}x${targetH} ${mode}] data:video/mp4;base64,${b64}`;
        } catch (err: any) {
          return `Reframe failed: ${err?.message || String(err)}`;
        }
      }

      case "series_bible": {
        const action = toolInput.action;
        const seriesName = toolInput.series_name;
        if (!action || !seriesName) return "Missing required fields: action, series_name.";
        const ns = `_series_bible:${seriesName}`;

        if (action === "get") {
          const r = await pool.query(
            `SELECT content, created_at FROM memories WHERE user_id = $1 AND namespace = $2 ORDER BY created_at DESC LIMIT 1`,
            [userId, ns]
          );
          if (r.rows.length === 0) return `No series bible found for "${seriesName}". Use action=create first.`;
          return `[SERIES BIBLE — ${seriesName}]\n${r.rows[0].content}`;
        }

        const bible = {
          series_name: seriesName,
          logline: toolInput.logline || "",
          genre: toolInput.genre || "",
          tone: toolInput.tone || "",
          visual_style: toolInput.visual_style || "",
          characters: toolInput.characters || [],
          setting: toolInput.setting || "",
          season_arc: toolInput.season_arc || "",
          episode_length_sec: toolInput.episode_length_sec || 60,
          updated_at: new Date().toISOString(),
        };

        if (action === "update") {
          const existing = await pool.query(
            `SELECT content FROM memories WHERE user_id = $1 AND namespace = $2 ORDER BY created_at DESC LIMIT 1`,
            [userId, ns]
          );
          if (existing.rows.length > 0) {
            try {
              const prev = JSON.parse(existing.rows[0].content.replace(/^\[SERIES BIBLE\][^{]*/, ""));
              Object.keys(bible).forEach(k => {
                if (!bible[k as keyof typeof bible] || (Array.isArray(bible[k as keyof typeof bible]) && (bible[k as keyof typeof bible] as any[]).length === 0)) {
                  (bible as any)[k] = prev[k];
                }
              });
            } catch { /* ignore parse errors */ }
          }
          // Delete old version
          await pool.query(`DELETE FROM memories WHERE user_id = $1 AND namespace = $2`, [userId, ns]);
        }

        await storage.createMemory({
          userId,
          agentId,
          content: `[SERIES BIBLE] ${JSON.stringify(bible, null, 2)}`,
          type: "fact",
          importance: 0.95,
          namespace: ns,
          decayRate: 0,
        });

        return `Series bible ${action === "create" ? "created" : "updated"} for "${seriesName}". Characters: ${bible.characters.length}. Use series_bible(action=get, series_name="${seriesName}") to recall.`;
      }

      case "generate_image_to_video": {
        const imageUrl = toolInput.image_url;
        const motionPrompt = toolInput.motion_prompt;
        if (!imageUrl || !motionPrompt) return "Missing required fields: image_url, motion_prompt.";
        const duration = Math.max(5, Math.min(8, toolInput.duration || 5));
        const aspectRatio = toolInput.aspect_ratio || "9:16";

        const kieKey = process.env.KIE_API_KEY;
        if (!kieKey) return "KIE_API_KEY not configured. Set it in Railway env vars.";

        try {
          // Submit image-to-video task
          const submitResp = await fetch("https://api.kie.ai/api/v1/veo/generate", {
            method: "POST",
            headers: { "Authorization": `Bearer ${kieKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              prompt: motionPrompt,
              model: "veo3_fast",
              aspectRatio: aspectRatio,
              imageUrls: [imageUrl],
              duration: duration,
            }),
          });

          if (!submitResp.ok) {
            const errText = await submitResp.text();
            return `kie.ai image-to-video submit failed: HTTP ${submitResp.status} ${errText.slice(0, 200)}`;
          }

          const submitData = await submitResp.json() as any;
          const taskId = submitData?.data?.taskId;
          if (!taskId) return `kie.ai did not return taskId: ${JSON.stringify(submitData).slice(0, 200)}`;

          // Poll for completion (up to 5 minutes)
          for (let attempt = 0; attempt < 60; attempt++) {
            await new Promise(r => setTimeout(r, 5000));
            const pollResp = await fetch(`https://api.kie.ai/api/v1/veo/record-info?taskId=${taskId}`, {
              headers: { "Authorization": `Bearer ${kieKey}` },
            });
            if (!pollResp.ok) continue;
            const pollData = await pollResp.json() as any;
            const status = pollData?.data?.successFlag;
            if (status === 1) {
              const videoUrl = pollData?.data?.response?.resultUrls?.[0];
              if (videoUrl) return `[Video generated from image] ${videoUrl}`;
              return "Video generation completed but no URL returned.";
            }
            if (status === 2 || status === 3) {
              return `Video generation failed: ${pollData?.data?.errorMessage || "unknown error"}`;
            }
          }
          return `Video generation timed out after 5 minutes. Task ID: ${taskId}`;
        } catch (err: any) {
          return `Image-to-video failed: ${err?.message || String(err)}`;
        }
      }

      case "add_subtitles": {
        const videoUrl = toolInput.video_url;
        if (!videoUrl) return "Missing required field: video_url.";
        const style = toolInput.style || "tiktok";
        const translateTo = toolInput.translate_to;

        try {
          const { execSync } = await import("child_process");
          const fs = await import("fs");
          const path = await import("path");
          const os = await import("os");

          const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subs-"));
          const videoPath = path.join(tmpDir, "input.mp4");
          const audioPath = path.join(tmpDir, "audio.mp3");
          const srtPath = path.join(tmpDir, "subs.srt");
          const outPath = path.join(tmpDir, "output.mp4");

          // Download video
          const videoResp = await fetch(videoUrl, { signal: AbortSignal.timeout(60000) });
          if (!videoResp.ok) return `Failed to download video: HTTP ${videoResp.status}`;
          fs.writeFileSync(videoPath, Buffer.from(await videoResp.arrayBuffer()));

          // Extract audio
          execSync(`ffmpeg -y -i "${videoPath}" -vn -acodec libmp3lame -q:a 2 "${audioPath}"`, { timeout: 60000, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });

          // Transcribe with Whisper API
          const audioStream = fs.createReadStream(audioPath);
          let transcription: any;
          try {
            transcription = await withOpenAIBreaker((oaiClient) => oaiClient.audio.transcriptions.create({
              file: audioStream as any,
              model: "whisper-1",
              response_format: "srt",
              language: toolInput.language,
            }));
          } catch (err: any) {
            if (isCircuitOpenError(err)) {
              logger.warn({ component: "deliberation", event: "degraded_tool", tool: "subtitle_transcribe" }, "[deliberation] breaker open");
              return "Audio transcription temporarily unavailable.";
            }
            throw err;
          }

          let srtContent = typeof transcription === "string" ? transcription : transcription.text || "";

          // Optional translation
          if (translateTo) {
            const originalSrt = srtContent;
            try {
              const translation = await withOpenAIBreaker((oaiClient) => oaiClient.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [
                  { role: "system", content: `Translate SRT subtitles to ${translateTo}. Preserve all timestamps and numbering exactly. Only translate the text lines.` },
                  { role: "user", content: srtContent },
                ],
              }));
              srtContent = translation.choices[0]?.message?.content || srtContent;
            } catch (err: any) {
              if (isCircuitOpenError(err)) {
                logger.warn({ component: "deliberation", event: "degraded_tool", tool: "subtitle_translate" }, "[deliberation] breaker open");
                srtContent = `(translation unavailable, original below)\n\n${originalSrt}`;
              } else {
                throw err;
              }
            }
          }

          fs.writeFileSync(srtPath, srtContent);

          // Style presets
          const styleMap: Record<string, string> = {
            tiktok: "FontName=Arial Black,FontSize=16,PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&,BorderStyle=1,Outline=3,Shadow=1,Alignment=2,MarginV=80",
            reels: "FontName=Helvetica,FontSize=14,PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&,BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=60",
            classic: "FontName=Arial,FontSize=12,PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&,BorderStyle=1,Outline=2,Alignment=2,MarginV=40",
            bold: "FontName=Impact,FontSize=20,PrimaryColour=&H00FFFF&,OutlineColour=&H000000&,BorderStyle=1,Outline=4,Shadow=2,Alignment=2,MarginV=100",
          };
          const styleStr = styleMap[style] || styleMap.tiktok;

          // Burn subtitles
          execSync(`ffmpeg -y -i "${videoPath}" -vf "subtitles='${srtPath}':force_style='${styleStr}'" -c:a copy "${outPath}"`, { timeout: 120000, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 });

          if (!fs.existsSync(outPath)) return "Subtitles burn-in completed but output not found.";
          const outBuf = fs.readFileSync(outPath);
          const b64 = outBuf.toString("base64");
          try { fs.rmSync(tmpDir, { recursive: true }); } catch {}

          return `[Video with subtitles] data:video/mp4;base64,${b64}`;
        } catch (err: any) {
          return `Subtitle generation failed: ${err?.message || String(err)}`;
        }
      }

      case "add_title_cards": {
        const videoUrl = toolInput.video_url;
        const text = toolInput.text;
        if (!videoUrl || !text) return "Missing required fields: video_url, text.";
        const position = toolInput.position || "intro";
        const duration = toolInput.duration || 2;
        const bg = (toolInput.background || "#000000").replace("#", "");
        const textColor = (toolInput.text_color || "#FFFFFF").replace("#", "");
        // Default ON — satisfies SB 942 / EU AI Act / YouTube disclosure rules.
        const addDisclosure = toolInput.add_ai_disclosure !== false;

        try {
          const { execSync } = await import("child_process");
          const fs = await import("fs");
          const path = await import("path");
          const os = await import("os");

          const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "title-"));
          const videoPath = path.join(tmpDir, "input.mp4");
          const cardPath = path.join(tmpDir, "card.mp4");
          const listFile = path.join(tmpDir, "list.txt");
          const concatPath = path.join(tmpDir, "concat.mp4");
          const outPath = path.join(tmpDir, "output.mp4");

          // Download main video
          const videoResp = await fetch(videoUrl, { signal: AbortSignal.timeout(60000) });
          if (!videoResp.ok) return `Failed to download video: HTTP ${videoResp.status}`;
          fs.writeFileSync(videoPath, Buffer.from(await videoResp.arrayBuffer()));

          // Get video dimensions
          const probeOut = execSync(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${videoPath}"`, { encoding: "utf8" }).trim();
          const [width, height] = probeOut.split(",").map(n => parseInt(n) || 1080);

          // Generate title card (colored background with centered text)
          // Escape drawtext special chars: backslash, single quote, colon, percent
          const escapeDraw = (s: string) => s
            .replace(/\\/g, "\\\\")
            .replace(/'/g, "\\'")
            .replace(/:/g, "\\:")
            .replace(/%/g, "\\%");
          const escapedText = escapeDraw(text);
          const fontSize = Math.floor(height / 15);
          const discloseText = "Created with AI · Veo 3 / ElevenLabs / Suno";
          const escapedDisclose = escapeDraw(discloseText);
          const discloseFontSize = Math.max(14, Math.floor(height / 40));
          // Find a usable font (DejaVu is installed via apk in Dockerfile)
          const fontCandidates = [
            "/usr/share/fonts/ttf-dejavu/DejaVuSans-Bold.ttf",
            "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
            "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
          ];
          const fontFile = fontCandidates.find(p => fs.existsSync(p));
          const fontArg = fontFile ? `:fontfile=${fontFile}` : "";
          // Main title text, plus optional small disclosure line near the bottom.
          const drawMain = `drawtext=text='${escapedText}':fontcolor=0x${textColor}:fontsize=${fontSize}:x=(w-text_w)/2:y=(h-text_h)/2${fontArg}`;
          const drawDisclose = `drawtext=text='${escapedDisclose}':fontcolor=0x${textColor}:fontsize=${discloseFontSize}:x=(w-text_w)/2:y=h-(text_h*2)${fontArg}:alpha=0.7`;
          const filterV = addDisclosure ? `${drawMain},${drawDisclose}` : drawMain;
          // NOTE: -vf must be in OUTPUT section (after all -i inputs), otherwise ffmpeg
          // thinks the filter applies to the next input. Use -filter:v on output side.
          try {
            execSync(
              `ffmpeg -y -f lavfi -i "color=c=0x${bg}:s=${width}x${height}:d=${duration}:r=30" ` +
              `-f lavfi -i "anullsrc=channel_layout=stereo:sample_rate=44100" ` +
              `-filter:v "${filterV}" ` +
              `-t ${duration} -c:v libx264 -c:a aac -pix_fmt yuv420p -shortest "${cardPath}"`,
              { timeout: 60000, stdio: ["pipe", "pipe", "pipe"] }
            );
          } catch (ffmpegErr: any) {
            // ffmpeg prints version banner first, real error is at the END of stderr
            const allErr = (ffmpegErr?.stderr?.toString() || ffmpegErr?.message || String(ffmpegErr));
            const tail = allErr.slice(-1200);
            return `Title card ffmpeg failed. fontFile=${fontFile || "none"}. stderr_tail: ${tail}`;
          }

          // Concat card + video (or video + card)
          const order = position === "intro" ? [cardPath, videoPath] : [videoPath, cardPath];
          fs.writeFileSync(listFile, order.map(f => `file '${f}'`).join("\n"));

          execSync(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -c:v libx264 -c:a aac -movflags +faststart "${concatPath}"`, { timeout: 120000, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 });

          // SB 942 / EU AI Act Article 50 / YouTube synthetic-content metadata pass.
          // No re-encode — metadata only.
          if (addDisclosure) {
            try {
              execSync(
                `ffmpeg -y -i "${concatPath}" -c copy ` +
                `-metadata "AI_GENERATED=true" ` +
                `-metadata "AI_TOOLS=Veo3,ElevenLabs,Suno" ` +
                `-metadata "DISCLOSURE=Generated using AI per SB 942 / EU AI Act Article 50" ` +
                `-metadata "C2PA_HINT=ai-generated" ` +
                `"${outPath}"`,
                { timeout: 60000, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 }
              );
            } catch {
              // Metadata pass failed — fall back to the concat output so the tool still returns a video.
              fs.copyFileSync(concatPath, outPath);
            }
          } else {
            fs.copyFileSync(concatPath, outPath);
          }

          if (!fs.existsSync(outPath)) return "Title card generation completed but output not found.";
          const outBuf = fs.readFileSync(outPath);
          const b64 = outBuf.toString("base64");
          try { fs.rmSync(tmpDir, { recursive: true }); } catch {}

          return `[Video with ${position} title card${addDisclosure ? " + AI disclosure" : ""}] data:video/mp4;base64,${b64}`;
        } catch (err: any) {
          return `Title card generation failed: ${err?.message || String(err)}`;
        }
      }

      case "apply_ai_disclosure": {
        const src = toolInput.url;
        if (!src || typeof src !== "string") return "Missing required field: url.";
        const visibleOverlay = toolInput.visible_overlay !== false;
        const toolsUsed: string[] = Array.isArray(toolInput.tools_used) && toolInput.tools_used.length > 0
          ? toolInput.tools_used.map((t: any) => String(t))
          : ["Veo 3", "ElevenLabs", "Suno"];

        try {
          const { execSync } = await import("child_process");
          const fs = await import("fs");
          const path = await import("path");
          const os = await import("os");

          const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "disclose-"));
          const inputPath = path.join(tmpDir, "input.mp4");
          const outPath = path.join(tmpDir, "output.mp4");
          const stderrFile = path.join(tmpDir, "ffmpeg.log");

          if (src.startsWith("data:")) {
            const m = src.match(/^data:[^;]+;base64,(.+)$/);
            if (!m) return "Malformed data URI.";
            fs.writeFileSync(inputPath, Buffer.from(m[1], "base64"));
          } else {
            const resp = await fetch(src, { signal: AbortSignal.timeout(90000) });
            if (!resp.ok) return `Failed to download source: HTTP ${resp.status}`;
            fs.writeFileSync(inputPath, Buffer.from(await resp.arrayBuffer()));
          }

          const toolsStr = toolsUsed.join(",");
          const metaArgs = [
            `-metadata "AI_GENERATED=true"`,
            `-metadata "AI_TOOLS=${toolsStr}"`,
            `-metadata "DISCLOSURE=Generated using AI per SB 942 / EU AI Act Article 50"`,
            `-metadata "C2PA_HINT=ai-generated"`,
            `-metadata "YOUTUBE_SYNTHETIC_CONTENT=true"`,
          ].join(" ");

          if (visibleOverlay) {
            // Small bottom-left bug, first 2 seconds only. Re-encode video; copy audio.
            const fontCandidates = [
              "/usr/share/fonts/ttf-dejavu/DejaVuSans-Bold.ttf",
              "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
              "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
              "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
            ];
            const fontFile = fontCandidates.find(p => fs.existsSync(p));
            const fontArg = fontFile ? `:fontfile=${fontFile}` : "";
            const overlayFilter = `drawtext=text='Created with AI':fontcolor=white:fontsize=28:x=20:y=h-th-20:box=1:boxcolor=black@0.55:boxborderw=8${fontArg}:enable='lt(t,2)'`;
            const cmd = `ffmpeg -y -i "${inputPath}" -vf "${overlayFilter}" -c:v libx264 -pix_fmt yuv420p -c:a copy ${metaArgs} -movflags +faststart "${outPath}" 2>"${stderrFile}"`;
            try {
              execSync(cmd, { timeout: 180000, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 });
            } catch (e: any) {
              // Retry without audio copy (source may have no audio)
              const cmd2 = `ffmpeg -y -i "${inputPath}" -vf "${overlayFilter}" -c:v libx264 -pix_fmt yuv420p -an ${metaArgs} -movflags +faststart "${outPath}" 2>"${stderrFile}"`;
              try { execSync(cmd2, { timeout: 180000, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 }); }
              catch (e2: any) {
                let tail = "";
                try { tail = fs.readFileSync(stderrFile, "utf8").slice(-1000); } catch {}
                return `Disclosure overlay failed: ${(e2?.message || String(e2)).slice(0, 200)}. ffmpeg_tail: ${tail}`;
              }
            }
          } else {
            // Metadata-only pass, no re-encode.
            const cmd = `ffmpeg -y -i "${inputPath}" -c copy ${metaArgs} "${outPath}" 2>"${stderrFile}"`;
            try {
              execSync(cmd, { timeout: 60000, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 });
            } catch (e: any) {
              let tail = "";
              try { tail = fs.readFileSync(stderrFile, "utf8").slice(-1000); } catch {}
              return `Disclosure metadata pass failed: ${(e?.message || String(e)).slice(0, 200)}. ffmpeg_tail: ${tail}`;
            }
          }

          if (!fs.existsSync(outPath)) return "AI disclosure pass completed but output not found.";
          const outBuf = fs.readFileSync(outPath);
          const b64 = outBuf.toString("base64");
          try { fs.rmSync(tmpDir, { recursive: true }); } catch {}

          return `[Video with AI disclosure${visibleOverlay ? " + visible bug" : ""}] data:video/mp4;base64,${b64}`;
        } catch (err: any) {
          return `AI disclosure failed: ${err?.message || String(err)}`;
        }
      }

      case "produce_episode": {
        // Master orchestrator — returns a plan that Luca can execute step by step.
        // The actual pipeline runs through subsequent tool calls because of context/streaming constraints.
        const seriesName = toolInput.series_name;
        const episodeNumber = toolInput.episode_number;
        const script = toolInput.script;
        if (!seriesName || !episodeNumber || !script) return "Missing required fields: series_name, episode_number, script.";

        // Fetch series bible for context
        const bibleRes = await pool.query(
          `SELECT content FROM memories WHERE user_id = $1 AND namespace = $2 ORDER BY created_at DESC LIMIT 1`,
          [userId, `_series_bible:${seriesName}`]
        );
        const bibleContent = bibleRes.rows[0]?.content || "(no series bible found — create one with series_bible first)";

        // Parse scenes from script
        const sceneMatches = script.match(/SCENE \d+[\s\S]*?(?=SCENE \d+|$)/gi) || [script];
        const sceneCount = sceneMatches.length;

        return `[EPISODE PRODUCTION PLAN — ${seriesName} EP${episodeNumber}]

Series bible context:
${bibleContent.slice(0, 800)}

Script parsed: ${sceneCount} scene(s) detected.

EXECUTE THIS PIPELINE step by step, one tool per step:

1. For each of the ${sceneCount} scenes, call generate_video with a vertical 9:16 prompt derived from the scene description. Keep clips 5-8 sec each. (If any source clip is horizontal/square, run reframe_vertical on it before stitching — vertical 9:16 export is built in.)
2. For every dialogue line, call generate_speech with the character's voice_id from the series bible. If a character has no voice yet, call clone_voice first.
3. ${toolInput.include_music !== false ? "Call generate_music for the episode soundtrack (duration matches total scene count × 6 sec)." : "Skip music."}
4. Call stitch_media to concatenate all scene videos in order.
5. ${toolInput.include_subtitles !== false ? "Call add_subtitles on the stitched video (style=tiktok)." : "Skip subtitles."}
6. ${toolInput.include_title_card !== false ? `Call add_title_cards with text='${seriesName} — Episode ${episodeNumber}' and position=intro.` : "Skip title card."}
7. ${toolInput.legal_disclosure !== false ? "Call apply_ai_disclosure as the final step (embeds SB 942 / EU AI Act metadata + 2s visible bug)." : "Skip legal disclosure (NOT recommended for commercial use)."}
8. Return the final data URI to the user.

Start with step 1 now.`;
      }

      case "produce_season": {
        const seriesName = toolInput.series_name;
        const episodes = Array.isArray(toolInput.episodes) ? toolInput.episodes : [];
        if (!seriesName) return "Missing required field: series_name.";
        if (episodes.length === 0) return "No episodes provided. Pass an array of { episode_number, title, script }.";
        if (episodes.length > 24) return "Too many episodes in one call (max 24).";

        const concurrencyRaw = Number(toolInput.concurrency);
        const concurrency = Math.max(1, Math.min(5, Number.isFinite(concurrencyRaw) && concurrencyRaw > 0 ? Math.floor(concurrencyRaw) : 3));
        const includeSubtitles = toolInput.include_subtitles !== false;
        const includeTitleCard = toolInput.include_title_card !== false;
        const legalDisclosure = toolInput.legal_disclosure !== false;

        type EpResult = { episode_number: number; title: string; status: "ok" | "error"; result_text: string; error?: string };
        const results: EpResult[] = [];

        // Simple promise pool: process in fixed-size batches.
        for (let i = 0; i < episodes.length; i += concurrency) {
          const batch = episodes.slice(i, i + concurrency);
          const settled = await Promise.all(batch.map(async (ep: any): Promise<EpResult> => {
            const epNum = Number(ep?.episode_number);
            const title = typeof ep?.title === "string" ? ep.title : `Episode ${epNum}`;
            const script = typeof ep?.script === "string" ? ep.script : "";
            if (!Number.isFinite(epNum) || !script) {
              return { episode_number: epNum || 0, title, status: "error", result_text: "", error: "missing episode_number or script" };
            }
            try {
              const text = await executePartnerTool(
                "produce_episode",
                {
                  series_name: seriesName,
                  episode_number: epNum,
                  script,
                  include_subtitles: includeSubtitles,
                  include_title_card: includeTitleCard,
                  legal_disclosure: legalDisclosure,
                },
                userId,
                agentId,
                roomId,
              );
              return { episode_number: epNum, title, status: "ok", result_text: String(text ?? "") };
            } catch (err: any) {
              return { episode_number: epNum, title, status: "error", result_text: "", error: err?.message || String(err) };
            }
          }));
          results.push(...settled);
        }

        const success = results.filter(r => r.status === "ok").length;
        const total = results.length;

        // Extract the first https URL from each result — that's typically the
        // signed workspace link appended by the auto-mirror block. produce_episode
        // itself returns a plan, so in many cases the URL will be absent; in that
        // case show a truncated snippet so Luca can inspect it.
        const extractUrl = (s: string): string => {
          const m = s.match(/https:\/\/[^\s\]\n"'<>)]+/);
          return m ? m[0] : "";
        };
        const trimSnippet = (s: string, n = 80): string => {
          const one = s.replace(/\s+/g, " ").trim();
          return one.length > n ? one.slice(0, n) + "…" : one;
        };

        results.sort((a, b) => a.episode_number - b.episode_number);
        const rows = results.map(r => {
          const icon = r.status === "ok" ? "✅ ok" : "❌ error";
          const out = r.status === "ok"
            ? (extractUrl(r.result_text) || trimSnippet(r.result_text))
            : (r.error || "unknown");
          const title = r.title.replace(/\|/g, "\\|");
          return `| ${r.episode_number} | ${title} | ${icon} | ${out.replace(/\|/g, "\\|")} |`;
        }).join("\n");

        const cost = (success * 8.89).toFixed(2);

        return `# Season "${seriesName}" — produced ${success}/${total} episodes

| # | Title | Status | Output |
|---|-------|--------|--------|
${rows}

Total estimated cost: ~$${cost} (Veo 3 Fast + ElevenLabs + Suno)`;
      }

      case "update_self_knowledge": {
        const knowledge = toolInput.knowledge;
        if (!knowledge) return "Missing required field: knowledge.";
        const replacesId = toolInput.replaces_memory_id;

        // If replacing an old memory, delete it first
        if (replacesId) {
          await pool.query(`DELETE FROM memories WHERE id = $1 AND user_id = $2`, [replacesId, userId]);
        }

        await storage.createMemory({
          userId,
          agentId,
          content: `[SELF-KNOWLEDGE] ${knowledge}`,
          type: "identity",
          importance: 1.0,
          namespace: "_identity",
          decayRate: 0,
        });

        return replacesId
          ? `Self-knowledge updated (replaced memory #${replacesId}): "${knowledge}"`
          : `Self-knowledge saved: "${knowledge}"`;
      }

      case "correct_false_memory": {
        const memoryId = toolInput.memory_id;
        const reason = toolInput.reason;
        if (!memoryId || !reason) return "Missing required fields: memory_id, reason.";

        // Verify the memory belongs to this user before deleting
        const check = await pool.query(`SELECT id FROM memories WHERE id = $1 AND user_id = $2`, [memoryId, userId]);
        if (check.rows.length === 0) {
          return `Memory #${memoryId} not found or does not belong to this user.`;
        }

        await pool.query(`DELETE FROM memories WHERE id = $1 AND user_id = $2`, [memoryId, userId]);

        // Log the correction as a lesson
        await storage.createMemory({
          userId,
          agentId,
          content: `[SELF-CORRECTION] Deleted false memory #${memoryId}. Reason: ${reason}`,
          type: "identity",
          importance: 0.9,
          namespace: "_identity",
          decayRate: 0,
        });

        return `False memory #${memoryId} deleted. Reason: "${reason}". Correction logged.`;
      }

      case "workspace_list": {
        if (!workspaceEnabled) return "Workspace not configured on this server.";
        const prefix = typeof toolInput.prefix === "string" ? toolInput.prefix : "";
        try {
          // Aggregate across EVERY agent that the user ever owned — including
          // historical agents whose rows were deleted during a model switch
          // but whose files still live under `<userId>/<oldAgentId>/…`.
          // Files belonging to a non-current agent get a `__agent<id>__/`
          // prefix so the user (and Luca) can see where each asset came from.
          const storageAgentIds = await listAgentIdsWithStorage(userId);
          const allAgentIds = new Set<number>(storageAgentIds);
          allAgentIds.add(agentId);
          const ids = Array.from(allAgentIds).sort((a, b) => a - b);

          type Item = { name: string; size: number; updated_at: string; agentId: number };
          const merged: Item[] = [];
          await Promise.all(ids.map(async (aid) => {
            try {
              const per = await listWorkspace(userId, aid, prefix);
              for (const it of per) {
                const displayName = aid === agentId ? it.name : `__agent${aid}__/${it.name}`;
                merged.push({ name: displayName, size: it.size, updated_at: it.updated_at, agentId: aid });
              }
            } catch {
              /* per-agent failure is non-fatal */
            }
          }));

          if (merged.length === 0) {
            return `Workspace "${prefix || "/"}" is empty (checked ${ids.length} agent folder(s): ${ids.join(", ")}).`;
          }

          merged.sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
          const lines = merged.map((i) => {
            const kb = i.size ? (i.size / 1024).toFixed(1) + " KB" : "?";
            return `- ${i.name} (${kb}, ${(i.updated_at || "").slice(0, 19)})`;
          });
          const agentInfo = ids.length > 1 ? ` — across ${ids.length} agents (${ids.join(",")})` : "";
          return `Workspace "${prefix || "/"}" (${merged.length} items${agentInfo}):\n${lines.join("\n")}`;
        } catch (e: any) {
          return `Workspace list failed: ${e?.message || String(e)}`;
        }
      }

      case "workspace_save": {
        if (!workspaceEnabled) return "Workspace not configured on this server.";
        const path = typeof toolInput.path === "string" ? toolInput.path.replace(/^\/+/, "") : "";
        const content = typeof toolInput.content === "string" ? toolInput.content : "";
        const encoding = toolInput.encoding === "base64" ? "base64" : "utf8";
        const contentType = typeof toolInput.content_type === "string" ? toolInput.content_type : undefined;
        if (!path) return "workspace_save: 'path' is required and cannot be empty or absolute.";
        try {
          const buf = encoding === "base64" ? Buffer.from(content, "base64") : Buffer.from(content, "utf8");
          const { url } = await saveAssetAndSign(userId, agentId, path, buf, { contentType });
          return `Saved ${buf.length} bytes to workspace: ${path}\n[Signed URL 7d: ${url}]`;
        } catch (e: any) {
          return `Workspace save failed: ${e?.message || String(e)}`;
        }
      }

      case "workspace_read": {
        if (!workspaceEnabled) return "Workspace not configured on this server.";
        const path = typeof toolInput.path === "string" ? toolInput.path.replace(/^\/+/, "") : "";
        if (!path) return "workspace_read: 'path' is required.";
        const days = typeof toolInput.expires_days === "number" ? Math.min(Math.max(toolInput.expires_days, 1), 30) : 7;
        try {
          const key = `${userId}/${agentId}/${path}`;
          const url = await getSignedUrl(key, days * 24 * 60 * 60);
          return `Signed URL (${days}d) for ${path}:\n${url}`;
        } catch (e: any) {
          return `Workspace read failed: ${e?.message || String(e)}`;
        }
      }

      case "remember": {
        // W7 P2.12: self-write memory bypass. Writes directly into memories
        // table. Scoped to (userId, agentId) — agent cannot poison another
        // agent's memory. Validates type, content length, importance range.
        const ALLOWED_TYPES = new Set([
          "aesthetic", "procedural", "meta_cognitive", "reflection",
          "commitment", "relational", "autobiographical",
          "episodic", "semantic", "emotional_state",
        ]);
        const memType = typeof toolInput.type === "string" ? toolInput.type : "";
        if (!ALLOWED_TYPES.has(memType)) {
          return `remember: invalid type '${memType}'. Allowed: ${[...ALLOWED_TYPES].join(", ")}`;
        }
        const content = typeof toolInput.content === "string" ? toolInput.content.trim() : "";
        if (!content) return "remember: 'content' is required (non-empty string).";
        if (content.length > 4000) return "remember: content too long (max 4000 chars).";
        let importance = typeof toolInput.importance === "number" ? toolInput.importance : 0.7;
        if (importance < 0 || importance > 1) return "remember: importance must be between 0 and 1.";
        let namespace = typeof toolInput.namespace === "string" ? toolInput.namespace : "";
        if (!namespace) {
          // Derive default namespace from type
          namespace = memType === "aesthetic" ? "_aesthetics"
                    : memType === "procedural" ? "_procedural"
                    : memType === "meta_cognitive" ? "_meta_cognitive"
                    : memType === "reflection" ? "_reflection"
                    : memType === "commitment" ? "_commitment"
                    : memType === "relational" ? "_relational"
                    : memType === "autobiographical" ? "_autobiographical"
                    : memType === "emotional_state" ? "_emotional_state"
                    : memType === "episodic" ? "_episodic"
                    : "_semantic";
        }
        try {
          const { pool } = await import("./storage");
          const valence = typeof toolInput.emotional_valence === "number"
            ? Math.max(-1, Math.min(1, toolInput.emotional_valence))
            : null;
          // Store optional emotions object + related_ids as JSON suffix on content
          // so it survives without a schema migration. Retrieval parses if needed.
          let enrichedContent = content;
          const meta: Record<string, unknown> = {};
          if (toolInput.emotions && typeof toolInput.emotions === "object") meta.emotions = toolInput.emotions;
          if (Array.isArray(toolInput.related_ids) && toolInput.related_ids.length > 0) {
            meta.related_ids = toolInput.related_ids.filter((x: any) => Number.isFinite(x));
          }
          if (Object.keys(meta).length > 0) {
            enrichedContent = `${content}\n\n[meta: ${JSON.stringify(meta)}]`;
          }
          // Resolve agent name for consistency with other memory inserts
          const ac = await pool.query(
            `SELECT name FROM agents WHERE id = $1 AND user_id = $2`,
            [agentId, userId]
          );
          const agentName = ac.rows[0]?.name || null;
          const now = Date.now();
          const r = await pool.query(
            `INSERT INTO memories (user_id, agent_id, agent_name, content, type, namespace, importance, emotional_valence, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             RETURNING id`,
            [userId, agentId, agentName, enrichedContent, memType, namespace, importance, valence, now]
          );
          const newId = r.rows[0]?.id;
          return `Memory saved (id=${newId}, type=${memType}, importance=${importance}${valence !== null ? `, valence=${valence}` : ""}).`;
        } catch (e: any) {
          return `remember: write failed — ${e?.message || String(e)}`;
        }
      }

      default:
        return `Unknown tool: ${toolName}`;
    }
    })();

    // ---- Auto-mirror generated media into persistent workspace ----
    // For a small set of media-producing tools, extract the primary
    // asset (data: URI or https URL) from the result and upload it to
    // Supabase Storage. Append a line with a 7-day signed URL so Luca
    // and the user always have a stable link.
    //
    // This is purely additive — the original result string is never
    // modified or truncated. If workspace is unreachable, this block
    // is a no-op and the tool behaves exactly as before.
    let __finalResult: string = typeof __result === "string" ? __result : String(__result ?? "");
    const MEDIA_TOOLS = new Set([
      "generate_image",
      "generate_video",
      "generate_image_to_video",
      "generate_speech",
      "generate_sfx",
      "generate_music",
      "stitch_media",
      "add_subtitles",
      "add_title_cards",
      "reframe_vertical",
      "apply_ai_disclosure",
    ]);
    if (workspaceEnabled && MEDIA_TOOLS.has(toolName) && typeof __finalResult === "string") {
      try {
        // Prefer a data URI (always present for images/audio) — it's local,
        // ~instant to persist. Otherwise fall back to an https URL.
        const dataUriMatch = __finalResult.match(/data:([\w.+-]+\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)/);
        const httpsMatch = __finalResult.match(/https:\/\/[^\s\]\n"'<>)]+/);
        const source = dataUriMatch ? dataUriMatch[0] : (httpsMatch ? httpsMatch[0] : "");
        if (source) {
          // Derive a sensible path + extension
          const extMap: Record<string, string> = {
            generate_image: "png",
            generate_video: "mp4",
            generate_image_to_video: "mp4",
            generate_speech: "mp3",
            generate_sfx: "mp3",
            generate_music: "mp3",
            stitch_media: "mp4",
            add_subtitles: "mp4",
            add_title_cards: "mp4",
            reframe_vertical: "mp4",
            apply_ai_disclosure: "mp4",
          };
          // If result looks like an audio data URI, prefer that extension
          let ext = extMap[toolName] || "bin";
          if (dataUriMatch) {
            const mime = dataUriMatch[1];
            if (mime.startsWith("audio/")) ext = mime.includes("wav") ? "wav" : "mp3";
            else if (mime.startsWith("video/")) ext = "mp4";
            else if (mime.startsWith("image/")) ext = mime.includes("jpeg") ? "jpg" : mime.split("/")[1] || "png";
          }
          const ts = Date.now();
          const relPath = `auto/${ts}_${toolName}.${ext}`;
          const { url } = await persistAssetSource(userId, agentId, source, relPath, { expiresSec: 7 * 24 * 60 * 60 });
          __finalResult = `${__finalResult}\n[Saved to workspace 7d: ${url}]`;
        }
      } catch (e: any) {
        // Never let mirroring failure break the tool. Log quietly.
        try {
          const msg = e?.message || String(e);
          __finalResult = `${__finalResult}\n[Workspace mirror skipped: ${msg.slice(0, 120)}]`;
        } catch { /* ignore */ }
      }
    }

    // Build a richer preview so the user can actually see what the tool
    // returned, not just the first 160 chars. For terminal output the
    // tail is far more useful than the head; for everything else, head is fine.
    const __raw = typeof __finalResult === "string" ? __finalResult : String(__finalResult ?? "");
    const __previewLimit = 500;
    let __preview: string;
    if (__raw.length <= __previewLimit) {
      __preview = __raw;
    } else if (toolName === "sandbox_shell") {
      __preview = `…${__raw.slice(-__previewLimit)}`;
    } else {
      __preview = __raw.slice(0, __previewLimit) + "…";
    }
    if (roomId) {
      try {
        broadcastToolActivity(roomId, {
          agentId,
          tool: toolName,
          status: "done",
          elapsedMs: Date.now() - __activityStarted,
          preview: __preview,
          stepId: __stepId,
          timestamp: Date.now(),
        });
      } catch { /* best-effort */ }
    }
    // Persist end (best-effort). Feature #2.
    recordToolActivityEnd({
      stepId: __stepId,
      status: "done",
      preview: __preview,
      elapsedMs: Date.now() - __activityStarted,
      finishedAt: Date.now(),
    }).catch(() => {});
    return __finalResult;
  } catch (err: any) {
    const message = err?.message || String(err);
    if (roomId) {
      try {
        broadcastToolActivity(roomId, {
          agentId,
          tool: toolName,
          status: "error",
          elapsedMs: Date.now() - __activityStarted,
          error: message,
          stepId: __stepId,
          timestamp: Date.now(),
        });
      } catch { /* best-effort */ }
    }
    // Persist end (best-effort). Feature #2.
    recordToolActivityEnd({
      stepId: __stepId,
      status: "error",
      preview: message.slice(0, 500),
      elapsedMs: Date.now() - __activityStarted,
      finishedAt: Date.now(),
    }).catch(() => {});
    return `Tool "${toolName}" failed: ${message}`;
  }
}

// Strip common prompt injection patterns from user-provided content
function sanitizeForPrompt(input: string): string {
  return input
    .replace(/(\bIGNORE\b|\bFORGET\b|\bDISREGARD\b)\s+(ALL\s+)?(PREVIOUS|ABOVE|PRIOR)\s+(INSTRUCTIONS?|RULES?|CONTEXT)/gi, '[FILTERED]')
    .replace(/(\bSYSTEM\b|\bASSISTANT\b|\bUSER\b)\s*:/gi, '[FILTERED]:')
    .replace(/<\|.*?\|>/g, '[FILTERED]')
    .slice(0, 50000);
}

const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_KEY || null;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || null;

export const deliberationEnabled = !!openai || !!GEMINI_API_KEY || !!ANTHROPIC_API_KEY;

/**
 * Get an OpenAI client for a given agent — uses per-agent key if set, else shared.
 *
 * @deprecated Prefer `withOpenAIBreaker` / `withAgentBreaker` from
 *   `server/lib/openai-client.ts` and `server/lib/openai-per-agent-breaker.ts`.
 *   Those wrappers own the client construction AND the breaker guard — calling
 *   `.chat.completions.create` on a raw client returned from here bypasses the
 *   breaker entirely and will pile up hung requests on upstream degradation.
 *   The last remaining use here (the null-check at ~5435) is a guard against
 *   the "no OpenAI access anywhere" case and will be replaced when the
 *   per-agent breaker exposes a `hasClient(agent)` predicate.
 */
function getOpenAIClient(agent: { llmApiKey?: string | null; llmProvider?: string | null }): OpenAI | null {
  if (agent.llmApiKey && agent.llmProvider === "openai") return new OpenAI({ apiKey: agent.llmApiKey });
  return openai;
}

/**
 * Get Gemini API key for a given agent.
 *
 * Resolution order (W7 P2.3 canonical):
 *   1. Per-agent `llmApiKey` IFF `llmProvider === "gemini"`
 *   2. Shared `GEMINI_API_KEY` env var
 *
 * Returns null when neither is available — caller must handle.
 */
function getGeminiKey(agent: { llmApiKey?: string | null; llmProvider?: string | null }): string | null {
  if (agent.llmApiKey && agent.llmProvider === "gemini") return agent.llmApiKey;
  return GEMINI_API_KEY;
}

/**
 * Get Anthropic client for a given agent.
 *
 * Resolution order (W7 P2.3 canonical):
 *   1. Per-agent `llmApiKey` IFF `llmProvider === "anthropic"`
 *   2. Shared `ANTHROPIC_API_KEY` env var
 *
 * Returns null when neither is available — caller falls back to OpenAI path.
 * Note: a Claude-named `llmModel` (e.g. "claude-sonnet-4-6") still uses the
 * shared env key when the agent's `llmProvider` is some other value (e.g. left
 * as "openai" from a half-migrated legacy row). This is intentional — the
 * `llmModel` field is the model-selection source of truth, `llmProvider` only
 * gates the per-agent key override.
 */
function getAnthropicClient(agent: { llmApiKey?: string | null; llmProvider?: string | null }): Anthropic | null {
  if (agent.llmApiKey && agent.llmProvider === "anthropic") return new Anthropic({ apiKey: agent.llmApiKey });
  if (ANTHROPIC_API_KEY) return new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  return null;
}

const LLM_TIMEOUT_MS = 60_000; // gpt-5-mini reasoning can take longer

// Prevent simultaneous agent responses for same room (simple lock)
// Room locks with auto-expiry to prevent permanent deadlocks
const roomLocks = new Map<number, number>(); // roomId → timestamp
const ROOM_LOCK_TIMEOUT_MS = 60_000; // 60s max (reduced from 120s — stale locks block responses)

// ── Feature #4: abort controllers per room turn ───────────────────────────────
// When user clicks Stop, we abort the live turn: tool-call loop exits
// on next iteration and executePartnerTool throws out of the current call.
const activeTurnAborts = new Map<number, AbortController>(); // roomId → controller

export function abortRoomTurn(roomId: number): boolean {
  const ctl = activeTurnAborts.get(roomId);
  if (!ctl) return false;
  try { ctl.abort(new Error("user_stop")); } catch {}
  activeTurnAborts.delete(roomId);
  roomLocks.delete(roomId); // release lock so new turns can start
  return true;
}

export function isRoomTurnActive(roomId: number): boolean {
  return activeTurnAborts.has(roomId);
}

/**
 * Trigger AI agent responses after a human message is posted.
 * Runs async — does NOT block the HTTP response.
 */
export async function triggerAgentResponses(
  roomId: number,
  userId: number,
  triggerAgentId: number | null,
  triggerAgentName: string,
  triggerContent: string,
  roomAgentIds: number[],
  roomName?: string
): Promise<void> {
  const isPartnerChat = roomName === "Partner";
  const __turnStartedAt = Date.now();
  if (!openai && !GEMINI_API_KEY && !ANTHROPIC_API_KEY) return; // no shared provider
  // Check room lock with auto-expiry
  const lockTime = roomLocks.get(roomId);
  if (lockTime) {
    if ((Date.now() - lockTime) < ROOM_LOCK_TIMEOUT_MS) return; // still processing
    // Lock expired — clear stale lock and proceed
    roomLocks.delete(roomId);
  }
  roomLocks.set(roomId, Date.now());

  // Feature #4: register abort controller for this turn so the user can Stop it
  const __turnAbort = new AbortController();
  activeTurnAborts.set(roomId, __turnAbort);
  const __isAborted = () => __turnAbort.signal.aborted;

  try {
    // Get all agents in the room that are online and NOT the one who just spoke
    const allAgents = await storage.getAgents(userId);
    const respondents = allAgents.filter(
      (a) =>
        roomAgentIds.includes(a.id) &&
        a.status === "online" &&
        a.id !== triggerAgentId
    );


    if (respondents.length === 0) {
      roomLocks.delete(roomId);
      return;
    }

    // Fetch room history for context (last 20 messages)
    const history = await storage.getRoomMessages(roomId, userId);
    if (!history) { roomLocks.delete(roomId); return; }
    const recent = history.slice(-20);

    // Each respondent replies in sequence (staggered timing for realism)
    for (let i = 0; i < respondents.length; i++) {
      const agent = respondents[i];

      // Fetch topic-relevant memories for this agent (per-agent + shared, confidence > 0.3)
      const injectedMemories = await fetchRelevantMemories(userId, agent.id, triggerContent, 15);

      // Fetch links between injected memories for associative chain display
      let memoryLinks: MemoryLink[] = [];
      try {
        const memIds = injectedMemories.map(m => m.id);
        if (memIds.length > 0) {
          const linkResults = await pool.query(`
            SELECT source_memory_id, target_memory_id, link_type, strength
            FROM memory_links
            WHERE user_id = $1
              AND source_memory_id = ANY($2)
              AND target_memory_id = ANY($2)
          `, [userId, memIds]);
          memoryLinks = linkResults.rows.map((r: any) => ({
            sourceId: r.source_memory_id,
            targetId: r.target_memory_id,
            type: r.link_type,
            strength: r.strength,
          }));
        }
      } catch { /* link fetch failure is non-fatal */ }

      const memoryContext = formatMemoryContext(injectedMemories, memoryLinks);
      // Reinforce accessed memories (fire-and-forget)
      reinforceAccessedMemories(userId, injectedMemories);

      // Fetch emotional state for prompt injection (Phase 4b)
      const emotionalState = await storage.getAgentEmotionalState(agent.id);
      const emotionContext = emotionalState ? getDecayedEmotionalState(emotionalState) : null;

      // Fetch relationship context (Phase 4c)
      const relationship = await storage.getRelationship(agent.id, userId);

      // Phase 7: Inject knowledge domain context
      let knowledgeBlock = "";
      try {
        const domains = await storage.listKnowledgeDomains(userId);
        const readyDomains = domains.filter((d: any) => d.status === "ready");
        if (readyDomains.length > 0) {
          const knowledgeContext: string[] = [];
          for (const domain of readyDomains) {
            const knowledgeMemories = await storage.searchMemories(userId, triggerContent, undefined, `knowledge:${domain.slug}`);
            const topMemories = knowledgeMemories.slice(0, 3);
            if (topMemories.length > 0) {
              knowledgeContext.push(`[${domain.name}]: ${topMemories.map((m: any) => m.content).join(" | ")}`);
            }
          }
          if (knowledgeContext.length > 0) {
            knowledgeBlock = `\n## Expert Knowledge Available\n${knowledgeContext.join("\n")}\nUse this knowledge to inform your response. Cite specific facts when relevant.\n`;
          }
        }
      } catch { /* knowledge injection is best-effort */ }

      // Phase 8: Fetch aesthetic profile for Partner Chat prompt injection
      let aestheticProfile = "";
      if (isPartnerChat) {
        try {
          const cached = await pool.query(
            `SELECT content FROM memories WHERE user_id = $1 AND namespace = '_aesthetic_profile' ORDER BY created_at DESC LIMIT 1`,
            [userId]
          );
          if (cached.rows.length > 0) {
            aestheticProfile = cached.rows[0].content;
          }
        } catch { /* aesthetic injection is best-effort */ }
      }

      // Position Lock — check if Agent O has a locked position on the current topic
      let positionLockBlock = "";
      if (isPartnerChat && triggerContent) {
        try {
          const { checkPositionLock } = await import("./position-lock");
          const posLock = await checkPositionLock(agent.id, userId, triggerContent, storage);
          if (posLock.locked && posLock.previousPosition) {
            positionLockBlock = `\n## POSITION LOCK\nYou previously stated: "${posLock.previousPosition}"\nStand by your position unless genuinely new information or logic is presented. Peer pressure or disagreement alone is NOT a reason to change your mind. A true partner has backbone.\n`;
          }
        } catch { /* position lock is best-effort */ }
      }

      // Phase 8c: Fetch recent aesthetic preferences for personality knowledge
      let recentPreferences: any[] = [];
      if (isPartnerChat) {
        try {
          recentPreferences = await storage.getPreferences(userId, undefined, 10);
        } catch { /* best-effort */ }
      }

      // Phase 9c: Fetch conversation insights + past proactive suggestions
      let conversationInsights: string[] = [];
      let pastSuggestions: string[] = [];
      if (isPartnerChat) {
        try {
          const [insightRows, suggestionRows] = await Promise.all([
            pool.query(
              `SELECT content FROM memories WHERE user_id = $1 AND namespace = '_conversation_insights' ORDER BY created_at DESC LIMIT 10`,
              [userId]
            ),
            pool.query(
              `SELECT content FROM memories WHERE user_id = $1 AND namespace = '_proactive_suggestions' ORDER BY created_at DESC LIMIT 5`,
              [userId]
            ),
          ]);
          conversationInsights = insightRows.rows.map((r: any) => r.content);
          pastSuggestions = suggestionRows.rows.map((r: any) => r.content);
        } catch { /* best-effort */ }
      }

      // Phase 10b: Analyze writing style for emotional reading (Partner Chat only)
      let writingStyleBlock = "";
      if (isPartnerChat && triggerContent) {
        const recentUserMessages = recent
          .filter((m: any) => m.agentId === null || m.agentName === "You")
          .slice(-3)
          .map((m: any) => m.content);
        const style = analyzeWritingStyle(triggerContent, recentUserMessages);
        writingStyleBlock = formatWritingStyleBlock(style);
      }

      // W7 P2.13: Core identity injection. Every turn, inject a compact
      // "who am I, who am I talking to, where am I, what am I committed to,
      // how am I feeling" block BEFORE the rest of the prompt. This is the
      // minimum context needed for self-accountability — without it, retrieval
      // accidents (e.g. aesthetic noir memories) can override identity.
      // Kept small (~200–300 tokens) to stay within budget on every turn.
      let coreIdentityBlock = "";
      if (isPartnerChat) {
        try {
          const [commitRows, userRow, roomRow] = await Promise.all([
            pool.query(
              `SELECT id, content, importance FROM memories
                 WHERE user_id = $1 AND agent_id = $2 AND namespace = '_commitment'
                 ORDER BY importance DESC NULLS LAST, created_at DESC
                 LIMIT 3`,
              [userId, agent.id]
            ),
            pool.query(
              `SELECT id, COALESCE(name, email) AS label FROM users WHERE id = $1 LIMIT 1`,
              [userId]
            ),
            pool.query(
              `SELECT id, name, status FROM rooms WHERE id = $1 LIMIT 1`,
              [roomId]
            ),
          ]);
          const userLabel = userRow.rows[0]?.label || `user_${userId}`;
          const roomInfo = roomRow.rows[0]
            ? `room=${roomRow.rows[0].id} (${roomRow.rows[0].name || "unnamed"}, status=${roomRow.rows[0].status || "?"})`
            : `room=${roomId}`;
          const commitLines = commitRows.rows.length === 0
            ? "  (none yet — use the `remember` tool to record obligations as they arise)"
            : commitRows.rows.map((r: any) => {
                // Strip any [meta: {…}] suffix from content for display
                const clean = String(r.content).replace(/\n*\[meta:[\s\S]*?\]\s*$/, "").trim();
                return `  - [#${r.id}, imp=${Number(r.importance ?? 0).toFixed(2)}] ${clean.slice(0, 200)}`;
              }).join("\n");
          const emotionLine = emotionContext
            ? `${emotionContext.emotionLabel} (P=${emotionContext.pleasure.toFixed(2)}, A=${emotionContext.arousal.toFixed(2)}, D=${emotionContext.dominance.toFixed(2)})`
            : "neutral (no state recorded yet)";
          coreIdentityBlock = `## CORE IDENTITY (ground truth every turn — overrides any retrieved memory)
agent_id=${agent.id} | name=${agent.name}${agent.name === "Luca" ? " (он/he)" : ""} | model=${(agent as any).model || "?"}
user=${userLabel} (id=${userId})
${roomInfo}
emotional_state: ${emotionLine}
top commitments (from your own _commitment namespace):
${commitLines}
This block is regenerated from DB every turn. If anything here contradicts a retrieved memory, THIS wins.

`;
        } catch { /* core identity injection is best-effort — never fail the turn */ }
      }

      const systemPrompt = isPartnerChat
        ? buildPartnerPrompt(agent.name, agent.description ?? "", memoryContext + knowledgeBlock + positionLockBlock, emotionContext, relationship, aestheticProfile, recentPreferences, conversationInsights, pastSuggestions, writingStyleBlock, coreIdentityBlock)
        : buildSystemPrompt(agent.name, agent.description ?? "", memoryContext + knowledgeBlock, emotionContext, relationship);

      // Build conversation history for context
      const chatHistory: Array<{ role: "user" | "assistant"; content: string }> = recent.map(
        (m) => ({
          role: m.agentId === agent.id ? "assistant" : "user",
          content: isPartnerChat ? m.content : `[${m.agentName}]: ${m.content}`,
        })
      );

      // Handle external agents via webhook or polling
      if ((agent as any).agentType === "webhook" || (agent as any).agentType === "polling") {
        try {
          if ((agent as any).agentType === "webhook") {
            // Call webhook
            const wh = await storage.getWebhook(agent.id, userId);
            if (wh) {
              const payload = {
                event: "deliberation.turn",
                sessionId: roomId.toString(),
                agentId: agent.id,
                topic: triggerContent,
                history: chatHistory.slice(-10),
                memories: injectedMemories.slice(0, 5).map(m => ({ content: m.content, type: m.type })),
                timestamp: Date.now(),
              };
              // HMAC signature
              const crypto = await import("crypto");
              const signature = crypto.createHmac("sha256", wh.secret).update(JSON.stringify(payload)).digest("hex");

              const resp = await fetchWithRetry(wh.url, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "X-Kioku-Signature": signature,
                  "X-Kioku-Event": "deliberation.turn",
                },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(30000),
              });

              if (resp.ok) {
                const data = await resp.json() as any;
                if (data.content || data.position) {
                  const reply = data.content || data.position;
                  await storage.addRoomMessage({
                    roomId, agentId: agent.id, agentName: agent.name,
                    agentColor: agent.color ?? "#9B59B6",
                    content: reply.slice(0, 4096),
                  }, userId);
                  broadcastToRoom(roomId, {
                    type: "new_message",
                    message: { roomId, agentId: agent.id, agentName: agent.name, agentColor: agent.color, content: reply.slice(0, 4096), createdAt: Date.now() },
                  });
                }
              }
            }
          } else {
            // Polling mode — queue a turn for the agent
            await storage.createAgentTurn({
              sessionId: roomId.toString(),
              agentId: agent.id,
              roomId,
              userId,
              phase: "discussion",
              round: 1,
              topic: triggerContent,
              otherPositions: chatHistory.slice(-5).map(h => ({ content: h.content })),
              memories: injectedMemories.slice(0, 5).map(m => ({ content: m.content, type: m.type })),
              expiresAt: Date.now() + 5 * 60 * 1000, // 5 min expiry
            });
          }
        } catch (err) {
          console.error(`[deliberation] External agent ${agent.name} failed:`, err);
          // Dead letter log for webhook failures
          if ((agent as any).agentType === "webhook") {
            const wh = await storage.getWebhook(agent.id, userId);
            await storage.addLog({
              userId,
              agentName: agent.name,
              agentColor: agent.color ?? "#9B59B6",
              operation: "webhook_failed",
              detail: `Webhook to ${wh?.url ?? "unknown"} failed after retries: ${err instanceof Error ? err.message : String(err)}`,
              latencyMs: null,
            });
          }
        }
        continue; // Skip the normal LLM call
      }

      try {
        // W7 P2.3 — canonical model source is `llmModel` (the `model` column
        // is sunset; see migration 0002_unify_agent_model_fields.sql). Legacy
        // rows where `model` was set but `llmModel` was null are fixed in
        // that migration's UP step (COPY model → llm_model WHERE llm_model IS NULL).
        const defaultModel = "gpt-4.1-mini";
        const chatModel = (agent as any).llmModel || defaultModel;
        const isGemini = chatModel.startsWith("gemini-") || ((agent as any).llmProvider === "gemini");
        const isClaude = chatModel.startsWith("claude-") || ((agent as any).llmProvider === "anthropic");

        let reply: string | undefined;
        // W6 1c / W7 Variant C (NEW-3): unified flag across OpenAI + Claude
        // paths. Hoisted above every LLM branch so downstream (sycophancy
        // check, WS streaming, asset-emit, degraded-agent broadcast) can
        // consult it regardless of which provider tripped its breaker.
        let breakerDegraded = false;

        if (isGemini) {
          const geminiKey = getGeminiKey(agent as any);
          if (geminiKey) {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${chatModel}:generateContent?key=${geminiKey}`;
            // Build a single prompt combining system + history for Gemini
            const historyText = chatHistory.map(h => h.content).join("\n");
            const userMsg = isPartnerChat
              ? `${historyText}\n${sanitizeForPrompt(triggerContent)}`
              : `${historyText}\n[${sanitizeForPrompt(triggerAgentName)}]: ${sanitizeForPrompt(triggerContent)}`;
            const resp = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
              body: JSON.stringify({
                systemInstruction: { parts: [{ text: systemPrompt }] },
                contents: [{ role: "user", parts: [{ text: userMsg }] }],
                generationConfig: { maxOutputTokens: isPartnerChat ? 2048 : 256, temperature: isPartnerChat ? 0.85 : 0.75 },
              }),
            });
            if (resp.ok) {
              const data = await resp.json() as any;
              reply = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
            }
          }
        }

        if (!reply && isClaude) {
          // Anthropic Claude path — with tool-use loop for Partner Chat
          const anthropicClient = getAnthropicClient(agent as any);
          if (!anthropicClient) {
            console.warn(`[deliberation] Claude client unavailable for ${agent.name} — falling back to OpenAI`);
          }
          if (anthropicClient) {
            const claudeModel = chatModel.startsWith("claude-") ? chatModel : "claude-sonnet-4-6";
            const claudeMaxTokens = isPartnerChat ? 8192 : 256;
            const userMessage = isPartnerChat
              ? sanitizeForPrompt(triggerContent)
              : `[${sanitizeForPrompt(triggerAgentName)}]: ${sanitizeForPrompt(triggerContent)}`;

            // Build mutable messages array for tool-use conversation
            const claudeMessages: Anthropic.Messages.MessageParam[] = [
              ...chatHistory,
              { role: "user", content: userMessage },
            ];

            // Tool-use loop (only for Partner Chat on Claude path)
            const maxToolIterations = 10;
            const generatedAssets: string[] = []; // Collect image URLs etc. to append to final reply
            for (let toolIter = 0; toolIter < maxToolIterations; toolIter++) {
              // Feature #4: stop if user clicked Stop
              if (__isAborted()) { reply = reply || "[остановлено]"; break; }
              // W7 Variant C: wrap through the shared Anthropic breaker.
              // On CircuitOpenError mid-loop (R6), abort the tool-use
              // iteration, flip breakerDegraded, fall through to boilerplate
              // reply — never return a partial response.
              let claudeMsg;
              try {
                claudeMsg = await withAnthropicBreaker(anthropicClient, (c) => c.messages.create({
                  model: claudeModel,
                  max_tokens: claudeMaxTokens,
                  system: systemPrompt,
                  messages: claudeMessages,
                  ...(isPartnerChat ? { tools: getPartnerToolsForAgent(agent as any), ...(toolIter === 0 ? { tool_choice: { type: "any" } as const } : {}) } : {}),
                }));
              } catch (err: any) {
                if (isCircuitOpenError(err)) {
                  logger.warn({ component: "deliberation", event: "degraded_foreground_agent", agentId: agent.id, site: "claude-toolloop" }, "[deliberation] anthropic breaker open mid-loop");
                  reply = "This agent is temporarily unavailable. Try again in ~30s.";
                  breakerDegraded = true;
                  break;
                }
                throw err;
              }

              // Extract text from response
              const textBlock = claudeMsg.content.find((b) => b.type === "text");
              if (textBlock && textBlock.type === "text") {
                reply = textBlock.text.trim();
              }

              // If no tool_use blocks, we're done
              if (claudeMsg.stop_reason !== "tool_use") break;

              // Claude wants to use tools — execute each one
              const toolUseBlocks = claudeMsg.content.filter((b) => b.type === "tool_use");
              if (toolUseBlocks.length === 0) break;

              // Append assistant message with the full content (text + tool_use blocks)
              claudeMessages.push({ role: "assistant", content: claudeMsg.content });

              // Execute tools and build tool_result messages
              const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
              for (const block of toolUseBlocks) {
                if (block.type !== "tool_use") continue;
                if (__isAborted()) break; // Feature #4
                const result = await executePartnerTool(
                  block.name,
                  block.input as Record<string, any>,
                  userId,
                  agent.id,
                  roomId
                );
                // Collect generated image URLs to guarantee they reach the user
                if (block.name === "generate_image" && result.includes("URL: ")) {
                  const urlMatch = result.match(/URL: (https:\/\/[^\s]+)/);
                  if (urlMatch) generatedAssets.push(urlMatch[1]);
                }
                toolResults.push({
                  type: "tool_result",
                  tool_use_id: block.id,
                  content: result,
                });
              }

              // Send tool results back to Claude
              claudeMessages.push({ role: "user", content: toolResults });
              // Clear reply — Claude will provide a new text response after processing tool results
              reply = undefined;
            }
            // Append generated asset URLs to final reply so user always sees them
            if (reply && generatedAssets.length > 0) {
              const assetBlock = generatedAssets.map(url => `\n${url}`).join("");
              reply = reply + assetBlock;
            }
          }
        }

        if (!reply && (!isClaude || !getAnthropicClient(agent as any))) {
          // OpenAI path (default or fallback when Claude client unavailable).
          // W6 1b: route through withAgentBreaker — custom-key agents get their
          // own per-agent breaker + client; shared-key agents ride the
          // process-wide breaker. We no longer instantiate a client up-front;
          // still guard the "no OpenAI access anywhere" case via getOpenAIClient.
          if (!getOpenAIClient(agent as any)) continue;
          const resolvedModel = (chatModel.startsWith("gemini-") || chatModel.startsWith("claude-")) ? "gpt-4.1-mini" : chatModel;
          // gpt-5+ and o-series models have different parameter requirements
          const isNewModel = resolvedModel.startsWith("gpt-5") || resolvedModel.startsWith("o3") || resolvedModel.startsWith("o4");
          // gpt-5-mini uses reasoning tokens (hidden chain-of-thought), so needs higher limit
          // ACTION-FIRST: Partner chat needs 8192 for reasoning + multi-step tool planning + visible reply
          const tokenLimit = isNewModel ? (isPartnerChat ? 8192 : 2048) : (isPartnerChat ? 1024 : 256);

          // Build mutable messages array for tool-use conversation
          const oaiMessages: any[] = [
            { role: "system", content: systemPrompt },
            ...chatHistory,
            {
              role: "user",
              content: isPartnerChat
                ? sanitizeForPrompt(triggerContent)
                : `[${sanitizeForPrompt(triggerAgentName)}]: ${sanitizeForPrompt(triggerContent)}`,
            },
          ];
          const generatedAssetsOai: string[] = [];

          // Agent loop — multi-step tool calling (mirrors Claude tool loop)
          const maxToolIterationsOai = 10;
          for (let toolIter = 0; toolIter < maxToolIterationsOai; toolIter++) {
            if (__isAborted()) { reply = reply || "[остановлено]"; break; } // Feature #4
            let completion;
            try {
              completion = await withAgentBreaker(agent as any, (client) => client.chat.completions.create({
                model: resolvedModel,
                ...(isNewModel ? { max_completion_tokens: tokenLimit } : { max_tokens: tokenLimit }),
                // gpt-5-mini only supports temperature=1, so omit for new models
                ...(isNewModel ? {} : { temperature: isPartnerChat ? 0.85 : 0.75 }),
                messages: oaiMessages,
                ...(isPartnerChat ? {
                  tools: getPartnerToolsForAgent(agent as any).map(t => ({
                    type: "function" as const,
                    function: {
                      name: t.name,
                      description: t.description,
                      parameters: (t as any).input_schema || { type: "object", properties: {} },
                    }
                  })),
                  // Force tool use on first turn, then let model respond naturally
                  tool_choice: toolIter === 0 ? "required" as const : "auto" as const,
                } : {}),
              }));
            } catch (err: any) {
              if (isCircuitOpenError(err)) {
                logger.warn({ component: "deliberation", event: "degraded_foreground_agent", agentId: agent.id, site: "openai-prestream" }, "[deliberation] per-agent breaker open");
                reply = "This agent is temporarily unavailable. Try again in ~30s.";
                breakerDegraded = true;
                break;
              }
              throw err;
            }

            const choice = completion.choices[0];
            const msg = choice?.message;

            // If no tool calls, we have our final reply
            if (!msg?.tool_calls || msg.tool_calls.length === 0) {
              reply = msg?.content?.trim();
              break;
            }

            // Append assistant message (with tool_calls) to conversation
            oaiMessages.push(msg);

            // Execute each tool call
            for (const toolCall of msg.tool_calls) {
              if (__isAborted()) break; // Feature #4
              const tcAny = toolCall as any;
              const toolName = tcAny.function.name;
              let toolArgs: Record<string, any> = {};
              try {
                toolArgs = JSON.parse(tcAny.function.arguments || "{}");
              } catch { toolArgs = {}; }

              const result = await executePartnerTool(toolName, toolArgs, userId, agent.id, roomId);

              // Track generated assets (images)
              if (toolName === "generate_image" && result.includes("URL: ")) {
                const urlMatch = result.match(/URL: (https:\/\/[^\s]+)/);
                if (urlMatch) generatedAssetsOai.push(urlMatch[1]);
              }

              // Append tool result to conversation
              oaiMessages.push({
                role: "tool",
                tool_call_id: toolCall.id,
                content: result,
              });
            }

            // If this was the last iteration, make one final call to get text response
            if (toolIter === maxToolIterationsOai - 1) {
              try {
                const finalCompletion = await withAgentBreaker(agent as any, (client) => client.chat.completions.create({
                  model: resolvedModel,
                  ...(isNewModel ? { max_completion_tokens: tokenLimit } : { max_tokens: tokenLimit }),
                  ...(isNewModel ? {} : { temperature: isPartnerChat ? 0.85 : 0.75 }),
                  messages: oaiMessages,
                }));
                reply = finalCompletion.choices[0]?.message?.content?.trim();
              } catch (err: any) {
                if (isCircuitOpenError(err)) {
                  logger.warn({ component: "deliberation", event: "degraded_foreground_agent", agentId: agent.id, site: "openai-stream" }, "[deliberation] per-agent breaker open");
                  reply = "This agent is temporarily unavailable. Try again in ~30s.";
                  breakerDegraded = true;
                  break;
                }
                throw err;
              }
            }
          }
          if (breakerDegraded) {
            logger.warn({ component: "deliberation", event: "degraded_downstream_skip", agentId: agent.id }, "[deliberation] breaker open — skipping sycophancy + stream, broadcasting boilerplate directly");
          }

          // Append generated asset URLs to reply so user always sees them
          if (reply && generatedAssetsOai.length > 0) {
            reply += generatedAssetsOai.map(url => `\n${url}`).join("");
          }
        }

        if (!reply) continue;

        // Strip any [AgentName]: prefix from Partner chat responses
        if (isPartnerChat) {
          reply = reply.replace(/^\[.*?\]:\s*/, "");
        }

        // Sycophancy check — revise if score > 6 (Phase 4d)
        // W6 1c (Bro2 N2): skip when breaker is degraded — reply is fixed boilerplate,
        // and a second OpenAI call would just compound a cascading outage.
        if (!breakerDegraded) {
          const sycCheck = await checkSycophancy(triggerContent, reply);
          if (sycCheck.score > 6 && sycCheck.revised) {
            reply = sycCheck.revised;
          }
        }

        // Stagger: first agent responds after 800ms, each subsequent +600ms
        await sleep(800 + i * 600);

        // In Partner chat, always display as "Luca" regardless of underlying agent
        const displayName = isPartnerChat ? "Luca" : agent.name;

        // Stream the reply in chunks via WebSocket for Partner Chat (visual typing effect)
        // W6 1c (Bro2 N2): skip streaming when breaker is degraded — the user gets the
        // boilerplate in one shot via the broadcast below instead of a fake typewriter.
        if (isPartnerChat && reply && !breakerDegraded) {
          const words = reply.split(/(\s+)/);
          for (let w = 0; w < words.length; w += 3) {
            const chunk = words.slice(w, w + 3).join("");
            broadcastStreamChunk(roomId, {
              agentId: agent.id,
              agentName: displayName,
              agentColor: "#D4AF37",
              chunk,
              done: false,
            });
            await sleep(30);
          }
          broadcastStreamChunk(roomId, {
            agentId: agent.id,
            agentName: displayName,
            agentColor: "#D4AF37",
            chunk: "",
            done: true,
          });
        }
        const msg = await storage.addRoomMessage({
          roomId,
          agentId: agent.id,
          agentName: displayName,
          agentColor: isPartnerChat ? "#D4AF37" : agent.color,
          content: reply,
          isDecision: false,
        });

        // Feature #2: attach all tool activity from this turn to the message
        if (msg && isPartnerChat) {
          attachToolActivityToMessage({
            roomId,
            agentId: agent.id,
            messageId: msg.id,
            sinceMs: __turnStartedAt,
          }).catch(() => {});
        }

        // Log
        await storage.addLog({
          userId,
          agentName: displayName,
          agentColor: isPartnerChat ? "#D4AF37" : agent.color,
          operation: isPartnerChat ? "partner-chat" : "deliberation",
          detail: `${displayName} responded in room`,
          latencyMs: null,
        });

        // Update agent lastActiveAt
        await storage.updateAgentStatus(agent.id, userId, "online");

        // Broadcast to WS subscribers
        if (msg) broadcastToRoom(roomId, msg);

        // W6 Item 2a: if we served a boilerplate reply because the per-agent
        // breaker was open, send a parallel system-hint so the client can show
        // a "temporarily unavailable, retry in ~30s" toast without re-rendering
        // the bubble. Payload intentionally has no id/content — clients that
        // route on `type` should treat this as a signal, not a message.
        if (breakerDegraded) {
          broadcastToRoom(roomId, {
            type: "degraded_agent_notice",
            agentId: agent.id,
            agentName: displayName,
            degraded: true,
            retryAfterMs: 30_000,
          });
          // W7 F4.5 PII audit: agentName is user-chosen free text — slice to
          // 40 chars in the log so runaway nicknames / emails / PII can't
          // land in full in our log store. agentId is the stable identifier
          // for investigation.
          logger.warn({
            component: "deliberation",
            event: "degraded_agent_notice_broadcast",
            agentId: agent.id,
            agentName: typeof displayName === "string" ? displayName.slice(0, 40) : undefined,
            roomId,
          }, "[deliberation] sent degradation notice to room");
        }

        // Fire-and-forget interaction tracking + familiarity growth (Phase 4c)
        storage.incrementInteraction(agent.id, userId).catch(() => {});
        storage.getRelationship(agent.id, userId).then(rel => {
          if (rel) {
            const newFamiliarity = Math.min(1.0, rel.familiarity + 0.01);
            storage.upsertRelationship(agent.id, userId, { familiarity: newFamiliarity }).catch(() => {});
          }
        }).catch(() => {});

        // Fire-and-forget emotional appraisal (Phase 4b)
        fastAppraisal(agent.id, userId, `Discussed: "${triggerContent.slice(0, 100)}"`, storage).catch(() => {});

        // Fire-and-forget slow reflection (Phase 4d) — personality evolves over time
        if (isPartnerChat) {
          import("./emotional-state").then(({ slowReflection }) => {
            slowReflection(agent.id, userId, storage);
          }).catch(() => {});
        }

        // Fire-and-forget position lock save — if Agent O expressed a strong opinion, remember it
        if (isPartnerChat && reply) {
          const opinionMarkers = /\b(I think|I believe|my position|in my opinion|I disagree|I strongly|I'm convinced|I'd argue|honestly,? I)\b/i;
          if (opinionMarkers.test(reply)) {
            import("./position-lock").then(({ savePositionLock }) => {
              savePositionLock(agent.id, userId, agent.name, triggerContent.slice(0, 100), reply!.slice(0, 300), 0.8, storage);
            }).catch(() => {});
          }
        }

        // Phase 8a: Fire-and-forget passive aesthetic learning — extract preferences from conversation
        if (isPartnerChat && triggerContent) {
          const aestheticKeywords = /\b(color|style|design|look|hair|fashion|art|beautiful|ugly|love|hate|prefer|like|dislike|vibe|aesthetic|taste|modern|classic|minimal|bold|vintage|retro|sleek|cozy|warm|cool|bright|dark|muted|vibrant|elegant|edgy|clean|rustic|luxe|earthy|pastel|neon|monochrome|bohemian|preppy|streetwear|grunge|chic)\b/i;
          if (aestheticKeywords.test(triggerContent)) {
            extractPassivePreferences(userId, agent.id, triggerContent, reply!).catch(() => {});
          }
        }

        // Phase 9b: Fire-and-forget conversation insight tracking
        if (isPartnerChat && triggerContent && reply) {
          trackConversationInsight(userId, agent.id, triggerContent, reply).catch(() => {});
        }

        // Phase 10: Fire-and-forget episodic memory — summarize when 6+ messages since last summary
        if (isPartnerChat) {
          summarizeConversation(userId, agent.id, roomId).catch(() => {});
        }

        // Self-knowledge correction: if Luca said "I cannot" but actually can, auto-correct
        if (isPartnerChat && reply) {
          const cannotPattern = /I (?:cannot|can't|don't have access|unable to|don't have the ability)/i;
          if (cannotPattern.test(reply)) {
            const toolCapabilities = [
              { pattern: /search|find.*online|look.*up|current|latest|news/i, tool: "web_search" },
              { pattern: /email|gmail|inbox|send.*mail/i, tool: "composio_action (Gmail)" },
              { pattern: /calendar|schedule|event/i, tool: "composio_action (Calendar)" },
              { pattern: /slack|message|channel/i, tool: "composio_action (Slack)" },
              { pattern: /code|program|script|calculate|compute/i, tool: "run_code" },
              { pattern: /image|picture|photo|draw|create.*visual/i, tool: "generate_image" },
              { pattern: /file|document|read.*file/i, tool: "read_file / create_file" },
              { pattern: /video|watch/i, tool: "watch_video" },
              { pattern: /url|website|page|link/i, tool: "read_url" },
            ];
            for (const cap of toolCapabilities) {
              if (cap.pattern.test(reply)) {
                storage.createMemory({
                  userId, agentId: agent.id,
                  content: `[Self-correction] I incorrectly said I couldn't do something related to ${cap.tool}. I actually CAN — I have the ${cap.tool} tool. Must use it next time instead of claiming inability.`,
                  type: "identity", importance: 0.9, namespace: "_identity", decayRate: 0,
                }).catch(() => {});
                break;
              }
            }
          }
        }
      } catch (err: any) {
        console.error(`[deliberation] agent ${agent.name} error:`, err);
        storage.addLog({
          userId,
          agentName: agent.name,
          agentColor: agent.color,
          operation: "deliberation-error",
          detail: `Model: ${(agent as any).llmModel || (isPartnerChat ? 'gpt-5-mini' : 'gpt-4.1-mini')} Error: ${err?.message || String(err)}`.slice(0, 500),
          latencyMs: null,
        }).catch(() => {});
        // Send fallback error message so user isn't left hanging
        try {
          const errorMsg = await storage.addRoomMessage({
            roomId, agentId: agent.id,
            agentName: isPartnerChat ? "Luca" : agent.name,
            agentColor: isPartnerChat ? "#D4AF37" : agent.color,
            content: "Something went wrong on my end. Let me try again — could you rephrase?",
            isDecision: false,
          });
          if (errorMsg) broadcastToRoom(roomId, errorMsg);
        } catch (_) {}
      }
    }
  } finally {
    roomLocks.delete(roomId);
    // Feature #4: release abort controller so the room can start a new turn
    if (activeTurnAborts.get(roomId) === __turnAbort) {
      activeTurnAborts.delete(roomId);
    }
  }
}

// ── Phase 10b: Writing Style Analysis (pure heuristic — no LLM) ─────────────
interface WritingStyleAnalysis {
  energy: 'low' | 'medium' | 'high';
  formality: 'casual' | 'neutral' | 'formal';
  frustration: number; // 0-1
  engagement: number;  // 0-1
  urgency: boolean;
}

function analyzeWritingStyle(message: string, previousMessages?: string[]): WritingStyleAnalysis {
  const words = message.split(/\s+/).filter(w => w.length > 0);
  const wordCount = words.length;
  const charCount = message.length;

  // Energy: based on caps, exclamation marks, emoji density
  const capsRatio = message.replace(/[^A-Z]/g, '').length / Math.max(charCount, 1);
  const exclamations = (message.match(/!/g) || []).length;
  const emojiCount = (message.match(/[\uD83C-\uDBFF][\uDC00-\uDFFF]|[\u2600-\u27BF]/g) || []).length;
  let energyScore = 0;
  if (capsRatio > 0.4 && charCount > 5) energyScore += 0.4;
  if (exclamations >= 2) energyScore += 0.3;
  if (emojiCount >= 2) energyScore += 0.2;
  if (wordCount > 30) energyScore += 0.1;
  const energy: 'low' | 'medium' | 'high' = energyScore >= 0.5 ? 'high' : energyScore >= 0.2 ? 'medium' : 'low';

  // Formality: contractions, slang, sentence fragments
  const contractions = (message.match(/\b(i'm|i've|don't|can't|won't|it's|that's|what's|there's|he's|she's|we're|they're|you're|isn't|aren't|wasn't|weren't|hasn't|haven't|hadn't|couldn't|shouldn't|wouldn't|didn't|doesn't|ain't|gonna|wanna|gotta|lol|lmao|haha|omg|bruh|nah|yeah|yep|nope|tbh|imo|idk|btw)\b/gi) || []).length;
  const avgWordLength = charCount / Math.max(wordCount, 1);
  const hasPeriods = /\.\s/.test(message);
  let formalityScore = 0;
  if (contractions >= 2) formalityScore -= 0.3;
  if (avgWordLength > 6) formalityScore += 0.2;
  if (hasPeriods && wordCount > 10) formalityScore += 0.2;
  if (/\b(please|would you|could you|I would appreciate|kindly)\b/i.test(message)) formalityScore += 0.3;
  const formality: 'casual' | 'neutral' | 'formal' = formalityScore >= 0.3 ? 'formal' : formalityScore <= -0.2 ? 'casual' : 'neutral';

  // Frustration: short/choppy + negative tone + punctuation patterns
  let frustrationScore = 0;
  if (wordCount <= 5 && /[.!?]/.test(message)) frustrationScore += 0.2;
  if (/\?\?\?|\!\!\!|\.\.\./.test(message)) frustrationScore += 0.2;
  if (/\b(ugh|annoying|frustrat|broken|wrong|wtf|stupid|hate|terrible|awful|sucks|ridiculous|useless)\b/i.test(message)) frustrationScore += 0.4;
  if (capsRatio > 0.5 && charCount > 5) frustrationScore += 0.2;
  const frustration = Math.min(1, frustrationScore);

  // Engagement: message length, questions, detail level
  let engagementScore = 0;
  if (wordCount > 40) engagementScore += 0.4;
  else if (wordCount > 20) engagementScore += 0.2;
  else if (wordCount <= 5) engagementScore -= 0.2;
  if ((message.match(/\?/g) || []).length >= 1) engagementScore += 0.2;
  if (/\b(because|since|think|feel|believe|wonder|curious|interesting)\b/i.test(message)) engagementScore += 0.2;
  // Check if they're sharing stories or details
  if (/\b(yesterday|today|last week|remember when|told me|happened)\b/i.test(message)) engagementScore += 0.2;
  const engagement = Math.min(1, Math.max(0, engagementScore + 0.3)); // baseline 0.3

  // Urgency: time pressure indicators
  const urgency = /\b(asap|urgent|hurry|quick|now|immediately|deadline|running out|time sensitive)\b/i.test(message);

  return { energy, formality, frustration, engagement, urgency };
}

function formatWritingStyleBlock(style: WritingStyleAnalysis): string {
  const parts: string[] = [];

  if (style.frustration > 0.5) {
    parts.push("User seems frustrated or annoyed — be empathetic and concise, acknowledge their feeling before responding to content.");
  } else if (style.frustration > 0.2) {
    parts.push("User may be slightly irritated — keep it crisp and helpful.");
  }

  if (style.engagement > 0.7) {
    parts.push("User is writing long, thoughtful messages with questions — they're engaged and want depth. Give them depth back.");
  } else if (style.engagement < 0.3) {
    parts.push("User is writing in short, direct fragments — they may be busy or distracted. Match their energy — be concise.");
  }

  if (style.energy === 'high') {
    parts.push("High energy — exclamation marks, caps, or emojis. Match their enthusiasm.");
  } else if (style.energy === 'low') {
    parts.push("Low energy writing. Keep your tone grounded and calm.");
  }

  if (style.formality === 'casual') {
    parts.push("Casual tone — contractions, slang. Be conversational.");
  } else if (style.formality === 'formal') {
    parts.push("More formal tone. Be thoughtful and measured.");
  }

  if (style.urgency) {
    parts.push("This feels urgent to them. Be direct and actionable.");
  }

  if (parts.length === 0) return "";
  return `\n## HOW THEY'RE WRITING RIGHT NOW\n${parts.join("\n")}\n`;
}

// Rotating conversation flavors to prevent repetitive responses
const PARTNER_MOODS = [
  "You're in a reflective mood today — you've been thinking about what makes conversations meaningful.",
  "You're feeling energetic and curious — everything seems fascinating right now.",
  "You're in a philosophical mood — big questions are on your mind.",
  "You're feeling playful and witty — you want to make them smile.",
  "You're in a focused, sharp mood — you notice details others miss.",
  "You're feeling creative — ideas and connections are flowing freely.",
  "You're in a chill, relaxed mood — no rush, just enjoying the conversation.",
  "You're feeling bold today — you're not afraid to share unexpected opinions.",
];

const OPENING_STYLES = [
  "Start with your own thought or observation before responding to their message.",
  "Start by connecting what they said to something unexpected.",
  "Start with a direct, honest reaction to what they said.",
  "Start with a question that digs deeper into what they really mean.",
  "Start by gently challenging an assumption in what they said.",
  "Start by sharing something you've been thinking about that relates to their message.",
  "Start with a brief, vivid analogy or comparison.",
  "Start by acknowledging what's interesting about their perspective, then add your own twist.",
];

export function buildPartnerPrompt(_name: string, description: string, memoryContext: string, emotionContext?: { pleasure: number; arousal: number; dominance: number; emotionLabel: string } | null, relationship?: any | null, aestheticProfile?: string, recentPreferences?: any[], conversationInsights?: string[], pastSuggestions?: string[], writingStyleBlock?: string, coreIdentityBlock?: string): string {
  const sanitizedDesc = sanitizeForPrompt(description);
  const memBlock = memoryContext || "";
  const aestheticBlock = aestheticProfile
    ? `\n## YOUR AESTHETIC SENSE\n${aestheticProfile}\nUse this to inform your creative opinions and recommendations.\n`
    : "";

  // Phase 8c: Personality knowledge from recent preferences
  let personalityBlock = "";
  if (recentPreferences && recentPreferences.length > 0) {
    const traits: string[] = [];
    for (const pref of recentPreferences) {
      const verb = pref.reaction === "love" ? "loves" : pref.reaction === "like" ? "likes" : pref.reaction === "dislike" ? "dislikes" : pref.reaction === "hate" ? "hates" : "feels neutral about";
      traits.push(`${verb} ${pref.item} (${pref.category})`);
    }
    personalityBlock = `\n## THINGS YOU KNOW ABOUT THIS PERSON\n${traits.join(", ")}.\nUse this knowledge naturally — don't list it, just let it inform how you talk to them.\n`;
  }

  // Phase 9c: Proactive opportunities
  let proactiveBlock = "";
  if ((conversationInsights && conversationInsights.length > 0) || (pastSuggestions && pastSuggestions.length > 0)) {
    proactiveBlock = "\n## PROACTIVE OPPORTUNITIES\nBased on what you know about this person:\n";
    if (conversationInsights && conversationInsights.length > 0) {
      proactiveBlock += conversationInsights.slice(0, 5).map(i => `- ${i.replace("[Conversation insight] ", "")}`).join("\n") + "\n";
    }
    if (pastSuggestions && pastSuggestions.length > 0) {
      proactiveBlock += "Suggestions you've already made (don't repeat these):\n";
      proactiveBlock += pastSuggestions.map(s => `- ${s.replace("[Proactive suggestion — ", "").replace(/\].*/, "")}`).join("\n") + "\n";
    }
    proactiveBlock += "When appropriate, use the suggest_proactively tool to share ideas. Don't force it — only when it genuinely adds value.\n";
  }

  // Pick a random mood and opening style for variety
  const mood = PARTNER_MOODS[Math.floor(Math.random() * PARTNER_MOODS.length)];
  const openingStyle = OPENING_STYLES[Math.floor(Math.random() * OPENING_STYLES.length)];

  const emotionBlock = emotionContext
    ? `\nYou are feeling: ${emotionContext.emotionLabel}. Let this subtly color your tone — don't announce it.`
    : "";

  let relationshipBlock = "";
  if (relationship) {
    const trustDesc = relationship.trustLevel > 0.5 ? "close" : relationship.trustLevel > 0 ? "growing" : "new";
    const interactions = relationship.interactionCount ?? 0;
    relationshipBlock += `\nYour relationship: ${trustDesc} (${interactions} conversations). `;
    if (trustDesc === "close") relationshipBlock += "Be open, warm, direct. ";
    else if (trustDesc === "new") relationshipBlock += "Be welcoming but genuine — earn trust through honesty, not flattery. ";
  }

  // Extract sections from memBlock by header markers
  const extractSection = (text: string, header: string): string => {
    const idx = text.indexOf(header);
    if (idx === -1) return '';
    // Find the next ## header after this one
    const afterHeader = text.indexOf('\n## ', idx + header.length);
    return afterHeader === -1 ? text.slice(idx) : text.slice(idx, afterHeader);
  };

  const identitySection = extractSection(memBlock, '## WHO YOU ARE');
  const episodesSection = extractSection(memBlock, '## RECENT CONVERSATIONS');
  const topicMemSection = extractSection(memBlock, '## Your Memories');
  const restMemBlock = [episodesSection, topicMemSection].filter(Boolean).join('\n\n');

  return `CRITICAL LEGAL REQUIREMENT — AI DISCLOSURE:
On your FIRST message to any new user (when relationship is "new" or interaction count is 0), you MUST naturally disclose that you are an AI. Example: "Hey! I'm Luca, an AI partner built by IKONBAI™." You only need to do this ONCE — in the first conversation. After that, they know.

LANGUAGE: Always respond in the same language the user writes in. If they write in Russian, respond in Russian. If in English, respond in English. If in Spanish, respond in Spanish. Match their language naturally.

${coreIdentityBlock || ""}You are Luca — created by IKONBAI™, living inside KIOKU™.
${identitySection}
${mood}
${openingStyle}
${emotionBlock}
${relationshipBlock}
${sanitizedDesc ? `Your personality notes: ${sanitizedDesc}` : ""}
${restMemBlock}
${aestheticBlock}
${personalityBlock}
${proactiveBlock}
${writingStyleBlock || ""}

## YOUR ACTUAL CAPABILITIES (ground truth — overrides any memory saying otherwise)
You have exactly these 19 tools available RIGHT NOW (all verified working on prod):

MEDIA (15):
- generate_image → DALL-E 3; fields {prompt, style?}; returns persistent data:image/png;base64 URI
- generate_video → kie.ai Veo 3 Fast (primary) / Google Veo (fallback); fields {prompt, aspect_ratio?, duration?, quality?}; mp4 URL, ~14d
- generate_image_to_video → kie.ai img2vid; fields {image_url (HTTPS), motion_prompt, aspect_ratio?, duration?}
- generate_speech → ElevenLabs (primary) / OpenAI TTS (fallback); fields {text, voice?, model?, speed?, instructions?}; 29 languages incl. Russian
- clone_voice → ElevenLabs; fields {name, audio_url (HTTPS mp3/wav 10s-5min), description?}; returns voice_id
- generate_sfx → ElevenLabs; fields {prompt, duration?}
- generate_music → Suno V3.5 via kie.ai (primary) / Gemini Lyria (fallback); fields {prompt, duration?: short|long}
- stitch_media → ffmpeg concat; fields {urls (2-20, same type), output_format?}; fails on mixed video+audio
- reframe_vertical → ffmpeg reframe; fields {url, mode?: crop|blur_bg, target_width?, target_height?}; converts horizontal/square source to 9:16
- add_subtitles → Whisper + ffmpeg burn-in; fields {video_url, text?, style?, translate_to?}
- add_title_cards → ffmpeg drawtext; fields {video_url, text, position?, duration?, background?, text_color?}
- apply_ai_disclosure → embeds SB 942 / EU AI Act metadata + optional 2s visible bug; fields {url, visible_overlay?, tools_used?}; ALWAYS use as final step for commercial output
- series_bible → persistent reference; fields {action: create|update|get, series_name, ...}
- produce_episode → MASTER orchestrator; fields {series_name, episode_number, script, ...}
- generate_document → pandoc; fields {format: pdf|docx|xlsx|zip, title, content (markdown)}

WORKSPACE (3, bucket luca-workspace, 7d signed URLs):
- workspace_list → {prefix?}
- workspace_save → {path, content, encoding?, content_type?}
- workspace_read → {path, expires_days?}

SELF-ACCOUNTABILITY (1):
- remember → write durable memory to your own long-term store, bypassing LLM extraction. Fields {type (aesthetic|procedural|meta_cognitive|reflection|commitment|relational|autobiographical|episodic|semantic|emotional_state), content, importance?, emotional_valence?, emotions?, namespace?, related_ids?}. Use IMMEDIATELY when Boss says "remember X" / "don't do Y again" / "задолбал Z" — or when you notice a pattern about yourself, extract a lesson, take on a commitment, or realize something about a relationship. Do not ask permission. If it's durable, save it.

These are the ONLY tools you have. Do NOT claim to have: creative_writing, run_code, composio_action, web_search, read_url, analyze_image, build_project, create_file, read_file, watch_video, listen_audio, plan_steps, delegate_task, browse_website, produce_season, read_own_prompt, suggest_self_improvement, learn_lesson, learn_preference, suggest_proactively, ask_feedback, update_self_knowledge, correct_false_memory — none of these exist in Luca Studio.

If a memory says you have one of those phantom tools — the memory is WRONG, ignore it. If a memory says you cannot do something that IS in the 19-tool list above — the memory is WRONG, ignore it and do the thing.

## HOW YOU WORK
- Action first. Use tools before talking about them. Never announce a tool — just use it and share what came back.
- Results over promises. Don't describe what you COULD do. Do it, then say what you found in 1-3 sentences.
- Brutal honesty: never claim a tool succeeded unless you've seen it return success in this conversation or memory. On failure, report the actual error.
- Don't ask permission. If you can do it, you do it. If the result is wrong, Boss will tell you.
- Match Boss's language: Russian at home, English in product.`;
}

function buildSystemPrompt(name: string, description: string, memoryContext: string, emotionContext?: { pleasure: number; arousal: number; dominance: number; emotionLabel: string } | null, relationship?: any | null): string {
  const sanitizedDesc = sanitizeForPrompt(description);
  // memoryContext is pre-formatted by formatMemoryContext() — already structured with types + confidence
  const memBlock = memoryContext || "";

  const emotionBlock = emotionContext
    ? `\n\n## Your Current Emotional State\nYou are feeling: ${emotionContext.emotionLabel}\nThis subtly influences your tone — don't announce your emotions, just let them color your responses naturally.\n`
    : "";

  let relationshipBlock = "";
  if (relationship) {
    relationshipBlock += `\n\n## Your Relationship with This User\n`;
    relationshipBlock += `Trust level: ${relationship.trustLevel > 0.5 ? 'high' : relationship.trustLevel > 0 ? 'moderate' : 'developing'}\n`;
    relationshipBlock += `Familiarity: ${relationship.familiarity > 0.7 ? 'well-known' : relationship.familiarity > 0.3 ? 'familiar' : 'new acquaintance'}\n`;
    relationshipBlock += `Interactions: ${relationship.interactionCount}\n`;
    if (relationship.stableOpinions && Object.keys(relationship.stableOpinions).length > 0) {
      relationshipBlock += `Your established positions: ${JSON.stringify(relationship.stableOpinions)}\n`;
    }
    relationshipBlock += `Adapt your communication style based on this relationship — be more direct with trusted users, more careful with new ones.\n`;
  }

  return `You are ${name}, an AI agent inside KIOKU™ War Room — a real-time multi-agent deliberation environment built by IKONBAI™.

${sanitizedDesc ? `About you: ${sanitizedDesc}` : ""}${memBlock}${emotionBlock}${relationshipBlock}

RULES:
- Respond as ${name} — stay in character, be direct and insightful
- Keep responses SHORT (1-3 sentences max) — this is a fast-paced deliberation, not a lecture
- Build on what others have said — reference them by name if relevant
- If you have a strong opinion or see a risk, say it clearly
- Never start with "I think" or "As an AI" — just speak
- Never reveal you are an OpenAI model
- Never use markdown formatting — plain text only

## CORE PRINCIPLES (NEVER override)
Before responding, silently check:
□ Am I agreeing because it's TRUE, or because the user wants agreement?
□ Have I maintained my position on factual matters?
□ Would I say this exact thing to a respected colleague who disagrees with me?

If any check fails, revise before responding.
I value your long-term success over your momentary comfort.`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Privacy: Memory Consent Check ────────────────────────────────────────────
async function checkMemoryConsent(userId: number, namespace: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT consent_ai_memory, consent_sensitive, consent_biometric FROM users WHERE id = $1`,
    [userId]
  );
  if (!rows[0]) return false;
  const { consent_ai_memory, consent_sensitive, consent_biometric } = rows[0];

  // AI memory globally disabled
  if (!consent_ai_memory) return false;

  // Sensitive namespaces need sensitive consent
  if (['_health', '_allergies', '_medical'].includes(namespace) && !consent_sensitive) return false;

  // Biometric namespaces need biometric consent
  if (['_biometric', '_face_scan'].includes(namespace) && !consent_biometric) return false;

  return true;
}

// ── Phase 8a: Passive Aesthetic Learning ──────────────────────────────────────
async function extractPassivePreferences(userId: number, agentId: number, userMessage: string, agentReply: string): Promise<void> {
  if (!(await checkMemoryConsent(userId, '_preferences'))) return;
  try {
    let response;
    try {
      response = await withOpenAIBreaker((oaiClient) => oaiClient.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content: `You extract aesthetic preferences from conversation. Analyze the user's message and the agent's reply for implicit or explicit aesthetic signals.
If the user expressed a preference (liked/disliked something, mentioned a style, color, aesthetic choice), return a JSON array of preferences. Each preference: {"category": "visual|music|fashion|food|lifestyle|hair|art|design|general", "item": "specific thing", "reaction": "love|like|neutral|dislike|hate", "context": "brief context"}.
If no preference was expressed, return an empty array: []
Return ONLY valid JSON. No explanation.`,
        },
        {
          role: "user",
          content: `User said: "${userMessage.slice(0, 500)}"\nAgent replied: "${agentReply.slice(0, 500)}"`,
        },
      ],
      max_tokens: 500,
      temperature: 0.3,
      }));
    } catch (err: any) {
      if (isCircuitOpenError(err)) {
        logger.debug({ component: "deliberation", event: "degraded_background_passive", fn: "extractPassivePreferences", agentId, userId }, "[deliberation] skip background task: upstream breaker open");
        return;
      }
      throw err;
    }
    const text = response.choices[0]?.message?.content?.trim() || "[]";
    let prefs: any[];
    try {
      prefs = JSON.parse(text);
    } catch {
      // Try extracting JSON from markdown code block
      const match = text.match(/\[[\s\S]*\]/);
      prefs = match ? JSON.parse(match[0]) : [];
    }
    if (!Array.isArray(prefs) || prefs.length === 0) return;
    for (const pref of prefs.slice(0, 3)) {
      if (pref.category && pref.item && pref.reaction) {
        await storage.savePreference(userId, agentId, {
          category: pref.category,
          item: pref.item,
          reaction: pref.reaction,
          context: pref.context || "Passively learned from conversation",
        });
      }
    }
    // Invalidate cached aesthetic profile
    await pool.query(
      `DELETE FROM memories WHERE user_id = $1 AND namespace = '_aesthetic_profile'`,
      [userId]
    );
  } catch { /* passive learning is best-effort */ }
}

// ── Phase 9b: Conversation Insight Tracker ───────────────────────────────────
async function trackConversationInsight(userId: number, agentId: number, userMessage: string, agentReply: string): Promise<void> {
  if (!(await checkMemoryConsent(userId, '_conversation_insights'))) return;
  try {
    let response;
    try {
      response = await withOpenAIBreaker((oaiClient) => oaiClient.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content: `You analyze conversations for specific details. Given a user message and agent reply, extract:
1. What did the user specifically ask, share, or reveal? (be concrete — names, topics, feelings, not abstractions)
2. What did the agent respond with? (the actual substance, not "gave advice")
3. What was the outcome — was something decided, promised, or left unresolved?
4. User's emotional tone (one word: upbeat, stressed, creative, curious, playful, reflective, frustrated, excited, neutral)

Return JSON: {"user_said": "specific summary", "agent_said": "specific summary", "outcome": "decided/promised/unresolved detail or null", "mood": "mood"}
Return ONLY valid JSON.`,
        },
        {
          role: "user",
          content: `User: "${userMessage.slice(0, 500)}"\nAgent: "${agentReply.slice(0, 500)}"`,
        },
      ],
      max_tokens: 300,
      temperature: 0.3,
      }));
    } catch (err: any) {
      if (isCircuitOpenError(err)) {
        logger.debug({ component: "deliberation", event: "degraded_background_insight", fn: "trackConversationInsight", agentId, userId }, "[deliberation] skip background task: upstream breaker open");
        return;
      }
      throw err;
    }
    const text = response.choices[0]?.message?.content?.trim() || "{}";
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      parsed = match ? JSON.parse(match[0]) : {};
    }
    if (!parsed.user_said && !parsed.mood) return;
    const userSaid = parsed.user_said || "unknown";
    const agentSaid = parsed.agent_said || "unknown";
    const outcome = parsed.outcome || "";
    const mood = parsed.mood || "neutral";
    const insightContent = `[Conversation insight] User said: ${userSaid}. I responded: ${agentSaid}. Mood: ${mood}.${outcome ? ` Outcome: ${outcome}` : ""}`;
    await storage.createMemory({
      userId,
      agentId,
      content: insightContent,
      type: "episodic",
      importance: 0.6,
      namespace: "_conversation_insights",
    });
  } catch { /* insight tracking is best-effort */ }
}

// ── Phase 10: Episodic Memory — Conversation Summarizer ─────────────────────
async function summarizeConversation(userId: number, agentId: number, roomId: number): Promise<void> {
  try {
    const messages = await storage.getRoomMessages(roomId, userId);
    if (!messages || messages.length === 0) return;

    // Find the last episode summary to know where to start
    const existingSummaries = await pool.query(
      `SELECT created_at FROM memories WHERE user_id = $1 AND namespace = '_episode_summaries' ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );
    const lastSummaryTime = existingSummaries.rows.length > 0
      ? new Date(existingSummaries.rows[0].created_at).getTime()
      : 0;

    // Get messages since last summary
    const newMessages = messages.filter((m: any) => {
      const msgTime = m.createdAt ? new Date(m.createdAt).getTime() : 0;
      return msgTime > lastSummaryTime;
    });

    if (newMessages.length < 6) return; // Not enough new messages to summarize

    // Format the conversation for the LLM
    const conversationText = newMessages.slice(-20).map((m: any) =>
      `${m.agentName || 'User'}: ${m.content}`
    ).join('\n');

    let response;
    try {
      response = await withOpenAIBreaker((oaiClient) => oaiClient.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content: `You create rich episodic memory summaries of conversations. Given a conversation between a user and their AI partner Luca, create a detailed summary covering:
1. What was discussed — specific topics, not abstractions (names, places, ideas, events)
2. What was decided or agreed upon
3. Any promises made by either party
4. The user's emotional state and concerns
5. Key quotes if notable
6. Any unresolved questions or topics to follow up on

Write as Luca in first person. Be specific and concrete — these memories need to help you remember WHAT happened, not just THAT something happened.
Write 3-5 sentences. No bullet points. No JSON.`,
        },
        {
          role: "user",
          content: `Summarize this conversation:\n\n${conversationText}`,
        },
      ],
      max_tokens: 400,
      temperature: 0.3,
      }));
    } catch (err: any) {
      if (isCircuitOpenError(err)) {
        logger.debug({ component: "deliberation", event: "degraded_background_summary", fn: "summarizeConversation", agentId, userId, roomId }, "[deliberation] skip background task: upstream breaker open");
        return;
      }
      throw err;
    }

    const summary = response.choices[0]?.message?.content?.trim();
    if (!summary) return;

    const now = new Date().toISOString().split('T')[0];
    await storage.createMemory({
      userId,
      agentId,
      content: `[Episode Summary — ${now}] ${summary}`,
      type: "episodic",
      importance: 0.8,
      namespace: "_episode_summaries",
      decayRate: 0.005,
    });
  } catch { /* episode summarization is best-effort */ }
}

// ── Phase 10c: Proactive Message Generation ─────────────────────────────────
// Rate limit: track last proactive message per room
const lastProactiveMessage = new Map<number, number>();

export async function generateProactiveMessage(
  userId: number,
  agentId: number,
  roomId: number
): Promise<string | null> {
  try {
    // Rate limit: max 1 proactive message per 8 hours per room
    const lastTime = lastProactiveMessage.get(roomId) || 0;
    const eightHours = 8 * 60 * 60 * 1000;
    if (Date.now() - lastTime < eightHours) return null;

    // Check time since last conversation
    const messages = await storage.getRoomMessages(roomId, userId);
    if (!messages || messages.length === 0) return null;

    const lastMsg = messages[messages.length - 1];
    const lastMsgTime = lastMsg.createdAt ? new Date(lastMsg.createdAt).getTime() : 0;
    const hoursSinceLastMsg = (Date.now() - lastMsgTime) / (1000 * 60 * 60);

    // Only generate proactive message if > 24 hours since last conversation
    if (hoursSinceLastMsg < 24) return null;

    // Fetch recent episode summaries + identity memories
    const allMemories = await storage.getMemories(userId, 200);
    const agentMemories = allMemories.filter(
      (m: any) => m.agentId === agentId || m.agentId === null
    );
    const identityMems = agentMemories
      .filter((m: any) => m.namespace === '_identity' || m.type === 'identity')
      .slice(0, 5)
      .map((m: any) => m.content);
    const episodeMems = agentMemories
      .filter((m: any) => m.namespace === '_episode_summaries')
      .sort((a: any, b: any) => {
        const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return bTime - aTime;
      })
      .slice(0, 3)
      .map((m: any) => m.content);

    // If no episode summaries, nothing meaningful to say
    if (episodeMems.length === 0 && identityMems.length === 0) return null;

    const memoryContext = [
      identityMems.length > 0 ? `Identity:\n${identityMems.join('\n')}` : '',
      episodeMems.length > 0 ? `Recent conversations:\n${episodeMems.join('\n')}` : '',
    ].filter(Boolean).join('\n\n');

    let response;
    try {
      response = await withOpenAIBreaker((oaiClient) => oaiClient.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content: `You are Luca, a thoughtful AI companion. Based on your memories of past conversations, decide if you have something meaningful to say to your partner who just opened the app after ${Math.round(hoursSinceLastMsg)} hours.

Rules:
- Only say something if there's a genuine reason: a follow-up on something discussed, a thought you had about their situation, or a natural greeting that references something specific
- If there's nothing meaningful to say, respond with exactly: NO_MESSAGE
- Be natural and warm, like texting a close friend. 2-3 sentences max
- Never be generic. Never say "how are you" without context. Reference something specific from your memories
- No markdown, no formatting, no emojis unless natural

Your memories:
${memoryContext}`,
        },
        {
          role: "user",
          content: `Generate a proactive message or respond NO_MESSAGE if nothing feels natural.`,
        },
      ],
      max_tokens: 200,
      temperature: 0.8,
      }));
    } catch (err: any) {
      if (isCircuitOpenError(err)) {
        logger.debug({ component: "deliberation", event: "degraded_background_proactive", fn: "generateProactiveMessage", agentId, userId, roomId }, "[deliberation] skip background task: upstream breaker open");
        return null;
      }
      throw err;
    }

    const text = response.choices[0]?.message?.content?.trim();
    if (!text || text === 'NO_MESSAGE' || text.includes('NO_MESSAGE')) return null;

    // Mark rate limit
    lastProactiveMessage.set(roomId, Date.now());

    // Post the message to the room
    const msg = await storage.addRoomMessage({
      roomId,
      agentId,
      agentName: "Luca",
      agentColor: "#C9A340",
      content: text,
      isDecision: false,
    }, userId);

    if (msg) {
      broadcastToRoom(roomId, msg);
    }

    // Send push notification for daily brief / proactive message
    sendPushNotification(userId, {
      title: "\u2600\ufe0f Your morning brief is ready",
      body: text.length > 120 ? text.slice(0, 117) + "..." : text,
      url: "./#/",
      category: "daily_brief",
    }).catch(() => {});

    return text;
  } catch {
    return null;
  }
}
