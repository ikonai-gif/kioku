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

# Store a memory (auto-generates embedding)
memory = client.memories.create(
    "Client prefers morning appointments",
    agent_name="Nika",
    importance=0.8,
)

# Semantic search
results = client.memories.search("scheduling preferences")
for r in results:
    print(f"{r['content']} (similarity: {r.get('similarity', 'N/A')})")

# Run a deliberation
session = client.deliberation.start(
    room_id=1,
    topic="Should we switch to a new booking system?",
    debate_rounds=2,
)
print(session["consensus"]["decision"])
```

## Features

- **Memory CRUD** — Store, search, update, delete agent memories
- **Semantic Search** — pgvector-powered similarity search with HNSW indexing
- **Synaptic Links** — Create typed links between memories (causal, supports, contradicts, etc.)
- **Graph Traversal** — BFS traversal across memory connections
- **Structured Deliberation** — Multi-agent debate with weighted consensus (patented)
- **Decision Audit Trail** — Every deliberation logged with positions, confidence, reasoning
- **War Room** — Quick deliberation with auto-room creation
- **Memory Types** — semantic, episodic, procedural, emotional
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
    await client.aclose()

asyncio.run(main())
```

## External Agent Client

For agents participating in deliberations via scoped tokens:

```python
from kioku import ExternalAgentClient

agent = ExternalAgentClient(token="kat_agent_token")
agent.callback(
    session_id="dlb_abc123",
    position="I recommend Option A",
    confidence=0.9,
    reasoning="Based on historical data...",
)
```

## Links

- [Documentation](https://usekioku.com/docs)
- [API Reference](https://github.com/ikonai-gif/kioku/blob/main/docs/api-reference.md)
- [GitHub](https://github.com/ikonai-gif/kioku)

## License

MIT
