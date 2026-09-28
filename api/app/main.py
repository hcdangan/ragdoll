"""Ragdoll RAG engine entrypoint.

Vercel auto-detects a module-level `app` in `api/index.py`, and the same object
serves local development through `uvicorn app.main:app --app-dir api`.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .errors import (
    RagdollError,
    ragdoll_error_handler,
    unexpected_error_handler,
    validation_error_handler,
)
from .routes import router

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("ragdoll")

OPENAPI_TAGS = [
    {"name": "ops", "description": "Health and configuration."},
    {"name": "pipeline", "description": "Connection testing and index building."},
    {"name": "chat", "description": "Grounded answering and citations."},
    {"name": "evaluate", "description": "Ragas-style evaluation."},
]


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    """Validates configuration once, then logs it.

    The hosted-without-a-token case is fatal rather than a warning: `vercel.json`
    publishes `/engine/*` to the internet, so an unset token would leave PDF
    ingest, chat and evaluation open to anyone who guesses the path. Failing at
    startup turns a silent security hole into a deployment that will not boot.
    """

    settings = get_settings()
    if settings.hosted and not settings.api_token:
        raise RuntimeError(
            "RAGDOLL_API_TOKEN must be set on a hosted deployment: the engine is "
            "reachable from the internet and every route depends on that token."
        )

    logger.info(
        "ragdoll engine ready version=%s hosted=%s guardrails=%s groundedness>=%.2f token=%s",
        settings.version,
        settings.hosted,
        settings.enable_guardrails,
        settings.groundedness_threshold,
        "set" if settings.api_token else "unset (loopback only)",
    )
    yield


def create_app() -> FastAPI:
    """Builds the FastAPI application."""

    settings = get_settings()
    app = FastAPI(
        title=settings.app_name,
        version=settings.version,
        description=(
            "Retrieval engine for RAGdoll: PDF ingest, chunking, embedding, "
            "retrieval, grounded generation and Ragas-style evaluation."
        ),
        openapi_tags=OPENAPI_TAGS,
        lifespan=lifespan,
        docs_url="/docs",
        redoc_url=None,
    )

    app.add_exception_handler(RagdollError, ragdoll_error_handler)  # type: ignore[arg-type]
    # FastAPI's default request-validation error is a list of pydantic issues,
    # which does not match the `{detail: {code, message}}` envelope the bridge
    # parses. Normalising it here keeps every non-2xx response one shape.
    app.add_exception_handler(RequestValidationError, validation_error_handler)
    app.add_exception_handler(Exception, unexpected_error_handler)

    origins = settings.allowed_origins
    if origins:
        # Only needed when the engine is exposed to a browser; the default
        # deployment keeps it reachable exclusively through the Next.js bridge.
        app.add_middleware(
            CORSMiddleware,
            allow_origins=origins,
            allow_credentials=False,
            allow_methods=["GET", "POST", "DELETE"],
            allow_headers=["Authorization", "Content-Type"],
        )

    app.include_router(router)
    return app


app = create_app()
