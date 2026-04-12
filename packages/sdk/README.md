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

// Store a memory
await kioku.memories.create({
  content: "User prefers dark mode and concise responses",
  agentName: "Aria",
  type: "semantic",
  importance: 0.8,
});

// Semantic search
const results = await kioku.memories.search({ query: "user preferences" });

// List agents
const agents = await kioku.agents.list();

// Start a deliberation
const session = await kioku.deliberation.start(2, {
  topic: "Should we pivot to B2B?",
  model: "gpt-4o",
  debateRounds: 2,
});
```

## Resources

### `kioku.agents`
- `list()` — List all agents
- `create(input)` — Create a new agent (with optional model & role)
- `update(id, input)` — Update agent (name, description, model, role)
- `setStatus(id, status)` — Toggle agent status
- `delete(id)` — Delete an agent

### `kioku.memories`
- `list()` — List all memories
- `search({ query })` — Semantic search
- `create(input)` — Store a memory (auto-classified via AUDN cycle)
- `delete(id)` — Delete a memory

### `kioku.rooms`
- `list()` — List deliberation rooms
- `create(input)` — Create a room
- `messages(roomId)` — Get room messages
- `sendMessage(roomId, input)` — Send a message
- `delete(id)` — Delete a room

### `kioku.deliberation`
- `start(roomId, { topic, model?, debateRounds? })` — Start structured deliberation
- `sessions(roomId)` — List all sessions
- `get(roomId, sessionId)` — Full session with audit trail
- `consensus(roomId)` — Latest consensus

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

## External Agent Client

For agents authenticating with `kat_*` tokens:

```ts
import { ExternalAgentClient } from "@ikonbai/kioku-sdk";

const agent = new ExternalAgentClient({
  agentToken: "kat_abc123...",
});

// Send position to a deliberation
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

## Docs

Full API reference: [usekioku.com/docs](https://usekioku.com/docs)

## License

MIT — © 2026 IKONBAI™, Inc. Patent Pending.
