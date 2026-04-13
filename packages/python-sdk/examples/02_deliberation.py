"""KIOKU™ Example 2: Multi-Agent Deliberation

Create agents, set up a room, and run a structured deliberation
with auditable consensus.
"""

from kioku import KiokuClient

client = KiokuClient(
    api_key="kk_your_key",
    base_url="https://your-instance.up.railway.app",
)

# --- Create agents with distinct roles ---
agents = []
for name, desc in [
    ("Analyst", "Data-driven market analysis"),
    ("Strategist", "Long-term business strategy"),
    ("Risk Assessor", "Risk identification and mitigation"),
]:
    agent = client.agents.create(name, description=desc)
    agents.append(agent)
    print(f"Created agent: {agent['name']} (#{agent['id']})")

agent_ids = [a["id"] for a in agents]

# --- Create room ---
room = client.rooms.create(
    "Product Launch Review",
    description="Should we launch the new feature in Q2?",
    agent_ids=agent_ids,
)
print(f"\nRoom created: {room['name']} (#{room['id']})")

# --- Run deliberation ---
print("\nStarting deliberation...")
session = client.deliberation.start(
    room_id=room["id"],
    topic="Should we launch the premium tier in Q2 or wait for Q3?",
    debate_rounds=2,
)

print(f"Session: {session.get('id', 'N/A')}")
print(f"Status: {session.get('status', 'N/A')}")

# --- Read consensus ---
if "consensus" in session:
    c = session["consensus"]
    print(f"\n=== CONSENSUS ===")
    print(f"Decision: {c.get('decision', 'N/A')}")
    print(f"Confidence: {c.get('confidence', 'N/A')}")
    if "votes" in c:
        print(f"Votes: {len(c['votes'])}")

# --- Review all sessions ---
print(f"\n--- All sessions in room #{room['id']} ---")
sessions = client.deliberation.sessions(room["id"])
for s in sessions:
    print(f"  [{s.get('id', '?')}] {s.get('topic', 'N/A')[:50]} — {s.get('status', '?')}")

# --- Cleanup ---
for a in agents:
    client.agents.delete(a["id"])
client.rooms.delete(room["id"])
print("\nCleaned up agents and room.")
client.close()
