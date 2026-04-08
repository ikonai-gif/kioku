import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Users / Workspaces
export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  company: text("company"),
  plan: text("plan").notNull().default("dev"), // dev | starter | team | business
  billingCycle: text("billing_cycle").notNull().default("monthly"), // monthly | yearly
  apiKey: text("api_key").notNull().unique(),
  createdAt: integer("created_at").notNull(),
});

export const insertUserSchema = createInsertSchema(users).omit({ id: true, createdAt: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

// Magic link tokens
export const magicTokens = sqliteTable("magic_tokens", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull(),
  token: text("token").notNull().unique(),
  expiresAt: integer("expires_at").notNull(),
  used: integer("used").notNull().default(0),
});

export const insertMagicTokenSchema = createInsertSchema(magicTokens).omit({ id: true });
export type InsertMagicToken = z.infer<typeof insertMagicTokenSchema>;
export type MagicToken = typeof magicTokens.$inferSelect;

// Agents
export const agents = sqliteTable("agents", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  color: text("color").notNull().default("#D4AF37"),
  status: text("status").notNull().default("idle"), // online | idle | offline
  memoriesCount: integer("memories_count").notNull().default(0),
  lastActiveAt: integer("last_active_at"),
  enabled: integer("enabled").notNull().default(1),
  createdAt: integer("created_at").notNull(),
});

export const insertAgentSchema = createInsertSchema(agents).omit({ id: true, createdAt: true });
export type InsertAgent = z.infer<typeof insertAgentSchema>;
export type Agent = typeof agents.$inferSelect;

// Memories
export const memories = sqliteTable("memories", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull(),
  agentId: integer("agent_id"),
  agentName: text("agent_name"),
  content: text("content").notNull(),
  type: text("type").notNull().default("semantic"), // semantic | episodic | procedural
  importance: real("importance").notNull().default(0.5),
  namespace: text("namespace"),
  createdAt: integer("created_at").notNull(),
});

export const insertMemorySchema = createInsertSchema(memories).omit({ id: true, createdAt: true });
export type InsertMemory = z.infer<typeof insertMemorySchema>;
export type Memory = typeof memories.$inferSelect;

// Flows — agent working groups (task-oriented teams)
export const flows = sqliteTable("flows", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  agentIds: text("agent_ids").notNull().default("[]"), // JSON array of agent ids
  // canvas positions: JSON { [agentId]: {x, y} }
  positions: text("positions").notNull().default("{}"),
  // per-agent roles+tasks: JSON { [agentId]: { role: string, task: string } }
  agentRoles: text("agent_roles").notNull().default("{}"),
  createdAt: integer("created_at").notNull(),
});

export const insertFlowSchema = createInsertSchema(flows).omit({ id: true, createdAt: true });
export type InsertFlow = z.infer<typeof insertFlowSchema>;
export type Flow = typeof flows.$inferSelect;

// Deliberation Rooms
export const rooms = sqliteTable("rooms", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  status: text("status").notNull().default("standby"), // active | standby | idle
  agentIds: text("agent_ids").notNull().default("[]"), // JSON array
  createdAt: integer("created_at").notNull(),
});

export const insertRoomSchema = createInsertSchema(rooms).omit({ id: true, createdAt: true });
export type InsertRoom = z.infer<typeof insertRoomSchema>;
export type Room = typeof rooms.$inferSelect;

// Room Messages
export const roomMessages = sqliteTable("room_messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  roomId: integer("room_id").notNull(),
  agentId: integer("agent_id"),
  agentName: text("agent_name").notNull(),
  agentColor: text("agent_color").notNull().default("#D4AF37"),
  content: text("content").notNull(),
  isDecision: integer("is_decision").notNull().default(0),
  createdAt: integer("created_at").notNull(),
});

export const insertRoomMessageSchema = createInsertSchema(roomMessages).omit({ id: true, createdAt: true });
export type InsertRoomMessage = z.infer<typeof insertRoomMessageSchema>;
export type RoomMessage = typeof roomMessages.$inferSelect;

// Live Feed / Logs
export const logs = sqliteTable("logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull(),
  agentName: text("agent_name"),
  agentColor: text("agent_color").notNull().default("#D4AF37"),
  operation: text("operation").notNull(), // stored | search | retrieved | deliberation
  detail: text("detail").notNull(),
  latencyMs: integer("latency_ms"),
  createdAt: integer("created_at").notNull(),
});

export const insertLogSchema = createInsertSchema(logs).omit({ id: true, createdAt: true });
export type InsertLog = z.infer<typeof insertLogSchema>;
export type Log = typeof logs.$inferSelect;
