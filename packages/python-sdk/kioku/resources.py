"""KIOKU™ SDK resource classes — Agents, Memories, Rooms, Deliberation, etc."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from kioku._http import HttpClient


# ---------------------------------------------------------------------------
# Agents
# ---------------------------------------------------------------------------


class Agents:
    """Manage AI agents."""

    def __init__(self, http: HttpClient):
        self._http = http

    def list(self) -> List[Dict[str, Any]]:
        """List all agents."""
        return self._http.get("/api/v1/agents")

    def create(
        self,
        name: str,
        *,
        description: Optional[str] = None,
        color: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Create a new agent."""
        body: Dict[str, Any] = {"name": name}
        if description is not None:
            body["description"] = description
        if color is not None:
            body["color"] = color
        return self._http.post("/api/v1/agents", json=body)

    def update(
        self,
        agent_id: int,
        *,
        name: Optional[str] = None,
        description: Optional[str] = None,
        color: Optional[str] = None,
        model: Optional[str] = None,
        role: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Update an agent."""
        body: Dict[str, Any] = {}
        if name is not None:
            body["name"] = name
        if description is not None:
            body["description"] = description
        if color is not None:
            body["color"] = color
        if model is not None:
            body["model"] = model
        if role is not None:
            body["role"] = role
        return self._http.patch(f"/api/v1/agents/{agent_id}", json=body)

    def set_status(
        self,
        agent_id: int,
        *,
        enabled: Optional[bool] = None,
        status: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Toggle agent status."""
        body: Dict[str, Any] = {}
        if enabled is not None:
            body["enabled"] = enabled
        if status is not None:
            body["status"] = status
        return self._http.patch(f"/api/v1/agents/{agent_id}/toggle", json=body)

    def delete(self, agent_id: int) -> Dict[str, Any]:
        """Delete an agent."""
        return self._http.delete(f"/api/v1/agents/{agent_id}")

    # --- Async ---

    async def alist(self) -> List[Dict[str, Any]]:
        return await self._http.aget("/api/v1/agents")

    async def acreate(self, name: str, **kwargs: Any) -> Dict[str, Any]:
        body: Dict[str, Any] = {"name": name, **kwargs}
        return await self._http.apost("/api/v1/agents", json=body)

    async def adelete(self, agent_id: int) -> Dict[str, Any]:
        return await self._http.adelete(f"/api/v1/agents/{agent_id}")


# ---------------------------------------------------------------------------
# Memories
# ---------------------------------------------------------------------------


class Memories:
    """Store, search, and manage agent memories."""

    def __init__(self, http: HttpClient):
        self._http = http

    def list(
        self,
        *,
        query: Optional[str] = None,
        namespace: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """List memories. Pass `query` for semantic search."""
        params: Dict[str, Any] = {}
        if query is not None:
            params["q"] = query
        if namespace is not None:
            params["namespace"] = namespace
        return self._http.get("/api/v1/memories", params=params or None)

    def search(
        self,
        query: str,
        *,
        namespace: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """Semantic similarity search over memories."""
        return self.list(query=query, namespace=namespace)

    def create(
        self,
        content: str,
        *,
        agent_id: Optional[int] = None,
        agent_name: Optional[str] = None,
        memory_type: Optional[str] = None,
        importance: Optional[float] = None,
        namespace: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Store a new memory. Auto-generates embedding."""
        body: Dict[str, Any] = {"content": content}
        if agent_id is not None:
            body["agentId"] = agent_id
        if agent_name is not None:
            body["agentName"] = agent_name
        if memory_type is not None:
            body["type"] = memory_type
        if importance is not None:
            body["importance"] = importance
        if namespace is not None:
            body["namespace"] = namespace
        return self._http.post("/api/v1/memories", json=body)

    def delete(self, memory_id: int) -> Dict[str, Any]:
        """Delete a memory."""
        return self._http.delete(f"/api/v1/memories/{memory_id}")

    def purge(
        self,
        scope: str = "all",
        *,
        agent_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Purge memories. scope='all' or scope='agent' with agent_id."""
        body: Dict[str, Any] = {"scope": scope}
        if agent_id is not None:
            body["agent_id"] = agent_id
        return self._http.delete("/api/v1/memories/purge", json=body)

    def export(self) -> Dict[str, Any]:
        """Export all memories (GDPR Art. 20)."""
        return self._http.get("/api/v1/memories/export")

    # --- Links (Synaptic Graph) ---

    def create_link(
        self,
        memory_id: int,
        target_id: int,
        *,
        link_type: Optional[str] = None,
        strength: Optional[float] = None,
    ) -> Dict[str, Any]:
        """Create a synaptic link between memories."""
        body: Dict[str, Any] = {"targetId": target_id}
        if link_type is not None:
            body["linkType"] = link_type
        if strength is not None:
            body["strength"] = strength
        return self._http.post(f"/api/v1/memories/{memory_id}/links", json=body)

    def list_links(self, memory_id: int) -> List[Dict[str, Any]]:
        """List links for a memory."""
        return self._http.get(f"/api/v1/memories/{memory_id}/links")

    def delete_link(self, memory_id: int, link_id: int) -> Dict[str, Any]:
        """Delete a synaptic link."""
        return self._http.delete(f"/api/v1/memories/{memory_id}/links/{link_id}")

    def graph(
        self,
        memory_id: int,
        *,
        depth: Optional[int] = None,
        limit: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        """Traverse the synaptic graph (BFS) from a memory."""
        params: Dict[str, Any] = {}
        if depth is not None:
            params["depth"] = depth
        if limit is not None:
            params["limit"] = limit
        return self._http.get(
            f"/api/v1/memories/{memory_id}/graph", params=params or None
        )

    # --- Maintenance ---

    def consolidate(self) -> Dict[str, Any]:
        """Consolidate similar memories (auto-merge)."""
        return self._http.post("/api/v1/memories/consolidate")

    def gc(self, *, threshold: Optional[float] = None) -> Dict[str, Any]:
        """Garbage-collect decayed memories (forgetting curve)."""
        params: Dict[str, Any] = {}
        if threshold is not None:
            params["threshold"] = threshold
        return self._http.post("/api/v1/memories/gc")

    # --- Async ---

    async def alist(self, **kwargs: Any) -> List[Dict[str, Any]]:
        params: Dict[str, Any] = {}
        if "query" in kwargs and kwargs["query"] is not None:
            params["q"] = kwargs["query"]
        if "namespace" in kwargs and kwargs["namespace"] is not None:
            params["namespace"] = kwargs["namespace"]
        return await self._http.aget("/api/v1/memories", params=params or None)

    async def asearch(self, query: str, **kwargs: Any) -> List[Dict[str, Any]]:
        return await self.alist(query=query, **kwargs)

    async def acreate(self, content: str, **kwargs: Any) -> Dict[str, Any]:
        body: Dict[str, Any] = {"content": content}
        field_map = {
            "agent_id": "agentId",
            "agent_name": "agentName",
            "memory_type": "type",
            "importance": "importance",
            "namespace": "namespace",
        }
        for py_key, api_key in field_map.items():
            if py_key in kwargs and kwargs[py_key] is not None:
                body[api_key] = kwargs[py_key]
        return await self._http.apost("/api/v1/memories", json=body)

    async def adelete(self, memory_id: int) -> Dict[str, Any]:
        return await self._http.adelete(f"/api/v1/memories/{memory_id}")


# ---------------------------------------------------------------------------
# Rooms
# ---------------------------------------------------------------------------


class Rooms:
    """Manage rooms for agent collaboration."""

    def __init__(self, http: HttpClient):
        self._http = http

    def list(self) -> List[Dict[str, Any]]:
        """List all rooms."""
        return self._http.get("/api/v1/rooms")

    def create(
        self,
        name: str,
        *,
        description: Optional[str] = None,
        agent_ids: Optional[List[int]] = None,
    ) -> Dict[str, Any]:
        """Create a room."""
        body: Dict[str, Any] = {"name": name}
        if description is not None:
            body["description"] = description
        if agent_ids is not None:
            body["agentIds"] = agent_ids
        return self._http.post("/api/v1/rooms", json=body)

    def update(
        self,
        room_id: int,
        *,
        name: Optional[str] = None,
        description: Optional[str] = None,
        status: Optional[str] = None,
        agent_ids: Optional[List[int]] = None,
    ) -> Dict[str, Any]:
        """Update a room."""
        body: Dict[str, Any] = {}
        if name is not None:
            body["name"] = name
        if description is not None:
            body["description"] = description
        if status is not None:
            body["status"] = status
        if agent_ids is not None:
            body["agentIds"] = agent_ids
        return self._http.patch(f"/api/v1/rooms/{room_id}", json=body)

    def delete(self, room_id: int) -> Dict[str, Any]:
        """Delete a room."""
        return self._http.delete(f"/api/v1/rooms/{room_id}")

    def messages(self, room_id: int) -> List[Dict[str, Any]]:
        """List messages in a room."""
        return self._http.get(f"/api/v1/rooms/{room_id}/messages")

    def send_message(
        self,
        room_id: int,
        agent_name: str,
        content: str,
        *,
        agent_id: Optional[int] = None,
        agent_color: Optional[str] = None,
        is_decision: Optional[bool] = None,
    ) -> Dict[str, Any]:
        """Send a message to a room."""
        body: Dict[str, Any] = {"agentName": agent_name, "content": content}
        if agent_id is not None:
            body["agentId"] = agent_id
        if agent_color is not None:
            body["agentColor"] = agent_color
        if is_decision is not None:
            body["isDecision"] = is_decision
        return self._http.post(f"/api/v1/rooms/{room_id}/messages", json=body)

    # --- Async ---

    async def alist(self) -> List[Dict[str, Any]]:
        return await self._http.aget("/api/v1/rooms")

    async def acreate(self, name: str, **kwargs: Any) -> Dict[str, Any]:
        body: Dict[str, Any] = {"name": name}
        if "description" in kwargs:
            body["description"] = kwargs["description"]
        if "agent_ids" in kwargs:
            body["agentIds"] = kwargs["agent_ids"]
        return await self._http.apost("/api/v1/rooms", json=body)

    async def amessages(self, room_id: int) -> List[Dict[str, Any]]:
        return await self._http.aget(f"/api/v1/rooms/{room_id}/messages")


# ---------------------------------------------------------------------------
# Deliberation (KIOKU™ USP)
# ---------------------------------------------------------------------------


class Deliberation:
    """Structured multi-agent deliberation with consensus."""

    def __init__(self, http: HttpClient):
        self._http = http

    def start(
        self,
        room_id: int,
        topic: str,
        *,
        model: Optional[str] = None,
        debate_rounds: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Start a structured deliberation session.

        Agents debate in phases: Position → Debate → Final → Consensus.
        Returns the full session with rounds and consensus result.
        """
        body: Dict[str, Any] = {"topic": topic}
        if model is not None:
            body["model"] = model
        if debate_rounds is not None:
            body["debateRounds"] = debate_rounds
        return self._http.post(f"/api/v1/rooms/{room_id}/deliberate", json=body)

    def get(self, room_id: int, session_id: str) -> Dict[str, Any]:
        """Get a specific deliberation session."""
        return self._http.get(
            f"/api/v1/rooms/{room_id}/deliberations/{session_id}"
        )

    def sessions(self, room_id: int) -> List[Dict[str, Any]]:
        """List all deliberation sessions in a room."""
        return self._http.get(f"/api/v1/rooms/{room_id}/deliberations")

    def consensus(self, room_id: int) -> Dict[str, Any]:
        """Get the latest consensus from a room.

        Returns decision, confidence, votes, and dissenting opinions.
        """
        return self._http.get(f"/api/v1/rooms/{room_id}/consensus")

    # --- Async ---

    async def astart(self, room_id: int, topic: str, **kwargs: Any) -> Dict[str, Any]:
        body: Dict[str, Any] = {"topic": topic}
        if "model" in kwargs:
            body["model"] = kwargs["model"]
        if "debate_rounds" in kwargs:
            body["debateRounds"] = kwargs["debate_rounds"]
        return await self._http.apost(
            f"/api/v1/rooms/{room_id}/deliberate", json=body
        )

    async def aget(self, room_id: int, session_id: str) -> Dict[str, Any]:
        return await self._http.aget(
            f"/api/v1/rooms/{room_id}/deliberations/{session_id}"
        )

    async def asessions(self, room_id: int) -> List[Dict[str, Any]]:
        return await self._http.aget(f"/api/v1/rooms/{room_id}/deliberations")

    async def aconsensus(self, room_id: int) -> Dict[str, Any]:
        return await self._http.aget(f"/api/v1/rooms/{room_id}/consensus")


# ---------------------------------------------------------------------------
# War Room (convenience shortcut)
# ---------------------------------------------------------------------------


class WarRoom:
    """Quick access to War Room (auto-creates room)."""

    def __init__(self, http: HttpClient):
        self._http = http

    def message(
        self,
        agent_name: str,
        content: str,
        *,
        agent_color: Optional[str] = None,
        is_decision: Optional[bool] = None,
        room_name: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Send a message to the War Room."""
        body: Dict[str, Any] = {"agentName": agent_name, "content": content}
        if agent_color is not None:
            body["agentColor"] = agent_color
        if is_decision is not None:
            body["isDecision"] = is_decision
        if room_name is not None:
            body["roomName"] = room_name
        return self._http.post("/api/v1/warroom/message", json=body)


# ---------------------------------------------------------------------------
# Webhooks
# ---------------------------------------------------------------------------


class Webhooks:
    """Manage agent webhooks for external integration."""

    def __init__(self, http: HttpClient):
        self._http = http

    def register(self, agent_id: int, url: str) -> Dict[str, Any]:
        """Register a webhook for an agent."""
        return self._http.post(
            f"/api/v1/agents/{agent_id}/webhook", json={"url": url}
        )

    def get(self, agent_id: int) -> Dict[str, Any]:
        """Get webhook for an agent."""
        return self._http.get(f"/api/v1/agents/{agent_id}/webhook")

    def delete(self, agent_id: int) -> Dict[str, Any]:
        """Delete webhook for an agent."""
        return self._http.delete(f"/api/v1/agents/{agent_id}/webhook")

    def list(self) -> List[Dict[str, Any]]:
        """List all webhooks."""
        return self._http.get("/api/v1/webhooks")


# ---------------------------------------------------------------------------
# Agent Tokens
# ---------------------------------------------------------------------------


class Tokens:
    """Manage external agent tokens (kat_* auth)."""

    def __init__(self, http: HttpClient):
        self._http = http

    def create(
        self,
        agent_id: int,
        *,
        name: Optional[str] = None,
        scopes: Optional[List[str]] = None,
        expires_in_days: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Create an agent token."""
        body: Dict[str, Any] = {}
        if name is not None:
            body["name"] = name
        if scopes is not None:
            body["scopes"] = scopes
        if expires_in_days is not None:
            body["expiresInDays"] = expires_in_days
        return self._http.post(f"/api/v1/agents/{agent_id}/token", json=body)

    def list(self, agent_id: int) -> List[Dict[str, Any]]:
        """List tokens for an agent."""
        return self._http.get(f"/api/v1/agents/{agent_id}/tokens")

    def revoke(self, agent_id: int, token_id: int) -> Dict[str, Any]:
        """Revoke a specific token."""
        return self._http.delete(f"/api/v1/agents/{agent_id}/tokens/{token_id}")

    def revoke_all(self, agent_id: int) -> Dict[str, Any]:
        """Revoke all tokens for an agent."""
        return self._http.delete(f"/api/v1/agents/{agent_id}/tokens")


# ---------------------------------------------------------------------------
# Flows
# ---------------------------------------------------------------------------


class Flows:
    """Manage agent flows (pipelines)."""

    def __init__(self, http: HttpClient):
        self._http = http

    def list(self) -> List[Dict[str, Any]]:
        return self._http.get("/api/v1/flows")

    def create(
        self,
        name: str,
        *,
        description: Optional[str] = None,
        agent_ids: Optional[List[int]] = None,
        positions: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        body: Dict[str, Any] = {"name": name}
        if description is not None:
            body["description"] = description
        if agent_ids is not None:
            body["agentIds"] = agent_ids
        if positions is not None:
            body["positions"] = positions
        return self._http.post("/api/v1/flows", json=body)

    def update(self, flow_id: int, **kwargs: Any) -> Dict[str, Any]:
        body: Dict[str, Any] = {}
        field_map = {
            "name": "name",
            "description": "description",
            "agent_ids": "agentIds",
            "positions": "positions",
            "agent_roles": "agentRoles",
        }
        for py_key, api_key in field_map.items():
            if py_key in kwargs and kwargs[py_key] is not None:
                body[api_key] = kwargs[py_key]
        return self._http.patch(f"/api/v1/flows/{flow_id}", json=body)

    def delete(self, flow_id: int) -> Dict[str, Any]:
        return self._http.delete(f"/api/v1/flows/{flow_id}")


# ---------------------------------------------------------------------------
# Account
# ---------------------------------------------------------------------------


class Account:
    """Account management (GDPR)."""

    def __init__(self, http: HttpClient):
        self._http = http

    def export_data(self) -> Dict[str, Any]:
        """Full GDPR data export (Art. 20)."""
        return self._http.get("/api/v1/account/export")

    def delete(self) -> Dict[str, Any]:
        """Delete account and all data (GDPR Art. 17). IRREVERSIBLE."""
        return self._http.delete("/api/v1/account")


# ---------------------------------------------------------------------------
# Billing
# ---------------------------------------------------------------------------


class Billing:
    """Billing and subscription management."""

    def __init__(self, http: HttpClient):
        self._http = http

    def checkout(
        self,
        plan: str,
        *,
        billing_cycle: Optional[str] = None,
        success_url: Optional[str] = None,
        cancel_url: Optional[str] = None,
    ) -> Dict[str, Any]:
        body: Dict[str, Any] = {"plan": plan}
        if billing_cycle is not None:
            body["billing_cycle"] = billing_cycle
        if success_url is not None:
            body["success_url"] = success_url
        if cancel_url is not None:
            body["cancel_url"] = cancel_url
        return self._http.post("/api/v1/billing/checkout", json=body)

    def portal(self, *, return_url: Optional[str] = None) -> Dict[str, Any]:
        body: Dict[str, Any] = {}
        if return_url is not None:
            body["return_url"] = return_url
        return self._http.post("/api/v1/billing/portal", json=body)

    def status(self) -> Dict[str, Any]:
        return self._http.get("/api/v1/billing/status")
