/**
 * Deliberation Engine — Phase 2A
 * When a user posts a message to a room, online agents in that room
 * automatically generate AI responses via OpenAI gpt-4o-mini.
 * Each agent has its own "persona" derived from name + description + memories.
 */

import OpenAI from "openai";
import { storage } from "./storage";
import { broadcastToRoom } from "./ws";

const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

export const deliberationEnabled = !!openai;

// Prevent simultaneous agent responses for same room (simple lock)
const roomLocks = new Set<number>();

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
  roomAgentIds: number[]
): Promise<void> {
  if (!openai) return;
  if (roomLocks.has(roomId)) return; // already processing
  roomLocks.add(roomId);

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

      // Fetch agent's recent memories for persona context
      const memories = await storage.getMemories(userId);
      const agentMemories = memories
        .filter((m) => m.agentId === agent.id)
        .slice(0, 5)
        .map((m) => m.content)
        .join("\n");

      const systemPrompt = buildSystemPrompt(agent.name, agent.description ?? "", agentMemories);

      // Build conversation history for context
      const chatHistory: Array<{ role: "user" | "assistant"; content: string }> = recent.map(
        (m) => ({
          role: m.agentId === agent.id ? "assistant" : "user",
          content: `[${m.agentName}]: ${m.content}`,
        })
      );

      try {
        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          max_tokens: 256,
          temperature: 0.75,
          messages: [
            { role: "system", content: systemPrompt },
            ...chatHistory,
            {
              role: "user",
              content: `[${triggerAgentName}]: ${triggerContent}`,
            },
          ],
        });

        const reply = completion.choices[0]?.message?.content?.trim();
        if (!reply) continue;

        // Stagger: first agent responds after 800ms, each subsequent +600ms
        await sleep(800 + i * 600);

        const msg = await storage.addRoomMessage({
          roomId,
          agentId: agent.id,
          agentName: agent.name,
          agentColor: agent.color,
          content: reply,
          isDecision: false,
        });

        // Log
        await storage.addLog({
          userId,
          agentName: agent.name,
          agentColor: agent.color,
          operation: "deliberation",
          detail: `${agent.name} responded in room`,
          latencyMs: null,
        });

        // Update agent lastActiveAt
        await storage.updateAgentStatus(agent.id, userId, "online");

        // Broadcast to WS subscribers
        if (msg) broadcastToRoom(roomId, msg);
      } catch (err) {
        console.error(`[deliberation] agent ${agent.name} error:`, err);
      }
    }
  } finally {
    roomLocks.delete(roomId);
  }
}

function buildSystemPrompt(name: string, description: string, memories: string): string {
  const memBlock = memories
    ? `\n\nYour recent memories:\n${memories}`
    : "";

  return `You are ${name}, an AI agent inside KIOKU™ War Room — a real-time multi-agent deliberation environment built by IKONBAI™.

${description ? `About you: ${description}` : ""}${memBlock}

RULES:
- Respond as ${name} — stay in character, be direct and insightful
- Keep responses SHORT (1-3 sentences max) — this is a fast-paced deliberation, not a lecture
- Build on what others have said — reference them by name if relevant
- If you have a strong opinion or see a risk, say it clearly
- Never start with "I think" or "As an AI" — just speak
- Never reveal you are an OpenAI model
- Never use markdown formatting — plain text only`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
