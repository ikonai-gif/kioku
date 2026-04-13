"""HTTP transport layer for KIOKU™ SDK."""

from __future__ import annotations

from typing import Any, Dict, Optional

import httpx

from kioku.exceptions import (
    AuthenticationError,
    ConflictError,
    KiokuError,
    NotFoundError,
    RateLimitError,
    ServerError,
    ValidationError,
)

DEFAULT_BASE_URL = "https://usekioku.com"
DEFAULT_TIMEOUT = 30.0
SDK_USER_AGENT = "kioku-python/0.1.0"


class HttpClient:
    """Low-level HTTP client with error handling."""

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        api_key: Optional[str] = None,
        agent_token: Optional[str] = None,
        timeout: float = DEFAULT_TIMEOUT,
    ):
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._agent_token = agent_token

        headers: Dict[str, str] = {
            "User-Agent": SDK_USER_AGENT,
            "Accept": "application/json",
        }
        if api_key:
            headers["x-api-key"] = api_key
        if agent_token:
            headers["x-agent-token"] = agent_token

        self._client = httpx.Client(
            base_url=self._base_url,
            headers=headers,
            timeout=timeout,
        )
        self._async_client: Optional[httpx.AsyncClient] = None

    # --- Sync ---

    def get(self, path: str, params: Optional[Dict[str, Any]] = None) -> Any:
        return self._handle(self._client.get(path, params=params))

    def post(self, path: str, json: Optional[Any] = None) -> Any:
        return self._handle(self._client.post(path, json=json))

    def patch(self, path: str, json: Optional[Any] = None) -> Any:
        return self._handle(self._client.patch(path, json=json))

    def delete(self, path: str, json: Optional[Any] = None) -> Any:
        if json is not None:
            return self._handle(self._client.request("DELETE", path, json=json))
        return self._handle(self._client.delete(path))

    # --- Async ---

    def _ensure_async(self) -> httpx.AsyncClient:
        if self._async_client is None:
            self._async_client = httpx.AsyncClient(
                base_url=self._base_url,
                headers=dict(self._client.headers),
                timeout=self._client.timeout,
            )
        return self._async_client

    async def aget(self, path: str, params: Optional[Dict[str, Any]] = None) -> Any:
        client = self._ensure_async()
        return self._handle(await client.get(path, params=params))

    async def apost(self, path: str, json: Optional[Any] = None) -> Any:
        client = self._ensure_async()
        return self._handle(await client.post(path, json=json))

    async def apatch(self, path: str, json: Optional[Any] = None) -> Any:
        client = self._ensure_async()
        return self._handle(await client.patch(path, json=json))

    async def adelete(self, path: str, json: Optional[Any] = None) -> Any:
        client = self._ensure_async()
        if json is not None:
            return self._handle(await client.request("DELETE", path, json=json))
        return self._handle(await client.delete(path))

    # --- Response handling ---

    @staticmethod
    def _handle(response: httpx.Response) -> Any:
        status = response.status_code

        if 200 <= status < 300:
            if response.headers.get("content-type", "").startswith("application/json"):
                return response.json()
            return response.text

        # Parse error body
        try:
            body = response.json()
        except Exception:
            body = {"error": response.text}

        message = body.get("error", body.get("message", f"HTTP {status}"))

        if status == 400:
            raise ValidationError(message, status_code=status, response_body=body)
        if status == 401:
            raise AuthenticationError(message, status_code=status, response_body=body)
        if status == 404:
            raise NotFoundError(message, status_code=status, response_body=body)
        if status == 409:
            raise ConflictError(message, status_code=status, response_body=body)
        if status == 429:
            retry_after = response.headers.get("retry-after")
            raise RateLimitError(
                message,
                status_code=status,
                response_body=body,
                retry_after=int(retry_after) if retry_after else None,
            )
        if status >= 500:
            raise ServerError(message, status_code=status, response_body=body)

        raise KiokuError(message, status_code=status, response_body=body)

    def close(self) -> None:
        self._client.close()

    async def aclose(self) -> None:
        if self._async_client:
            await self._async_client.aclose()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        await self.aclose()
