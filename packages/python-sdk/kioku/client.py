"""KIOKU™ main client."""

from __future__ import annotations

from typing import Any, Dict, Optional

from kioku._http import DEFAULT_BASE_URL, HttpClient
from kioku.resources import (
    Account,
    Agents,
    Billing,
    Deliberation,
    Flows,
    Memories,
    Rooms,
    Tokens,
    WarRoom,
    Webhooks,
)


class KiokuClient:
    """KIOKU™ Python SDK client.

    Example::

        from kioku import KiokuClient

        client = KiokuClient(api_key="kk_your_key")

        # Store a memory
        memory = client.memories.create("User prefers dark mode")

        # Semantic search
        results = client.memories.search("user preferences")

        # Start deliberation
        session = client.deliberation.start(
            room_id=1,
            topic="Should we migrate to a new framework?",
        )
        print(session["consensus"])

    Args:
        api_key: Your KIOKU API key (kk_...).
        base_url: API base URL. Defaults to https://usekioku.com.
        timeout: Request timeout in seconds. Defaults to 30.
    """

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = 30.0,
    ):
        self._http = HttpClient(base_url=base_url, api_key=api_key, timeout=timeout)

        # Resource namespaces
        self.agents = Agents(self._http)
        self.memories = Memories(self._http)
        self.rooms = Rooms(self._http)
        self.deliberation = Deliberation(self._http)
        self.warroom = WarRoom(self._http)
        self.webhooks = Webhooks(self._http)
        self.tokens = Tokens(self._http)
        self.flows = Flows(self._http)
        self.account = Account(self._http)
        self.billing = Billing(self._http)

    # --- Top-level convenience ---

    def health(self) -> Dict[str, Any]:
        """Check KIOKU server health."""
        return self._http.get("/health")

    def stats(self) -> Dict[str, Any]:
        """Get usage stats."""
        return self._http.get("/api/v1/stats")

    def usage(self) -> Dict[str, Any]:
        """Get detailed usage and limits."""
        return self._http.get("/api/v1/usage")

    def me(self) -> Dict[str, Any]:
        """Get current user info."""
        return self._http.get("/api/v1/auth/me")

    def logs(self) -> Any:
        """Get activity logs."""
        return self._http.get("/api/v1/logs")

    # --- Lifecycle ---

    def close(self) -> None:
        """Close the HTTP client."""
        self._http.close()

    async def aclose(self) -> None:
        """Close the async HTTP client."""
        await self._http.aclose()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        await self.aclose()

    def __repr__(self) -> str:
        return f"KiokuClient(base_url={self._http._base_url!r})"
