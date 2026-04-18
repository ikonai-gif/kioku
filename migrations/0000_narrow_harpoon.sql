CREATE TABLE "aesthetic_preferences" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"agent_id" integer NOT NULL,
	"category" text NOT NULL,
	"item" text NOT NULL,
	"reaction" text NOT NULL,
	"context" text,
	"tags" text DEFAULT '[]' NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_emotional_state" (
	"id" serial PRIMARY KEY NOT NULL,
	"agent_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"pleasure" real DEFAULT 0 NOT NULL,
	"arousal" real DEFAULT 0 NOT NULL,
	"dominance" real DEFAULT 0 NOT NULL,
	"baseline_pleasure" real DEFAULT 0.1 NOT NULL,
	"baseline_arousal" real DEFAULT 0 NOT NULL,
	"baseline_dominance" real DEFAULT 0.2 NOT NULL,
	"emotion_label" text DEFAULT 'neutral' NOT NULL,
	"poignancy_sum" real DEFAULT 0 NOT NULL,
	"half_life_minutes" integer DEFAULT 120 NOT NULL,
	"last_updated_at" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "agent_emotional_state_agent_id_unique" UNIQUE("agent_id")
);
--> statement-breakpoint
CREATE TABLE "agent_relationships" (
	"id" serial PRIMARY KEY NOT NULL,
	"agent_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"trust_level" real DEFAULT 0 NOT NULL,
	"familiarity" real DEFAULT 0 NOT NULL,
	"interaction_count" integer DEFAULT 0 NOT NULL,
	"shared_references" text DEFAULT '[]' NOT NULL,
	"emotional_history" text DEFAULT '[]' NOT NULL,
	"stable_opinions" text DEFAULT '{}' NOT NULL,
	"last_interaction_at" bigint,
	"created_at" bigint NOT NULL,
	CONSTRAINT "uq_agent_relationships_agent_user" UNIQUE("agent_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "agent_turns" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"agent_id" integer NOT NULL,
	"room_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"phase" text NOT NULL,
	"round" integer DEFAULT 1 NOT NULL,
	"topic" text NOT NULL,
	"other_positions" text DEFAULT '[]' NOT NULL,
	"memories" text DEFAULT '[]' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"response" text,
	"responded_at" bigint,
	"expires_at" bigint NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"color" text DEFAULT '#D4AF37' NOT NULL,
	"model" text,
	"role" text,
	"llm_provider" text,
	"llm_api_key" text,
	"llm_model" text,
	"agent_type" text DEFAULT 'internal' NOT NULL,
	"webhook_url" text,
	"webhook_secret" text,
	"status" text DEFAULT 'idle' NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"memories_count" integer DEFAULT 0 NOT NULL,
	"last_active_at" bigint,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "flows" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"agent_ids" text DEFAULT '[]' NOT NULL,
	"positions" text DEFAULT '{}' NOT NULL,
	"agent_roles" text DEFAULT '{}' NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_domains" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"category" text NOT NULL,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'loading' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "uq_knowledge_domains_user_slug" UNIQUE("user_id","slug")
);
--> statement-breakpoint
CREATE TABLE "logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"agent_name" text,
	"agent_color" text DEFAULT '#D4AF37' NOT NULL,
	"operation" text NOT NULL,
	"detail" text NOT NULL,
	"latency_ms" integer,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "magic_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"token" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"used" boolean DEFAULT false NOT NULL,
	CONSTRAINT "magic_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"agent_id" integer,
	"agent_name" text,
	"content" text NOT NULL,
	"type" text DEFAULT 'semantic' NOT NULL,
	"importance" real DEFAULT 0.5 NOT NULL,
	"namespace" text,
	"embedding" text,
	"strength" real DEFAULT 1,
	"emotional_valence" real,
	"last_accessed_at" bigint,
	"access_count" integer DEFAULT 0,
	"confidence" real DEFAULT 1,
	"decay_rate" real DEFAULT 0.01,
	"last_reinforced_at" bigint,
	"reinforcements" integer DEFAULT 0,
	"expires_at" bigint,
	"cause_id" integer,
	"context_trigger" text,
	"emotion_vector" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"source_memory_id" integer NOT NULL,
	"target_memory_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"link_type" text DEFAULT 'related' NOT NULL,
	"strength" real DEFAULT 0.5 NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "room_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"room_id" integer NOT NULL,
	"agent_id" integer,
	"agent_name" text NOT NULL,
	"agent_color" text DEFAULT '#D4AF37' NOT NULL,
	"content" text NOT NULL,
	"is_decision" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'standby' NOT NULL,
	"agent_ids" text DEFAULT '[]' NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_tracking" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"period_start" bigint NOT NULL,
	"period_end" bigint NOT NULL,
	"deliberations" integer DEFAULT 0 NOT NULL,
	"rounds" integer DEFAULT 0 NOT NULL,
	"api_calls" integer DEFAULT 0 NOT NULL,
	"webhook_calls" integer DEFAULT 0 NOT NULL,
	"tokens_used" integer DEFAULT 0 NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_integrations" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"provider" text NOT NULL,
	"access_token" text NOT NULL,
	"refresh_token" text,
	"token_expiry" bigint,
	"email" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "user_integrations_user_id_provider_unique" UNIQUE("user_id","provider")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"company" text,
	"plan" text DEFAULT 'dev' NOT NULL,
	"billing_cycle" text DEFAULT 'monthly' NOT NULL,
	"stripe_customer_id" text,
	"api_key" text NOT NULL,
	"created_at" bigint NOT NULL,
	"role" text DEFAULT 'user' NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_api_key_unique" UNIQUE("api_key")
);
