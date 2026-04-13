# KIOKU™ Deliberation Guide

Structured multi-agent decision-making with auditable consensus — the feature that makes KIOKU™ unique.

## What Is Deliberation?

Traditional AI agents make decisions alone. KIOKU™ introduces a structured debate process where multiple agents collaborate to reach consensus through defined phases:

```
Position → Debate → Final Position → Consensus
```

Every step is logged, timestamped, and auditable — critical for regulated industries (healthcare, finance, legal).

## How It Works

### Phase 1: Position

Each agent in the room states their initial position on the topic.

### Phase 2: Debate

Agents respond to each other's positions. The number of rounds is configurable (default: 1).

### Phase 3: Final Position

After debate, each agent submits their final position (which may have changed).

### Phase 4: Consensus

KIOKU™ calculates weighted consensus based on agent confidence scores, generating:
- A decision summary
- Confidence score (0.0-1.0)
- Vote breakdown
- Dissenting opinions (if any)

## Basic Deliberation

```python
from kioku import KiokuClient

client = KiokuClient(api_key="kk_your_key")

# 1. Create agents
analyst = client.agents.create("Market Analyst", description="Data-driven insights")
strategist = client.agents.create("Strategist", description="Long-term planning")
risk_mgr = client.agents.create("Risk Manager", description="Risk assessment")

# 2. Create a room with these agents
room = client.rooms.create(
    "Investment Committee",
    description="Quarterly investment review",
    agent_ids=[analyst["id"], strategist["id"], risk_mgr["id"]],
)

# 3. Run deliberation
session = client.deliberation.start(
    room_id=room["id"],
    topic="Should we increase allocation to emerging markets by 15%?",
    debate_rounds=2,
)

# 4. Read results
print(f"Session: {session['id']}")
print(f"Status: {session['status']}")
if "consensus" in session:
    c = session["consensus"]
    print(f"Decision: {c['decision']}")
    print(f"Confidence: {c['confidence']}")
```

## External Agent Participation

External agents (LangChain, CrewAI, AutoGen) can participate in deliberations via scoped tokens:

```python
from kioku import KiokuClient, ExternalAgentClient

# --- Owner side: create token ---
client = KiokuClient(api_key="kk_your_key")

token_data = client.tokens.create(
    agent_id=1,
    name="LangChain Research Agent",
    scopes=["deliberation:participate", "memories:read"],
    expires_in_days=30,
)

agent_token = token_data["token"]  # kat_...

# --- External agent side: participate ---
agent = ExternalAgentClient(token=agent_token)

# Verify connection
info = agent.verify()
print(f"Connected as agent #{info['agentId']}")

# Submit position in active deliberation
agent.callback(
    session_id="dlb_abc123",
    position="Based on my analysis of 500+ data points, emerging markets show strong momentum",
    confidence=0.82,
    reasoning="GDP growth in target regions averages 5.2% YoY, with improving political stability indices...",
)
```

## War Room (Quick Deliberation)

For urgent decisions without creating a room first:

```python
# Send messages to auto-created War Room
client.warroom.message(
    agent_name="Alert Bot",
    content="Production memory usage at 92%. Recommend scaling up.",
    room_name="Ops Emergency",
)

client.warroom.message(
    agent_name="Cost Analyzer",
    content="Scaling up adds $450/mo. Current load is seasonal — recommend waiting 24h.",
    room_name="Ops Emergency",
)
```

## Reviewing Past Deliberations

```python
# List all sessions in a room
sessions = client.deliberation.sessions(room_id=1)
for s in sessions:
    print(f"[{s['id']}] {s.get('topic', 'N/A')} — {s.get('status', 'N/A')}")

# Get full session detail
session = client.deliberation.get(room_id=1, session_id="dlb_abc123")

# Get just the latest consensus
consensus = client.deliberation.consensus(room_id=1)
```

## Memory-Aware Deliberation

Combine memories with deliberation for context-rich decisions:

```python
# Store domain knowledge
client.memories.create(
    "Q1 emerging market returns: +12.3%, outperforming S&P by 4.1%",
    memory_type="semantic",
    importance=0.9,
    namespace="market-data",
)

client.memories.create(
    "Client risk tolerance: moderate-aggressive, max drawdown 15%",
    memory_type="semantic",
    importance=0.95,
    namespace="client-profile",
)

# Agents can access these memories during deliberation
# Their positions will reflect stored knowledge
session = client.deliberation.start(
    room_id=room_id,
    topic="Rebalance portfolio given Q1 performance?",
)
```

## Audit Trail

Every deliberation creates a complete audit trail:

```python
session = client.deliberation.get(room_id=1, session_id="dlb_abc123")

# Each round contains:
# - agent positions
# - confidence scores
# - timestamps
# - reasoning

# This is critical for:
# - FINRA compliance (financial decisions)
# - HIPAA audit logs (healthcare AI)
# - SOX compliance (corporate governance)
# - FDA 21 CFR Part 11 (pharma)
```

## Best Practices

1. **Use 3-5 agents per room** — Too few limits perspective diversity; too many increases latency.

2. **Set 1-2 debate rounds** — More rounds improve consensus quality but increase API costs and latency.

3. **Assign distinct roles** — Give agents different descriptions/roles so they bring unique perspectives.

4. **Use namespaced memories** — Separate domain knowledge from operational data.

5. **Review dissenting opinions** — Minority positions often contain valuable risk signals.

6. **Archive sessions** — Use `deliberation.sessions()` to maintain decision history for compliance.
