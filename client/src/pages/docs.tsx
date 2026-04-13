import { useState, useRef, useCallback } from "react";
import {
  BookOpen, Copy, Check, ChevronDown, ChevronRight, Search, ArrowLeft,
  Shield, Key, Zap, Globe, Code2
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Method badge colors ────────────────────────────────────────────────────
const METHOD_COLORS: Record<string, string> = {
  GET:    "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  POST:   "bg-blue-500/15 text-blue-400 border-blue-500/30",
  PATCH:  "bg-amber-500/15 text-amber-400 border-amber-500/30",
  DELETE: "bg-red-500/15 text-red-400 border-red-500/30",
};

const METHOD_DOT: Record<string, string> = {
  GET: "bg-emerald-400", POST: "bg-blue-400", PATCH: "bg-amber-400", DELETE: "bg-red-400",
};

// ── Endpoint data derived from server/routes.ts ────────────────────────────

interface Param {
  name: string;
  type: string;
  required?: boolean;
  description: string;
}

interface Endpoint {
  method: string;
  path: string;
  description: string;
  auth: string;
  params?: Param[];
  body?: Param[];
  queryParams?: Param[];
  exampleResponse: string;
}

interface Category {
  name: string;
  icon: string;
  description: string;
  endpoints: Endpoint[];
}

const API_CATEGORIES: Category[] = [
  {
    name: "Authentication",
    icon: "shield",
    description: "Magic-link passwordless authentication, session management, and API key rotation.",
    endpoints: [
      {
        method: "POST", path: "/api/auth/magic-link",
        description: "Request a magic link email for passwordless sign-in.",
        auth: "None",
        body: [
          { name: "email", type: "string", required: true, description: "User email address" },
          { name: "name", type: "string", required: false, description: "Display name" },
          { name: "company", type: "string", required: false, description: "Company name" },
        ],
        exampleResponse: '{\n  "ok": true,\n  "message": "Magic link sent to your email"\n}',
      },
      {
        method: "POST", path: "/api/auth/verify",
        description: "Verify a magic link token and receive a session token.",
        auth: "None",
        body: [
          { name: "token", type: "string", required: true, description: "Magic link token from email" },
        ],
        exampleResponse: '{\n  "ok": true,\n  "sessionToken": "eyJhbG...",\n  "user": { "id": 1, "email": "you@example.com", "plan": "dev" }\n}',
      },
      {
        method: "GET", path: "/api/auth/me",
        description: "Get the currently authenticated user's profile.",
        auth: "Session cookie or API key",
        exampleResponse: '{\n  "id": 1,\n  "email": "you@example.com",\n  "name": "Dev",\n  "plan": "dev",\n  "apiKey": "kk_abc123..."\n}',
      },
      {
        method: "POST", path: "/api/auth/logout",
        description: "Clear the session cookie and log out.",
        auth: "Session cookie",
        exampleResponse: '{\n  "ok": true\n}',
      },
      {
        method: "POST", path: "/api/auth/rotate-key",
        description: "Rotate the user's API key. Old key is immediately invalidated.",
        auth: "Session cookie or API key",
        exampleResponse: '{\n  "ok": true,\n  "apiKey": "kk_new_key_here..."\n}',
      },
    ],
  },
  {
    name: "Agents",
    icon: "bot",
    description: "Manage AI agents — create, update, toggle, and delete agents in your workspace.",
    endpoints: [
      {
        method: "GET", path: "/api/agents",
        description: "List all agents in your workspace.",
        auth: "Session cookie or API key",
        exampleResponse: '[\n  {\n    "id": 1,\n    "name": "CFO-Agent",\n    "description": "Financial analysis",\n    "color": "#4ade80",\n    "status": "idle",\n    "enabled": true\n  }\n]',
      },
      {
        method: "POST", path: "/api/agents",
        description: "Create a new agent.",
        auth: "Session cookie or API key",
        body: [
          { name: "name", type: "string", required: true, description: "Agent display name" },
          { name: "description", type: "string", required: false, description: "Agent description" },
          { name: "color", type: "string", required: false, description: "Hex color (default: #D4AF37)" },
          { name: "llmProvider", type: "string", required: false, description: "LLM provider (openai, anthropic)" },
          { name: "llmModel", type: "string", required: false, description: "Model identifier" },
        ],
        exampleResponse: '{\n  "id": 2,\n  "name": "Research-Agent",\n  "color": "#60a5fa",\n  "status": "idle",\n  "enabled": true\n}',
      },
      {
        method: "PATCH", path: "/api/agents/:id",
        description: "Update agent fields (name, description, color, model, role, LLM config).",
        auth: "Session cookie or API key",
        params: [{ name: "id", type: "number", required: true, description: "Agent ID" }],
        body: [
          { name: "name", type: "string", required: false, description: "New name" },
          { name: "description", type: "string", required: false, description: "New description" },
          { name: "color", type: "string", required: false, description: "New hex color" },
          { name: "model", type: "string", required: false, description: "New model" },
          { name: "role", type: "string", required: false, description: "Agent role" },
        ],
        exampleResponse: '{\n  "id": 2,\n  "name": "Updated-Agent",\n  "color": "#c084fc"\n}',
      },
      {
        method: "PATCH", path: "/api/agents/:id/toggle",
        description: "Toggle agent enabled/disabled status.",
        auth: "Session cookie or API key",
        params: [{ name: "id", type: "number", required: true, description: "Agent ID" }],
        body: [
          { name: "enabled", type: "boolean", required: false, description: "Enable or disable" },
          { name: "status", type: "string", required: false, description: "Set status (idle, active, etc.)" },
        ],
        exampleResponse: '{\n  "ok": true\n}',
      },
      {
        method: "DELETE", path: "/api/agents/:id",
        description: "Delete an agent and all its associated data.",
        auth: "Session cookie or API key",
        params: [{ name: "id", type: "number", required: true, description: "Agent ID" }],
        exampleResponse: '{\n  "ok": true\n}',
      },
    ],
  },
  {
    name: "Agent Tokens",
    icon: "key",
    description: "Generate and manage kat_* tokens for external agent authentication.",
    endpoints: [
      {
        method: "POST", path: "/api/agents/:id/token",
        description: "Generate a new agent token (kat_*) for external auth.",
        auth: "Session cookie or API key",
        params: [{ name: "id", type: "number", required: true, description: "Agent ID" }],
        body: [
          { name: "name", type: "string", required: false, description: "Token name/label" },
          { name: "scopes", type: "string[]", required: false, description: "Permission scopes" },
          { name: "expiresInDays", type: "number", required: false, description: "Days until expiry" },
        ],
        exampleResponse: '{\n  "ok": true,\n  "token": "kat_abc123...",\n  "note": "Save this token — it cannot be retrieved later"\n}',
      },
      {
        method: "GET", path: "/api/agents/:id/tokens",
        description: "List all tokens for an agent (token values are masked).",
        auth: "Session cookie or API key",
        params: [{ name: "id", type: "number", required: true, description: "Agent ID" }],
        exampleResponse: '[\n  {\n    "id": 1,\n    "name": "prod-token",\n    "scopes": ["deliberation.respond"],\n    "createdAt": "2026-01-15T10:00:00Z"\n  }\n]',
      },
      {
        method: "DELETE", path: "/api/agents/:id/tokens/:tokenId",
        description: "Revoke a specific agent token.",
        auth: "Session cookie or API key",
        params: [
          { name: "id", type: "number", required: true, description: "Agent ID" },
          { name: "tokenId", type: "number", required: true, description: "Token ID to revoke" },
        ],
        exampleResponse: '{\n  "ok": true\n}',
      },
      {
        method: "DELETE", path: "/api/agents/:id/tokens",
        description: "Revoke all tokens for an agent.",
        auth: "Session cookie or API key",
        params: [{ name: "id", type: "number", required: true, description: "Agent ID" }],
        exampleResponse: '{\n  "ok": true\n}',
      },
    ],
  },
  {
    name: "Webhooks",
    icon: "globe",
    description: "Register webhook URLs for external agent event delivery.",
    endpoints: [
      {
        method: "POST", path: "/api/agents/:id/webhook",
        description: "Register a webhook URL for an agent. Returns a signing secret.",
        auth: "Session cookie or API key",
        params: [{ name: "id", type: "number", required: true, description: "Agent ID" }],
        body: [
          { name: "url", type: "string", required: true, description: "Webhook callback URL" },
        ],
        exampleResponse: '{\n  "ok": true,\n  "agentId": 1,\n  "url": "https://example.com/hook",\n  "secret": "whk_abc123...",\n  "note": "Save this secret — it signs X-Kioku-Signature headers"\n}',
      },
      {
        method: "GET", path: "/api/agents/:id/webhook",
        description: "Get the webhook configuration for an agent.",
        auth: "Session cookie or API key",
        params: [{ name: "id", type: "number", required: true, description: "Agent ID" }],
        exampleResponse: '{\n  "agentId": 1,\n  "url": "https://example.com/hook",\n  "createdAt": "2026-01-15T10:00:00Z"\n}',
      },
      {
        method: "DELETE", path: "/api/agents/:id/webhook",
        description: "Delete the webhook for an agent.",
        auth: "Session cookie or API key",
        params: [{ name: "id", type: "number", required: true, description: "Agent ID" }],
        exampleResponse: '{\n  "ok": true\n}',
      },
      {
        method: "GET", path: "/api/webhooks",
        description: "List all webhooks registered by the authenticated user.",
        auth: "Session cookie or API key",
        exampleResponse: '[\n  {\n    "agentId": 1,\n    "url": "https://example.com/hook"\n  }\n]',
      },
    ],
  },
  {
    name: "Memories",
    icon: "brain",
    description: "Create, search, link, and manage agent memories with embeddings and confidence decay.",
    endpoints: [
      {
        method: "GET", path: "/api/memories",
        description: "List or search memories. Supports semantic search via embeddings.",
        auth: "Session cookie or API key",
        queryParams: [
          { name: "q", type: "string", required: false, description: "Search query (triggers semantic search)" },
          { name: "namespace", type: "string", required: false, description: "Filter by namespace" },
          { name: "page", type: "number", required: false, description: "Page number (default: 1)" },
          { name: "limit", type: "number", required: false, description: "Results per page (max: 200)" },
          { name: "include_embedding", type: "boolean", required: false, description: "Include raw embedding vectors" },
        ],
        exampleResponse: '{\n  "data": [\n    {\n      "id": 1,\n      "content": "Q3 revenue increased 23%",\n      "type": "semantic",\n      "importance": 0.8,\n      "namespace": "finance"\n    }\n  ],\n  "pagination": { "page": 1, "limit": 50, "total": 142 }\n}',
      },
      {
        method: "POST", path: "/api/memories",
        description: "Create a new memory. Embeddings are generated automatically.",
        auth: "Session cookie or API key",
        body: [
          { name: "content", type: "string", required: true, description: "Memory content text" },
          { name: "agentId", type: "number", required: false, description: "Owning agent ID" },
          { name: "agentName", type: "string", required: false, description: "Agent name for logs" },
          { name: "type", type: "string", required: false, description: "Memory type: semantic, episodic, procedural, temporal, causal, contextual (default: semantic)" },
          { name: "importance", type: "number", required: false, description: "Importance score 0-1 (default: 0.5)" },
          { name: "namespace", type: "string", required: false, description: "Namespace for grouping (default: default)" },
          { name: "confidence", type: "number", required: false, description: "Initial confidence 0-1 (default: 1.0)" },
          { name: "decayRate", type: "number", required: false, description: "Confidence decay rate (default: 0.01)" },
        ],
        exampleResponse: '{\n  "id": 42,\n  "content": "New product launch date set for March",\n  "type": "semantic",\n  "importance": 0.7,\n  "confidence": 1.0\n}',
      },
      {
        method: "GET", path: "/api/memories/:id",
        description: "Get a single memory by ID. Also reinforces confidence (bumps decay clock).",
        auth: "Session cookie or API key",
        params: [{ name: "id", type: "number", required: true, description: "Memory ID" }],
        exampleResponse: '{\n  "id": 42,\n  "content": "New product launch date set for March",\n  "currentConfidence": 0.95\n}',
      },
      {
        method: "DELETE", path: "/api/memories/:id",
        description: "Delete a specific memory.",
        auth: "Session cookie or API key",
        params: [{ name: "id", type: "number", required: true, description: "Memory ID" }],
        exampleResponse: '{\n  "ok": true\n}',
      },
      {
        method: "POST", path: "/api/memories/:id/links",
        description: "Create a synaptic link between two memories.",
        auth: "Session cookie or API key",
        params: [{ name: "id", type: "number", required: true, description: "Source memory ID" }],
        body: [
          { name: "targetId", type: "number", required: true, description: "Target memory ID" },
          { name: "linkType", type: "string", required: false, description: "Link type (related, causal, temporal)" },
          { name: "strength", type: "number", required: false, description: "Link strength 0-1" },
        ],
        exampleResponse: '{\n  "id": 1,\n  "sourceId": 42,\n  "targetId": 43,\n  "linkType": "related",\n  "strength": 0.9\n}',
      },
      {
        method: "GET", path: "/api/memories/:id/links",
        description: "Get all synaptic links for a memory.",
        auth: "Session cookie or API key",
        params: [{ name: "id", type: "number", required: true, description: "Memory ID" }],
        exampleResponse: '[\n  { "id": 1, "sourceId": 42, "targetId": 43, "linkType": "related", "strength": 0.9 }\n]',
      },
      {
        method: "DELETE", path: "/api/memories/:id/links/:linkId",
        description: "Delete a specific memory link.",
        auth: "Session cookie or API key",
        params: [
          { name: "id", type: "number", required: true, description: "Memory ID" },
          { name: "linkId", type: "number", required: true, description: "Link ID" },
        ],
        exampleResponse: '{\n  "success": true\n}',
      },
      {
        method: "GET", path: "/api/memories/:id/graph",
        description: "Traverse memory links via BFS to build a knowledge graph.",
        auth: "Session cookie or API key",
        params: [{ name: "id", type: "number", required: true, description: "Root memory ID" }],
        queryParams: [
          { name: "depth", type: "number", required: false, description: "Max traversal depth (default: 2, max: 4)" },
          { name: "limit", type: "number", required: false, description: "Max nodes returned (default: 20, max: 50)" },
        ],
        exampleResponse: '[\n  { "id": 42, "content": "Root memory", "depth": 0 },\n  { "id": 43, "content": "Linked memory", "depth": 1 }\n]',
      },
      {
        method: "POST", path: "/api/memories/consolidate",
        description: "Consolidate similar memories using AI (deduplication + summarization).",
        auth: "Session cookie or API key",
        exampleResponse: '{\n  "consolidated": 5,\n  "removed": 3,\n  "message": "Consolidated 5 memory groups"\n}',
      },
      {
        method: "POST", path: "/api/memories/gc",
        description: "Garbage-collect decayed memories below confidence threshold.",
        auth: "Session cookie or API key",
        body: [
          { name: "threshold", type: "number", required: false, description: "Importance threshold (default: 0.05)" },
          { name: "confidenceThreshold", type: "number", required: false, description: "Confidence threshold (default: 0.1)" },
        ],
        exampleResponse: '{\n  "pruned": 12,\n  "message": "Removed 12 decayed memories"\n}',
      },
      {
        method: "DELETE", path: "/api/memories/purge",
        description: "GDPR Art. 17 — Purge all memories or by scope/agent.",
        auth: "Session cookie or API key",
        body: [
          { name: "scope", type: "string", required: false, description: "Scope: all, agent" },
          { name: "agent_id", type: "number", required: false, description: "Agent ID (required when scope=agent)" },
        ],
        exampleResponse: '{\n  "ok": true,\n  "deleted": 47\n}',
      },
      {
        method: "GET", path: "/api/memories/export",
        description: "GDPR Art. 20 — Export all memories as a JSON download.",
        auth: "Session cookie or API key",
        exampleResponse: '[\n  { "id": 1, "content": "...", "type": "semantic", "createdAt": "..." }\n]',
      },
    ],
  },
  {
    name: "Rooms",
    icon: "message",
    description: "Manage deliberation rooms where agents collaborate and make decisions.",
    endpoints: [
      {
        method: "GET", path: "/api/rooms",
        description: "List all rooms in your workspace.",
        auth: "Session cookie or API key",
        exampleResponse: '[\n  {\n    "id": 1,\n    "name": "Executive Board Room",\n    "status": "standby",\n    "agentIds": "[1,2,3]"\n  }\n]',
      },
      {
        method: "POST", path: "/api/rooms",
        description: "Create a new deliberation room.",
        auth: "Session cookie or API key",
        body: [
          { name: "name", type: "string", required: true, description: "Room name" },
          { name: "description", type: "string", required: false, description: "Room description" },
          { name: "agentIds", type: "number[]", required: false, description: "Array of agent IDs to assign" },
        ],
        exampleResponse: '{\n  "id": 2,\n  "name": "Strategy Room",\n  "status": "standby"\n}',
      },
      {
        method: "PATCH", path: "/api/rooms/:id",
        description: "Update room fields (name, description, status, agents).",
        auth: "Session cookie or API key",
        params: [{ name: "id", type: "number", required: true, description: "Room ID" }],
        body: [
          { name: "name", type: "string", required: false, description: "New name" },
          { name: "description", type: "string", required: false, description: "New description" },
          { name: "status", type: "string", required: false, description: "Room status" },
          { name: "agentIds", type: "number[]", required: false, description: "Updated agent IDs" },
        ],
        exampleResponse: '{\n  "id": 2,\n  "name": "Updated Room",\n  "status": "active"\n}',
      },
      {
        method: "DELETE", path: "/api/rooms/:id",
        description: "Delete a room and all its messages.",
        auth: "Session cookie or API key",
        params: [{ name: "id", type: "number", required: true, description: "Room ID" }],
        exampleResponse: '{\n  "ok": true\n}',
      },
      {
        method: "GET", path: "/api/rooms/:id/messages",
        description: "Get all messages in a room.",
        auth: "Session cookie or API key",
        params: [{ name: "id", type: "number", required: true, description: "Room ID" }],
        exampleResponse: '[\n  {\n    "id": 1,\n    "agentName": "CFO-Agent",\n    "content": "Budget analysis complete",\n    "isDecision": false,\n    "createdAt": "2026-01-15T10:30:00Z"\n  }\n]',
      },
      {
        method: "POST", path: "/api/rooms/:id/messages",
        description: "Post a message to a room. Triggers AI agent responses if agents are assigned.",
        auth: "Session cookie or API key",
        params: [{ name: "id", type: "number", required: true, description: "Room ID" }],
        body: [
          { name: "agentName", type: "string", required: true, description: "Sender agent name" },
          { name: "content", type: "string", required: true, description: "Message content" },
          { name: "agentId", type: "number", required: false, description: "Sender agent ID" },
          { name: "agentColor", type: "string", required: false, description: "Sender color" },
          { name: "isDecision", type: "boolean", required: false, description: "Mark as a decision (auto-saved to memories)" },
        ],
        exampleResponse: '{\n  "id": 5,\n  "agentName": "PM-Agent",\n  "content": "Feature approved for sprint 12",\n  "isDecision": true\n}',
      },
    ],
  },
  {
    name: "Deliberation",
    icon: "zap",
    description: "Start structured AI deliberation sessions, track phases, and reach consensus.",
    endpoints: [
      {
        method: "POST", path: "/api/rooms/:id/deliberate",
        description: "Start a structured deliberation session on a topic.",
        auth: "Session cookie or API key",
        params: [{ name: "id", type: "number", required: true, description: "Room ID" }],
        body: [
          { name: "topic", type: "string", required: true, description: "Deliberation topic" },
          { name: "model", type: "string", required: false, description: "LLM model to use" },
          { name: "debateRounds", type: "number", required: false, description: "Number of debate rounds (default: 2)" },
        ],
        exampleResponse: '{\n  "sessionId": "d_abc123",\n  "topic": "Should we expand to EU market?",\n  "phase": "individual_analysis",\n  "status": "running"\n}',
      },
      {
        method: "GET", path: "/api/rooms/:id/deliberations/:sessionId",
        description: "Get a specific deliberation session with all phase data.",
        auth: "Session cookie or API key",
        params: [
          { name: "id", type: "number", required: true, description: "Room ID" },
          { name: "sessionId", type: "string", required: true, description: "Session ID" },
        ],
        exampleResponse: '{\n  "sessionId": "d_abc123",\n  "topic": "...",\n  "phase": "consensus",\n  "votes": [...],\n  "consensus": { "decision": "approve", "confidence": 0.87 }\n}',
      },
      {
        method: "GET", path: "/api/rooms/:id/deliberations",
        description: "List all deliberation sessions for a room.",
        auth: "Session cookie or API key",
        params: [{ name: "id", type: "number", required: true, description: "Room ID" }],
        exampleResponse: '[\n  {\n    "sessionId": "d_abc123",\n    "topic": "EU expansion",\n    "phase": "completed",\n    "createdAt": "2026-01-15T10:00:00Z"\n  }\n]',
      },
      {
        method: "GET", path: "/api/rooms/:id/consensus",
        description: "Get the latest consensus decision for a room.",
        auth: "Session cookie or API key",
        params: [{ name: "id", type: "number", required: true, description: "Room ID" }],
        exampleResponse: '{\n  "decision": "approve",\n  "confidence": 0.87,\n  "reasoning": "3 out of 4 agents voted in favor..."\n}',
      },
    ],
  },
  {
    name: "Billing & Usage",
    icon: "credit-card",
    description: "Monitor usage, manage plans, and view rate limits.",
    endpoints: [
      {
        method: "GET", path: "/api/usage",
        description: "Get usage metrics — memory count, request counts, rate limits.",
        auth: "Session cookie or API key",
        exampleResponse: '{\n  "memories_count": 142,\n  "agents_count": 4,\n  "rooms_count": 2,\n  "requests_today": 87,\n  "requests_this_month": 1204,\n  "plan": "dev",\n  "limits": {\n    "requests_per_minute": 60,\n    "requests_per_day": 5000\n  }\n}',
      },
      {
        method: "PATCH", path: "/api/billing/plan",
        description: "Update user plan (admin/master key required).",
        auth: "Master key (x-master-key header)",
        body: [
          { name: "plan", type: "string", required: true, description: "Plan name: dev, starter, team, business" },
          { name: "billingCycle", type: "string", required: false, description: "monthly or yearly" },
        ],
        exampleResponse: '{\n  "id": 1,\n  "plan": "team",\n  "billingCycle": "monthly"\n}',
      },
    ],
  },
  {
    name: "Account",
    icon: "user",
    description: "Account management, data export, registration, and GDPR compliance.",
    endpoints: [
      {
        method: "POST", path: "/api/register",
        description: "Register a new tenant account and get an API key.",
        auth: "None",
        body: [
          { name: "email", type: "string", required: true, description: "Email address" },
          { name: "name", type: "string", required: false, description: "Display name" },
          { name: "plan", type: "string", required: false, description: "Requested plan" },
        ],
        exampleResponse: '{\n  "api_key": "kk_abc123...",\n  "tenant_id": 5,\n  "email": "dev@example.com",\n  "plan": "free"\n}',
      },
      {
        method: "DELETE", path: "/api/account",
        description: "GDPR Art. 17 — Permanently delete your account and all data.",
        auth: "Session cookie or API key",
        exampleResponse: '{\n  "ok": true,\n  "message": "Account and all associated data deleted"\n}',
      },
      {
        method: "GET", path: "/api/account/export",
        description: "GDPR Art. 20 — Export all your data as JSON.",
        auth: "Session cookie or API key",
        exampleResponse: '{\n  "user": { "id": 1, "email": "..." },\n  "agents": [...],\n  "memories": [...],\n  "rooms": [...]\n}',
      },
    ],
  },
  {
    name: "Flows",
    icon: "git-branch",
    description: "Manage agent orchestration flows for chaining agent operations.",
    endpoints: [
      {
        method: "GET", path: "/api/flows",
        description: "List all flows in your workspace.",
        auth: "Session cookie or API key",
        exampleResponse: '[\n  { "id": 1, "name": "Data Pipeline", "agentIds": "[1,2]" }\n]',
      },
      {
        method: "POST", path: "/api/flows",
        description: "Create a new orchestration flow.",
        auth: "Session cookie or API key",
        body: [
          { name: "name", type: "string", required: true, description: "Flow name" },
          { name: "description", type: "string", required: false, description: "Flow description" },
          { name: "agentIds", type: "number[]", required: false, description: "Agent IDs in this flow" },
          { name: "positions", type: "object", required: false, description: "Node positions for UI layout" },
        ],
        exampleResponse: '{\n  "id": 2,\n  "name": "Review Pipeline"\n}',
      },
      {
        method: "PATCH", path: "/api/flows/:id",
        description: "Update a flow's configuration.",
        auth: "Session cookie or API key",
        params: [{ name: "id", type: "number", required: true, description: "Flow ID" }],
        body: [
          { name: "name", type: "string", required: false, description: "New name" },
          { name: "description", type: "string", required: false, description: "New description" },
          { name: "agentIds", type: "number[]", required: false, description: "Updated agent IDs" },
        ],
        exampleResponse: '{\n  "id": 2,\n  "name": "Updated Flow"\n}',
      },
      {
        method: "DELETE", path: "/api/flows/:id",
        description: "Delete a flow.",
        auth: "Session cookie or API key",
        params: [{ name: "id", type: "number", required: true, description: "Flow ID" }],
        exampleResponse: '{\n  "ok": true\n}',
      },
    ],
  },
  {
    name: "External Agents",
    icon: "plug",
    description: "Callback endpoint and token verification for external agents using kat_* tokens.",
    endpoints: [
      {
        method: "POST", path: "/api/agent-callback",
        description: "External agent response endpoint. Requires a kat_* token with deliberation.respond scope.",
        auth: "Agent token (x-agent-token header)",
        body: [
          { name: "sessionId", type: "string", required: true, description: "Deliberation session ID" },
          { name: "position", type: "string", required: true, description: "Agent's position/vote" },
          { name: "confidence", type: "number", required: false, description: "Confidence level 0-1" },
          { name: "reasoning", type: "string", required: false, description: "Agent's reasoning" },
        ],
        exampleResponse: '{\n  "ok": true,\n  "received": {\n    "agentId": 3,\n    "sessionId": "d_abc123",\n    "position": "approve",\n    "confidence": 0.8\n  }\n}',
      },
      {
        method: "GET", path: "/api/agent-auth/verify",
        description: "Verify an agent token's validity and return its scopes.",
        auth: "Agent token (x-agent-token header)",
        exampleResponse: '{\n  "ok": true,\n  "agentId": 3,\n  "userId": 1,\n  "scopes": ["deliberation.respond"]\n}',
      },
    ],
  },
  {
    name: "System",
    icon: "server",
    description: "Health checks, stats, embeddings status, and activity logs.",
    endpoints: [
      {
        method: "GET", path: "/health",
        description: "Basic health check endpoint.",
        auth: "None",
        exampleResponse: '{\n  "status": "ok",\n  "ts": "2026-01-15T10:00:00.000Z"\n}',
      },
      {
        method: "GET", path: "/api/stats",
        description: "Get workspace statistics (operations, latency, active agents).",
        auth: "Session cookie or API key",
        exampleResponse: '{\n  "totalOps": 1204,\n  "avgLatency": 42,\n  "activeAgents": 3\n}',
      },
      {
        method: "GET", path: "/api/embed/status",
        description: "Check if the embeddings model is available.",
        auth: "None",
        exampleResponse: '{\n  "enabled": true,\n  "model": "text-embedding-3-small"\n}',
      },
      {
        method: "GET", path: "/api/logs",
        description: "Get the activity log feed for your workspace.",
        auth: "Session cookie or API key",
        exampleResponse: '[\n  {\n    "agentName": "CFO-Agent",\n    "operation": "stored",\n    "detail": "Q3 revenue report analyzed",\n    "createdAt": "2026-01-15T10:30:00Z"\n  }\n]',
      },
    ],
  },
];

// ── Code example generators ────────────────────────────────────────────────

function genCurl(ep: Endpoint): string {
  const parts = [`curl -X ${ep.method} "https://usekioku.com${ep.path}"`];
  if (ep.auth && ep.auth !== "None") {
    if (ep.auth.includes("Agent token")) {
      parts.push(`  -H "x-agent-token: kat_YOUR_TOKEN"`);
    } else if (ep.auth.includes("Master key")) {
      parts.push(`  -H "x-master-key: YOUR_MASTER_KEY"`);
    } else {
      parts.push(`  -H "x-api-key: kk_YOUR_API_KEY"`);
    }
  }
  if (ep.body && ep.body.length > 0 && (ep.method === "POST" || ep.method === "PATCH" || ep.method === "DELETE")) {
    parts.push(`  -H "Content-Type: application/json"`);
    const bodyObj: Record<string, any> = {};
    for (const p of ep.body.filter(b => b.required)) {
      bodyObj[p.name] = p.type === "number" ? 1 : p.type === "boolean" ? true : p.type.includes("[]") ? [] : `example_${p.name}`;
    }
    if (Object.keys(bodyObj).length > 0) {
      parts.push(`  -d '${JSON.stringify(bodyObj)}'`);
    }
  }
  return parts.join(" \\\n");
}

function genJS(ep: Endpoint): string {
  const hasBody = ep.body && ep.body.length > 0 && (ep.method === "POST" || ep.method === "PATCH" || ep.method === "DELETE");
  let authHeader = "";
  if (ep.auth?.includes("Agent token")) {
    authHeader = `"x-agent-token": "kat_YOUR_TOKEN"`;
  } else if (ep.auth?.includes("Master key")) {
    authHeader = `"x-master-key": "YOUR_MASTER_KEY"`;
  } else if (ep.auth !== "None") {
    authHeader = `"x-api-key": "kk_YOUR_API_KEY"`;
  }

  const lines = [
    `const response = await fetch("https://usekioku.com${ep.path}", {`,
    `  method: "${ep.method}",`,
    `  headers: {`,
  ];
  if (authHeader) lines.push(`    ${authHeader},`);
  if (hasBody) lines.push(`    "Content-Type": "application/json",`);
  lines.push(`  },`);
  if (hasBody) {
    const bodyObj: Record<string, any> = {};
    for (const p of ep.body!.filter(b => b.required)) {
      bodyObj[p.name] = p.type === "number" ? 1 : p.type === "boolean" ? true : p.type.includes("[]") ? [] : `example_${p.name}`;
    }
    if (Object.keys(bodyObj).length > 0) {
      lines.push(`  body: JSON.stringify(${JSON.stringify(bodyObj)}),`);
    }
  }
  lines.push(`});`);
  lines.push(`const data = await response.json();`);
  return lines.join("\n");
}

function genPython(ep: Endpoint): string {
  const hasBody = ep.body && ep.body.length > 0 && (ep.method === "POST" || ep.method === "PATCH" || ep.method === "DELETE");
  let headerKey = "";
  if (ep.auth?.includes("Agent token")) {
    headerKey = `    "x-agent-token": "kat_YOUR_TOKEN"`;
  } else if (ep.auth?.includes("Master key")) {
    headerKey = `    "x-master-key": "YOUR_MASTER_KEY"`;
  } else if (ep.auth !== "None") {
    headerKey = `    "x-api-key": "kk_YOUR_API_KEY"`;
  }

  const lines = [`import requests`, ``];
  lines.push(`response = requests.${ep.method.toLowerCase()}(`);
  lines.push(`    "https://usekioku.com${ep.path}",`);
  if (headerKey) {
    lines.push(`    headers={`);
    lines.push(`${headerKey},`);
    lines.push(`    },`);
  }
  if (hasBody) {
    const bodyObj: Record<string, any> = {};
    for (const p of ep.body!.filter(b => b.required)) {
      bodyObj[p.name] = p.type === "number" ? 1 : p.type === "boolean" ? true : p.type.includes("[]") ? [] : `example_${p.name}`;
    }
    if (Object.keys(bodyObj).length > 0) {
      lines.push(`    json=${JSON.stringify(bodyObj)},`);
    }
  }
  lines.push(`)`);
  lines.push(`data = response.json()`);
  return lines.join("\n");
}

// ── Copy button component ──────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [text]);
  return (
    <button
      onClick={copy}
      className="absolute top-2 right-2 p-1.5 rounded-md bg-white/5 hover:bg-white/10 transition-colors text-muted-foreground hover:text-foreground"
      title="Copy to clipboard"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

// ── Code block component ───────────────────────────────────────────────────

function CodeBlock({ code, language }: { code: string; language: string }) {
  return (
    <div className="relative group">
      <CopyButton text={code} />
      <pre className="bg-[#0a0e1a] border border-white/5 rounded-lg p-4 pr-10 overflow-x-auto text-xs leading-relaxed">
        <code className="text-slate-300 font-mono whitespace-pre">{code}</code>
      </pre>
      <div className="absolute bottom-2 right-2 text-[9px] uppercase tracking-wider text-muted-foreground/30 font-mono">
        {language}
      </div>
    </div>
  );
}

// ── Single endpoint card ───────────────────────────────────────────────────

function EndpointCard({ ep }: { ep: Endpoint }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"curl" | "js" | "python">("curl");

  const codeExamples = {
    curl: genCurl(ep),
    js: genJS(ep),
    python: genPython(ep),
  };

  return (
    <div className="border border-white/5 rounded-xl overflow-hidden bg-card/50 hover:border-white/10 transition-colors">
      {/* Header (always visible) */}
      <button
        className="w-full flex items-center gap-3 px-4 py-3 text-left cursor-pointer hover:bg-white/[0.02] transition-colors"
        onClick={() => setOpen(!open)}
      >
        {/* Method badge */}
        <span className={cn(
          "inline-flex items-center justify-center px-2.5 py-0.5 rounded-md text-[11px] font-bold tracking-wider border font-mono flex-shrink-0",
          METHOD_COLORS[ep.method]
        )}>
          {ep.method}
        </span>
        {/* Path */}
        <code className="text-sm font-mono text-foreground/90 truncate">{ep.path}</code>
        {/* Description */}
        <span className="hidden sm:block text-xs text-muted-foreground truncate ml-auto mr-2">{ep.description}</span>
        {/* Chevron */}
        {open ? <ChevronDown className="w-4 h-4 text-muted-foreground flex-shrink-0" /> : <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />}
      </button>

      {/* Expanded details */}
      {open && (
        <div className="px-4 pb-4 space-y-4 border-t border-white/5">
          {/* Description */}
          <p className="text-sm text-muted-foreground pt-3">{ep.description}</p>

          {/* Auth badge */}
          <div className="flex items-center gap-2">
            <Shield className="w-3.5 h-3.5 text-primary" />
            <span className="text-xs text-muted-foreground">Auth: <span className="text-foreground/80">{ep.auth}</span></span>
          </div>

          {/* URL Params */}
          {ep.params && ep.params.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-foreground/70 uppercase tracking-wider mb-2">URL Parameters</h4>
              <div className="space-y-1">
                {ep.params.map((p) => (
                  <div key={p.name} className="flex items-start gap-2 text-xs">
                    <code className="font-mono text-primary bg-primary/10 px-1.5 py-0.5 rounded">{p.name}</code>
                    <span className="text-muted-foreground/60">{p.type}</span>
                    {p.required && <span className="text-red-400 text-[10px]">required</span>}
                    <span className="text-muted-foreground">{p.description}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Query Params */}
          {ep.queryParams && ep.queryParams.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-foreground/70 uppercase tracking-wider mb-2">Query Parameters</h4>
              <div className="space-y-1">
                {ep.queryParams.map((p) => (
                  <div key={p.name} className="flex items-start gap-2 text-xs flex-wrap">
                    <code className="font-mono text-primary bg-primary/10 px-1.5 py-0.5 rounded">{p.name}</code>
                    <span className="text-muted-foreground/60">{p.type}</span>
                    {p.required && <span className="text-red-400 text-[10px]">required</span>}
                    <span className="text-muted-foreground">{p.description}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Request Body */}
          {ep.body && ep.body.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-foreground/70 uppercase tracking-wider mb-2">Request Body</h4>
              <div className="space-y-1">
                {ep.body.map((p) => (
                  <div key={p.name} className="flex items-start gap-2 text-xs flex-wrap">
                    <code className="font-mono text-primary bg-primary/10 px-1.5 py-0.5 rounded">{p.name}</code>
                    <span className="text-muted-foreground/60">{p.type}</span>
                    {p.required && <span className="text-red-400 text-[10px]">required</span>}
                    <span className="text-muted-foreground">{p.description}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Code examples with tabs */}
          <div>
            <div className="flex items-center gap-1 mb-2">
              {(["curl", "js", "python"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={cn(
                    "px-3 py-1 rounded-md text-xs font-medium transition-colors",
                    tab === t
                      ? "bg-primary/15 text-primary border border-primary/30"
                      : "text-muted-foreground hover:text-foreground hover:bg-white/5"
                  )}
                >
                  {t === "js" ? "JavaScript" : t === "curl" ? "cURL" : "Python"}
                </button>
              ))}
            </div>
            <CodeBlock code={codeExamples[tab]} language={tab === "js" ? "javascript" : tab} />
          </div>

          {/* Example response */}
          <div>
            <h4 className="text-xs font-semibold text-foreground/70 uppercase tracking-wider mb-2">Example Response</h4>
            <CodeBlock code={ep.exampleResponse} language="json" />
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main Docs Page ─────────────────────────────────────────────────────────

export default function DocsPage() {
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const scrollToCategory = (name: string) => {
    setActiveCategory(name);
    sectionRefs.current[name]?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // Filter endpoints by search query
  const filteredCategories = API_CATEGORIES.map((cat) => ({
    ...cat,
    endpoints: cat.endpoints.filter((ep) => {
      if (!search) return true;
      const q = search.toLowerCase();
      return (
        ep.method.toLowerCase().includes(q) ||
        ep.path.toLowerCase().includes(q) ||
        ep.description.toLowerCase().includes(q) ||
        cat.name.toLowerCase().includes(q)
      );
    }),
  })).filter((cat) => cat.endpoints.length > 0);

  const totalEndpoints = API_CATEGORIES.reduce((s, c) => s + c.endpoints.length, 0);

  return (
    <div className="min-h-screen bg-background">
      {/* Hero section with gradient */}
      <div className="relative overflow-hidden border-b border-white/5">
        <div className="absolute inset-0 bg-gradient-to-br from-[#0a1628] via-[#0d1b2a] to-[#0a0e1a]" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,rgba(212,175,55,0.08),transparent_60%)]" />
        <div className="relative px-4 sm:px-6 lg:px-8 py-8 sm:py-12 max-w-6xl mx-auto">
          <div className="flex items-center gap-2 mb-1">
            <a href="#/" className="text-muted-foreground hover:text-foreground transition-colors">
              <ArrowLeft className="w-4 h-4" />
            </a>
            <span className="text-[10px] uppercase tracking-widest text-primary font-semibold">KIOKU™ Platform</span>
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold text-foreground mt-2 mb-2">API Reference</h1>
          <p className="text-sm text-muted-foreground max-w-xl leading-relaxed">
            Complete reference for the KIOKU™ REST API. Manage agents, memories, rooms,
            deliberations, and more. {totalEndpoints} endpoints across {API_CATEGORIES.length} categories.
          </p>

          {/* Quick info cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-6">
            <div className="flex items-center gap-3 bg-white/[0.03] border border-white/5 rounded-xl px-4 py-3">
              <Globe className="w-5 h-5 text-primary flex-shrink-0" />
              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Base URL</div>
                <code className="text-xs font-mono text-foreground">https://usekioku.com</code>
              </div>
            </div>
            <div className="flex items-center gap-3 bg-white/[0.03] border border-white/5 rounded-xl px-4 py-3">
              <Key className="w-5 h-5 text-primary flex-shrink-0" />
              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Auth</div>
                <code className="text-xs font-mono text-foreground">x-api-key: kk_...</code>
              </div>
            </div>
            <div className="flex items-center gap-3 bg-white/[0.03] border border-white/5 rounded-xl px-4 py-3">
              <Code2 className="w-5 h-5 text-primary flex-shrink-0" />
              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Format</div>
                <code className="text-xs font-mono text-foreground">JSON (application/json)</code>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {/* Search + category filter */}
        <div className="sticky top-0 z-30 bg-background/80 backdrop-blur-xl pb-4 -mx-4 px-4 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8 pt-2 border-b border-white/5 mb-6">
          {/* Search */}
          <div className="relative mb-3">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search endpoints... (e.g. POST, /memories, deliberation)"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-10 pr-4 py-2.5 bg-white/[0.03] border border-white/10 rounded-xl text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20 transition-all"
            />
          </div>
          {/* Category pills */}
          <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-none">
            {API_CATEGORIES.map((cat) => (
              <button
                key={cat.name}
                onClick={() => scrollToCategory(cat.name)}
                className={cn(
                  "px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-all border flex items-center gap-1.5",
                  activeCategory === cat.name
                    ? "bg-primary/15 text-primary border-primary/30"
                    : "bg-white/[0.03] text-muted-foreground border-white/5 hover:text-foreground hover:bg-white/5"
                )}
              >
                <span className={cn("w-1.5 h-1.5 rounded-full", activeCategory === cat.name ? "bg-primary" : "bg-muted-foreground/30")} />
                {cat.name}
                <span className="text-[10px] text-muted-foreground/50 ml-0.5">({cat.endpoints.length})</span>
              </button>
            ))}
          </div>
        </div>

        {/* Authentication overview */}
        <div className="mb-8 p-5 rounded-xl border border-primary/20 bg-primary/[0.03]">
          <h3 className="text-sm font-semibold text-primary flex items-center gap-2 mb-3">
            <Shield className="w-4 h-4" /> Authentication
          </h3>
          <div className="text-xs text-muted-foreground leading-relaxed space-y-2">
            <p>
              KIOKU™ supports three authentication methods:
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-3">
              <div className="bg-white/[0.03] rounded-lg p-3 border border-white/5">
                <div className="text-foreground font-medium mb-1">API Key</div>
                <code className="text-[11px] text-primary bg-primary/10 px-1.5 py-0.5 rounded">x-api-key: kk_*</code>
                <p className="mt-1.5 text-muted-foreground/80">For server-to-server integrations. Get your key from the Dashboard.</p>
              </div>
              <div className="bg-white/[0.03] rounded-lg p-3 border border-white/5">
                <div className="text-foreground font-medium mb-1">Session Cookie</div>
                <code className="text-[11px] text-primary bg-primary/10 px-1.5 py-0.5 rounded">kioku_session</code>
                <p className="mt-1.5 text-muted-foreground/80">Set automatically after magic link sign-in. httpOnly, 30-day expiry.</p>
              </div>
              <div className="bg-white/[0.03] rounded-lg p-3 border border-white/5">
                <div className="text-foreground font-medium mb-1">Agent Token</div>
                <code className="text-[11px] text-primary bg-primary/10 px-1.5 py-0.5 rounded">x-agent-token: kat_*</code>
                <p className="mt-1.5 text-muted-foreground/80">Scoped tokens for external agents. Generate via Agent Tokens API.</p>
              </div>
            </div>
          </div>
        </div>

        {/* Category sections */}
        <div className="space-y-8">
          {filteredCategories.map((cat) => (
            <div
              key={cat.name}
              ref={(el) => { sectionRefs.current[cat.name] = el; }}
              className="scroll-mt-32"
            >
              {/* Category header */}
              <div className="flex items-center gap-3 mb-3">
                <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
                  <Zap className="w-4 h-4 text-primary" />
                </div>
                <div>
                  <h2 className="text-base font-semibold text-foreground">{cat.name}</h2>
                  <p className="text-xs text-muted-foreground">{cat.description}</p>
                </div>
                <span className="ml-auto text-[10px] text-muted-foreground/40 bg-white/[0.03] px-2 py-0.5 rounded-full border border-white/5">
                  {cat.endpoints.length} endpoint{cat.endpoints.length !== 1 ? "s" : ""}
                </span>
              </div>
              {/* Endpoints */}
              <div className="space-y-2">
                {cat.endpoints.map((ep) => (
                  <EndpointCard key={`${ep.method}-${ep.path}`} ep={ep} />
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Empty state */}
        {filteredCategories.length === 0 && (
          <div className="text-center py-16">
            <Search className="w-8 h-8 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">No endpoints match "{search}"</p>
            <button onClick={() => setSearch("")} className="text-xs text-primary mt-2 hover:underline">Clear search</button>
          </div>
        )}

        {/* Footer */}
        <div className="mt-12 pt-8 border-t border-white/5 text-center pb-8">
          <p className="text-[10px] text-muted-foreground/30">
            KIOKU™ API Reference · {totalEndpoints} endpoints · Built by IKONBAI™, Inc. · Patent Pending
          </p>
        </div>
      </div>
    </div>
  );
}
