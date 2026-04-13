"""KIOKU™ External Agent Client — lightweight client for agent-to-agent auth."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from kioku._http import DEFAULT_BASE_URL, HttpClient


class ExternalAgentClient:
    """Lightweight client for external agents using kat_* tokens.

    External agents use scoped tokens (kat_...) to participate in
    deliberation sessions, poll for pending turns, and verify their identity.

    Example::

        from kioku import ExternalAgentClient

        agent = ExternalAgentClient(token="kat_your_token")

        # Verify token
        info = agent.verify()
        print(info["agentId"], info["scopes"])

        # Poll for pending turns
        turns = agent.get_pending_turns()
        if turns:
            agent.respond_to_turn(
                turns[0]["id"],
                position="I recommend Option A",
                confidence=0.85,
            )

        # Or use direct callback
        agent.callback(
            session_id="dlb_abc123",
            position="I recommend Option A because...",
            confidence=0.85,
        )

    Args:
        token: Agent token (kat_...).
        base_url: API base URL. Defaults to https://usekioku.com.
        timeout: Request timeout in seconds.
    """

    def __init__(
        self,
        token: str,
        *,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = 30.0,
    ):
        self._http = HttpClient(
            base_url=base_url, agent_token=token, timeout=timeout
        )

    def verify(self) -> Dict[str, Any]:
        """Verify the agent token and get agent info.

        Returns:
            Dict with agentId, userId, and scopes.
        """
        return self._http.get("/api/v1/agent-auth/verify")

    def callback(
        self,
        session_id: str,
        position: str,
        *,
        confidence: Optional[float] = None,
        reasoning: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Submit a deliberation position.

        Args:
            session_id: The deliberation session ID (dlb_...).
            position: The agent's position/answer (1-5000 chars).
            confidence: Confidence level 0.0-1.0.
            reasoning: Detailed reasoning (up to 10000 chars).
        """
        body: Dict[str, Any] = {
            "sessionId": session_id,
            "position": position,
        }
        if confidence is not None:
            body["confidence"] = confidence
        if reasoning is not None:
            body["reasoning"] = reasoning
        return self._http.post("/api/v1/agent-callback", json=body)

    def get_pending_turns(self) -> List[Dict[str, Any]]:
        """Get pending deliberation turns for this agent."""
        return self._http.get("/api/v1/agent/pending-turns")

    def get_turn(self, turn_id: int) -> Dict[str, Any]:
        """Get a specific turn by ID."""
        return self._http.get(f"/api/v1/agent/turns/{turn_id}")

    def respond_to_turn(
        self,
        turn_id: int,
        *,
        position: str,
        confidence: Optional[float] = None,
        reasoning: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Respond to a pending deliberation turn.

        Args:
            turn_id: The turn ID.
            position: The agent's position.
            confidence: Confidence 0.0-1.0 (defaults to 0.5).
            reasoning: Reasoning text.
        """
        body: Dict[str, Any] = {"position": position}
        if confidence is not None:
            body["confidence"] = confidence
        if reasoning is not None:
            body["reasoning"] = reasoning
        return self._http.post(f"/api/v1/agent/turns/{turn_id}/respond", json=body)

    # --- Async ---

    async def averify(self) -> Dict[str, Any]:
        return await self._http.aget("/api/v1/agent-auth/verify")

    async def acallback(
        self, session_id: str, position: str, **kwargs: Any
    ) -> Dict[str, Any]:
        body: Dict[str, Any] = {"sessionId": session_id, "position": position}
        if "confidence" in kwargs:
            body["confidence"] = kwargs["confidence"]
        if "reasoning" in kwargs:
            body["reasoning"] = kwargs["reasoning"]
        return await self._http.apost("/api/v1/agent-callback", json=body)

    async def aget_pending_turns(self) -> List[Dict[str, Any]]:
        return await self._http.aget("/api/v1/agent/pending-turns")

    async def aget_turn(self, turn_id: int) -> Dict[str, Any]:
        return await self._http.aget(f"/api/v1/agent/turns/{turn_id}")

    async def arespond_to_turn(
        self, turn_id: int, *, position: str, **kwargs: Any
    ) -> Dict[str, Any]:
        body: Dict[str, Any] = {"position": position}
        if "confidence" in kwargs:
            body["confidence"] = kwargs["confidence"]
        if "reasoning" in kwargs:
            body["reasoning"] = kwargs["reasoning"]
        return await self._http.apost(
            f"/api/v1/agent/turns/{turn_id}/respond", json=body
        )

    def close(self) -> None:
        self._http.close()

    async def aclose(self) -> None:
        await self._http.aclose()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        await self.aclose()
