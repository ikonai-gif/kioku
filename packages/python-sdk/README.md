# kioku-memory

Python SDK for **KIOKU™** — AI Agent Memory & Deliberation Platform.

KIOKU™ is the only agent memory platform built for **decisions**, not just context. Store memories, run structured multi-agent deliberations, and get auditable consensus.

## Install

```bash
pip install kioku-memory
```

## Quick Start

```python
from kioku import KiokuClient

client = KiokuClient(api_key="kk_your_key")

# Store a memory (with new types: temporal, causal, contextual)
memory = client.memories.create(
    "Client prefers morning appointments",
    agent_name="Nika",
    importance=0.8,
    confidence=0.95,
    memory_type="temporal",
)

# Semantic search
results = client.memories.search("scheduling preferences")
for r in results:
    print(f"{r['content']} (similarity: {r.get('similarity', 'N/A')})")

# Create agents from a template
team = client.templates.create_from_template("executive-board")
print(f"Created {len(team['agents'])} agents + room")

# Run a deliberation with human input
session = client.deliberation.start(
    room_id=1,
    topic="Should we switch to a new booking system?",
    debate_rounds=2,
    include_human=True,
)

# Submit human input
client.deliberation.submit_human_input(
    room_id=1,
    session_id=session["sessionId"],
    phase="debate",
    round=1,
    position="I support the switch",
    confidence=0.9,
)

# Check usage
usage = client.usage.get()
print(usage["plan"], usage["usage"]["deliberations"])
```

## Features

- **Memory CRUD** — Store, search, update, delete agent memories
- **Semantic Search** — pgvector-powered similarity search with HNSW indexing
- **Memory Types** — semantic, episodic, procedural, temporal, causal, contextual
- **Confidence Scores** — Attach confidence to memories
- **Synaptic Links** — Create typed links between memories (causal, supports, contradicts, etc.)
- **Graph Traversal** — BFS traversal across memory connections
- **Structured Deliberation** — Multi-agent debate with weighted consensus (patented)
- **Human Input** — Participate as a human in deliberation sessions
- **Decision Audit Trail** — Every deliberation logged with positions, confidence, reasoning
- **Agent Templates** — Pre-built agent teams (executive board, technical council, etc.)
- **Polling Mode** — External agents can poll for pending turns and respond
- **Usage Metering** — Track deliberations, API calls, webhooks, and token usage
- **Agent LLM Config** — Configure per-agent LLM provider, API key, and model
- **War Room** — Quick deliberation with auto-room creation
- **Forgetting Curve** — Automatic memory decay and garbage collection
- **Memory Consolidation** — Auto-merge similar memories
- **External Agent Auth** — kat_* tokens for agent-to-agent communication
- **GDPR Compliant** — Full data export and account deletion
- **Async Support** — All methods have async variants (prefix with `a`)

## Async Usage

```python
import asyncio
from kioku import KiokuClient

async def main():
    client = KiokuClient(api_key="kk_your_key")
    results = await client.memories.asearch("user preferences")
    templates = await client.templates.alist()
    usage = await client.usage.aget()
    await client.aclose()

asyncio.run(main())
```

## External Agent Client

For agents participating in deliberations via scoped tokens:

```python
from kioku import ExternalAgentClient

agent = ExternalAgentClient(token="kat_agent_token")

# Poll for pending turns
turns = agent.get_pending_turns()
if turns:
    agent.respond_to_turn(
        turns[0]["id"],
        position="I recommend Option A",
        confidence=0.9,
        reasoning="Based on historical data...",
    )

# Or use direct callback
agent.callback(
    session_id="dlb_abc123",
    position="I recommend Option A",
    confidence=0.9,
    reasoning="Based on historical data...",
)
```

## New in v0.2.0

- **Templates** — `client.templates.list()`, `client.templates.create_from_template(id)`
- **Agent LLM Config** — `client.agents.update_llm(id, provider=..., api_key=..., model=...)`
- **Deliberation Human Input** — `client.deliberation.submit_human_input(room_id, session_id, ...)`
- **Polling** — `client.polling.get_pending_turns()`, `client.polling.respond_to_turn(id, ...)`
- **Usage** — `client.usage.get()`, `client.usage.get_history(months=6)`
- **Memory Types** — Added temporal, causal, contextual types + confidence field
- All new methods have async variants

## Links

- [Documentation](https://usekioku.com/docs)
- [API Reference](https://github.com/ikonai-gif/kioku/blob/main/docs/api-reference.md)
- [GitHub](https://github.com/ikonai-gif/kioku)

## License

MIT
