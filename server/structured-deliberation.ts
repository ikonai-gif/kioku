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
import { broadcastToRoom } from "./ws";

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

/**
 * Call OpenAI LLM directly.
 */
async function callOpenAI(
  model: string,
  systemPrompt: string,
  userMessage: string,
  maxTokens: number,
  temperature: number
): Promise<string> {
  if (!openai) throw new Error("OPENAI_API_KEY not configured");
  const completion = await openai.chat.completions.create({
    model,
    max_tokens: maxTokens,
    temperature,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
  });
  return completion.choices[0]?.message?.content?.trim() || "";
}

/**
 * Call Gemini LLM directly.
 */
async function callGemini(
  model: string,
  systemPrompt: string,
  userMessage: string,
  maxTokens: number,
  temperature: number
): Promise<string> {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not configured");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
 */
async function callLLM(
  model: string,
  systemPrompt: string,
  userMessage: string,
  options?: { maxTokens?: number; temperature?: number }
): Promise<string> {
  const maxTokens = options?.maxTokens ?? 400;
  const temperature = options?.temperature ?? 0.7;

  if (isGeminiModel(model)) {
    try {
      return await callGemini(model, systemPrompt, userMessage, maxTokens, temperature);
    } catch (err: any) {
      if (!openai) {
        throw new Error(`All AI providers failed. Gemini: ${err.message}`);
      }
      console.warn(`[deliberation] Gemini failed, falling back to OpenAI:`, err.message);
      try {
        return await callOpenAI(DEFAULT_MODEL, systemPrompt, userMessage, maxTokens, temperature);
      } catch (openaiErr: any) {
        throw new Error(`All AI providers failed. Gemini: ${err.message}, OpenAI: ${openaiErr.message}`);
      }
    }
  }

  // OpenAI models — try OpenAI first, fall back to Gemini
  try {
    return await callOpenAI(model, systemPrompt, userMessage, maxTokens, temperature);
  } catch (err: any) {
    if (!GEMINI_API_KEY) {
      throw new Error(`All AI providers failed. OpenAI: ${err.message}`);
    }
    console.warn(`[deliberation] OpenAI failed, falling back to Gemini:`, err.message);
    try {
      return await callGemini(GEMINI_FALLBACK_MODEL, systemPrompt, userMessage, maxTokens, temperature);
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

// ── Main Entry Point ──────────────────────────────────────────────

export async function runDeliberation(
  roomId: number,
  userId: number,
  topic: string,
  options?: { model?: string; debateRounds?: number }
): Promise<DeliberationSession> {
  if (!openai && !GEMINI_API_KEY) throw new Error("No AI provider configured (set OPENAI_API_KEY or GEMINI_API_KEY)");
  if (activeSessions.has(roomId)) throw new Error("Deliberation already running in this room");

  activeSessions.add(roomId);
  const sessionId = `dlb_${roomId}_${Date.now()}`;
  const fallbackModel = options?.model || DEFAULT_MODEL;
  const debateRounds = options?.debateRounds ?? 2;

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

    if (agents.length < 2) throw new Error("Need at least 2 non-offline agents for deliberation");

    // Post system message: deliberation starting
    await postSystemMessage(roomId, `⚡ Structured deliberation started: "${topic}" — ${agents.length} agents, ${debateRounds} debate rounds`);

    // ── Phase 1: Initial Positions ──
    const initialPositions = await collectPositions(
      roomId, userId, agents, topic, "position", 1, fallbackModel, [], sessionId
    );
    session.rounds.push(initialPositions);
    await persistSession(session, userId);

    // ── Phase 2: Debate Rounds ──
    let previousPositions = initialPositions.positions;
    for (let r = 1; r <= debateRounds; r++) {
      const debateResult = await collectPositions(
        roomId, userId, agents, topic, "debate", r, fallbackModel, previousPositions, sessionId
      );
      session.rounds.push(debateResult);
      previousPositions = debateResult.positions;
      await persistSession(session, userId);
    }

    // ── Phase 3: Final Positions ──
    const allPriorPositions = session.rounds.flatMap((r) => r.positions);
    const finalPositions = await collectPositions(
      roomId, userId, agents, topic, "final", 1, fallbackModel, allPriorPositions, sessionId
    );
    session.rounds.push(finalPositions);
    await persistSession(session, userId);

    // ── Phase 4: Consensus ──
    const consensus = buildConsensus(
      initialPositions.positions,
      finalPositions.positions,
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

    // Save decision to memories
    await storage.createMemory({
      userId,
      agentId: null,
      agentName: "KIOKU™ Consensus",
      content: `[Decision] ${consensus.decision}`,
      type: "procedural",
      importance: 0.95,
      namespace: "decisions",
    });

    // Log dissent if any
    if (consensus.dissent.length > 0) {
      await postSystemMessage(roomId, `📋 Dissenting views: ${consensus.dissent.join("; ")}`);
    }

    await postSystemMessage(roomId, `✅ Deliberation complete. Consensus confidence: ${(consensus.confidence * 100).toFixed(0)}%`);

    // Collect unique models used
    session.modelsUsed = Array.from(new Set(agents.map((a) => a.model || fallbackModel)));
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
  agents: Array<{ id: number; name: string; description: string | null; color: string; model: string | null; role: string | null }>,
  topic: string,
  phase: "position" | "debate" | "final",
  round: number,
  fallbackModel: string,
  priorPositions: AgentPosition[],
  sessionId: string
): Promise<DeliberationRound> {
  const phaseLabel =
    phase === "position" ? "📍 Phase 1 — Initial Positions" :
    phase === "debate" ? `💬 Debate Round ${round}` :
    "🎯 Final Positions";

  await postSystemMessage(roomId, phaseLabel);

  const positions: AgentPosition[] = [];

  for (let i = 0; i < agents.length; i++) {
    const agent = agents[i];

    // Fetch agent memories for persona
    const memories = await storage.getMemories(userId);
    const agentMemories = memories
      .filter((m) => m.agentId === agent.id)
      .slice(0, 5)
      .map((m) => m.content)
      .join("\n");

    const systemPrompt = buildDeliberationPrompt(
      agent.name,
      agent.description ?? "",
      agentMemories,
      phase,
      topic,
      priorPositions,
      agent.role
    );

    // Use agent's assigned model, or fallback
    const agentModel = agent.model || fallbackModel;

    try {
      // Check if agent has an external webhook registered
      const webhook = await storage.getWebhook(agent.id);
      let parsed: { position: string; confidence: number; reasoning: string };

      if (webhook) {
        // External agent — dispatch via webhook
        parsed = await callWebhook(webhook.url, webhook.secret, {
          event: "deliberation.round",
          sessionId,
          roomId,
          agentId: agent.id,
          agentName: agent.name,
          topic,
          phase,
          round,
          priorPositions,
        });
      } else {
        // Internal agent — call LLM directly
        const raw = await callLLM(
          agentModel,
          systemPrompt,
          `Topic for deliberation: "${topic}"\n\nRespond with your position in the EXACT format:\nPOSITION: [your clear position in 1-2 sentences]\nCONFIDENCE: [number 0.0 to 1.0]\nREASONING: [your argument in 2-3 sentences]`,
          { maxTokens: 400, temperature: phase === "debate" ? 0.8 : 0.6 }
        );
        parsed = parseAgentResponse(raw, agent.name);
      }

      positions.push({
        agentId: agent.id,
        agentName: agent.name,
        agentColor: agent.color,
        ...parsed,
      });

      // Stagger timing
      await sleep(600 + i * 400);

      // Post to room as regular message so WS clients see it
      const modelTag = webhook ? " [webhook]" : (agentModel !== DEFAULT_MODEL ? ` [${agentModel}]` : "");
      const displayContent = `[${phaseLabel}]${modelTag} ${parsed.position} (confidence: ${(parsed.confidence * 100).toFixed(0)}%)`;
      const msg = await storage.addRoomMessage({
        roomId,
        agentId: agent.id,
        agentName: agent.name,
        agentColor: agent.color,
        content: displayContent,
        isDecision: false,
      });
      if (msg) broadcastToRoom(roomId, msg);

      // Log
      await storage.addLog({
        userId,
        agentName: agent.name,
        agentColor: agent.color,
        operation: "deliberation_round",
        detail: `${phase} r${round}: ${webhook ? "webhook" : `model=${agentModel}`} confidence=${parsed.confidence}`,
        latencyMs: null,
      });
    } catch (err) {
      console.error(`[structured-deliberation] ${agent.name} error:`, err);
      positions.push({
        agentId: agent.id,
        agentName: agent.name,
        agentColor: agent.color,
        position: "[no response]",
        confidence: 0,
        reasoning: "Agent failed to respond",
      });
    }
  }

  return { phase, round, positions, timestamp: Date.now() };
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
  memories: string,
  phase: "position" | "debate" | "final",
  topic: string,
  priorPositions: AgentPosition[],
  role: string | null
): string {
  const memBlock = memories ? `\n\nYour relevant memories:\n${memories}` : "";

  const roleBlock = role && ROLE_INSTRUCTIONS[role]
    ? `\n\n${ROLE_INSTRUCTIONS[role]}`
    : "";

  const priorBlock =
    priorPositions.length > 0
      ? `\n\nOther agents' positions so far:\n${priorPositions
          .map(
            (p) =>
              `- ${p.agentName}: "${p.position}" (confidence: ${(p.confidence * 100).toFixed(0)}%) — Reasoning: ${p.reasoning}`
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

${description ? `About you: ${description}` : ""}${roleBlock}${memBlock}

DELIBERATION TOPIC: "${topic}"

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
