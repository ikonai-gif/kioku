# KIOKU™ Python SDK — Quickstart

Get started with KIOKU™ in under 5 minutes.

## Installation

```bash
pip install kioku-memory
```

## Authentication

Every request requires an API key. Get yours from the KIOKU™ dashboard or use the master key for self-hosted instances.

```python
from kioku import KiokuClient

client = KiokuClient(api_key="kk_your_api_key")

# Self-hosted
client = KiokuClient(
    api_key="your_master_key",
    base_url="https://your-kioku-instance.com",
)
```

## Store a Memory

```python
memory = client.memories.create(
    "Client prefers morning appointments and warm blonde tones",
    agent_name="Nika",
    memory_type="semantic",    # semantic | episodic | procedural | emotional
    importance=0.8,
)
print(f"Stored memory #{memory['id']}")
```

## Search Memories

KIOKU™ uses pgvector with HNSW indexing for semantic similarity search:

```python
results = client.memories.search("scheduling preferences")
for r in results:
    print(f"[{r.get('similarity', 'N/A')}] {r['content']}")
```

## Run a Deliberation

KIOKU™'s unique feature — structured multi-agent debate with auditable consensus:

```python
# Create a room with agents
room = client.rooms.create(
    "Architecture Review",
    agent_ids=[1, 2, 3],
)

# Start deliberation
session = client.deliberation.start(
    room_id=room["id"],
    topic="Should we migrate from PostgreSQL to CockroachDB?",
    debate_rounds=2,
)

# Get the consensus
consensus = session["consensus"]
print(f"Decision: {consensus['decision']}")
print(f"Confidence: {consensus['confidence']}")
```

## Context Manager

```python
with KiokuClient(api_key="kk_your_key") as client:
    memories = client.memories.list()
    print(f"Total memories: {len(memories)}")
# Connection auto-closed
```

## Async Support

Every method has an async variant (prefix with `a`):

```python
import asyncio
from kioku import KiokuClient

async def main():
    client = KiokuClient(api_key="kk_your_key")
    
    memories = await client.memories.alist()
    results = await client.memories.asearch("user preferences")
    
    await client.aclose()

asyncio.run(main())
```

## Error Handling

```python
from kioku import KiokuClient, AuthenticationError, NotFoundError, RateLimitError

client = KiokuClient(api_key="kk_your_key")

try:
    memory = client.memories.create("test")
except AuthenticationError:
    print("Invalid API key")
except RateLimitError as e:
    print(f"Rate limited. Retry after {e.retry_after}s")
except NotFoundError:
    print("Resource not found")
```

## What's Next

- [API Reference](./api-reference.md) — Full method documentation
- [Deliberation Guide](./deliberation-guide.md) — Deep dive into structured multi-agent decisions
- [Examples](../examples/) — Working scripts for common use cases
