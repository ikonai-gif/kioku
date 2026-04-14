import { pgTable, text, integer, real, serial, bigint, boolean, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Users / Workspaces
export const users = pgTable("users", {
  id:           serial("id").primaryKey(),
  email:        text("email").notNull().unique(),
  name:         text("name").notNull(),
  company:      text("company"),
  plan:             text("plan").notNull().default("dev"),       // dev | starter | team | business
  billingCycle:     text("billing_cycle").notNull().default("monthly"),
  stripeCustomerId: text("stripe_customer_id"),
  apiKey:           text("api_key").notNull().unique(),
  createdAt:    bigint("created_at", { mode: "number" }).notNull(),
  role:             text("role").notNull().default("user"),
});

export const insertUserSchema = createInsertSchema(users).omit({ id: true, createdAt: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

// Magic link tokens
export const magicTokens = pgTable("magic_tokens", {
  id:        serial("id").primaryKey(),
  email:     text("email").notNull(),
  token:     text("token").notNull().unique(),
  expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
  used:      boolean("used").notNull().default(false),
});

export const insertMagicTokenSchema = createInsertSchema(magicTokens).omit({ id: true });
export type InsertMagicToken = z.infer<typeof insertMagicTokenSchema>;
export type MagicToken = typeof magicTokens.$inferSelect;

// Agents
export const agents = pgTable("agents", {
  id:            serial("id").primaryKey(),
  userId:        integer("user_id").notNull(),
  name:          text("name").notNull(),
  description:   text("description"),
  color:         text("color").notNull().default("#D4AF37"),
  model:         text("model"),                                // gpt-4.1-mini | gpt-4o | gemini-2.0-flash | null=default
  role:          text("role"),                                  // devils_advocate | contrarian | mediator | analyst | null=default
  llmProvider:   text("llm_provider"),                         // openai | gemini | null=use default
  llmApiKey:     text("llm_api_key"),                          // encrypted per-agent API key | null=use shared
  llmModel:      text("llm_model"),                            // per-agent model override | null=use default
  agentType:     text("agent_type").notNull().default("internal"), // internal | webhook | polling
  webhookUrl:    text("webhook_url"),                          // webhook mode: POST target URL
  webhookSecret: text("webhook_secret"),                       // webhook mode: HMAC signing secret
  status:        text("status").notNull().default("idle"),   // online | idle | offline | error
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),  // circuit breaker counter
  errorMessage:  text("error_message"),                        // last error reason (when status=error)
  memoriesCount: integer("memories_count").notNull().default(0),
  lastActiveAt:  bigint("last_active_at", { mode: "number" }),
  enabled:       boolean("enabled").notNull().default(true),
  createdAt:     bigint("created_at", { mode: "number" }).notNull(),
});

export const insertAgentSchema = createInsertSchema(agents).omit({ id: true, createdAt: true });
export type InsertAgent = z.infer<typeof insertAgentSchema>;
export type Agent = typeof agents.$inferSelect;

// Memories — embedding stored as JSON array string
// NOTE: DB also has `embedding_vec vector(1536)` column managed via raw SQL (pgvector)
export const memories = pgTable("memories", {
  id:        serial("id").primaryKey(),
  userId:    integer("user_id").notNull(),
  agentId:   integer("agent_id"),
  agentName: text("agent_name"),
  content:   text("content").notNull(),
  type:      text("type").notNull().default("semantic"),     // semantic | episodic | procedural | emotional | temporal | causal | contextual
  importance: real("importance").notNull().default(0.5),
  namespace: text("namespace"),
  embedding: text("embedding"),                              // JSON float[] from OpenAI
  strength:         real("strength").default(1.0),           // 0.0-1.0, decays over time
  emotionalValence: real("emotional_valence"),               // -1.0 (negative) to 1.0 (positive)
  lastAccessedAt:   bigint("last_accessed_at", { mode: "number" }),
  accessCount:      integer("access_count").default(0),
  // Phase 2: Confidence decay system
  confidence:       real("confidence").default(1.0),         // 0.0-1.0, decays over time unless reinforced
  decayRate:        real("decay_rate").default(0.01),        // rate per day
  lastReinforcedAt: bigint("last_reinforced_at", { mode: "number" }),
  reinforcements:   integer("reinforcements").default(0),
  // Phase 2: Type-specific fields
  expiresAt:        bigint("expires_at", { mode: "number" }),          // temporal memories
  causeId:          integer("cause_id"),                                // causal memories — references another memory
  contextTrigger:   text("context_trigger"),                           // contextual memories
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export const insertMemorySchema = createInsertSchema(memories).omit({ id: true, createdAt: true });
export type InsertMemory = z.infer<typeof insertMemorySchema>;
export type Memory = typeof memories.$inferSelect;

// Memory Links (synaptic connections)
export const memoryLinks = pgTable("memory_links", {
  id:             serial("id").primaryKey(),
  sourceMemoryId: integer("source_memory_id").notNull(),
  targetMemoryId: integer("target_memory_id").notNull(),
  userId:         integer("user_id").notNull(),
  linkType:       text("link_type").notNull().default("related"),  // related | causal | contradicts | refines | supports
  strength:       real("strength").notNull().default(0.5),         // 0.0-1.0
  createdAt:      bigint("created_at", { mode: "number" }).notNull(),
});

export const insertMemoryLinkSchema = createInsertSchema(memoryLinks).omit({ id: true, createdAt: true });
export type InsertMemoryLink = z.infer<typeof insertMemoryLinkSchema>;
export type MemoryLink = typeof memoryLinks.$inferSelect;

// Flows
export const flows = pgTable("flows", {
  id:          serial("id").primaryKey(),
  userId:      integer("user_id").notNull(),
  name:        text("name").notNull(),
  description: text("description"),
  agentIds:    text("agent_ids").notNull().default("[]"),
  positions:   text("positions").notNull().default("{}"),
  agentRoles:  text("agent_roles").notNull().default("{}"),
  createdAt:   bigint("created_at", { mode: "number" }).notNull(),
});

export const insertFlowSchema = createInsertSchema(flows).omit({ id: true, createdAt: true });
export type InsertFlow = z.infer<typeof insertFlowSchema>;
export type Flow = typeof flows.$inferSelect;

// Deliberation Rooms
export const rooms = pgTable("rooms", {
  id:          serial("id").primaryKey(),
  userId:      integer("user_id").notNull(),
  name:        text("name").notNull(),
  description: text("description"),
  status:      text("status").notNull().default("standby"),  // active | standby | idle
  agentIds:    text("agent_ids").notNull().default("[]"),
  createdAt:   bigint("created_at", { mode: "number" }).notNull(),
});

export const insertRoomSchema = createInsertSchema(rooms).omit({ id: true, createdAt: true });
export type InsertRoom = z.infer<typeof insertRoomSchema>;
export type Room = typeof rooms.$inferSelect;

// Room Messages
export const roomMessages = pgTable("room_messages", {
  id:         serial("id").primaryKey(),
  roomId:     integer("room_id").notNull(),
  agentId:    integer("agent_id"),
  agentName:  text("agent_name").notNull(),
  agentColor: text("agent_color").notNull().default("#D4AF37"),
  content:    text("content").notNull(),
  isDecision: boolean("is_decision").notNull().default(false),
  createdAt:  bigint("created_at", { mode: "number" }).notNull(),
});

export const insertRoomMessageSchema = createInsertSchema(roomMessages).omit({ id: true, createdAt: true });
export type InsertRoomMessage = z.infer<typeof insertRoomMessageSchema>;
export type RoomMessage = typeof roomMessages.$inferSelect;

// Agent Turns (polling mode queue)
export const agentTurns = pgTable("agent_turns", {
  id:              serial("id").primaryKey(),
  sessionId:       text("session_id").notNull(),
  agentId:         integer("agent_id").notNull(),
  roomId:          integer("room_id").notNull(),
  userId:          integer("user_id").notNull(),
  phase:           text("phase").notNull(),
  round:           integer("round").notNull().default(1),
  topic:           text("topic").notNull(),
  otherPositions:  text("other_positions").notNull().default("[]"),
  memories:        text("memories").notNull().default("[]"),
  status:          text("status").notNull().default("pending"),  // pending | responded | expired
  response:        text("response"),                              // JSON: { position, confidence, reasoning }
  respondedAt:     bigint("responded_at", { mode: "number" }),
  expiresAt:       bigint("expires_at", { mode: "number" }).notNull(),
  createdAt:       bigint("created_at", { mode: "number" }).notNull(),
});

export const insertAgentTurnSchema = createInsertSchema(agentTurns).omit({ id: true, createdAt: true });
export type InsertAgentTurn = z.infer<typeof insertAgentTurnSchema>;
export type AgentTurn = typeof agentTurns.$inferSelect;

// Live Feed / Logs
export const logs = pgTable("logs", {
  id:         serial("id").primaryKey(),
  userId:     integer("user_id").notNull(),
  agentName:  text("agent_name"),
  agentColor: text("agent_color").notNull().default("#D4AF37"),
  operation:  text("operation").notNull(),
  detail:     text("detail").notNull(),
  latencyMs:  integer("latency_ms"),
  createdAt:  bigint("created_at", { mode: "number" }).notNull(),
});

export const insertLogSchema = createInsertSchema(logs).omit({ id: true, createdAt: true });
export type InsertLog = z.infer<typeof insertLogSchema>;
export type Log = typeof logs.$inferSelect;

// Usage Tracking — per-user per-month metering
export const usageTracking = pgTable("usage_tracking", {
  id:                    serial("id").primaryKey(),
  userId:                integer("user_id").notNull(),
  periodStart:           bigint("period_start", { mode: "number" }).notNull(), // first of month UTC
  periodEnd:             bigint("period_end", { mode: "number" }).notNull(),   // first of next month UTC
  deliberations:         integer("deliberations").notNull().default(0),
  rounds:                integer("rounds").notNull().default(0),
  apiCalls:              integer("api_calls").notNull().default(0),
  webhookCalls:          integer("webhook_calls").notNull().default(0),
  tokensUsed:            integer("tokens_used").notNull().default(0),
  updatedAt:             bigint("updated_at", { mode: "number" }).notNull(),
});

export const insertUsageTrackingSchema = createInsertSchema(usageTracking).omit({ id: true });
export type InsertUsageTracking = z.infer<typeof insertUsageTrackingSchema>;
export type UsageTracking = typeof usageTracking.$inferSelect;
