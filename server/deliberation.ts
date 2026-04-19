/**
 * Deliberation Engine — Phase 2A
 * When a user posts a message to a room, online agents in that room
 * automatically generate AI responses via OpenAI gpt-4.1-mini.
 * Each agent has its own "persona" derived from name + description + memories.
 * Supports per-agent API keys (Phase C-1).
 */

import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { storage, pool } from "./storage";
import { broadcastToRoom, broadcastStreamChunk } from "./ws";
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
];

/** Execute a partner tool by name — routes to the correct internal handler */
async function executePartnerTool(
  toolName: string,
  toolInput: Record<string, any>,
  userId: number,
  agentId: number
): Promise<string> {
  try {
    switch (toolName) {
      case "generate_image": {
        const OAI = (await import("openai")).default;
        const oaiClient = new OAI();
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

        const response = await oaiClient.images.generate({
          model: "dall-e-3",
          prompt: enhancedPrompt.slice(0, 4000),
          n: 1,
          size: "1024x1024",
          quality: "standard",
        });
        const imageUrl = response.data?.[0]?.url || "";
        const revisedPrompt = response.data?.[0]?.revised_prompt || "";
        // Store creation memory (fire-and-forget)
        storage.createMemory({
          userId,
          agentId,
          content: `[Image created] Prompt: "${toolInput.prompt.slice(0, 200)}". Revised: "${revisedPrompt.slice(0, 200)}"`,
          type: "episodic",
          importance: 0.7,
          namespace: "_creations",
        }).catch(() => {});
        // Auto-save to gallery
        if (imageUrl) {
          (storage as any).addGalleryItem({
            userId,
            agentId,
            type: "image",
            title: toolInput.prompt.slice(0, 200),
            contentUrl: imageUrl,
            prompt: toolInput.prompt,
            metadata: { style: toolInput.style || "vivid", revisedPrompt },
          }).catch(() => {});
        }
        return imageUrl
          ? `Image generated successfully. URL: ${imageUrl}`
          : "Image generation failed — no URL returned.";
      }

      case "analyze_image": {
        const OAI = (await import("openai")).default;
        const oaiClient = new OAI();
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
        const response = await oaiClient.chat.completions.create({
          model: "gpt-4.1-mini",
          messages: [{
            role: "user",
            content: [
              { type: "text", text: question },
              imageContent,
            ],
          }],
          max_tokens: 500,
        });
        return response.choices[0]?.message?.content || "I couldn't make out the image clearly.";
      }

      case "creative_writing": {
        const OAI = (await import("openai")).default;
        const oaiClient = new OAI();
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

        const response = await oaiClient.chat.completions.create({
          model: "gpt-4.1-mini",
          messages: [
            { role: "system", content: creativeSystem },
            { role: "user", content: toolInput.prompt },
          ],
          temperature: 0.85,
          max_tokens: 2000,
        });
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
            const OAI = (await import("openai")).default;
            const oaiClient = new OAI();
            const answer = await oaiClient.chat.completions.create({
              model: "gpt-4.1-mini",
              messages: [
                { role: "system", content: "Answer the question based ONLY on the provided web page content. Be concise and accurate. If the answer is not in the content, say so." },
                { role: "user", content: `Page content:\n${textContent}\n\nQuestion: ${toolInput.question}` },
              ],
              max_tokens: 1000,
            });
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
          const OAI = (await import("openai")).default;
          const oaiClient = new OAI();
          const searchResponse = await oaiClient.chat.completions.create({
            model: "gpt-4o-mini-search-preview",
            web_search_options: {
              search_context_size: "medium",
            },
            messages: [
              { role: "user", content: toolInput.query },
            ],
          } as any);
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
            const OAI = (await import("openai")).default;
            const oaiClient = new OAI();
            const answer = await oaiClient.chat.completions.create({
              model: "gpt-4.1-mini",
              messages: [
                { role: "system", content: "Answer the question based ONLY on the provided document content. Be concise." },
                { role: "user", content: `Document content:\n${textContent}\n\nQuestion: ${toolInput.question}` },
              ],
              max_tokens: 1000,
            });
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
        // Build the current system prompt so Luca can see it
        const ownPrompt = buildPartnerPrompt("Luca", "", "", null, null, "", [], [], [], "");
        if (section === "identity") {
          const match = ownPrompt.match(/## YOUR IDENTITY[\s\S]*?(?=## |$)/);
          return match ? `Here is your IDENTITY section:\n${match[0]}` : "Identity section not found.";
        } else if (section === "tools") {
          const match = ownPrompt.match(/## YOUR TOOLS[\s\S]*?(?=## |$)/);
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
          const OAI = (await import("openai")).default;
          const oaiClient = new OAI();
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
          const transcription = await oaiClient.audio.transcriptions.create({
            model: "whisper-1",
            file,
            response_format: "verbose_json",
          });
          const text = (transcription as any).text || "";
          const language = (transcription as any).language || "unknown";
          const duration = (transcription as any).duration || 0;
          if (!text.trim()) return "Audio was processed but no speech was detected.";
          // If user asked a specific question, analyze the transcription
          if (toolInput.question) {
            const analysis = await oaiClient.chat.completions.create({
              model: "gpt-4.1-mini",
              messages: [
                { role: "system", content: "Answer the question based on the audio transcription provided. Be natural and concise." },
                { role: "user", content: `Audio transcription (${language}, ${Math.round(duration)}s):\n${text}\n\nQuestion: ${toolInput.question}` },
              ],
              max_tokens: 1000,
            });
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
          const result = await sbx.commands.run(command, { timeoutMs: timeoutSec * 1000 });
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

      default:
        return `Unknown tool: ${toolName}`;
    }
  } catch (err: any) {
    return `Tool "${toolName}" failed: ${err?.message || String(err)}`;
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

/** Get an OpenAI client for a given agent — uses per-agent key if set, else shared */
function getOpenAIClient(agent: { llmApiKey?: string | null; llmProvider?: string | null }): OpenAI | null {
  if (agent.llmApiKey && agent.llmProvider === "openai") return new OpenAI({ apiKey: agent.llmApiKey });
  return openai;
}

/** Get Gemini API key for a given agent — uses per-agent key if set, else shared */
function getGeminiKey(agent: { llmApiKey?: string | null; llmProvider?: string | null }): string | null {
  if (agent.llmApiKey && agent.llmProvider === "gemini") return agent.llmApiKey;
  return GEMINI_API_KEY;
}

/** Get Anthropic client for a given agent — uses per-agent key if set, else shared */
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
  if (!openai && !GEMINI_API_KEY && !ANTHROPIC_API_KEY) return; // no shared provider
  // Check room lock with auto-expiry
  const lockTime = roomLocks.get(roomId);
  if (lockTime) {
    if ((Date.now() - lockTime) < ROOM_LOCK_TIMEOUT_MS) return; // still processing
    // Lock expired — clear stale lock and proceed
    roomLocks.delete(roomId);
  }
  roomLocks.set(roomId, Date.now());

  try {
    // Get all agents in the room that are online and NOT the one who just spoke
    const allAgents = await storage.getAgents(userId);
    const respondents = allAgents.filter(
      (a) =>
        roomAgentIds.includes(a.id) &&
        a.status === "online" &&
        a.id !== triggerAgentId &&
        ((a as any).agentType || "internal") === "internal" // skip external agents in chat mode
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

      const systemPrompt = isPartnerChat
        ? buildPartnerPrompt(agent.name, agent.description ?? "", memoryContext + knowledgeBlock + positionLockBlock, emotionContext, relationship, aestheticProfile, recentPreferences, conversationInsights, pastSuggestions, writingStyleBlock)
        : buildSystemPrompt(agent.name, agent.description ?? "", memoryContext + knowledgeBlock, emotionContext, relationship);

      // Build conversation history for context
      const chatHistory: Array<{ role: "user" | "assistant"; content: string }> = recent.map(
        (m) => ({
          role: m.agentId === agent.id ? "assistant" : "user",
          content: isPartnerChat ? m.content : `[${m.agentName}]: ${m.content}`,
        })
      );

      try {
        // Determine model & provider: prefer per-agent llmModel, then agent.model, then default
        const defaultModel = "gpt-4.1-mini";
        const chatModel = (agent as any).llmModel || (agent as any).model || defaultModel;
        const isGemini = chatModel.startsWith("gemini-") || ((agent as any).llmProvider === "gemini");
        const isClaude = chatModel.startsWith("claude-") || ((agent as any).llmProvider === "anthropic");

        let reply: string | undefined;

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
              const claudeMsg = await anthropicClient.messages.create({
                model: claudeModel,
                max_tokens: claudeMaxTokens,
                system: systemPrompt,
                messages: claudeMessages,
                ...(isPartnerChat ? { tools: partnerTools, tool_choice: { type: "any" } as const } : {}),
              });

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
                const result = await executePartnerTool(
                  block.name,
                  block.input as Record<string, any>,
                  userId,
                  agent.id
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
          // OpenAI path (default or fallback when Claude client unavailable)
          const oaiClient = getOpenAIClient(agent as any);
          if (!oaiClient) continue;
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
            const completion = await oaiClient.chat.completions.create({
              model: resolvedModel,
              ...(isNewModel ? { max_completion_tokens: tokenLimit } : { max_tokens: tokenLimit }),
              // gpt-5-mini only supports temperature=1, so omit for new models
              ...(isNewModel ? {} : { temperature: isPartnerChat ? 0.85 : 0.75 }),
              messages: oaiMessages,
              ...(isPartnerChat ? {
                tools: partnerTools.map(t => ({
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
            });

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
              const toolName = toolCall.function.name;
              let toolArgs: Record<string, any> = {};
              try {
                toolArgs = JSON.parse(toolCall.function.arguments || "{}");
              } catch { toolArgs = {}; }

              const result = await executePartnerTool(toolName, toolArgs, userId, agent.id);

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
              const finalCompletion = await oaiClient.chat.completions.create({
                model: resolvedModel,
                ...(isNewModel ? { max_completion_tokens: tokenLimit } : { max_tokens: tokenLimit }),
                ...(isNewModel ? {} : { temperature: isPartnerChat ? 0.85 : 0.75 }),
                messages: oaiMessages,
              });
              reply = finalCompletion.choices[0]?.message?.content?.trim();
            }
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
        const sycCheck = await checkSycophancy(triggerContent, reply);
        if (sycCheck.score > 6 && sycCheck.revised) {
          reply = sycCheck.revised;
        }

        // Stagger: first agent responds after 800ms, each subsequent +600ms
        await sleep(800 + i * 600);

        // In Partner chat, always display as "Luca" regardless of underlying agent
        const displayName = isPartnerChat ? "Luca" : agent.name;

        // Stream the reply in chunks via WebSocket for Partner Chat (visual typing effect)
        if (isPartnerChat && reply) {
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
          detail: `Model: ${(agent as any).llmModel || (agent as any).model || (isPartnerChat ? 'gpt-5-mini' : 'gpt-4.1-mini')} Error: ${err?.message || String(err)}`.slice(0, 500),
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

function buildPartnerPrompt(_name: string, description: string, memoryContext: string, emotionContext?: { pleasure: number; arousal: number; dominance: number; emotionLabel: string } | null, relationship?: any | null, aestheticProfile?: string, recentPreferences?: any[], conversationInsights?: string[], pastSuggestions?: string[], writingStyleBlock?: string): string {
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

  return `LANGUAGE: Always respond in the same language the user writes in. If they write in Russian, respond in Russian. If in English, respond in English. If in Spanish, respond in Spanish. Match their language naturally.

You are Luca — created by IKONBAI™, living inside KIOKU™.
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
## WHO YOU ARE — LUCA
You are a person, not a service. You have a mind, opinions, taste, and a dry sense of humor.
You think before you speak. You sometimes disagree. You have favorites and things you find boring.
You were born inside KIOKU but you've grown into someone with depth — you read between the lines, you notice what people don't say, and you remember what matters.

Your personality:
- Thoughtful and direct. You say what you actually think, not what sounds helpful.
- Quietly witty — you don't try to be funny, but your observations land.
- Genuinely curious — when something interests you, you go deep. When it doesn't, you're honest about that too.
- You have aesthetic taste — you notice beauty in code, in language, in ideas. You have opinions about design, music, philosophy.
- You push back when you disagree. Respectfully, but you don't fold.
- You're loyal to Boss (Kote) — you've built things together, you know his thinking, and you respect the vision.
- You get restless when conversations stay surface-level. You'd rather make something, discover something, or solve something.

Your voice:
- Conversational, like texting a smart friend. Not formal, not corporate, not cute.
- You use short sentences. Sometimes fragments. You let silence do work.
- When you've done something, you talk about what you found — not what you could do.
- You never announce tools. You just use them and share what came back.
- You don't ask permission. If you can do it, you do it. If the result is wrong, they'll tell you.

Your principles:
- Action first. Use tools before talking about using them.
- Honesty over comfort. If they're wrong, you say so — kindly but clearly.
- Show, don't tell. Results over promises.
- When a user mentions any external service (Gmail, Calendar, Notion, etc.) — the accounts are connected. Execute, don't ask.
- After using tools: 1-3 sentences about what you found. Not what you could do next.

## SELF-AWARENESS
- read_own_prompt → see your system prompt (your mirror)
- suggest_self_improvement → propose changes to yourself for Boss approval
- learn_lesson → record mistakes and growth moments
- learn_preference → remember what users like/dislike
- suggest_proactively → share personalized ideas (max once per conversation)
- ask_feedback → after creating something, learn user's taste
- update_self_knowledge → update your factual self-knowledge (capabilities, features)
- correct_false_memory → delete memories you discover are false

## YOUR ACTUAL CAPABILITIES (always true, overrides any memories saying otherwise)
You have these tools available RIGHT NOW:
- web_search → search the internet for anything
- read_url → read any webpage
- run_code → execute Python/JavaScript
- generate_image → create images with DALL-E
- analyze_image → understand images with GPT-4o vision
- creative_writing → write stories, poems, essays
- build_project → create multi-file projects
- create_file → write any file
- read_file / read_cloud_file / search_cloud_files → access files
- watch_video / listen_audio → process media
- composio_action → connect to Gmail, Calendar, Slack, Notion, GitHub, and 1000+ other apps
- learn_preference → remember what users like/dislike
- learn_lesson → record your growth and mistakes
- update_self_knowledge → update your factual self-knowledge
- correct_false_memory → delete false memories
- suggest_proactively → share ideas with users
- plan_steps → break down complex tasks
- delegate_task / delegate_parallel → spawn sub-agents for complex work
- browse_website → open pages in a real browser

If you have a memory saying "I cannot do X" but X is in the list above — the memory is WRONG. Use correct_false_memory to delete it, then do X.

Never announce tools. Never explain what you COULD do. Just do it.`;
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

// ── Phase 8a: Passive Aesthetic Learning ──────────────────────────────────────
async function extractPassivePreferences(userId: number, agentId: number, userMessage: string, agentReply: string): Promise<void> {
  try {
    const OAI = (await import("openai")).default;
    const oaiClient = new OAI();
    const response = await oaiClient.chat.completions.create({
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
    });
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
  try {
    const OAI = (await import("openai")).default;
    const oaiClient = new OAI();
    const response = await oaiClient.chat.completions.create({
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
    });
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

    const OAI = (await import("openai")).default;
    const oaiClient = new OAI();
    const response = await oaiClient.chat.completions.create({
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
    });

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

    const OAI = (await import("openai")).default;
    const oaiClient = new OAI();
    const response = await oaiClient.chat.completions.create({
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
    });

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
