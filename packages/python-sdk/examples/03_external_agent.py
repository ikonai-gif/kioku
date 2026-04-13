"""KIOKU™ Example 3: External Agent Integration

Demonstrates how an external agent (LangChain, CrewAI, etc.)
connects to KIOKU™ via scoped tokens and participates in deliberation.
"""

from kioku import KiokuClient, ExternalAgentClient

# ============================================================
# STEP 1: Owner creates a scoped token for the external agent
# ============================================================

client = KiokuClient(
    api_key="kk_your_key",
    base_url="https://your-instance.up.railway.app",
)

# Create token with specific scopes
token_data = client.tokens.create(
    agent_id=1,  # The agent this token belongs to
    name="LangChain Research Bot",
    scopes=["deliberation:participate", "memories:read"],
    expires_in_days=30,
)

agent_token = token_data["token"]  # kat_...
print(f"Token created: {agent_token[:12]}...")
print(f"Scopes: {token_data.get('scopes', [])}")

# ============================================================
# STEP 2: External agent connects and verifies
# ============================================================

agent = ExternalAgentClient(
    token=agent_token,
    base_url="https://your-instance.up.railway.app",
)

info = agent.verify()
print(f"\nVerified as agent #{info['agentId']}")
print(f"Scopes: {info.get('scopes', [])}")

# ============================================================
# STEP 3: External agent participates in deliberation
# ============================================================

# Owner starts a deliberation session
session = client.deliberation.start(
    room_id=2,  # Room the agent is assigned to
    topic="Should we adopt RAG or fine-tuning for our knowledge base?",
)
session_id = session.get("id", "dlb_example")
print(f"\nDeliberation started: {session_id}")

# External agent submits their position
result = agent.callback(
    session_id=session_id,
    position="RAG is the better approach for our use case",
    confidence=0.88,
    reasoning=(
        "RAG provides real-time knowledge updates without retraining costs. "
        "Given our rapidly changing data (updated weekly), fine-tuning would "
        "require continuous retraining at ~$500/run. RAG adds only ~200ms "
        "latency per query, acceptable for our SLA."
    ),
)
print(f"Position submitted: {result}")

# ============================================================
# STEP 4: Token management
# ============================================================

# List all tokens for an agent
tokens = client.tokens.list(agent_id=1)
print(f"\nActive tokens for agent #1: {len(tokens)}")

# Revoke when no longer needed
# client.tokens.revoke(agent_id=1, token_id=token_data["id"])

client.close()
agent.close()
