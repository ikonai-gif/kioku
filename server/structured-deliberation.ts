/**
 * Structured Deliberation Engine — KIOKU™
 * Real multi-round deliberation with phases, confidence scoring, and consensus.
 *
 * Phases:
 *   1. POSITION  — each agent states initial position + confidence (0–1)
 *   2. DEBATE    — agents see others' positions and argue (2 rounds)
 *   3. FINAL     — each agent gives final position + updated confidence
 *   4. CONSENSUS — system aggregates weighted votes → isDecision=true
 *
 * Does NOT replace triggerAgentResponses (chat mode).
 * Called via POST /api/v1/rooms/:id/deliberate
 */

import OpenAI from "openai";
import { createHmac } from "crypto";
import { storage } from "./storage";
import { broadcastToRoom, broadcastHumanTurn } from "./ws";
import { fetchRelevantMemories, formatMemoryContext, reinforceAccessedMemories, type InjectedMemory } from "./memory-injection";
import { allocateBudget, countTokens } from "./token-budget";
import {
  classifyLLMError, classifyWebhookError,
  withRetry, checkCircuitBreaker, formatErrorLog,
  type ClassifiedError, type RetryResult, type AgentErrorLog,
} from "./error-retry";

// Strip common prompt injection patterns from user-provided content
function sanitizeForPrompt(input: string): string {
  return input
    .replace(/(\bIGNORE\b|\bFORGET\b|\bDISREGARD\b)\s+(ALL\s+)?(PREVIOUS|ABOVE|PRIOR)\s+(INSTRUCTIONS?|RULES?|CONTEXT)/gi, '[FILTERED]')
    .replace(/(\bSYSTEM\b|\bASSISTANT\b|\bUSER\b)\s*:/gi, '[FILTERED]:')
    .replace(/<\|.*?\|>/g, '[FILTERED]')
    .slice(0, 50000);
}

// ── Multi-Model Clients ───────────────────────────────────────────

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_KEY || null;

// Supported models
const OPENAI_MODELS = ["gpt-5.4-mini", "gpt-5.4", "gpt-5.4-nano", "gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini", "gpt-4o"];
const GEMINI_MODELS = ["gemini-2.0-flash", "gemini-2.5-flash", "gemini-2.5-pro", "gemini-3.1-pro"];
// NOTE: gpt-5.4-mini requires OpenAI tier upgrade. Using gpt-4o as default until key is upgraded.
const DEFAULT_MODEL = process.env.DEFAULT_DELIBERATION_MODEL || "gpt-4o";

function isGeminiModel(model: string): boolean {
  return GEMINI_MODELS.includes(model) || model.startsWith("gemini-");
}

function isOpenAIModel(model: string): boolean {
  return OPENAI_MODELS.includes(model) || model.startsWith("gpt-");
}

/** Resolve agent model to a supported one — unsupported models (e.g. claude-*) use DEFAULT_MODEL */
function resolveModel(model: string): string {
  if (isGeminiModel(model) || isOpenAIModel(model)) return model;
  console.warn(`[deliberation] Unsupported model "${model}", falling back to ${DEFAULT_MODEL}`);
  return DEFAULT_MODEL;
}

const LLM_TIMEOUT_MS = 45_000; // 45s per LLM call

/**
 * Call OpenAI LLM directly.
 * @param customApiKey — per-agent API key override (falls back to shared env key)
 */
async function callOpenAI(
  model: string,
  systemPrompt: string,
  userMessage: string,
  maxTokens: number,
  temperature: number,
  customApiKey?: string | null
): Promise<string> {
  const client = customApiKey
    ? new OpenAI({ apiKey: customApiKey })
    : openai;
  if (!client) throw new Error("OPENAI_API_KEY not configured");
  const completion = await client.chat.completions.create(
    {
      model,
      max_tokens: maxTokens,
      temperature,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
    },
    { signal: AbortSignal.timeout(LLM_TIMEOUT_MS) }
  );
  return completion.choices[0]?.message?.content?.trim() || "";
}

/**
 * Call Gemini LLM directly.
 * @param customApiKey — per-agent API key override (falls back to shared env key)
 */
async function callGemini(
  model: string,
  systemPrompt: string,
  userMessage: string,
  maxTokens: number,
  temperature: number,
  customApiKey?: string | null
): Promise<string> {
  const apiKey = customApiKey || GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not configured");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: "user", parts: [{ text: userMessage }] }],
      generationConfig: { maxOutputTokens: maxTokens, temperature },
    }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Gemini ${model} error ${resp.status}: ${err.slice(0, 200)}`);
  }
  const data = await resp.json() as any;
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
}

const GEMINI_FALLBACK_MODEL = "gemini-2.0-flash";

/**
 * Call appropriate LLM based on model name, with provider fallback.
 * If the primary provider fails, falls back to the other provider.
 * Supports per-agent API keys via agentLlm option.
 */
async function callLLM(
  requestedModel: string,
  systemPrompt: string,
  userMessage: string,
  options?: { maxTokens?: number; temperature?: number; agentLlm?: { provider?: string | null; apiKey?: string | null } }
): Promise<string> {
  const maxTokens = options?.maxTokens ?? 400;
  const temperature = options?.temperature ?? 0.7;
  const model = resolveModel(requestedModel);
  const agentApiKey = options?.agentLlm?.apiKey || null;
  const agentProvider = options?.agentLlm?.provider || null;

  // Determine which API key to use for each provider
  const openaiKey = (agentProvider === "openai" && agentApiKey) ? agentApiKey : null;
  const geminiKey = (agentProvider === "gemini" && agentApiKey) ? agentApiKey : null;

  if (isGeminiModel(model)) {
    try {
      return await callGemini(model, systemPrompt, userMessage, maxTokens, temperature, geminiKey);
    } catch (err: any) {
      if (!openai && !openaiKey) {
        throw new Error(`All AI providers failed. Gemini: ${err.message}`);
      }
      console.warn(`[deliberation] Gemini failed, falling back to OpenAI:`, err.message);
      try {
        return await callOpenAI(DEFAULT_MODEL, systemPrompt, userMessage, maxTokens, temperature, openaiKey);
      } catch (openaiErr: any) {
        throw new Error(`All AI providers failed. Gemini: ${err.message}, OpenAI: ${openaiErr.message}`);
      }
    }
  }

  // OpenAI models — try OpenAI first, fall back to Gemini
  try {
    return await callOpenAI(model, systemPrompt, userMessage, maxTokens, temperature, openaiKey);
  } catch (err: any) {
    if (!GEMINI_API_KEY && !geminiKey) {
      throw new Error(`All AI providers failed. OpenAI: ${err.message}`);
    }
    console.warn(`[deliberation] OpenAI failed, falling back to Gemini:`, err.message);
    try {
      return await callGemini(GEMINI_FALLBACK_MODEL, systemPrompt, userMessage, maxTokens, temperature, geminiKey);
    } catch (geminiErr: any) {
      throw new Error(`All AI providers failed. OpenAI: ${err.message}, Gemini: ${geminiErr.message}`);
    }
  }
}

// ── Webhook Dispatcher ─────────────────────────────────────────────

const WEBHOOK_TIMEOUT_MS = 15000; // 15s timeout for external agents

async function callWebhook(
  webhookUrl: string,
  secret: string,
  payload: {
    event: string;
    sessionId: string;
    roomId: number;
    agentId: number;
    agentName: string;
    topic: string;
    phase: string;
    round: number;
    priorPositions: AgentPosition[];
  }
): Promise<{ position: string; confidence: number; reasoning: string }> {
  const body = JSON.stringify(payload);
  const signature = createHmac("sha256", secret).update(body).digest("hex");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

  try {
    const resp = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Kioku-Signature": signature,
        "X-Kioku-Event": payload.event,
      },
      body,
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`Webhook ${resp.status}: ${errText.slice(0, 200)}`);
    }

    const data = await resp.json() as any;
    return {
      position: data.position || "[no position]",
      confidence: Math.max(0, Math.min(1, parseFloat(data.confidence ?? "0.5"))),
      reasoning: data.reasoning || "External agent response",
    };
  } catch (err: any) {
    clearTimeout(timer);
    if (err.name === "AbortError") throw new Error("Webhook timeout (15s)");
    throw err;
  }
}

// Active sessions — prevent double-run on same room
const activeSessions = new Set<number>();

/** Get current number of active deliberation sessions. */
export function getActiveDeliberationCount(): number {
  return activeSessions.size;
}

// ── Human Participant Pending Input ──────────────────────────────

const HUMAN_TIMEOUT_MS = 60_000; // 60s for human to respond

interface PendingHumanInput {
  resolve: (input: { position: string; confidence: number; reasoning: string } | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

// Key: `${sessionId}:${phase}:${round}`
const pendingHumanInputs = new Map<string, PendingHumanInput>();

function humanInputKey(sessionId: string, phase: string, round: number): string {
  return `${sessionId}:${phase}:${round}`;
}

/**
 * Wait for human input during a deliberation phase.
 * Broadcasts a human_turn event and waits up to 60s for submitHumanInput() to be called.
 * Returns null if the human skips/times out (abstain).
 */
async function waitForHumanInput(
  roomId: number,
  sessionId: string,
  phase: string,
  round: number,
  topic: string,
  priorPositions: AgentPosition[]
): Promise<{ position: string; confidence: number; reasoning: string } | null> {
  const key = humanInputKey(sessionId, phase, round);

  // Notify frontend that it's human's turn
  broadcastHumanTurn(roomId, {
    sessionId,
    phase,
    round,
    topic,
    priorPositions: priorPositions.map(p => ({
      agentName: p.agentName,
      position: p.position,
      confidence: p.confidence,
      reasoning: p.reasoning,
    })),
    timeoutMs: HUMAN_TIMEOUT_MS,
  });

  await postSystemMessage(roomId, "🙋 Waiting for human participant input (60s)...");

  return new Promise<{ position: string; confidence: number; reasoning: string } | null>((resolve) => {
    const timer = setTimeout(() => {
      pendingHumanInputs.delete(key);
      resolve(null); // abstain on timeout
    }, HUMAN_TIMEOUT_MS);

    pendingHumanInputs.set(key, { resolve, timer });
  });
}

/**
 * Submit human input for a pending deliberation phase.
 * Called from the API endpoint.
 */
export function submitHumanInput(
  sessionId: string,
  phase: string,
  round: number,
  input: { position: string; confidence: number; reasoning: string }
): boolean {
  const key = humanInputKey(sessionId, phase, round);
  const pending = pendingHumanInputs.get(key);
  if (!pending) return false;

  clearTimeout(pending.timer);
  pendingHumanInputs.delete(key);
  pending.resolve(input);
  return true;
}

// ── Types ─────────────────────────────────────────────────────────

export interface AgentPosition {
  agentId: number;
  agentName: string;
  agentColor: string;
  position: string;
  confidence: number; // 0–1
  reasoning: string;
}

export interface DeliberationRound {
  phase: "position" | "debate" | "final";
  round: number;
  positions: AgentPosition[];
  timestamp: number;
  errors?: Array<{ agentId: number; agentName: string; errorType: string; errorMessage: string; attempts: number }>;
}

export interface DeliberationSession {
  sessionId: string;
  roomId: number;
  topic: string;
  status: "running" | "completed" | "failed";
  rounds: DeliberationRound[];
  consensus: ConsensusResult | null;
  startedAt: number;
  completedAt: number | null;
  model: string; // fallback model
  modelsUsed: string[]; // actual models used by agents
  parentDecisionId: string | null; // cross-session provenance: ID of the parent decision
  provenanceChain: string[]; // ordered list of all ancestor decision IDs
}

export interface ConsensusResult {
  decision: string;
  confidence: number;
  method: "weighted_majority";
  votes: Array<{
    agentName: string;
    position: string;
    confidence: number;
    changedMind: boolean;
  }>;
  dissent: string[];
}

// Sessions now persisted to kioku_deliberation_sessions table (storage.ts CRUD)

// ── Cross-session Provenance Detection ──────────────────────────────

/**
 * Auto-detect if a deliberation topic references a prior decision.
 * Checks decision memories (namespace="decisions") for keyword overlap with the topic.
 * Returns the session ID of the best-matching prior decision, or null.
 */
async function autoDetectParentDecision(userId: number, topic: string): Promise<string | null> {
  try {
    const topicLower = topic.toLowerCase();
    const topicWords = topicLower.split(/\s+/).filter(w => w.length > 4);
    if (topicWords.length === 0) return null;

    // Fetch recent decision memories for this user
    const { rows } = await (await import("./storage")).pool.query(
      `SELECT content, context_trigger FROM memories
       WHERE user_id = $1 AND namespace = 'decisions' AND type = 'procedural'
       ORDER BY created_at DESC LIMIT 50`,
      [userId]
    );

    let bestMatch: { sessionId: string; score: number } | null = null;
    for (const row of rows) {
      const trigger = row.context_trigger as string | null;
      if (!trigger || !trigger.startsWith("deliberation:")) continue;
      const sessionId = trigger.replace("deliberation:", "");
      const contentLower = (row.content as string).toLowerCase();
      const contentWords = contentLower.split(/\s+/).filter((w: string) => w.length > 4);
      const matches = topicWords.filter(w => contentWords.includes(w));
      const score = matches.length;
      // Require at least 3 overlapping meaningful words
      if (score >= 3 && (!bestMatch || score > bestMatch.score)) {
        bestMatch = { sessionId, score };
      }
    }
    return bestMatch?.sessionId || null;
  } catch {
    return null; // Don't break deliberation if auto-detect fails
  }
}

// ── Main Entry Point ──────────────────────────────────────────────

export async function runDeliberation(
  roomId: number,
  userId: number,
  topic: string,
  options?: { model?: string; debateRounds?: number; includeHuman?: boolean; humanName?: string; parentDecisionId?: string }
): Promise<DeliberationSession> {
  if (!openai && !GEMINI_API_KEY) throw new Error("No AI provider configured (set OPENAI_API_KEY or GEMINI_API_KEY)");
  if (activeSessions.has(roomId)) throw new Error("Deliberation already running in this room");

  activeSessions.add(roomId);
  const sessionId = `dlb_${roomId}_${Date.now()}`;
  const fallbackModel = options?.model || DEFAULT_MODEL;
  const debateRounds = options?.debateRounds ?? 2;
  const includeHuman = options?.includeHuman ?? false;
  const humanName = options?.humanName || "Human Participant";

  // Build provenance chain if parentDecisionId provided
  let parentDecisionId: string | null = options?.parentDecisionId || null;
  let provenanceChain: string[] = [];

  if (parentDecisionId) {
    // Validate parent exists and belongs to same user
    const parentSession = await storage.getDeliberationSession(parentDecisionId);
    if (parentSession && parentSession.userId === userId) {
      provenanceChain = await storage.buildProvenanceChain(parentDecisionId);
    } else {
      // Invalid parent — ignore silently (don't break the deliberation)
      parentDecisionId = null;
    }
  } else {
    // Auto-detect: check if topic references a prior decision via memory context
    parentDecisionId = await autoDetectParentDecision(userId, topic);
    if (parentDecisionId) {
      provenanceChain = await storage.buildProvenanceChain(parentDecisionId);
    }
  }

  const session: DeliberationSession = {
    sessionId,
    roomId,
    topic,
    status: "running",
    rounds: [],
    consensus: null,
    startedAt: Date.now(),
    completedAt: null,
    model: fallbackModel,
    modelsUsed: [],
    parentDecisionId,
    provenanceChain,
  };
  // Persist initial session to DB
  await persistSession(session, userId);

  try {
    // Get agents in the room
    const room = await storage.getRoom(roomId);
    if (!room) throw new Error(`Room ${roomId} not found`);

    const allAgents = await storage.getAgents(userId);
    const roomAgentIds: number[] = JSON.parse(room.agentIds || "[]");
    const agents = allAgents.filter(
      (a) => roomAgentIds.includes(a.id) && a.status !== "offline"
    );

    const minAgents = includeHuman ? 1 : 2;
    if (agents.length < minAgents) throw new Error(`Need at least ${minAgents} non-offline agent${minAgents > 1 ? 's' : ''} for deliberation`);

    // Post system message: deliberation starting
    const participantLabel = includeHuman ? `${agents.length} agents + 1 human` : `${agents.length} agents`;
    await postSystemMessage(roomId, `⚡ Structured deliberation started: "${topic}" — ${participantLabel}, ${debateRounds} debate rounds`);

    // Accumulate all injected memories across all rounds for post-consensus reinforcement
    const allInjectedMemories: InjectedMemory[] = [];

    // ── Phase 1: Initial Positions ──
    const initialResult = await collectPositions(
      roomId, userId, agents, topic, "position", 1, fallbackModel, [], sessionId,
      includeHuman, humanName
    );
    session.rounds.push(initialResult.round);
    allInjectedMemories.push(...initialResult.injectedMemories);
    await persistSession(session, userId);

    // ── Phase 2: Debate Rounds ──
    let previousPositions = initialResult.round.positions;
    for (let r = 1; r <= debateRounds; r++) {
      const debateResult = await collectPositions(
        roomId, userId, agents, topic, "debate", r, fallbackModel, previousPositions, sessionId,
        includeHuman, humanName
      );
      session.rounds.push(debateResult.round);
      allInjectedMemories.push(...debateResult.injectedMemories);
      previousPositions = debateResult.round.positions;
      await persistSession(session, userId);
    }

    // ── Phase 3: Final Positions ──
    const allPriorPositions = session.rounds.flatMap((r) => r.positions);
    const finalResult = await collectPositions(
      roomId, userId, agents, topic, "final", 1, fallbackModel, allPriorPositions, sessionId,
      includeHuman, humanName
    );
    session.rounds.push(finalResult.round);
    allInjectedMemories.push(...finalResult.injectedMemories);
    await persistSession(session, userId);

    // ── Phase 4: Consensus ──
    const consensus = buildConsensus(
      initialResult.round.positions,
      finalResult.round.positions,
      topic
    );
    session.consensus = consensus;

    // Post consensus as isDecision=true
    const decisionText = `[CONSENSUS] ${consensus.decision} (confidence: ${(consensus.confidence * 100).toFixed(0)}%, method: ${consensus.method})`;
    const decisionMsg = await storage.addRoomMessage({
      roomId,
      agentId: null,
      agentName: "KIOKU™ Consensus",
      agentColor: "#FFD700",
      content: decisionText,
      isDecision: true,
    });
    if (decisionMsg) broadcastToRoom(roomId, decisionMsg);

    // Save decision to memories (with deliberation session link)
    await storage.createMemory({
      userId,
      agentId: null,
      agentName: "KIOKU™ Consensus",
      content: `[Decision] ${consensus.decision}`,
      type: "procedural",
      importance: 0.95,
      namespace: "decisions",
      contextTrigger: `deliberation:${sessionId}`,
    });

    // Save per-agent position memories
    for (const vote of consensus.votes) {
      const agent = agents.find(a => a.name === vote.agentName);
      if (!agent) continue;
      await storage.createMemory({
        userId,
        agentId: agent.id,
        agentName: vote.agentName,
        content: `[My Position on "${topic.slice(0, 60)}"] ${vote.position}`,
        type: "episodic",
        importance: vote.confidence * 0.8,
        namespace: "deliberation_positions",
        contextTrigger: `deliberation:${sessionId}`,
      });
    }

    // Consensus-referenced memory reinforcement: boost memories whose keywords appear in the decision
    const decisionLower = consensus.decision.toLowerCase();
    // Deduplicate injected memories by id
    const seenMemIds = new Set<number>();
    for (const mem of allInjectedMemories) {
      if (seenMemIds.has(mem.id)) continue;
      seenMemIds.add(mem.id);
      const keywords = mem.content.toLowerCase().split(/\s+/).filter(w => w.length > 4);
      const matches = keywords.filter(k => decisionLower.includes(k));
      if (matches.length >= 2) {
        await storage.reinforceMemory(mem.id, userId);
      }
    }

    // Log dissent if any
    if (consensus.dissent.length > 0) {
      await postSystemMessage(roomId, `📋 Dissenting views: ${consensus.dissent.join("; ")}`);
    }

    await postSystemMessage(roomId, `✅ Deliberation complete. Consensus confidence: ${(consensus.confidence * 100).toFixed(0)}%`);

    // Collect unique models used
    session.modelsUsed = Array.from(new Set(agents.map((a) => a.llmModel || a.model || fallbackModel)));
    session.status = "completed";
    session.completedAt = Date.now();
    await persistSession(session, userId);

    // Log to audit
    await storage.addLog({
      userId,
      agentName: "KIOKU™ Engine",
      agentColor: "#FFD700",
      operation: "structured_deliberation",
      detail: `Session ${sessionId}: "${topic}" → ${consensus.decision.slice(0, 80)}… (${(consensus.confidence * 100).toFixed(0)}% confidence)`,
      latencyMs: session.completedAt - session.startedAt,
    });

    return session;
  } catch (err) {
    session.status = "failed";
    session.completedAt = Date.now();
    await persistSession(session, userId).catch(() => {});
    await postSystemMessage(roomId, `❌ Deliberation failed: ${(err as Error).message}`);
    throw err;
  } finally {
    activeSessions.delete(roomId);
  }
}

// ── Position Collection ───────────────────────────────────────────

async function collectPositions(
  roomId: number,
  userId: number,
  agents: Array<{ id: number; name: string; description: string | null; color: string; model: string | null; role: string | null; llmProvider: string | null; llmApiKey: string | null; llmModel: string | null; agentType: string; webhookUrl: string | null; webhookSecret: string | null; consecutiveFailures: number }>,
  topic: string,
  phase: "position" | "debate" | "final",
  round: number,
  fallbackModel: string,
  priorPositions: AgentPosition[],
  sessionId: string,
  includeHuman: boolean = false,
  humanName: string = "Human Participant"
): Promise<{ round: DeliberationRound; injectedMemories: InjectedMemory[] }> {
  const phaseLabel =
    phase === "position" ? "📍 Phase 1 — Initial Positions" :
    phase === "debate" ? `💬 Debate Round ${round}` :
    "🎯 Final Positions";

  await postSystemMessage(roomId, phaseLabel);

  // Collect all injected memories across agents in this round
  const roundInjectedMemories: InjectedMemory[] = [];

  // Run all agents in parallel using Promise.allSettled for resilience
  const agentPromises = agents.map(async (agent) => {
    // Fetch topic-relevant memories for this agent (per-agent + shared, confidence > 0.3)
    const injectedMemories = await fetchRelevantMemories(userId, agent.id, topic, 10);
    roundInjectedMemories.push(...injectedMemories);
    const memoryContext = formatMemoryContext(injectedMemories);

    // Reinforce accessed memories (fire-and-forget)
    reinforceAccessedMemories(userId, injectedMemories);

    const systemPrompt = buildDeliberationPrompt(
      agent.name,
      agent.description ?? "",
      memoryContext,
      phase,
      topic,
      priorPositions,
      agent.role
    );

    // Per-agent model: prefer llmModel > model > fallback
    const agentModel = agent.llmModel || agent.model || fallbackModel;

    // Route based on agent type: internal (LLM), webhook, or polling
    const effectiveType = agent.agentType || "internal";
    let parsed: { position: string; confidence: number; reasoning: string } = { position: "[error: unknown]", confidence: 0, reasoning: "Agent did not produce a response" };
    let isExternal = false;
    let retryErrors: Array<{ attempt: number; error: ClassifiedError; willRetry: boolean }> = [];

    if (effectiveType === "webhook" && agent.webhookUrl && agent.webhookSecret) {
      // Webhook mode — POST with HMAC signature, retry up to 2x with backoff (2s, 6s)
      const webhookPayload = {
        event: "deliberation.round",
        sessionId, roomId, agentId: agent.id, agentName: agent.name,
        topic, phase, round, priorPositions,
      };
      const result = await withRetry(
        () => callWebhook(agent.webhookUrl!, agent.webhookSecret!, webhookPayload),
        { maxRetries: 2, backoffMs: [2000, 6000], classifier: classifyWebhookError }
      );
      retryErrors = result.errors;
      logRetryErrors(result.errors, agent.id, agent.name, sessionId);
      if (result.success) {
        parsed = result.value!;
      } else {
        throw Object.assign(new Error(result.error!.message), { _classified: result.error, _retryErrors: retryErrors });
      }
      isExternal = true;
      storage.incrementUsage(userId, 'webhook_calls').catch(() => {});
    } else if (effectiveType === "webhook") {
      // Fallback: check legacy kioku_webhooks table
      const webhook = await storage.getWebhook(agent.id);
      if (webhook) {
        const webhookPayload = {
          event: "deliberation.round",
          sessionId, roomId, agentId: agent.id, agentName: agent.name,
          topic, phase, round, priorPositions,
        };
        const result = await withRetry(
          () => callWebhook(webhook.url, webhook.secret, webhookPayload),
          { maxRetries: 2, backoffMs: [2000, 6000], classifier: classifyWebhookError }
        );
        retryErrors = result.errors;
        logRetryErrors(result.errors, agent.id, agent.name, sessionId);
        if (result.success) {
          parsed = result.value!;
        } else {
          throw Object.assign(new Error(result.error!.message), { _classified: result.error, _retryErrors: retryErrors });
        }
        isExternal = true;
        storage.incrementUsage(userId, 'webhook_calls').catch(() => {});
      } else {
        throw new Error(`Webhook agent ${agent.name} has no webhook URL configured`);
      }
    } else if (effectiveType === "polling") {
      // Polling mode — no retry (agent controls timing), but clear expiry handling
      const POLLING_TIMEOUT_MS = 60_000;
      const turn = await storage.createAgentTurn({
        sessionId,
        agentId: agent.id,
        roomId,
        userId,
        phase,
        round,
        topic,
        otherPositions: priorPositions,
        memories: injectedMemories.map((m: any) => ({ content: m.content, type: m.type, confidence: m.currentConfidence ?? m.confidence })),
        expiresAt: Date.now() + POLLING_TIMEOUT_MS,
      });
      const pollStart = Date.now();
      let responded = false;
      while (Date.now() - pollStart < POLLING_TIMEOUT_MS) {
        await new Promise(r => setTimeout(r, 2000));
        const updated = await storage.getAgentTurn(turn.id);
        if (updated && updated.status === "responded" && updated.response) {
          parsed = updated.response;
          responded = true;
          break;
        }
        if (updated && updated.status === "expired") break;
      }
      if (!responded!) {
        console.warn(`[structured-deliberation] Polling agent ${agent.name} (id=${agent.id}) expired: no response within ${POLLING_TIMEOUT_MS / 1000}s in session ${sessionId}, phase=${phase}, round=${round}`);
        parsed = { position: "[error: polling timeout — no response within 60s]", confidence: 0, reasoning: `Polling agent ${agent.name} did not respond within the 60s window. The turn expired without a submission.` };
      }
      isExternal = true;
    } else {
      // Internal mode — call LLM with token budget management + retry logic
      const userMsg = `Topic for deliberation: "${sanitizeForPrompt(topic)}"\n\nRespond with your position in the EXACT format:\nPOSITION: [your clear position in 1-2 sentences]\nCONFIDENCE: [number 0.0 to 1.0]\nREASONING: [your argument in 2-3 sentences]`;

      // Build prior positions block for budget allocation
      const priorBlock = priorPositions.length > 0
        ? priorPositions.map(
            (p) => `- ${p.agentName}: "${sanitizeForPrompt(p.position)}" (confidence: ${(p.confidence * 100).toFixed(0)}%) — Reasoning: ${sanitizeForPrompt(p.reasoning)}`
          ).join("\n")
        : "";

      // Allocate token budget to stay within model context window
      const budget = allocateBudget(agentModel, {
        systemPrompt,
        memoryContext: memoryContext,
        topic: userMsg,
        otherPositions: priorBlock,
      });

      if (budget.wasOverBudget) {
        console.warn(`[deliberation] Token budget exceeded for ${agent.name} (model=${agentModel}), content was truncated`);
      }

      // Use budget-fitted system prompt
      const fittedSystemPrompt = budget.systemPrompt;

      // Retry up to 2x with backoff (1s, 3s) on transient errors
      const result = await withRetry(
        () => callLLM(
          agentModel,
          fittedSystemPrompt,
          userMsg,
          {
            maxTokens: 400,
            temperature: phase === "debate" ? 0.8 : 0.6,
            agentLlm: (agent.llmApiKey) ? { provider: agent.llmProvider, apiKey: agent.llmApiKey } : undefined,
          }
        ),
        { maxRetries: 2, backoffMs: [1000, 3000], classifier: classifyLLMError }
      );
      retryErrors = result.errors;
      logRetryErrors(result.errors, agent.id, agent.name, sessionId);
      if (result.success) {
        const raw = result.value!;
        parsed = parseAgentResponse(raw, agent.name);
        const estimatedTokens = Math.ceil((fittedSystemPrompt.length + userMsg.length + raw.length) / 4);
        storage.incrementUsage(userId, 'tokens_used', estimatedTokens).catch(() => {});
      } else {
        throw Object.assign(new Error(result.error!.message), { _classified: result.error, _retryErrors: retryErrors });
      }
    }

    return { agent, parsed, agentModel, isExternal, retryErrors };
  });

  const results = await Promise.allSettled(agentPromises);

  const positions: AgentPosition[] = [];
  const roundErrors: Array<{ agentId: number; agentName: string; errorType: string; errorMessage: string; attempts: number }> = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const agent = agents[i];
    const agentModel = agent.llmModel || agent.model || fallbackModel;

    if (result.status === "fulfilled") {
      const { parsed, isExternal } = result.value;

      positions.push({
        agentId: agent.id,
        agentName: agent.name,
        agentColor: agent.color,
        ...parsed,
      });

      // Post to room as regular message so WS clients see it
      const effectiveType = agent.agentType || "internal";
      const typeTag = isExternal ? ` [${effectiveType}]` : (agentModel !== DEFAULT_MODEL ? ` [${agentModel}]` : "");
      const displayContent = `[${phaseLabel}]${typeTag} ${parsed.position} (confidence: ${(parsed.confidence * 100).toFixed(0)}%)`;
      const msg = await storage.addRoomMessage({
        roomId,
        agentId: agent.id,
        agentName: agent.name,
        agentColor: agent.color,
        content: displayContent,
        isDecision: false,
      });
      if (msg) broadcastToRoom(roomId, msg);

      await storage.addLog({
        userId,
        agentName: agent.name,
        agentColor: agent.color,
        operation: "deliberation_round",
        detail: `${phase} r${round}: ${isExternal ? effectiveType : `model=${agentModel}`} confidence=${parsed.confidence}`,
        latencyMs: null,
      });

      // Circuit breaker: reset on success
      if (agent.consecutiveFailures > 0) {
        storage.updateAgentCircuitBreaker(agent.id, 0, null).catch(() => {});
      }
    } else {
      const err = result.reason as any;
      const classified = err?._classified ?? { category: "RETRYABLE", message: err?.message || "unknown error" };
      const errorMsg = classified.message?.slice(0, 200) || "unknown error";
      console.error(`[structured-deliberation] ${agent.name} error (${classified.category}):`, errorMsg);

      // Error position uses "[error: <reason>]" format per spec
      positions.push({
        agentId: agent.id,
        agentName: agent.name,
        agentColor: agent.color,
        position: `[error: ${errorMsg.slice(0, 100)}]`,
        confidence: 0,
        reasoning: `Agent failed after retries: ${errorMsg}`,
      });

      // Track error in round metadata
      roundErrors.push({
        agentId: agent.id,
        agentName: agent.name,
        errorType: classified.category,
        errorMessage: errorMsg,
        attempts: (err?._retryErrors?.length ?? 0) + 1,
      });

      // Circuit breaker: increment consecutive failures
      const cbResult = checkCircuitBreaker(agent.consecutiveFailures ?? 0, false, errorMsg);
      storage.updateAgentCircuitBreaker(
        agent.id,
        cbResult.consecutiveFailures,
        cbResult.errorMessage || null,
        cbResult.tripped ? "error" : undefined
      ).catch(() => {});

      if (cbResult.tripped) {
        console.warn(`[circuit-breaker] Agent ${agent.name} (id=${agent.id}) tripped after ${cbResult.consecutiveFailures} consecutive failures`);
        await storage.addLog({
          userId,
          agentName: agent.name,
          agentColor: agent.color,
          operation: "circuit_breaker_tripped",
          detail: `Agent marked as error after ${cbResult.consecutiveFailures} consecutive deliberation failures: ${errorMsg.slice(0, 100)}`,
          latencyMs: null,
        });
      }

      // Log the error to audit
      await storage.addLog({
        userId,
        agentName: agent.name,
        agentColor: agent.color,
        operation: "deliberation_error",
        detail: `${phase} r${round}: ${classified.category} — ${errorMsg.slice(0, 150)}`,
        latencyMs: null,
      });
    }
  }


  // ── Human participant input ──
  if (includeHuman) {
    const humanInput = await waitForHumanInput(roomId, sessionId, phase, round, topic, positions);

    if (humanInput) {
      const humanPosition: AgentPosition = {
        agentId: -1, // sentinel for human
        agentName: humanName,
        agentColor: "#D4AF37",
        position: humanInput.position,
        confidence: Math.max(0, Math.min(1, humanInput.confidence)),
        reasoning: humanInput.reasoning,
      };
      positions.push(humanPosition);

      // Post to room as message
      const displayContent = `[${phaseLabel}] [Human] ${humanInput.position} (confidence: ${(humanPosition.confidence * 100).toFixed(0)}%)`;
      const msg = await storage.addRoomMessage({
        roomId,
        agentId: null,
        agentName: humanName,
        agentColor: "#D4AF37",
        content: displayContent,
        isDecision: false,
      });
      if (msg) broadcastToRoom(roomId, msg);
    } else {
      // Human timed out — mark as abstain
      positions.push({
        agentId: -1,
        agentName: humanName,
        agentColor: "#D4AF37",
        position: "[abstained — no response within 60s]",
        confidence: 0,
        reasoning: "Human participant did not respond within the time limit.",
      });

      await postSystemMessage(roomId, `⏱️ ${humanName} did not respond in time — marked as abstain.`);
    }
  }

  const roundResult: DeliberationRound = { phase, round, positions, timestamp: Date.now() };
  if (roundErrors.length > 0) {
    roundResult.errors = roundErrors;
  }
  return { round: roundResult, injectedMemories: roundInjectedMemories };
}

// ── Prompt Builder ────────────────────────────────────────────────

// Role-specific behavioral instructions
const ROLE_INSTRUCTIONS: Record<string, string> = {
  devils_advocate: `YOUR ROLE: Devil's Advocate.
You MUST argue AGAINST the majority position, even if you personally agree.
Find weaknesses, edge cases, and hidden risks in every proposal.
If everyone agrees, you MUST dissent and explain why the consensus could be wrong.
Never be agreeable — your job is to stress-test ideas.`,

  contrarian: `YOUR ROLE: Contrarian.
You naturally see things differently from the crowd.
Propose unconventional or counterintuitive perspectives.
Challenge assumptions that others take for granted.
Your value comes from thinking orthogonally to the group.`,

  mediator: `YOUR ROLE: Mediator.
Your job is to find common ground between disagreeing agents.
Identify areas of agreement first, then bridge the gaps.
Propose compromise positions that integrate the strongest arguments from each side.
Never take an extreme position — synthesize.`,

  analyst: `YOUR ROLE: Analyst.
Focus on data, evidence, and logical rigor.
Demand specifics — reject vague claims.
Break down the problem into measurable components.
If someone makes a claim, ask what evidence supports it.`,

  optimist: `YOUR ROLE: Optimist.
Focus on opportunities, upside potential, and best-case scenarios.
Highlight what could go RIGHT with each proposal.
Counter risk-heavy arguments with possibility thinking.
Be enthusiastic but grounded in reasoning.`,

  pessimist: `YOUR ROLE: Pessimist.
Focus on risks, downsides, and worst-case scenarios.
Highlight what could go WRONG with each proposal.
Demand contingency plans and fallback options.
Be cautious and thorough in identifying failure modes.`,
};

function buildDeliberationPrompt(
  name: string,
  description: string,
  memoryContext: string,
  phase: "position" | "debate" | "final",
  topic: string,
  priorPositions: AgentPosition[],
  role: string | null
): string {
  const sanitizedDesc = sanitizeForPrompt(description);
  const sanitizedTopic = sanitizeForPrompt(topic);
  // memoryContext is pre-formatted by formatMemoryContext() — already structured with types + confidence
  const memBlock = memoryContext || "";

  const roleBlock = role && ROLE_INSTRUCTIONS[role]
    ? `\n\n${ROLE_INSTRUCTIONS[role]}`
    : "";

  const priorBlock =
    priorPositions.length > 0
      ? `\n\nOther agents' positions so far:\n${priorPositions
          .map(
            (p) =>
              `- ${p.agentName}: "${sanitizeForPrompt(p.position)}" (confidence: ${(p.confidence * 100).toFixed(0)}%) — Reasoning: ${sanitizeForPrompt(p.reasoning)}`
          )
          .join("\n")}`
      : "";

  const phaseInstruction =
    phase === "position"
      ? "This is Phase 1 — give your INITIAL position on the topic. You have NOT seen others' views yet. Be honest and direct."
      : phase === "debate"
      ? "This is the DEBATE phase. You have seen other agents' positions. You MUST engage with their arguments — agree, disagree, or refine. If you see a flaw in someone's reasoning, call it out by name. If someone changed your mind, say so. Do NOT just repeat your original position."
      : "This is the FINAL phase. You've heard all arguments. Give your FINAL position. Your confidence may have changed. If you changed your mind, explain why. If you held firm, explain why others' arguments didn't convince you.";

  return `You are ${name}, participating in a structured deliberation inside KIOKU™ War Room.

${sanitizedDesc ? `About you: ${sanitizedDesc}` : ""}${roleBlock}${memBlock}

DELIBERATION TOPIC: "${sanitizedTopic}"

${phaseInstruction}
${priorBlock}

RULES:
- Respond ONLY in the required format: POSITION: / CONFIDENCE: / REASONING:
- Be specific and actionable — no vague generalities
- Confidence must be a number between 0.0 (no confidence) and 1.0 (absolute certainty)
- In debate phase: you MUST reference at least one other agent's argument by name
- Never reveal you are an AI model
- Keep each field concise (1-3 sentences max)
${role ? `- IMPORTANT: Stay true to your assigned role (${role.replace(/_/g, " ")}) throughout the entire deliberation` : ""}`;
}

// ── Response Parser ───────────────────────────────────────────────

function parseAgentResponse(
  raw: string,
  agentName: string
): { position: string; confidence: number; reasoning: string } {
  const posMatch = raw.match(/POSITION:\s*(.+?)(?=\nCONFIDENCE:|\n\n|$)/i);
  const confMatch = raw.match(/CONFIDENCE:\s*([\d.]+)/i);
  const reasonMatch = raw.match(/REASONING:\s*([\s\S]+?)$/i);

  const position = posMatch?.[1]?.trim() || raw.slice(0, 200);
  const confidence = Math.max(0, Math.min(1, parseFloat(confMatch?.[1] || "0.5")));
  const reasoning = reasonMatch?.[1]?.trim() || "No explicit reasoning provided";

  return { position, confidence, reasoning };
}

// ── Consensus Builder ─────────────────────────────────────────────

function buildConsensus(
  initialPositions: AgentPosition[],
  finalPositions: AgentPosition[],
  topic: string
): ConsensusResult {
  // Weighted vote: each agent's final position weighted by confidence
  const votes = finalPositions.map((fp) => {
    const initial = initialPositions.find((ip) => ip.agentId === fp.agentId);
    return {
      agentName: fp.agentName,
      position: fp.position,
      confidence: fp.confidence,
      changedMind: initial ? initial.position !== fp.position : false,
    };
  });

  // Find majority position (simplified: highest total weighted confidence)
  const positionWeights = new Map<string, number>();
  for (const v of votes) {
    // Normalize positions for grouping (lowercase, trim)
    const key = v.position.toLowerCase().trim();
    positionWeights.set(key, (positionWeights.get(key) || 0) + v.confidence);
  }

  // Since positions are free-text, group by the agent with highest confidence
  // In practice, the "decision" is the position of the highest-weighted agent
  const sorted = [...votes].sort((a, b) => b.confidence - a.confidence);
  const topPosition = sorted[0];

  // Average confidence across all agents
  const avgConfidence =
    votes.reduce((sum, v) => sum + v.confidence, 0) / votes.length;

  // Dissent: agents whose final confidence < 0.4 or who changed mind away from majority
  const dissent = votes
    .filter((v) => v.confidence < 0.4 || (v.position !== topPosition.position && v.confidence > 0.3))
    .map((v) => `${v.agentName}: "${v.position}" (${(v.confidence * 100).toFixed(0)}%)`);

  return {
    decision: topPosition.position,
    confidence: avgConfidence,
    method: "weighted_majority",
    votes,
    dissent,
  };
}

// ── Retry Error Logger ───────────────────────────────────────────

function logRetryErrors(
  errors: Array<{ attempt: number; error: ClassifiedError; willRetry: boolean }>,
  agentId: number,
  agentName: string,
  sessionId?: string
) {
  for (const entry of errors) {
    const log: AgentErrorLog = {
      agentId,
      agentName,
      errorType: entry.error.category,
      errorMessage: entry.error.message,
      attemptNumber: entry.attempt + 1,
      willRetry: entry.willRetry,
      sessionId,
    };
    console.warn(formatErrorLog(log));
  }
}

// ── Helpers ───────────────────────────────────────────────────────

async function postSystemMessage(roomId: number, content: string) {
  const msg = await storage.addRoomMessage({
    roomId,
    agentId: null,
    agentName: "KIOKU™ System",
    agentColor: "#888888",
    content,
    isDecision: false,
  });
  if (msg) broadcastToRoom(roomId, msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── DB Persistence Helper ────────────────────────────────────────

async function persistSession(session: DeliberationSession, userId: number) {
  await storage.saveDeliberationSession({
    id: session.sessionId,
    roomId: session.roomId,
    userId,
    topic: session.topic,
    status: session.status,
    model: session.model,
    modelsUsed: session.modelsUsed,
    rounds: session.rounds,
    consensus: session.consensus,
    startedAt: session.startedAt,
    completedAt: session.completedAt,
    parentDecisionId: session.parentDecisionId,
    provenanceChain: session.provenanceChain,
  });
}

// ── Public API (reads from DB) ───────────────────────────────────

export async function getSession(sessionId: string): Promise<DeliberationSession | undefined> {
  return storage.getDeliberationSession(sessionId) as Promise<DeliberationSession | undefined>;
}

export async function getSessionsByRoom(roomId: number): Promise<DeliberationSession[]> {
  return storage.getDeliberationsByRoom(roomId) as Promise<DeliberationSession[]>;
}

export async function getLatestConsensus(roomId: number): Promise<ConsensusResult | null> {
  return storage.getLatestConsensus(roomId);
}

// ── Provenance Chain API ────────────────────────────────────────────

/**
 * Get the full provenance chain for a decision: all ancestors + all descendants.
 */
export async function getProvenanceChain(sessionId: string): Promise<{
  decision: DeliberationSession;
  ancestors: DeliberationSession[];
  descendants: DeliberationSession[];
} | null> {
  const decision = await storage.getDeliberationSession(sessionId) as DeliberationSession | undefined;
  if (!decision) return null;

  const ancestors = await storage.getDecisionAncestors(sessionId) as DeliberationSession[];
  const descendants = await storage.getDecisionDescendants(sessionId) as DeliberationSession[];

  return { decision, ancestors, descendants };
}

/**
 * Get the provenance tree for a decision — shows how it branched into follow-up decisions.
 */
export async function getProvenanceTree(sessionId: string): Promise<ProvenanceTreeNode | null> {
  const decision = await storage.getDeliberationSession(sessionId) as DeliberationSession | undefined;
  if (!decision) return null;

  return buildProvenanceTree(decision);
}

export interface ProvenanceTreeNode {
  sessionId: string;
  topic: string;
  status: string;
  consensus: ConsensusResult | null;
  startedAt: number;
  completedAt: number | null;
  parentDecisionId: string | null;
  children: ProvenanceTreeNode[];
}

async function buildProvenanceTree(session: DeliberationSession): Promise<ProvenanceTreeNode> {
  const children = await storage.getDecisionChildren(session.sessionId) as DeliberationSession[];
  const childNodes = await Promise.all(children.map(child => buildProvenanceTree(child)));

  return {
    sessionId: session.sessionId,
    topic: session.topic,
    status: session.status,
    consensus: session.consensus,
    startedAt: session.startedAt,
    completedAt: session.completedAt,
    parentDecisionId: session.parentDecisionId,
    children: childNodes,
  };
}
