"""KIOKU™ SDK exceptions."""

from __future__ import annotations
from typing import Any, Optional


class KiokuError(Exception):
    """Base exception for all KIOKU SDK errors."""

    def __init__(
        self,
        message: str,
        status_code: Optional[int] = None,
        response_body: Optional[Any] = None,
    ):
        super().__init__(message)
        self.status_code = status_code
        self.response_body = response_body


class AuthenticationError(KiokuError):
    """Raised when authentication fails (401)."""


class NotFoundError(KiokuError):
    """Raised when a resource is not found (404)."""


class ValidationError(KiokuError):
    """Raised when request validation fails (400)."""


class RateLimitError(KiokuError):
    """Raised when rate limit is exceeded (429)."""

    def __init__(
        self,
        message: str,
        retry_after: Optional[int] = None,
        **kwargs: Any,
    ):
        super().__init__(message, **kwargs)
        self.retry_after = retry_after


class QuotaExceededError(KiokuError):
    """Raised when resource quota is exceeded (429 with quota context)."""


class ConflictError(KiokuError):
    """Raised when there is a conflict (409)."""


class ServerError(KiokuError):
    """Raised when the server returns 5xx."""
