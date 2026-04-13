import { z } from "zod";

// ── Validation helper ──────────────────────────────────────────────────────────
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export function validateBody<T>(schema: z.ZodSchema<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ValidationError(result.error.issues.map(i => i.message).join("; "));
  }
  return result.data;
}

// ── Auth schemas ────────────────────────────────────────────────────────────────
export const magicLinkSchema = z.object({
  email: z.string().email().max(320),
  name: z.string().max(100).optional(),
  company: z.string().max(200).optional(),
});

export const verifyTokenSchema = z.object({
  token: z.string().min(1).max(256),
});

// ── Agent schemas ───────────────────────────────────────────────────────────────
export const createAgentSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional().nullable(),
  color: z.string().max(20).optional(),
  llmProvider: z.enum(["openai", "gemini"]).optional().nullable(),
  llmApiKey: z.string().max(256).optional().nullable(),
  llmModel: z.string().max(50).optional().nullable(),
});

export const updateAgentSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional().nullable(),
  color: z.string().max(20).optional(),
  model: z.string().max(50).optional(),
  role: z.string().max(50).optional(),
  llmProvider: z.enum(["openai", "gemini"]).optional().nullable(),
  llmApiKey: z.string().max(256).optional().nullable(),
  llmModel: z.string().max(50).optional().nullable(),
});

export const toggleAgentSchema = z.object({
  enabled: z.boolean().optional(),
  status: z.string().max(20).optional(),
});

// ── Memory schemas ──────────────────────────────────────────────────────────────
export const createMemorySchema = z.object({
  content: z.string().min(1).max(50000),
  agentId: z.number().nullable().optional(),
  agentName: z.string().max(100).nullable().optional(),
  type: z.enum(["semantic", "episodic", "procedural", "emotional", "temporal", "causal", "contextual"]).optional(),
  importance: z.number().min(0).max(1).optional(),
  namespace: z.string().max(100).optional(),
  room_id: z.union([z.string(), z.number()]).optional(),
  // Phase 2: Confidence decay
  confidence: z.number().min(0).max(1).optional(),
  decayRate: z.number().min(0).max(1).optional(),
  // Phase 2: Type-specific fields
  expiresAt: z.number().optional(),        // temporal memories
  causeId: z.number().int().optional(),     // causal memories
  contextTrigger: z.string().max(500).optional(), // contextual memories
});

export const purgeMemoriesSchema = z.object({
  scope: z.enum(["all", "agent"]),
  agent_id: z.string().max(100).optional(),
});

// ── Memory Link schemas ────────────────────────────────────────────────────────
export const createMemoryLinkSchema = z.object({
  targetId: z.number().int(),
  linkType: z.enum(["related", "causal", "contradicts", "refines", "supports"]).optional(),
  strength: z.number().min(0).max(1).optional(),
});

// ── Flow schemas ────────────────────────────────────────────────────────────────
export const createFlowSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).nullable().optional(),
  agentIds: z.array(z.number()).optional(),
  positions: z.record(z.any()).optional(),
});

export const updateFlowSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).nullable().optional(),
  agentIds: z.array(z.number()).optional(),
  positions: z.record(z.any()).optional(),
  agentRoles: z.record(z.any()).optional(),
});

// ── Room schemas ────────────────────────────────────────────────────────────────
export const createRoomSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional().nullable(),
  agentIds: z.array(z.number()).optional(),
});

export const updateRoomSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).nullable().optional(),
  status: z.string().max(50).optional(),
  agentIds: z.array(z.number()).optional(),
});

// ── Room Message schemas ────────────────────────────────────────────────────────
export const createRoomMessageSchema = z.object({
  agentId: z.number().nullable().optional(),
  agentName: z.string().min(1).max(100),
  agentColor: z.string().max(20).optional(),
  content: z.string().min(1).max(50000),
  isDecision: z.boolean().optional(),
});

// ── Deliberation schemas ────────────────────────────────────────────────────────
const ALLOWED_MODELS = [
  // OpenAI models
  "gpt-5.4-mini", "gpt-5.4", "gpt-5.4-nano", "gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini", "gpt-4o",
  // Gemini models
  "gemini-2.0-flash", "gemini-2.5-flash", "gemini-2.5-pro", "gemini-3.1-pro",
] as const;

export const deliberateSchema = z.object({
  topic: z.string().min(1).max(2000),
  model: z.enum(ALLOWED_MODELS).optional(),
  debateRounds: z.number().int().min(1).max(5).optional(),
});

// ── Webhook schemas ─────────────────────────────────────────────────────────────
export const createWebhookSchema = z.object({
  url: z.string().url().max(2000),
});

// ── Agent Token schemas ─────────────────────────────────────────────────────────
export const createAgentTokenSchema = z.object({
  name: z.string().max(100).optional(),
  scopes: z.array(z.string().max(100)).optional(),
  expiresInDays: z.number().int().min(1).max(365).optional(),
});

// ── Agent Callback schemas ──────────────────────────────────────────────────────
export const agentCallbackSchema = z.object({
  sessionId: z.string().min(1).max(200),
  position: z.string().min(1).max(5000),
  confidence: z.number().min(0).max(1).optional(),
  reasoning: z.string().max(10000).optional(),
});

// ── War Room schemas ────────────────────────────────────────────────────────────
export const warRoomMessageSchema = z.object({
  agentName: z.string().min(1).max(100),
  content: z.string().min(1).max(50000),
  agentColor: z.string().max(20).optional(),
  isDecision: z.boolean().optional(),
  roomName: z.string().max(200).optional(),
});

// ── Billing schemas ─────────────────────────────────────────────────────────────
export const updatePlanSchema = z.object({
  plan: z.enum(["free", "starter", "professional", "enterprise"]),
  billingCycle: z.enum(["monthly", "yearly"]).optional(),
});

// ── Registration schemas ────────────────────────────────────────────────────────
export const registerSchema = z.object({
  email: z.string().email().max(320),
  name: z.string().max(100).optional(),
  plan: z.string().max(50).optional(),
});

// ── Waitlist schemas ────────────────────────────────────────────────────────────
export const waitlistSchema = z.object({
  email: z.string().email().max(320),
  name: z.string().max(100).optional(),
  company: z.string().max(200).optional(),
  useCase: z.string().max(2000).optional(),
});
