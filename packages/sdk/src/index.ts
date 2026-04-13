/**
 * KIOKU™ SDK — Official TypeScript/JavaScript client
 * © 2026 IKONBAI™, Inc. All rights reserved. Patent Pending.
 *
 * @example
 * ```ts
 * import { KiokuClient } from "@ikonbai/kioku-sdk";
 *
 * const kioku = new KiokuClient({ apiKey: "kk_your_api_key" });
 *
 * // Store a memory
 * await kioku.memories.create({ content: "User prefers dark mode", agentName: "Aria", type: "semantic" });
 *
 * // Semantic search
 * const results = await kioku.memories.search({ query: "user preferences" });
 *
 * // Start a deliberation (with human input)
 * const session = await kioku.deliberation.start(2, { topic: "Should we pivot?", model: "gpt-4o", includeHuman: true });
 *
 * // Register webhook for external agent
 * await kioku.webhooks.register(6, { url: "https://my-agent.example.com/hook" });
 *
 * // Create agent token
 * const token = await kioku.tokens.create(3, { name: "prod-agent", expiresInDays: 90 });
 *
 * // Create agents from template
 * const team = await kioku.templates.createFromTemplate("executive-board");
 *
 * // Get usage
 * const usage = await kioku.usage.get();
 * ```
 */

// ── Types ──────────────────────────────────────────────────

export interface KiokuConfig {
  /** Your KIOKU™ API key (kk_...) from Settings → API Keys */
  apiKey: string;
  /** Base URL — defaults to https://usekioku.com */
  baseUrl?: string;
}

export interface Agent {
  id: number;
  name: string;
  description?: string | null;
  color: string;
  status: "online" | "idle" | "offline";
  model?: string | null;
  role?: string | null;
  memoriesCount: number;
  enabled: boolean;
  llmProvider?: string | null;
  llmModel?: string | null;
  agentType?: string | null;
  createdAt: number;
}

export interface Memory {
  id: number;
  agentId?: number | null;
  agentName?: string | null;
  content: string;
  type: "semantic" | "episodic" | "procedural" | "temporal" | "causal" | "contextual";
  importance: number;
  confidence?: number | null;
  namespace: string;
  createdAt: number;
}

export interface Room {
  id: number;
  name: string;
  description?: string | null;
  status: "active" | "standby" | "archived";
  agentIds: number[];
  createdAt: number;
}

export interface RoomMessage {
  id: number;
  roomId: number;
  agentId?: number | null;
  agentName: string;
  agentColor: string;
  content: string;
  isDecision: boolean;
  createdAt: number;
}

export interface DeliberationSession {
  sessionId: string;
  roomId: number;
  topic: string;
  status: string;
  phases: DeliberationPhase[];
  consensus?: string | null;
  includeHuman?: boolean;
  createdAt: number;
}

export interface DeliberationPhase {
  phase: string;
  round?: number;
  positions: Array<{
    agentId: number;
    agentName: string;
    position: string;
    confidence: number;
    reasoning?: string;
    model?: string;
    role?: string;
  }>;
}

export interface Webhook {
  agentId: number;
  agentName?: string;
  url: string;
  secret: string;
  active: boolean;
  createdAt: number;
}

export interface AgentToken {
  token: string;
  agentId: number;
  name: string;
  scopes: string[];
  expiresAt: number;
  note: string;
}

export interface AgentTokenInfo {
  id?: number;
  agentId: number;
  name: string;
  scopes: string[];
  prefix: string;
  expiresAt: number;
  createdAt: number;
}

export interface AgentTemplate {
  id: string;
  name: string;
  agents: Array<{
    name: string;
    role: string;
    color: string;
    description: string;
  }>;
}

export interface TemplateResult {
  agents: Agent[];
  room: Room;
}

export interface PendingTurn {
  id: number;
  agentId: number;
  sessionId: string;
  roomId: number;
  phase: string;
  round: number;
  topic: string;
  status: "pending" | "responded" | "expired";
  expiresAt: number;
  createdAt: number;
}

export interface UsageInfo {
  plan: string;
  billing_cycle: string;
  usage: {
    deliberations: { used: number; limit: number };
    api_calls: { used: number; limit: number };
    webhooks: { used: number; limit: number };
    tokens_used: { used: number; limit: number };
  };
  resource_limits: {
    agents: { used: number; limit: number };
    memories: { used: number; limit: number };
    rooms: { used: number; limit: number };
    flows: { used: number; limit: number };
  };
  period: { start: number; end: number };
}

export interface UsageHistoryEntry {
  month: string;
  deliberations: number;
  apiCalls: number;
  webhooks: number;
  tokensUsed: number;
}

export interface HumanInputResult {
  accepted: boolean;
}

// ── Input types ──────────────────────────────────────────

export interface CreateAgentInput {
  name: string;
  description?: string;
  color?: string;
  model?: string;
  role?: "devils_advocate" | "contrarian" | "mediator" | "analyst" | "optimist" | "pessimist";
  llmProvider?: string;
  llmApiKey?: string;
  llmModel?: string;
  agentType?: string;
  webhookUrl?: string;
}

export interface UpdateAgentInput {
  name?: string;
  description?: string;
  color?: string;
  model?: string;
  role?: string;
  llmProvider?: string;
  llmApiKey?: string;
  llmModel?: string;
  agentType?: string;
  webhookUrl?: string;
}

export interface UpdateAgentLLMInput {
  provider: string;
  apiKey: string;
  model: string;
}

export interface CreateMemoryInput {
  content: string;
  agentId?: number;
  agentName?: string;
  type?: "semantic" | "episodic" | "procedural" | "temporal" | "causal" | "contextual";
  importance?: number;
  confidence?: number;
  namespace?: string;
}

export interface SearchMemoriesInput {
  query: string;
}

export interface CreateRoomInput {
  name: string;
  description?: string;
  agentIds?: number[];
}

export interface SendMessageInput {
  agentId?: number;
  agentName: string;
  agentColor?: string;
  content: string;
  isDecision?: boolean;
}

export interface StartDeliberationInput {
  topic: string;
  model?: string;
  debateRounds?: number;
  includeHuman?: boolean;
}

export interface RegisterWebhookInput {
  url: string;
}

export interface CreateTokenInput {
  name: string;
  expiresInDays?: number;
}

export interface AgentCallbackInput {
  sessionId: string;
  position: string;
  confidence: number;
  reasoning?: string;
}

export interface RespondToTurnInput {
  position: string;
  confidence?: number;
  reasoning?: string;
}

export interface HumanInputInput {
  phase: string;
  round: number;
  position: string;
  confidence?: number;
  reasoning?: string;
}

// ── Client ──────────────────────────────────────────────

export class KiokuClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  readonly agents: AgentsResource;
  readonly memories: MemoriesResource;
  readonly rooms: RoomsResource;
  readonly deliberation: DeliberationResource;
  readonly webhooks: WebhooksResource;
  readonly tokens: TokensResource;
  readonly templates: TemplatesResource;
  readonly usage: UsageResource;
  readonly polling: PollingResource;

  constructor(config: KiokuConfig) {
    this.baseUrl = (config.baseUrl || "https://usekioku.com").replace(/\/$/, "");
    this.headers = {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
    };
    this.agents = new AgentsResource(this);
    this.memories = new MemoriesResource(this);
    this.rooms = new RoomsResource(this);
    this.deliberation = new DeliberationResource(this);
    this.webhooks = new WebhooksResource(this);
    this.tokens = new TokensResource(this);
    this.templates = new TemplatesResource(this);
    this.usage = new UsageResource(this);
    this.polling = new PollingResource(this);
  }

  /** @internal */
  async _fetch<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}/api${path}`, {
      method,
      headers: this.headers,
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json() as Promise<T>;
  }
}

// ── Resources ──────────────────────────────────────────

class AgentsResource {
  constructor(private readonly client: KiokuClient) {}

  list(): Promise<Agent[]> {
    return this.client._fetch("GET", "/agents");
  }

  create(input: CreateAgentInput): Promise<Agent> {
    return this.client._fetch("POST", "/agents", input);
  }

  update(id: number, input: UpdateAgentInput): Promise<Agent> {
    return this.client._fetch("PATCH", `/agents/${id}`, input);
  }

  /** Update agent LLM configuration (provider, apiKey, model) */
  updateLLM(id: number, input: UpdateAgentLLMInput): Promise<Agent> {
    return this.client._fetch("PATCH", `/agents/${id}`, {
      llmProvider: input.provider,
      llmApiKey: input.apiKey,
      llmModel: input.model,
    });
  }

  setStatus(id: number, status: "online" | "idle" | "offline"): Promise<{ ok: boolean }> {
    return this.client._fetch("PATCH", `/agents/${id}/toggle`, { status });
  }

  delete(id: number): Promise<{ ok: boolean }> {
    return this.client._fetch("DELETE", `/agents/${id}`);
  }
}

class MemoriesResource {
  constructor(private readonly client: KiokuClient) {}

  list(): Promise<Memory[]> {
    return this.client._fetch("GET", "/memories");
  }

  search(input: SearchMemoriesInput): Promise<Memory[]> {
    return this.client._fetch("GET", `/memories?q=${encodeURIComponent(input.query)}`);
  }

  create(input: CreateMemoryInput): Promise<Memory> {
    return this.client._fetch("POST", "/memories", input);
  }

  delete(id: number): Promise<{ ok: boolean }> {
    return this.client._fetch("DELETE", `/memories/${id}`);
  }
}

class RoomsResource {
  constructor(private readonly client: KiokuClient) {}

  list(): Promise<Room[]> {
    return this.client._fetch("GET", "/rooms");
  }

  create(input: CreateRoomInput): Promise<Room> {
    return this.client._fetch("POST", "/rooms", input);
  }

  messages(roomId: number): Promise<RoomMessage[]> {
    return this.client._fetch("GET", `/rooms/${roomId}/messages`);
  }

  sendMessage(roomId: number, input: SendMessageInput): Promise<RoomMessage> {
    return this.client._fetch("POST", `/rooms/${roomId}/messages`, input);
  }

  delete(id: number): Promise<{ ok: boolean }> {
    return this.client._fetch("DELETE", `/rooms/${id}`);
  }
}

class DeliberationResource {
  constructor(private readonly client: KiokuClient) {}

  /** Start a structured deliberation session */
  start(roomId: number, input: StartDeliberationInput): Promise<DeliberationSession> {
    return this.client._fetch("POST", `/rooms/${roomId}/deliberate`, input);
  }

  /** List all deliberation sessions for a room */
  sessions(roomId: number): Promise<DeliberationSession[]> {
    return this.client._fetch("GET", `/rooms/${roomId}/deliberations`);
  }

  /** Get full session with audit trail */
  get(roomId: number, sessionId: string): Promise<DeliberationSession> {
    return this.client._fetch("GET", `/rooms/${roomId}/deliberations/${sessionId}`);
  }

  /** Get latest consensus for a room */
  consensus(roomId: number): Promise<{ sessionId: string; consensus: string; createdAt: number }> {
    return this.client._fetch("GET", `/rooms/${roomId}/consensus`);
  }

  /** Submit human participant input during a deliberation */
  submitHumanInput(roomId: number, sessionId: string, input: HumanInputInput): Promise<HumanInputResult> {
    return this.client._fetch("POST", `/rooms/${roomId}/deliberations/${sessionId}/human-input`, input);
  }
}

class WebhooksResource {
  constructor(private readonly client: KiokuClient) {}

  /** Register a webhook URL for an agent */
  register(agentId: number, input: RegisterWebhookInput): Promise<Webhook> {
    return this.client._fetch("POST", `/agents/${agentId}/webhook`, input);
  }

  /** Get webhook config for an agent */
  get(agentId: number): Promise<Webhook> {
    return this.client._fetch("GET", `/agents/${agentId}/webhook`);
  }

  /** Remove webhook from an agent */
  delete(agentId: number): Promise<{ ok: boolean }> {
    return this.client._fetch("DELETE", `/agents/${agentId}/webhook`);
  }

  /** List all webhooks */
  list(): Promise<Webhook[]> {
    return this.client._fetch("GET", "/webhooks");
  }
}

class TokensResource {
  constructor(private readonly client: KiokuClient) {}

  /** Create a scoped agent token (kat_*) */
  create(agentId: number, input: CreateTokenInput): Promise<AgentToken> {
    return this.client._fetch("POST", `/agents/${agentId}/token`, input);
  }

  /** List tokens for an agent (secrets not shown) */
  list(agentId: number): Promise<AgentTokenInfo[]> {
    return this.client._fetch("GET", `/agents/${agentId}/tokens`);
  }

  /** Revoke a single token */
  revoke(agentId: number, tokenId: number): Promise<{ ok: boolean }> {
    return this.client._fetch("DELETE", `/agents/${agentId}/tokens/${tokenId}`);
  }

  /** Revoke all tokens for an agent */
  revokeAll(agentId: number): Promise<{ ok: boolean }> {
    return this.client._fetch("DELETE", `/agents/${agentId}/tokens`);
  }

  /** Verify a token (use X-Agent-Token header) */
  verify(agentToken: string): Promise<{ ok: boolean; agentId: number; userId: number; scopes: string[] }> {
    return fetch(`${(this as any).client?.baseUrl || "https://usekioku.com"}/api/agent-auth/verify`, {
      headers: { "X-Agent-Token": agentToken },
    }).then(r => r.json());
  }
}

class TemplatesResource {
  constructor(private readonly client: KiokuClient) {}

  /** List available agent templates */
  list(): Promise<AgentTemplate[]> {
    return this.client._fetch("GET", "/agents/templates");
  }

  /** Create agents from a template (also creates a room) */
  createFromTemplate(templateId: string): Promise<TemplateResult> {
    return this.client._fetch("POST", `/agents/templates/${templateId}`);
  }
}

class UsageResource {
  constructor(private readonly client: KiokuClient) {}

  /** Get current usage and limits */
  get(): Promise<UsageInfo> {
    return this.client._fetch("GET", "/usage");
  }

  /** Get usage history for past months */
  getHistory(months?: number): Promise<{ history: UsageHistoryEntry[] }> {
    const q = months ? `?months=${months}` : "";
    return this.client._fetch("GET", `/usage/history${q}`);
  }
}

class PollingResource {
  constructor(private readonly client: KiokuClient) {}

  /** Get pending turns for the authenticated agent (use with ExternalAgentClient) */
  getPendingTurns(): Promise<PendingTurn[]> {
    return this.client._fetch("GET", "/agent/pending-turns");
  }

  /** Get a specific turn by ID */
  getTurn(turnId: number): Promise<PendingTurn> {
    return this.client._fetch("GET", `/agent/turns/${turnId}`);
  }

  /** Respond to a pending turn */
  respondToTurn(turnId: number, input: RespondToTurnInput): Promise<{ ok: boolean; turnId: number }> {
    return this.client._fetch("POST", `/agent/turns/${turnId}/respond`, input);
  }
}

// ── External Agent Client ──────────────────────────────

/**
 * Lightweight client for external agents authenticated with kat_* tokens.
 *
 * @example
 * ```ts
 * import { ExternalAgentClient } from "@ikonbai/kioku-sdk";
 *
 * const agent = new ExternalAgentClient({
 *   agentToken: "kat_abc123...",
 *   baseUrl: "https://usekioku.com",
 * });
 *
 * // Poll for pending turns
 * const turns = await agent.getPendingTurns();
 *
 * // Respond to a turn
 * await agent.respondToTurn(turns[0].id, {
 *   position: "We should proceed with caution",
 *   confidence: 0.85,
 *   reasoning: "Market conditions are uncertain",
 * });
 *
 * // Or use direct callback
 * await agent.callback({
 *   sessionId: "dlb_2_123",
 *   position: "We should proceed with caution",
 *   confidence: 0.85,
 *   reasoning: "Market conditions are uncertain",
 * });
 * ```
 */
export class ExternalAgentClient {
  private readonly baseUrl: string;
  private readonly agentToken: string;

  constructor(config: { agentToken: string; baseUrl?: string }) {
    this.baseUrl = (config.baseUrl || "https://usekioku.com").replace(/\/$/, "");
    this.agentToken = config.agentToken;
  }

  private async _fetch<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}/api${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Agent-Token": this.agentToken,
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json() as Promise<T>;
  }

  /** Send a position to an active deliberation session */
  async callback(input: AgentCallbackInput): Promise<{ ok: boolean; received: unknown }> {
    return this._fetch("POST", "/agent-callback", input);
  }

  /** Verify this token is valid */
  async verify(): Promise<{ ok: boolean; agentId: number; userId: number; scopes: string[] }> {
    return this._fetch("GET", "/agent-auth/verify");
  }

  /** Get pending deliberation turns for this agent */
  async getPendingTurns(): Promise<PendingTurn[]> {
    return this._fetch("GET", "/agent/pending-turns");
  }

  /** Get a specific turn */
  async getTurn(turnId: number): Promise<PendingTurn> {
    return this._fetch("GET", `/agent/turns/${turnId}`);
  }

  /** Respond to a pending deliberation turn */
  async respondToTurn(turnId: number, input: RespondToTurnInput): Promise<{ ok: boolean; turnId: number }> {
    return this._fetch("POST", `/agent/turns/${turnId}/respond`, input);
  }
}
