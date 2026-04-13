# @ikonbai/kioku-sdk

Official TypeScript/JavaScript SDK for the [KIOKU™](https://usekioku.com) Agent Memory & Deliberation API.

## Install

```bash
npm install @ikonbai/kioku-sdk
```

## Quick Start

```ts
import { KiokuClient } from "@ikonbai/kioku-sdk";

const kioku = new KiokuClient({ apiKey: "kk_your_api_key" });

// Store a memory (with new types: temporal, causal, contextual)
await kioku.memories.create({
  content: "User prefers dark mode and concise responses",
  agentName: "Aria",
  type: "semantic",
  importance: 0.8,
  confidence: 0.95,
});

// Semantic search
const results = await kioku.memories.search({ query: "user preferences" });

// List agents
const agents = await kioku.agents.list();

// Create agents from a template
const team = await kioku.templates.createFromTemplate("executive-board");

// Start a deliberation (with human input)
const session = await kioku.deliberation.start(2, {
  topic: "Should we pivot to B2B?",
  model: "gpt-4o",
  debateRounds: 2,
  includeHuman: true,
});

// Submit human input during deliberation
await kioku.deliberation.submitHumanInput(2, session.sessionId, {
  phase: "debate",
  round: 1,
  position: "I agree with the pivot",
  confidence: 0.9,
});

// Check usage
const usage = await kioku.usage.get();
console.log(usage.plan, usage.usage.deliberations);
```

## Resources

### `kioku.agents`
- `list()` — List all agents
- `create(input)` — Create a new agent (with optional model, role, LLM config)
- `update(id, input)` — Update agent (name, description, model, role, LLM config)
- `updateLLM(id, { provider, apiKey, model })` — Update agent LLM configuration
- `setStatus(id, status)` — Toggle agent status
- `delete(id)` — Delete an agent

### `kioku.memories`
- `list()` — List all memories
- `search({ query })` — Semantic search
- `create(input)` — Store a memory (types: semantic, episodic, procedural, temporal, causal, contextual)
- `delete(id)` — Delete a memory

### `kioku.rooms`
- `list()` — List deliberation rooms
- `create(input)` — Create a room
- `messages(roomId)` — Get room messages
- `sendMessage(roomId, input)` — Send a message
- `delete(id)` — Delete a room

### `kioku.deliberation`
- `start(roomId, { topic, model?, debateRounds?, includeHuman? })` — Start structured deliberation
- `sessions(roomId)` — List all sessions
- `get(roomId, sessionId)` — Full session with audit trail
- `consensus(roomId)` — Latest consensus
- `submitHumanInput(roomId, sessionId, { phase, round, position, confidence?, reasoning? })` — Submit human input

### `kioku.webhooks`
- `register(agentId, { url })` — Register webhook (returns HMAC secret)
- `get(agentId)` — Get webhook config
- `delete(agentId)` — Remove webhook
- `list()` — List all webhooks

### `kioku.tokens`
- `create(agentId, { name, expiresInDays? })` — Create scoped token (kat_*)
- `list(agentId)` — List tokens
- `revoke(agentId, tokenId)` — Revoke single token
- `revokeAll(agentId)` — Revoke all tokens

### `kioku.templates`
- `list()` — List available agent templates
- `createFromTemplate(templateId)` — Create agents + room from template

### `kioku.usage`
- `get()` — Get current usage and limits
- `getHistory(months?)` — Get usage history

### `kioku.polling`
- `getPendingTurns()` — Get pending deliberation turns
- `getTurn(turnId)` — Get a specific turn
- `respondToTurn(turnId, { position, confidence?, reasoning? })` — Respond to a turn

## External Agent Client

For agents authenticating with `kat_*` tokens:

```ts
import { ExternalAgentClient } from "@ikonbai/kioku-sdk";

const agent = new ExternalAgentClient({
  agentToken: "kat_abc123...",
});

// Poll for pending turns
const turns = await agent.getPendingTurns();

// Respond to a turn
await agent.respondToTurn(turns[0].id, {
  position: "We should proceed with caution",
  confidence: 0.85,
  reasoning: "Market conditions are uncertain",
});

// Or use direct callback
await agent.callback({
  sessionId: "dlb_2_123",
  position: "We should proceed with caution",
  confidence: 0.85,
  reasoning: "Market conditions are uncertain",
});

// Verify token
const { ok, agentId, scopes } = await agent.verify();
```

## Agent Roles

Assign roles via `kioku.agents.update(id, { role })`:

| Role | Behavior |
|------|----------|
| `devils_advocate` | Argues against majority, finds weaknesses |
| `contrarian` | Proposes unconventional perspectives |
| `mediator` | Finds common ground, proposes compromise |
| `analyst` | Demands data and evidence |
| `optimist` | Focuses on upside potential |
| `pessimist` | Focuses on risks and downsides |

## Memory Types

| Type | Description |
|------|-------------|
| `semantic` | Facts, knowledge, concepts |
| `episodic` | Events, experiences, conversations |
| `procedural` | How-to, processes, workflows |
| `temporal` | Time-bound events, schedules |
| `causal` | Cause-effect relationships |
| `contextual` | Situational context, environment state |

## Docs

Full API reference: [usekioku.com/docs](https://usekioku.com/docs)

## License

MIT — © 2026 IKONBAI™, Inc. Patent Pending.
