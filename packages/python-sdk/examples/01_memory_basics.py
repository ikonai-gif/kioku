"""KIOKU™ Example 1: Memory Basics

Store, search, link, and manage agent memories.
"""

from kioku import KiokuClient

# --- Setup ---
client = KiokuClient(
    api_key="kk_your_key",
    base_url="https://your-instance.up.railway.app",  # or https://usekioku.com
)

# --- Store memories ---
m1 = client.memories.create(
    "Client Maria prefers warm blonde tones and morning appointments",
    agent_name="Nika",
    memory_type="semantic",
    importance=0.9,
    namespace="salon-clients",
)
print(f"Created memory #{m1['id']}")

m2 = client.memories.create(
    "Maria was delighted with her last color treatment on March 15",
    agent_name="Nika",
    memory_type="emotional",
    importance=0.7,
    namespace="salon-clients",
)
print(f"Created memory #{m2['id']}")

m3 = client.memories.create(
    "Always mix L'Oreal Majirel 9.03 + 9.13 for Maria's base color",
    agent_name="Nika",
    memory_type="procedural",
    importance=0.95,
    namespace="salon-clients",
)
print(f"Created memory #{m3['id']}")

# --- Search ---
print("\n--- Searching: 'blonde hair color' ---")
results = client.memories.search("blonde hair color")
for r in results:
    print(f"  [{r.get('similarity', 'N/A'):.3f}] {r['content'][:80]}")

# --- Synaptic Links ---
print("\n--- Creating synaptic links ---")
client.memories.create_link(m1["id"], m2["id"], link_type="related", strength=0.8)
client.memories.create_link(m1["id"], m3["id"], link_type="supports", strength=0.9)
print(f"Linked #{m1['id']} → #{m2['id']} (related)")
print(f"Linked #{m1['id']} → #{m3['id']} (supports)")

# --- Graph Traversal ---
print("\n--- Graph from memory #{} ---".format(m1["id"]))
graph = client.memories.graph(m1["id"], depth=2)
for node in graph:
    print(f"  → #{node['id']}: {node['content'][:60]}...")

# --- Cleanup ---
client.memories.delete(m1["id"])
client.memories.delete(m2["id"])
client.memories.delete(m3["id"])
print("\nCleaned up test memories.")
client.close()
