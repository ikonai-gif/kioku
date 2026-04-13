"""Live tests against KIOKU™ production API."""

import sys
sys.path.insert(0, "/home/user/workspace/kioku-python-sdk")

from kioku import KiokuClient, ExternalAgentClient
from kioku.exceptions import NotFoundError, AuthenticationError

BASE_URL = "https://kioku-production.up.railway.app"
MASTER_KEY = "kioku_master_ikonbai_2026_secret"


def test_health():
    """Test: health endpoint (no auth)."""
    client = KiokuClient(api_key=MASTER_KEY, base_url=BASE_URL)
    health = client.health()
    assert health["status"] == "ok", f"Expected ok, got {health['status']}"
    assert health["db"] == "connected"
    print(f"  ✓ Health: {health['status']}, DB: {health['db']}, latency: {health['db_latency_ms']}ms")
    client.close()


def test_auth_me():
    """Test: get current user info."""
    client = KiokuClient(api_key=MASTER_KEY, base_url=BASE_URL)
    user = client.me()
    assert "email" in user, f"Expected email in user, got {user.keys()}"
    assert "plan" in user
    print(f"  ✓ Auth me: {user['email']}, plan: {user['plan']}")
    client.close()


def test_usage():
    """Test: get usage stats."""
    client = KiokuClient(api_key=MASTER_KEY, base_url=BASE_URL)
    usage = client.usage()
    assert "memories_count" in usage
    assert "plan" in usage
    print(f"  ✓ Usage: {usage['memories_count']} memories, {usage['agents_count']} agents, plan: {usage['plan']}")
    client.close()


def test_agents_list():
    """Test: list agents."""
    client = KiokuClient(api_key=MASTER_KEY, base_url=BASE_URL)
    agents = client.agents.list()
    assert isinstance(agents, list)
    print(f"  ✓ Agents: {len(agents)} total")
    for a in agents[:3]:
        print(f"    - {a['name']} ({a['status']})")
    client.close()


def test_memories_list():
    """Test: list memories."""
    client = KiokuClient(api_key=MASTER_KEY, base_url=BASE_URL)
    memories = client.memories.list()
    assert isinstance(memories, list)
    print(f"  ✓ Memories: {len(memories)} total")
    for m in memories[:3]:
        print(f"    - [{m['type']}] {m['content'][:60]}...")
    client.close()


def test_memories_search():
    """Test: semantic search."""
    client = KiokuClient(api_key=MASTER_KEY, base_url=BASE_URL)
    results = client.memories.search("preferences")
    assert isinstance(results, list)
    print(f"  ✓ Search 'preferences': {len(results)} results")
    for r in results[:3]:
        sim = r.get("similarity", "N/A")
        print(f"    - [{sim}] {r['content'][:60]}...")
    client.close()


def test_memories_create_and_delete():
    """Test: create memory, verify, then delete."""
    client = KiokuClient(api_key=MASTER_KEY, base_url=BASE_URL)

    # Create
    memory = client.memories.create(
        "SDK test memory — Python SDK v0.1.0 integration test",
        memory_type="semantic",
        importance=0.3,
        namespace="sdk-test",
    )
    assert "id" in memory, f"Expected id in memory, got {memory}"
    mem_id = memory["id"]
    print(f"  ✓ Created memory #{mem_id}")

    # Delete
    result = client.memories.delete(mem_id)
    assert result.get("ok") is True
    print(f"  ✓ Deleted memory #{mem_id}")
    client.close()


def test_rooms_list():
    """Test: list rooms."""
    client = KiokuClient(api_key=MASTER_KEY, base_url=BASE_URL)
    rooms = client.rooms.list()
    assert isinstance(rooms, list)
    print(f"  ✓ Rooms: {len(rooms)} total")
    for r in rooms[:3]:
        print(f"    - {r['name']} ({r['status']})")
    client.close()


def test_deliberation_sessions():
    """Test: list deliberation sessions for a room."""
    client = KiokuClient(api_key=MASTER_KEY, base_url=BASE_URL)
    rooms = client.rooms.list()
    if not rooms:
        print("  ⚠ No rooms, skipping deliberation test")
        client.close()
        return

    room_id = rooms[0]["id"]
    sessions = client.deliberation.sessions(room_id)
    assert isinstance(sessions, list)
    print(f"  ✓ Deliberation sessions in room #{room_id}: {len(sessions)}")
    client.close()


def test_flows_list():
    """Test: list flows."""
    client = KiokuClient(api_key=MASTER_KEY, base_url=BASE_URL)
    flows = client.flows.list()
    assert isinstance(flows, list)
    print(f"  ✓ Flows: {len(flows)} total")
    client.close()


def test_logs():
    """Test: get activity logs."""
    client = KiokuClient(api_key=MASTER_KEY, base_url=BASE_URL)
    logs = client.logs()
    assert isinstance(logs, list)
    print(f"  ✓ Logs: {len(logs)} entries")
    client.close()


def test_stats():
    """Test: get stats."""
    client = KiokuClient(api_key=MASTER_KEY, base_url=BASE_URL)
    stats = client.stats()
    assert "totalOps" in stats or "activeAgents" in stats
    print(f"  ✓ Stats: {stats}")
    client.close()


def test_wrong_auth():
    """Test: wrong API key returns AuthenticationError."""
    client = KiokuClient(api_key="kk_wrong_key_12345", base_url=BASE_URL)
    try:
        client.me()
        print("  ✗ Should have raised AuthenticationError")
    except AuthenticationError as e:
        print(f"  ✓ Auth error correctly raised: {e}")
    except Exception as e:
        print(f"  ✗ Wrong exception type: {type(e).__name__}: {e}")
    client.close()


def test_context_manager():
    """Test: context manager works."""
    with KiokuClient(api_key=MASTER_KEY, base_url=BASE_URL) as client:
        health = client.health()
        assert health["status"] == "ok"
    print("  ✓ Context manager works")


# --- Run all tests ---

if __name__ == "__main__":
    tests = [
        ("Health check", test_health),
        ("Auth (me)", test_auth_me),
        ("Usage", test_usage),
        ("Agents list", test_agents_list),
        ("Memories list", test_memories_list),
        ("Memories search", test_memories_search),
        ("Memory create & delete", test_memories_create_and_delete),
        ("Rooms list", test_rooms_list),
        ("Deliberation sessions", test_deliberation_sessions),
        ("Flows list", test_flows_list),
        ("Logs", test_logs),
        ("Stats", test_stats),
        ("Wrong auth", test_wrong_auth),
        ("Context manager", test_context_manager),
    ]

    passed = 0
    failed = 0

    print("=" * 60)
    print("KIOKU™ Python SDK — Live Production Tests")
    print("=" * 60)

    for name, func in tests:
        print(f"\n[{name}]")
        try:
            func()
            passed += 1
        except Exception as e:
            print(f"  ✗ FAILED: {type(e).__name__}: {e}")
            failed += 1

    print(f"\n{'=' * 60}")
    print(f"Results: {passed} passed, {failed} failed, {passed + failed} total")
    print("=" * 60)
