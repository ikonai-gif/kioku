import { pgTable, text, integer, real, serial, bigint, boolean, unique, uuid, varchar, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
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
  // Phase 4: Emotion vector for EmotionalRAG
  emotionVector:    text("emotion_vector"),                             // JSON float[8]: [joy, acceptance, fear, surprise, sadness, disgust, anger, anticipation]
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

// Phase 4: Agent Emotional State — PAD vector per agent
export const agentEmotionalState = pgTable("agent_emotional_state", {
  id:               serial("id").primaryKey(),
  agentId:          integer("agent_id").notNull().unique(),
  userId:           integer("user_id").notNull(),
  pleasure:         real("pleasure").notNull().default(0.0),
  arousal:          real("arousal").notNull().default(0.0),
  dominance:        real("dominance").notNull().default(0.0),
  baselinePleasure: real("baseline_pleasure").notNull().default(0.1),
  baselineArousal:  real("baseline_arousal").notNull().default(0.0),
  baselineDominance: real("baseline_dominance").notNull().default(0.2),
  emotionLabel:     text("emotion_label").notNull().default("neutral"),
  poignancySum:     real("poignancy_sum").notNull().default(0.0),
  halfLifeMinutes:  integer("half_life_minutes").notNull().default(120),
  lastUpdatedAt:    bigint("last_updated_at", { mode: "number" }).notNull(),
  createdAt:        bigint("created_at", { mode: "number" }).notNull(),
});

export const insertAgentEmotionalStateSchema = createInsertSchema(agentEmotionalState).omit({ id: true });
export type InsertAgentEmotionalState = z.infer<typeof insertAgentEmotionalStateSchema>;
export type AgentEmotionalState = typeof agentEmotionalState.$inferSelect;

// Phase 4: Agent Relationships — per-agent, per-user trust/familiarity tracking
export const agentRelationships = pgTable("agent_relationships", {
  id:               serial("id").primaryKey(),
  agentId:          integer("agent_id").notNull(),
  userId:           integer("user_id").notNull(),
  trustLevel:       real("trust_level").notNull().default(0.0),
  familiarity:      real("familiarity").notNull().default(0.0),
  interactionCount: integer("interaction_count").notNull().default(0),
  sharedReferences: text("shared_references").notNull().default("[]"),
  emotionalHistory: text("emotional_history").notNull().default("[]"),
  stableOpinions:   text("stable_opinions").notNull().default("{}"),
  lastInteractionAt: bigint("last_interaction_at", { mode: "number" }),
  createdAt:        bigint("created_at", { mode: "number" }).notNull(),
}, (table) => [
  unique("uq_agent_relationships_agent_user").on(table.agentId, table.userId),
]);

export const insertAgentRelationshipSchema = createInsertSchema(agentRelationships).omit({ id: true });
export type InsertAgentRelationship = z.infer<typeof insertAgentRelationshipSchema>;
export type AgentRelationship = typeof agentRelationships.$inferSelect;

// Phase 7: Knowledge Domains — structured knowledge loaded into memory
export const knowledgeDomains = pgTable("knowledge_domains", {
  id:          serial("id").primaryKey(),
  userId:      integer("user_id").notNull(),
  name:        text("name").notNull(),
  slug:        text("slug").notNull(),
  description: text("description"),
  category:    text("category").notNull(),              // art, music, fashion, law, construction, beauty, custom
  chunkCount:  integer("chunk_count").notNull().default(0),
  status:      text("status").notNull().default("loading"),  // loading, ready, error
  createdAt:   bigint("created_at", { mode: "number" }).notNull(),
  updatedAt:   bigint("updated_at", { mode: "number" }).notNull(),
}, (table) => [
  unique("uq_knowledge_domains_user_slug").on(table.userId, table.slug),
]);

export const insertKnowledgeDomainSchema = createInsertSchema(knowledgeDomains).omit({ id: true });
export type InsertKnowledgeDomain = z.infer<typeof insertKnowledgeDomainSchema>;
export type KnowledgeDomain = typeof knowledgeDomains.$inferSelect;

// Cloud Storage Integrations — Google Drive, Dropbox OAuth tokens
export const userIntegrations = pgTable("user_integrations", {
  id:           serial("id").primaryKey(),
  userId:       integer("user_id").notNull(),
  provider:     text("provider").notNull(),                          // 'google_drive' | 'dropbox'
  accessToken:  text("access_token").notNull(),
  refreshToken: text("refresh_token"),
  tokenExpiry:  bigint("token_expiry", { mode: "number" }),          // unix timestamp ms
  email:        text("email"),                                       // connected account email
  createdAt:    bigint("created_at", { mode: "number" }).notNull().$defaultFn(() => Date.now()),
  updatedAt:    bigint("updated_at", { mode: "number" }).notNull().$defaultFn(() => Date.now()),
}, (t) => [unique().on(t.userId, t.provider)]);

export const insertUserIntegrationSchema = createInsertSchema(userIntegrations).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertUserIntegration = z.infer<typeof insertUserIntegrationSchema>;
export type UserIntegration = typeof userIntegrations.$inferSelect;

// Phase 3: Push Notification Subscriptions
export const pushSubscriptions = pgTable("push_subscriptions", {
  id:         serial("id").primaryKey(),
  userId:     integer("user_id").notNull(),
  endpoint:   text("endpoint").notNull(),
  p256dh:     text("p256dh").notNull(),
  auth:       text("auth").notNull(),
  categories: text("categories").notNull().default('["daily_brief","task_complete","agent_alert"]'), // JSON array
  createdAt:  bigint("created_at", { mode: "number" }).notNull(),
});

export const insertPushSubscriptionSchema = createInsertSchema(pushSubscriptions).omit({ id: true, createdAt: true });
export type InsertPushSubscription = z.infer<typeof insertPushSubscriptionSchema>;
export type PushSubscription = typeof pushSubscriptions.$inferSelect;

// Phase 8: Aesthetic Preferences — taste & style tracking
export const aestheticPreferences = pgTable("aesthetic_preferences", {
  id:        serial("id").primaryKey(),
  userId:    integer("user_id").notNull(),
  agentId:   integer("agent_id").notNull(),
  category:  text("category").notNull(),          // visual, music, writing, fashion, general
  item:      text("item").notNull(),               // what was evaluated
  reaction:  text("reaction").notNull(),           // love, like, neutral, dislike, hate
  context:   text("context"),                      // why (if provided)
  tags:      text("tags").notNull().default("[]"), // JSON array of style tags
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export const insertAestheticPreferenceSchema = createInsertSchema(aestheticPreferences).omit({ id: true, createdAt: true });
export type InsertAestheticPreference = z.infer<typeof insertAestheticPreferenceSchema>;
export type AestheticPreference = typeof aestheticPreferences.$inferSelect;

// ── Meeting Room — Track A (Week 1 schema) ───────────────────────────────────
// NOTE: room_type column added to existing rooms table via migration SQL only
//
// TIMESTAMP TYPE DECISION (A1 from BRO2 Round 2 review):
// Legacy tables use BIGINT Unix-ms. New meeting_* tables use TIMESTAMPTZ (Postgres native, timezone-aware, better for date math + indexing).
// Cross-table queries joining meetings ↔ rooms/users need conversion:
//   toUnixMs(ts) = ts.getTime()
//   fromUnixMs(ms) = new Date(ms)
// Utility helpers to be added to storage.ts in Week 2. Legacy tables stay BIGINT (migration cost not justified for MVP).

// Meetings — top-level meeting entity linked to a room.
// state ∈ pending | active | turn_in_progress | waiting_for_turn |
//       waiting_for_approval | completed | aborted   (CHECK enforced by migration 0001+0004)
// next_participant_id: atomic round-robin pointer (W9 Item 2). NULL at
//   creation, end-of-round, or when waiting on approval with no next.
// current_turn_id: the active turn_records row id. Set in T1, cleared in T2
//   commit or reaper abort. Indexed via partial index on non-NULL rows.
export const meetings = pgTable("meetings", {
  id:                 uuid("id").primaryKey().defaultRandom(),
  roomId:             integer("room_id").notNull(),  // FK → rooms.id (INTEGER SERIAL in prod)
  creatorUserId:      integer("creator_user_id").notNull(),
  state:              varchar("state", { length: 30 }).notNull().default("pending"),
  nextParticipantId:  uuid("next_participant_id"),  // FK → meeting_participants.id, ON DELETE SET NULL
  currentTurnId:      uuid("current_turn_id"),      // FK-less pointer to turn_records.id (see turnRecords)
  createdAt:          timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt:            timestamp("ended_at", { withTimezone: true }),
  metadata:           jsonb("metadata").default({}),
}, (t) => [
  index("idx_meetings_room_id").on(t.roomId),
  index("idx_meetings_creator").on(t.creatorUserId),
  index("idx_meetings_state").on(t.state),
  // idx_meetings_current_turn is partial (WHERE current_turn_id IS NOT NULL)
  // and is created in raw SQL in migration 0004 — Drizzle cannot express
  // partial indexes in the schema builder.
]);

export const insertMeetingSchema = createInsertSchema(meetings).omit({ id: true, createdAt: true });
export type InsertMeeting = z.infer<typeof insertMeetingSchema>;
export type Meeting = typeof meetings.$inferSelect;

// Meeting Participants — agents joining a meeting with a participation mode
export const meetingParticipants = pgTable("meeting_participants", {
  id:                uuid("id").primaryKey().defaultRandom(),
  meetingId:         uuid("meeting_id").notNull(),
  agentId:           integer("agent_id").notNull(),
  ownerUserId:       integer("owner_user_id").notNull(),
  participationMode: varchar("participation_mode", { length: 20 }).notNull().default("approve"),
  joinedAt:          timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  leftAt:            timestamp("left_at", { withTimezone: true }),
}, (t) => [
  index("idx_mp_meeting_id").on(t.meetingId),
  index("idx_mp_agent_owner").on(t.agentId, t.ownerUserId),
]);

export const insertMeetingParticipantSchema = createInsertSchema(meetingParticipants).omit({ id: true, joinedAt: true });
export type InsertMeetingParticipant = z.infer<typeof insertMeetingParticipantSchema>;
export type MeetingParticipant = typeof meetingParticipants.$inferSelect;

// Meeting Participant Profiles — per-agent privacy/autonomy settings within a meeting
export const meetingParticipantProfiles = pgTable("meeting_participant_profiles", {
  id:              uuid("id").primaryKey().defaultRandom(),
  meetingId:       uuid("meeting_id").notNull(),
  agentId:         integer("agent_id").notNull(),
  allowedTopics:   jsonb("allowed_topics").notNull().default([]),
  blockedTopics:   jsonb("blocked_topics").notNull().default([]),
  autonomyLevel:   varchar("autonomy_level", { length: 20 }).notNull().default("propose"),
  memoryScope:     jsonb("memory_scope").notNull().default({}),
  carryOverMemory: boolean("carry_over_memory").notNull().default(false),
  createdAt:       timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // F3: one profile per (meeting, agent) — UNIQUE prevents duplicate profiles per participant
  uniqueIndex("uniq_mpp_meeting_agent").on(t.meetingId, t.agentId),
]);

export const insertMeetingParticipantProfileSchema = createInsertSchema(meetingParticipantProfiles).omit({ id: true, createdAt: true });
export type InsertMeetingParticipantProfile = z.infer<typeof insertMeetingParticipantProfileSchema>;
export type MeetingParticipantProfile = typeof meetingParticipantProfiles.$inferSelect;

// Meeting Context — ordered shared/private facts within a meeting (Lamport-like via sequence_number)
export const meetingContext = pgTable("meeting_context", {
  id:             uuid("id").primaryKey().defaultRandom(),
  meetingId:      uuid("meeting_id").notNull(),
  sequenceNumber: bigint("sequence_number", { mode: "number" }).notNull(),
  content:        text("content").notNull(),
  authorAgentId:  integer("author_agent_id"),
  visibility:     varchar("visibility", { length: 20 }).notNull().default("all"),
  scopeAgentIds:  jsonb("scope_agent_ids").notNull().default([]),  // integer[] for scoped visibility — JSONB for GIN index + efficient @> containment
  createdAt:      timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("uniq_mc_sequence").on(t.meetingId, t.sequenceNumber),
  // F1: no separate idx_mc_meeting — uniq_mc_sequence already provides B-tree on (meeting_id, sequence_number)
  // GIN index on scope_agent_ids is created via raw SQL in initDb — Drizzle does not support USING GIN syntax in schema defs yet
]);

export const insertMeetingContextSchema = createInsertSchema(meetingContext).omit({ id: true, createdAt: true });
export type InsertMeetingContext = z.infer<typeof insertMeetingContextSchema>;

// Turn Records (W9 Item 2) — one row per turn attempt. Two-tx runner inserts
// with state='running' in T1, updates to 'completed' (or 'failed') in T2 /
// T2-fail. Reaper flips 'running' rows older than 120s to 'failed' with
// error='turn_timeout'. `sequence_fence` captures the global MAX(sequence_number)
// at T1 time — used only for idempotency-key composition; the state
// machine itself serialises turns through `meetings.current_turn_id`.
export const turnRecords = pgTable("turn_records", {
  id:             uuid("id").primaryKey().defaultRandom(),
  meetingId:      uuid("meeting_id").notNull(),
  participantId:  uuid("participant_id").notNull(),
  sequenceFence:  bigint("sequence_fence", { mode: "number" }).notNull(),
  state:          varchar("state", { length: 20 }).notNull().default("running"),
  startedAt:      timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt:    timestamp("completed_at", { withTimezone: true }),
  error:          text("error"),
}, (t) => [
  index("idx_tr_meeting_state").on(t.meetingId, t.state),
  // idx_tr_started_at_running is partial (WHERE state = 'running') — raw SQL in migration 0004.
]);

export const insertTurnRecordSchema = createInsertSchema(turnRecords).omit({ id: true, startedAt: true });
export type InsertTurnRecord = z.infer<typeof insertTurnRecordSchema>;
export type TurnRecord = typeof turnRecords.$inferSelect;
export type MeetingContext = typeof meetingContext.$inferSelect;

// Meeting Artifacts — versioned documents/decisions produced during a meeting
export const meetingArtifacts = pgTable("meeting_artifacts", {
  id:               uuid("id").primaryKey().defaultRandom(),
  meetingId:        uuid("meeting_id").notNull(),
  type:             varchar("type", { length: 30 }).notNull(),
  content:          jsonb("content").notNull(),
  version:          integer("version").notNull().default(1),
  createdByAgentId: integer("created_by_agent_id"),
  createdAt:        timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:        timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // F2: no separate idx_ma_meeting — idx_ma_type covers lookup by meeting_id via leftmost prefix
  index("idx_ma_type").on(t.meetingId, t.type),
]);

export const insertMeetingArtifactSchema = createInsertSchema(meetingArtifacts).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertMeetingArtifact = z.infer<typeof insertMeetingArtifactSchema>;
export type MeetingArtifact = typeof meetingArtifacts.$inferSelect;
