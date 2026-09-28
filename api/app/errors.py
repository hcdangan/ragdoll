"""Typed errors that map onto the bridge's error taxonomy.

The `code` values are the contract: `web/src/lib/pipeline/engine-client.ts`
switches on them to decide whether the browser sees "check your API key",
"self-host to use local providers", or a generic failure.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from .schemas import ErrorDetail, ErrorResponse

logger = logging.getLogger("ragdoll.errors")


class RagdollError(Exception):
    """Base class for every engine failure surfaced to the bridge."""

    code: str = "engine_error"
    status_code: int = status.HTTP_500_INTERNAL_SERVER_ERROR
    retryable: bool = False

    def __init__(
        self,
        message: str,
        *,
        fields: dict[str, str] | None = None,
        cause: BaseException | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.fields = fields
        self.cause = cause

    def to_response(self) -> JSONResponse:
        """Renders the FastAPI error envelope."""

        detail = ErrorDetail(code=self.code, message=self.message, fields=self.fields)
        return JSONResponse(
            status_code=self.status_code,
            content=ErrorResponse(detail=detail).model_dump(by_alias=True),
        )


class ValidationError(RagdollError):
    """Caller supplied something the engine cannot accept."""

    code = "validation"
    # 422 is the semantic status; the numeric literal avoids the deprecated
    # `HTTP_422_UNPROCESSABLE_ENTITY` alias that newer Starlette warns about.
    status_code = 422


class UnauthorizedError(RagdollError):
    """The caller did not present the bridge's shared secret."""

    code = "unauthorized"
    status_code = status.HTTP_401_UNAUTHORIZED


class ProviderAuthError(RagdollError):
    """The provider rejected the supplied credentials."""

    code = "invalid_api_key"
    status_code = status.HTTP_401_UNAUTHORIZED


class ProviderUnreachableError(RagdollError):
    """DNS, TLS, connection or timeout failure against the provider."""

    code = "provider_unreachable"
    status_code = status.HTTP_502_BAD_GATEWAY
    retryable = True


class ProviderRequestError(RagdollError):
    """The provider answered with an unexpected status."""

    code = "provider_error"
    status_code = status.HTTP_502_BAD_GATEWAY
    retryable = True


class LoopbackBlockedError(RagdollError):
    """A hosted deployment was asked to reach the caller's own machine."""

    code = "provider_unreachable"
    status_code = status.HTTP_400_BAD_REQUEST


class PipelineMissingError(RagdollError):
    """No index exists for the session, so the bridge must rebuild it."""

    code = "pipeline_missing"
    status_code = status.HTTP_410_GONE


class PdfRejectedError(RagdollError):
    """A PDF failed sandbox validation."""

    code = "pdf_invalid"
    status_code = 422

    def __init__(self, message: str, *, code: str | None = None, **kwargs: Any) -> None:
        super().__init__(message, **kwargs)
        if code is not None:
            self.code = code


class GuardrailError(RagdollError):
    """Input tripped a safety filter."""

    code = "guardrail_jailbreak"
    status_code = status.HTTP_400_BAD_REQUEST

    def __init__(self, message: str, *, code: str = "guardrail_jailbreak", **kwargs: Any) -> None:
        super().__init__(message, **kwargs)
        self.code = code


class RateLimitError(RagdollError):
    """Too many concurrent or recent requests for this session."""

    code = "rate_limited"
    status_code = status.HTTP_429_TOO_MANY_REQUESTS
    retryable = True


async def ragdoll_error_handler(_: Request, exc: RagdollError) -> JSONResponse:
    """FastAPI exception handler for every RagdollError subclass."""

    return exc.to_response()


async def validation_error_handler(request: Request, exc: Exception) -> JSONResponse:
    """Normalises request-validation failures into the standard envelope.

    FastAPI answers a schema violation with a list of pydantic issues. The bridge
    parses one shape, so the list is flattened into `fields` keyed by JSON path,
    which also lets the creation form highlight the offending input.
    """

    issues = exc.errors() if isinstance(exc, RequestValidationError) else []
    fields: dict[str, str] = {}
    for issue in issues:
        location = issue.get("loc", ())
        path = ".".join(str(part) for part in location if part not in {"body", "query", "path"})
        fields[path or "form"] = str(issue.get("msg", "Invalid value"))

    # Logged as well as returned: a 422 from the bridge is almost always schema
    # drift between the two runtimes, and the path is what makes it fixable. The
    # keys of the offending body are logged (never the values) so a forbidden
    # field is identifiable without ever writing an API key to the log.
    keys = "unknown"
    if request.method in {"POST", "PUT", "PATCH"}:
        try:
            body = await request.json()
            keys = ",".join(sorted(body.keys())) if isinstance(body, dict) else type(body).__name__
        except Exception:
            keys = "unparseable"
    logger.warning("request validation failed: %s (body keys: %s)", fields, keys)

    detail = ErrorDetail(
        code="validation",
        message="The request did not match the engine schema.",
        fields=fields or None,
    )
    return JSONResponse(
        status_code=422,
        content=ErrorResponse(detail=detail).model_dump(by_alias=True),
    )


async def unexpected_error_handler(_: Request, exc: Exception) -> JSONResponse:
    """Last-resort handler: never leak a stack trace to the bridge."""

    error = RagdollError("The RAG engine failed to handle the request.", cause=exc)
    return error.to_response()
