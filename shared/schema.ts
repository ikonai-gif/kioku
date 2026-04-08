import { pgTable, text, integer, real, serial, bigint, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Users / Workspaces
export const users = pgTable("users", {
  id:           serial("id").primaryKey(),
  email:        text("email").notNull().unique(),
  name:         text("name").notNull(),
  company:      text("company"),
  plan:         text("plan").notNull().default("dev"),       // dev | starter | team | business
  billingCycle: text("billing_cycle").notNull().default("monthly"),
  apiKey:       text("api_key").notNull().unique(),
  createdAt:    bigint("created_at", { mode: "number" }).notNull(),
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
  status:        text("status").notNull().default("idle"),   // online | idle | offline
  memoriesCount: integer("memories_count").notNull().default(0),
  lastActiveAt:  bigint("last_active_at", { mode: "number" }),
  enabled:       boolean("enabled").notNull().default(true),
  createdAt:     bigint("created_at", { mode: "number" }).notNull(),
});

export const insertAgentSchema = createInsertSchema(agents).omit({ id: true, createdAt: true });
export type InsertAgent = z.infer<typeof insertAgentSchema>;
export type Agent = typeof agents.$inferSelect;

// Memories — embedding stored as JSON array string (for pgvector later)
export const memories = pgTable("memories", {
  id:        serial("id").primaryKey(),
  userId:    integer("user_id").notNull(),
  agentId:   integer("agent_id"),
  agentName: text("agent_name"),
  content:   text("content").notNull(),
  type:      text("type").notNull().default("semantic"),     // semantic | episodic | procedural
  importance: real("importance").notNull().default(0.5),
  namespace: text("namespace"),
  embedding: text("embedding"),                              // JSON float[] from OpenAI
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export const insertMemorySchema = createInsertSchema(memories).omit({ id: true, createdAt: true });
export type InsertMemory = z.infer<typeof insertMemorySchema>;
export type Memory = typeof memories.$inferSelect;

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
