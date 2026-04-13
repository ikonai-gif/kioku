# KIOKU™ Python SDK — API Reference

Complete reference for `kioku-memory` v0.1.0.

---

## KiokuClient

```python
from kioku import KiokuClient

client = KiokuClient(
    api_key="kk_your_key",      # Required
    base_url="https://...",      # Default: https://usekioku.com
    timeout=30.0,                # Seconds
)
```

### Top-Level Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `client.health()` | `dict` | Server health, DB status, latency |
| `client.me()` | `dict` | Current user (email, plan, id) |
| `client.usage()` | `dict` | Usage stats (memories, agents, plan limits) |
| `client.stats()` | `dict` | Aggregate stats (totalOps, avgLatency, activeAgents) |
| `client.logs()` | `list` | Activity log entries |
| `client.close()` | `None` | Close HTTP connection |

---

## client.agents

Manage AI agents registered in your KIOKU™ instance.

### agents.list()

```python
agents = client.agents.list()
# Returns: [{"id": 1, "name": "NIKA", "status": "idle", ...}, ...]
```

### agents.create(name, *, description, color)

```python
agent = client.agents.create(
    "Research Bot",
    description="Handles market research tasks",
    color="#3B82F6",
)
```

### agents.update(agent_id, *, name, description, color, model, role)

```python
client.agents.update(1, name="NIKA v2", model="gpt-4o")
```

### agents.set_status(agent_id, *, enabled, status)

```python
client.agents.set_status(1, status="online")
client.agents.set_status(1, enabled=False)
```

### agents.delete(agent_id)

```python
client.agents.delete(5)
```

---

## client.memories

Store, search, and manage agent memories with pgvector embeddings.

### memories.list(*, query, namespace)

```python
# All memories
memories = client.memories.list()

# With semantic search
memories = client.memories.list(query="appointment preferences")

# Namespaced
memories = client.memories.list(namespace="salon-clients")
```

### memories.search(query, *, namespace)

Convenience wrapper around `list(query=...)`.

```python
results = client.memories.search("dark mode preference")
# Returns: [{"id": 1, "content": "...", "similarity": 0.92, ...}, ...]
```

### memories.create(content, *, agent_id, agent_name, memory_type, importance, namespace)

```python
memory = client.memories.create(
    "Client prefers morning appointments",
    agent_name="Nika",
    memory_type="semantic",   # semantic | episodic | procedural | emotional
    importance=0.8,           # 0.0 - 1.0
    namespace="salon",
)
# Returns: {"id": 4, "content": "...", "type": "semantic", ...}
```

### memories.delete(memory_id)

```python
client.memories.delete(4)  # Returns: {"ok": true}
```

### memories.purge(scope, *, agent_id)

```python
# Delete all memories
client.memories.purge("all")

# Delete one agent's memories
client.memories.purge("agent", agent_id="3")
```

### memories.export()

GDPR Art. 20 compliant full data export.

```python
data = client.memories.export()
# Returns: {"memories": [...], "metadata": {...}}
```

### Synaptic Links (Memory Graph)

Create typed connections between memories.

```python
# Create link
link = client.memories.create_link(
    memory_id=1,
    target_id=2,
    link_type="supports",   # causal | supports | contradicts | related | temporal
    strength=0.9,
)

# List links
links = client.memories.list_links(memory_id=1)

# Delete link
client.memories.delete_link(memory_id=1, link_id=5)

# Graph traversal (BFS)
graph = client.memories.graph(memory_id=1, depth=3, limit=50)
```

### Maintenance

```python
# Auto-merge similar memories
client.memories.consolidate()

# Garbage collect decayed memories (forgetting curve)
client.memories.gc(threshold=0.1)
```

---

## client.rooms

Rooms group agents for collaboration and deliberation.

### rooms.list()

```python
rooms = client.rooms.list()
# Returns: [{"id": 1, "name": "...", "status": "standby", ...}, ...]
```

### rooms.create(name, *, description, agent_ids)

```python
room = client.rooms.create(
    "Q3 Strategy",
    description="Quarterly planning room",
    agent_ids=[1, 2, 3],
)
```

### rooms.update(room_id, *, name, description, status, agent_ids)

```python
client.rooms.update(1, status="active", agent_ids=[1, 2, 3, 4])
```

### rooms.delete(room_id)

```python
client.rooms.delete(5)
```

### rooms.messages(room_id)

```python
messages = client.rooms.messages(1)
# Returns: [{"agentName": "NIKA", "content": "...", "timestamp": "...", ...}]
```

### rooms.send_message(room_id, agent_name, content, *, agent_id, agent_color, is_decision)

```python
client.rooms.send_message(
    room_id=1,
    agent_name="Research Bot",
    content="Based on my analysis, Option A is optimal.",
    is_decision=True,
)
```

---

## client.deliberation

KIOKU™'s core differentiator — structured multi-agent deliberation with auditable consensus.

### deliberation.start(room_id, topic, *, model, debate_rounds)

Starts a full deliberation cycle: Position → Debate → Final → Consensus.

```python
session = client.deliberation.start(
    room_id=1,
    topic="Should we adopt microservices architecture?",
    model="gemini-2.5-flash",
    debate_rounds=2,
)
# Returns full session with rounds, positions, and consensus
```

### deliberation.get(room_id, session_id)

```python
session = client.deliberation.get(room_id=1, session_id="dlb_abc123")
```

### deliberation.sessions(room_id)

```python
sessions = client.deliberation.sessions(room_id=1)
# Returns: [{"id": "dlb_...", "topic": "...", "status": "completed", ...}]
```

### deliberation.consensus(room_id)

```python
result = client.deliberation.consensus(room_id=1)
# Returns: {"decision": "...", "confidence": 0.87, "votes": [...], ...}
```

---

## client.warroom

Quick deliberation without manually creating rooms.

### warroom.message(agent_name, content, *, agent_color, is_decision, room_name)

```python
client.warroom.message(
    agent_name="Alert Bot",
    content="Critical: Memory usage exceeds 90%",
    room_name="Ops Alert",
)
```

---

## client.webhooks

### webhooks.register(agent_id, url)

```python
client.webhooks.register(1, "https://your-app.com/webhook/kioku")
```

### webhooks.get(agent_id)

```python
webhook = client.webhooks.get(1)
```

### webhooks.delete(agent_id)

```python
client.webhooks.delete(1)
```

### webhooks.list()

```python
all_hooks = client.webhooks.list()
```

---

## client.tokens

Manage scoped agent tokens (`kat_*`) for external agent authentication.

### tokens.create(agent_id, *, name, scopes, expires_in_days)

```python
token = client.tokens.create(
    agent_id=1,
    name="LangChain Integration",
    scopes=["deliberation:participate", "memories:read"],
    expires_in_days=90,
)
# Returns: {"token": "kat_...", "id": 5, ...}
```

### tokens.list(agent_id)

```python
tokens = client.tokens.list(agent_id=1)
```

### tokens.revoke(agent_id, token_id)

```python
client.tokens.revoke(agent_id=1, token_id=5)
```

### tokens.revoke_all(agent_id)

```python
client.tokens.revoke_all(agent_id=1)
```

---

## client.flows

Manage agent pipelines.

### flows.list() / flows.create(name, ...) / flows.update(flow_id, ...) / flows.delete(flow_id)

```python
flows = client.flows.list()

flow = client.flows.create(
    "Intake Pipeline",
    description="Client intake → memory → deliberation",
    agent_ids=[1, 2, 3],
)

client.flows.update(flow["id"], name="Intake Pipeline v2")
client.flows.delete(flow["id"])
```

---

## client.account

GDPR compliance endpoints.

### account.export_data()

Full data export under GDPR Art. 20.

```python
data = client.account.export_data()
```

### account.delete()

Permanently delete account and all data. **IRREVERSIBLE.**

```python
client.account.delete()  # ⚠️ Cannot be undone
```

---

## client.billing

### billing.checkout(plan, *, billing_cycle, success_url, cancel_url)

```python
session = client.billing.checkout(
    "pro",
    billing_cycle="annual",
    success_url="https://app.com/success",
)
# Returns: {"url": "https://checkout.stripe.com/..."}
```

### billing.portal(*, return_url)

```python
portal = client.billing.portal(return_url="https://app.com/settings")
```

### billing.status()

```python
status = client.billing.status()
# Returns: {"plan": "pro", "status": "active", ...}
```

---

## ExternalAgentClient

Lightweight client for external agents using scoped `kat_*` tokens.

```python
from kioku import ExternalAgentClient

agent = ExternalAgentClient(token="kat_your_token")
```

### agent.verify()

```python
info = agent.verify()
# Returns: {"agentId": 1, "userId": "...", "scopes": [...]}
```

### agent.callback(session_id, position, *, confidence, reasoning)

Submit a position in a deliberation session.

```python
agent.callback(
    session_id="dlb_abc123",
    position="I recommend Option A",
    confidence=0.85,
    reasoning="Historical data shows 23% better outcomes...",
)
```

---

## Exceptions

All exceptions inherit from `KiokuError`.

| Exception | HTTP Code | When |
|-----------|-----------|------|
| `AuthenticationError` | 401 | Invalid or missing API key |
| `ValidationError` | 400 | Bad request parameters |
| `NotFoundError` | 404 | Resource doesn't exist |
| `ConflictError` | 409 | Resource conflict |
| `RateLimitError` | 429 | Too many requests |
| `QuotaExceededError` | 429 | Plan quota exceeded |
| `ServerError` | 5xx | Server-side error |
| `KiokuError` | any | Catch-all base |

```python
from kioku import KiokuError, RateLimitError

try:
    client.memories.create("test")
except RateLimitError as e:
    print(f"Retry after {e.retry_after} seconds")
    print(f"Status: {e.status_code}")
    print(f"Body: {e.response_body}")
except KiokuError as e:
    print(f"API error: {e}")
```

---

## Async Reference

Every sync method has an async counterpart prefixed with `a`:

| Sync | Async |
|------|-------|
| `agents.list()` | `agents.alist()` |
| `agents.create()` | `agents.acreate()` |
| `memories.search()` | `memories.asearch()` |
| `memories.create()` | `memories.acreate()` |
| `rooms.list()` | `rooms.alist()` |
| `deliberation.start()` | `deliberation.astart()` |
| `client.close()` | `client.aclose()` |

```python
async with KiokuClient(api_key="kk_key") as client:
    await client.memories.acreate("async memory")
```
