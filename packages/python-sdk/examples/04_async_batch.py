"""KIOKU™ Example 4: Async Batch Operations

Demonstrates async client for high-throughput memory ingestion
and parallel searches.
"""

import asyncio
from kioku import KiokuClient


async def main():
    client = KiokuClient(
        api_key="kk_your_key",
        base_url="https://your-instance.up.railway.app",
    )

    # --- Batch create memories ---
    print("=== Batch Memory Ingestion ===\n")

    knowledge_base = [
        ("Client Alex prefers short haircuts, fades on the sides", "semantic", 0.8),
        ("Alex is allergic to ammonia-based products", "semantic", 0.99),
        ("Alex visits every 3 weeks, usually Thursdays", "episodic", 0.7),
        ("For Alex's fade, use clipper guard #2 on sides, #4 on top", "procedural", 0.9),
        ("Alex was unhappy with the last beard trim — too short", "emotional", 0.85),
    ]

    # Create all memories concurrently
    tasks = [
        client.memories.acreate(
            content,
            memory_type=mtype,
            importance=imp,
            agent_name="Nika",
            namespace="clients",
        )
        for content, mtype, imp in knowledge_base
    ]

    results = await asyncio.gather(*tasks)
    created_ids = [r["id"] for r in results]
    print(f"Created {len(results)} memories: {created_ids}")

    # --- Parallel searches ---
    print("\n=== Parallel Searches ===\n")

    queries = [
        "hair cutting preferences",
        "allergies and safety",
        "scheduling patterns",
        "negative feedback",
    ]

    search_tasks = [client.memories.asearch(q) for q in queries]
    search_results = await asyncio.gather(*search_tasks)

    for query, hits in zip(queries, search_results):
        print(f'"{query}" → {len(hits)} results')
        for h in hits[:2]:
            print(f"  [{h.get('similarity', 'N/A')}] {h['content'][:60]}...")

    # --- Parallel: health + usage + stats ---
    print("\n=== System Status (parallel) ===\n")

    async def get_health():
        return await client._http.aget("/health")

    async def get_usage():
        return await client._http.aget("/api/v1/usage")

    async def get_stats():
        return await client._http.aget("/api/v1/stats")

    health, usage, stats = await asyncio.gather(
        get_health(), get_usage(), get_stats()
    )
    print(f"Health: {health['status']}, DB: {health['db']}")
    print(f"Memories: {usage['memories_count']}, Agents: {usage['agents_count']}")
    print(f"Total ops: {stats['totalOps']}, Avg latency: {stats['avgLatency']}ms")

    # --- Cleanup ---
    delete_tasks = [client.memories.adelete(mid) for mid in created_ids]
    await asyncio.gather(*delete_tasks)
    print(f"\nCleaned up {len(created_ids)} test memories.")

    await client.aclose()


if __name__ == "__main__":
    asyncio.run(main())
