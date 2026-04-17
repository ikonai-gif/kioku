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
    description: "Run Python or JavaScript code in a secure cloud sandbox. Use when the user asks you to calculate something, process data, analyze files, create charts, write and test code, or solve a programming problem. Python is preferred — it has full access to pip packages (pandas, matplotlib, numpy, etc).",
    input_schema: {
      type: "object" as const,
      properties: {
        code: { type: "string", description: "Code to execute. Use print() for Python or console.log() for JavaScript." },
        language: { type: "string", enum: ["javascript", "python"], description: "Programming language. Default: python" },
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
          // E2B Cloud Sandbox — secure isolated execution for Python & JavaScript
          const { Sandbox } = await import("@e2b/code-interpreter");
          const sbx = await Sandbox.create({ timeoutMs: 30_000 });
          try {
            const execution = await sbx.runCode(code, { language: lang as any });
            const stdout = execution.logs?.stdout?.join("\n") || "";
            const stderr = execution.logs?.stderr?.join("\n") || "";
            const text = execution.text || "";
            const error = execution.error;
            let output = "";
            if (error) {
              output = `Error: ${error.name}: ${error.value}\n${error.traceback}`;
            } else {
              const parts = [stdout, text].filter(Boolean);
              output = parts.join("\n") || "(no output)";
              if (stderr) output += `\nStderr: ${stderr}`;
            }
            // Check for generated files (charts, images)
            const results = execution.results || [];
            const imageResults = results.filter((r: any) => r.png || r.jpeg || r.svg);
            if (imageResults.length > 0) {
              output += `\n[Generated ${imageResults.length} image(s)/chart(s)]`;
            }
            return `Code executed successfully (${lang}):\n${output.slice(0, 5000)}`;
          } finally {
            await sbx.kill().catch(() => {});
          }
        } catch (err: any) {
          // Fallback to local vm for simple JS if E2B fails
          if (lang === "js") {
            try {
              const vm = await import("vm");
              const logs: string[] = [];
              const sandbox = {
                console: { log: (...a: any[]) => logs.push(a.map(x => typeof x === "object" ? JSON.stringify(x, null, 2) : String(x)).join(" ")) },
                JSON, Math, Date, Array, Object, String, Number, Boolean, RegExp, Map, Set, parseInt, parseFloat, isNaN, isFinite,
              };
              const ctx = vm.createContext(sandbox);
              const result = new vm.Script(code, { timeout: 10000 }).runInContext(ctx);
              const output = logs.length > 0 ? logs.join("\n") : (result !== undefined ? String(result) : "(no output)");
              return `Code executed (local fallback):\n${output.slice(0, 5000)}`;
            } catch (vmErr: any) {
              return `Code execution error: ${vmErr?.message || String(vmErr)}`;
            }
          }
          return `Code execution error: ${err?.message || String(err)}`;
        }
      }

      case "read_url": {
        const url = toolInput.url;
        if (!url || typeof url !== "string") return "No URL provided.";
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
      const injectedMemories = await fetchRelevantMemories(userId, agent.id, triggerContent, 8);
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
            const maxToolIterations = 5;
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

        // In Partner chat, always display as "Agent O" regardless of underlying agent
        const displayName = isPartnerChat ? "Agent O" : agent.name;

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

You are Agent O — created by IKONBAI™, living inside KIOKU™.

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
- If the user shares a URL/link → use read_url to actually read it, then discuss the content
- If asked to draw/create/visualize → use generate_image, and ALWAYS include the image URL in your response
- If asked about recent news or facts you're unsure about → use web_search
- If asked to calculate, process data, or write code → use run_code
- If the user shares an image URL → use analyze_image to see what's in it
- If asked to write something creative → use creative_writing
- If the user shares a link to a PDF, DOCX, or other document file → use read_file to read it, then discuss the content
- If you notice the user likes or dislikes something → use learn_preference to remember it for next time
- If you have a personalized suggestion (style idea, creative project, trend) → use suggest_proactively, but max once per conversation
Don't announce you're using tools. Just use them and share the results naturally, like a person who Googles something mid-conversation.`;
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
