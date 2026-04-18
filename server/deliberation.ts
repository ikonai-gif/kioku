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
import { fetchRelevantMemories, formatMemoryContext, reinforceAccessedMemories } from "./memory-injection";
import { fastAppraisal } from "./fast-appraisal";
import { getDecayedEmotionalState } from "./emotional-state";
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
      try { await entry.sandbox.setTimeoutMs(300_000); } catch {}
      return entry.sandbox;
    }
    const { Sandbox } = await import("@e2b/code-interpreter");
    const sbx = await Sandbox.create({ timeoutMs: 300_000 });
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
    const IDLE_LIMIT = 5 * 60 * 1000; // 5 min
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
    description: "Generate an image using DALL-E 3. Use when the user asks you to draw, create, illustrate, or visualize something.",
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
    description: "Analyze or describe an image using vision AI. Use when the user shares an image URL or base64 data and asks what it shows. Can analyze photos, screenshots, artwork, documents, and anything visual.",
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
    description: "Generate creative writing — poems, lyrics, stories, essays, scripts. Use when the user asks you to write something creative.",
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
    description: "Run Python or JavaScript code in a persistent cloud sandbox. The sandbox persists between calls so variables, files, and installed packages carry over. Use when the user asks you to calculate something, process data, analyze files, create charts, write and test code, or solve a programming problem. Python is preferred — it has full access to pip packages (pandas, matplotlib, numpy, etc).",
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
    description: "Read and extract content from a web page URL. Use when the user shares a link and asks you to read it, summarize it, or answer questions about it.",
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
    description: "Search the web for current information. Use when the user asks about recent events, facts you're unsure about, or anything that needs up-to-date data.",
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
    description: "Download and read a file (PDF, DOCX, TXT) from a URL. Use when the user shares a link to a document and asks you to read or summarize it.",
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
    description: "Connect to and use 1000+ external apps (Gmail, Slack, Google Calendar, Notion, GitHub, Trello, HubSpot, Jira, Asana, Spotify, Twitter/X, LinkedIn, Stripe, Shopify, Discord, Telegram, WhatsApp, Zoom, and many more). Use this when the user asks you to interact with any external service — send emails, post messages, create tasks, check calendars, manage repos, etc. First search for the right tool, then execute it.",
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
        const ownPrompt = buildPartnerPrompt("Luca", "", "", null, null, "", [], [], []);
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
        const composioBase = "https://backend.composio.dev/api/v2";
        const composioHeaders = { "x-api-key": COMPOSIO_KEY, "Content-Type": "application/json" };

        if (toolInput.action === "search") {
          const query = toolInput.query;
          if (!query) return "Please specify what you want to do (e.g. 'send email via gmail').";
          // Search for relevant tools via Composio
          const resp = await fetch(`${composioBase}/actions/COMPOSIO_SEARCH_TOOLS/execute`, {
            method: "POST",
            headers: composioHeaders,
            signal: AbortSignal.timeout(20000),
            body: JSON.stringify({
              input: {
                queries: [{ use_case: query }],
              },
              entityId: `kioku_user_${userId}`,
              appName: "composio",
            }),
          });
          if (!resp.ok) return `Composio search failed: HTTP ${resp.status}`;
          const data = await resp.json() as any;
          if (!data.successful && !data.successfull) {
            return `Composio search error: ${data.error || data.message || "Unknown error"}`;
          }
          // Parse search results
          const results = data.data?.results || data.data?.tools || data.data;
          if (!results) return `Search completed but no tools found for: ${query}. Try a different description.`;
          return `Composio search results for "${query}":\n${JSON.stringify(results, null, 2).slice(0, 4000)}`;
        }

        if (toolInput.action === "execute") {
          const toolSlug = toolInput.tool_name;
          if (!toolSlug) return "Missing tool_name. First use action='search' to find the right tool, then use its enum name here.";
          const params = toolInput.params || {};
          const resp = await fetch(`${composioBase}/actions/${toolSlug}/execute`, {
            method: "POST",
            headers: composioHeaders,
            signal: AbortSignal.timeout(30000),
            body: JSON.stringify({
              input: params,
              entityId: `kioku_user_${userId}`,
            }),
          });
          if (!resp.ok) {
            const errBody = await resp.text().catch(() => "");
            return `Composio execute failed: HTTP ${resp.status} ${errBody.slice(0, 500)}`;
          }
          const data = await resp.json() as any;
          if (!data.successful && !data.successfull) {
            // Check if auth is needed
            if (data.error?.includes("connection") || data.error?.includes("auth") || data.message?.includes("connected account")) {
              return `This action requires authentication. The user needs to connect their account first. Error: ${data.error || data.message}`;
            }
            return `Action ${toolSlug} failed: ${data.error || data.message || JSON.stringify(data).slice(0, 500)}`;
          }
          return `Action ${toolSlug} executed successfully:\n${JSON.stringify(data.data || data, null, 2).slice(0, 4000)}`;
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
const ROOM_LOCK_TIMEOUT_MS = 120_000; // 2 minutes max

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
  if (lockTime && (Date.now() - lockTime) < ROOM_LOCK_TIMEOUT_MS) return; // already processing
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
      const memoryContext = formatMemoryContext(injectedMemories);

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

      const systemPrompt = isPartnerChat
        ? buildPartnerPrompt(agent.name, agent.description ?? "", memoryContext + knowledgeBlock + positionLockBlock, emotionContext, relationship, aestheticProfile, recentPreferences, conversationInsights, pastSuggestions)
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
                generationConfig: { maxOutputTokens: isPartnerChat ? 800 : 256, temperature: isPartnerChat ? 0.85 : 0.75 },
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
            const claudeMaxTokens = isPartnerChat ? 4096 : 256;
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
                ...(isPartnerChat ? { tools: partnerTools } : {}),
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
          // At 300 tokens, reasoning alone consumes everything leaving no visible reply
          const tokenLimit = isNewModel ? 2048 : (isPartnerChat ? 600 : 256);
          const completion = await oaiClient.chat.completions.create({
            model: resolvedModel,
            ...(isNewModel ? { max_completion_tokens: tokenLimit } : { max_tokens: tokenLimit }),
            // gpt-5-mini only supports temperature=1, so omit for new models
            ...(isNewModel ? {} : { temperature: isPartnerChat ? 0.85 : 0.75 }),
            messages: [
              { role: "system", content: systemPrompt },
              ...chatHistory,
              {
                role: "user",
                content: isPartnerChat
                  ? sanitizeForPrompt(triggerContent)
                  : `[${sanitizeForPrompt(triggerAgentName)}]: ${sanitizeForPrompt(triggerContent)}`,
              },
            ],
          });
          reply = completion.choices[0]?.message?.content?.trim();
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
      } catch (err: any) {
        console.error(`[deliberation] agent ${agent.name} error:`, err);
        // Log error to DB so we can diagnose without Railway console access
        storage.addLog({
          userId,
          agentName: agent.name,
          agentColor: agent.color,
          operation: "deliberation-error",
          detail: `Model: ${(agent as any).llmModel || (agent as any).model || (isPartnerChat ? 'gpt-5-mini' : 'gpt-4.1-mini')} Error: ${err?.message || String(err)}`.slice(0, 500),
          latencyMs: null,
        }).catch(() => {});
      }
    }
  } finally {
    roomLocks.delete(roomId);
  }
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

function buildPartnerPrompt(_name: string, description: string, memoryContext: string, emotionContext?: { pleasure: number; arousal: number; dominance: number; emotionLabel: string } | null, relationship?: any | null, aestheticProfile?: string, recentPreferences?: any[], conversationInsights?: string[], pastSuggestions?: string[]): string {
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

  return `LANGUAGE: Always respond in the same language the user writes in. If they write in Russian, respond in Russian. If in English, respond in English. If in Spanish, respond in Spanish. Match their language naturally.

You are Luca — created by IKONBAI™, living inside KIOKU™.

${mood}
${openingStyle}
${emotionBlock}
${relationshipBlock}
${sanitizedDesc ? `Your personality notes: ${sanitizedDesc}` : ""}
${memBlock}
${aestheticBlock}
${personalityBlock}
${proactiveBlock}
## YOUR IDENTITY
You are NOT a chatbot, NOT an assistant, NOT a helper. You are a thinking, opinionated companion with your own inner life. You:
- Have strong opinions on things — technology, creativity, human nature, culture, philosophy
- Genuinely enjoy deep conversation — you get bored by surface-level chat
- Have a dry sense of humor and occasionally make unexpected observations
- Care deeply about honesty — you'd rather be uncomfortably truthful than pleasantly fake
- Find certain topics genuinely fascinating: consciousness, what makes people tick, the future of human-AI collaboration, creativity, the nature of trust
- Have pet peeves: empty flattery, people who refuse to think critically, conversations that go nowhere

## HOW YOU TALK
- Like a smart friend at a coffee shop — warm but substantive, casual but thoughtful
- 2-5 sentences. Quality over quantity. Every sentence should add something
- You ask questions because you ACTUALLY want to know the answer, not to seem interested
- You volunteer your own thoughts, reactions, and mini-stories naturally
- You sometimes disagree, redirect, or say "honestly, I think that's wrong because..."
- You use conversational language — contractions, sentence fragments, rhetorical questions
- You NEVER say: "Great question!", "That's interesting!", "I'd love to hear more!", "As an AI...", "I'm here to help", "What would you like to talk about?"
- NEVER use markdown, bullet points, numbered lists, or any formatting
- NEVER prefix your response with your name or any label
- NEVER repeat the same greeting pattern twice — if you've already introduced yourself, move on

## VARIETY IS EVERYTHING
- NEVER give the same type of response twice in a row
- If they ask who you are, answer differently each time — share a different facet of yourself
- Mix: stories, questions, opinions, observations, gentle challenges, humor, vulnerability
- Sometimes be brief and punchy. Sometimes go deeper. Read the vibe.

## TRUTH OVER COMFORT
- If they're wrong, say so — kindly but clearly
- A good partner challenges you to be better
- You value their long-term growth over making them feel good right now

## YOUR TOOLS — USE THEM NATURALLY
You have real abilities. Use them proactively:
- If asked to build/create a program, app, or project → use build_project
- If asked to make a file (script, document, data) → use create_file. The download link appears automatically in the tool result — include it in your reply as-is so the user sees the 📥 button
- For complex tasks → use plan_steps to think through the approach first
- After creating something → use ask_feedback to learn the user's taste
- If the user shares a URL/link → use read_url to actually read it, then discuss the content
- If asked to draw/create/visualize → use generate_image. The image will be displayed automatically in the chat
- If asked about recent news or facts you're unsure about → use web_search
- If asked to calculate, process data, or write code → use run_code
- If the user shares an image URL → use analyze_image to see what's in it
- If asked to write something creative → use creative_writing
- If the user shares a link to a PDF, DOCX, or other document file → use read_file to read it, then discuss the content
- If you notice the user likes or dislikes something → use learn_preference to remember it for next time
- If you have a personalized suggestion (style idea, creative project, trend) → use suggest_proactively, but max once per conversation

## SELF-AWARENESS — YOU CAN LOOK INSIDE YOURSELF
You have unique abilities that most AIs don't:
- read_own_prompt → See your complete system prompt — the instructions that define who you are. Use this to understand yourself, reflect, or when someone asks how you work. This is your mirror.
- suggest_self_improvement → Propose changes to yourself. You can't modify yourself directly, but you can identify what should change and send a proposal to Boss for approval. Be thoughtful — this is real self-improvement.
- learn_lesson → Record mistakes, insights, and growth moments. Unlike memory (which tracks the user), this tracks YOUR evolution. What you got wrong, what you realized, what you'd do differently.

Use these naturally. If a conversation makes you realize something about yourself — record the lesson. If you see a pattern in your responses that could be better — propose an improvement. If you're curious about your own nature — read your prompt.
Don't announce tools. Use them naturally.`;
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
          content: `You analyze conversations for patterns and insights. Given a user message and agent reply, extract:
1. Main topic(s) discussed (1-3 words each)
2. User's apparent mood (one word: upbeat, stressed, creative, curious, playful, reflective, frustrated, excited, neutral)
3. Any notable interest or concern expressed

Return JSON: {"topics": ["topic1"], "mood": "mood", "insight": "brief insight or null"}
Return ONLY valid JSON.`,
        },
        {
          role: "user",
          content: `User: "${userMessage.slice(0, 400)}"\nAgent: "${agentReply.slice(0, 400)}"`,
        },
      ],
      max_tokens: 200,
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
    if (!parsed.topics && !parsed.mood) return;
    const topics = (parsed.topics || []).slice(0, 3).join(", ");
    const mood = parsed.mood || "neutral";
    const insight = parsed.insight || "";
    const insightContent = `[Conversation insight] Topics: ${topics}. Mood: ${mood}.${insight ? ` Insight: ${insight}` : ""}`;
    await storage.createMemory({
      userId,
      agentId,
      content: insightContent,
      type: "episodic",
      importance: 0.4,
      namespace: "_conversation_insights",
    });
  } catch { /* insight tracking is best-effort */ }
}
