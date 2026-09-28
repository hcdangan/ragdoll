"""FastAPI routes.

Route responsibilities, in one line each:
  * `/v1/test`     — validate credentials before anything is indexed;
  * `/v1/pipeline` — parse PDFs, chunk, embed and index (idempotent replace);
  * `/v1/chat`     — grounded, cited answer with the groundedness gate;
  * `/v1/chat/stream` — the same, as SSE, with citations sent first;
  * `/v1/evaluate` — the Ragas-style report;
  * `/v1/session`  — purge a session.

Authentication is a shared bearer token presented by the Next.js bridge. The
engine is never called from a browser, so the token is the only credential and
no CORS surface is exposed.
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import AsyncIterator
from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse

from .config import get_settings
from .errors import GuardrailError, RagdollError, UnauthorizedError, ValidationError
from .evaluate import run_evaluation
from .providers import PROVIDER_IDS
from .rag import SERVICE, build_provider
from .schemas import (
    ChatRequest,
    ChatResponse,
    EvaluateRequest,
    EvaluationReport,
    HealthResponse,
    ResetResponse,
    TestConnectionRequest,
    TestConnectionResponse,
    UpsertResponse,
    all_embedding_models,
)
from .store import STORE

logger = logging.getLogger("ragdoll.routes")

router = APIRouter()

SSE_HEADERS = {
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}


async def require_bridge_token(request: Request) -> None:
    """Rejects requests that do not carry the bridge's shared secret.

    An unset token means the engine is expected to be reachable only over
    loopback, which is the documented self-hosted default.
    """

    expected = get_settings().api_token
    if not expected:
        return
    presented = request.headers.get("authorization", "")
    if presented.removeprefix("Bearer ").strip() != expected:
        raise UnauthorizedError("The bridge token is missing or invalid.")


@router.get(
    "/health",
    response_model=HealthResponse,
    dependencies=[Depends(require_bridge_token)],
    tags=["ops"],
)
async def health() -> HealthResponse:
    """Liveness and configuration summary.

    Token-guarded when a token is configured: on a hosted deployment the engine is
    reachable at `/engine/*`, so an unauthenticated endpoint would leak provider
    and session-count detail to anyone who guesses the path.
    """

    settings = get_settings()
    return HealthResponse(
        status="ok",
        version=settings.version,
        sessions=STORE.count(),
        hosted=settings.hosted,
        providers=list(PROVIDER_IDS),
        embedding_models=all_embedding_models(),
    )


@router.post(
    "/v1/test",
    response_model=TestConnectionResponse,
    dependencies=[Depends(require_bridge_token)],
    tags=["pipeline"],
)
async def test_connection(payload: TestConnectionRequest) -> TestConnectionResponse:
    """Validates the provider, key, model and embedding width."""

    result = await SERVICE.test_connection(payload.session)
    return TestConnectionResponse.model_validate(result)


@router.post(
    "/v1/pipeline",
    response_model=UpsertResponse,
    dependencies=[Depends(require_bridge_token)],
    tags=["pipeline"],
)
async def upsert_pipeline(payload: TestConnectionRequest) -> UpsertResponse:
    """Builds (or replaces) the session index from the uploaded PDFs."""

    result = await SERVICE.ensure_index(payload.session)
    return UpsertResponse.model_validate(result)


@router.post(
    "/v1/chat",
    response_model=ChatResponse,
    dependencies=[Depends(require_bridge_token)],
    tags=["chat"],
)
async def chat(payload: ChatRequest) -> ChatResponse:
    """Answers a question with citations and the groundedness gate applied."""

    result = await SERVICE.answer(
        session=payload.session, question=payload.question, history=list(payload.session.history)
    )
    return ChatResponse(
        answer=result.answer,
        citations=result.citations,
        fallback=result.fallback,
        standaloneQuery=result.standalone_query,
        retrieved=result.retrieved,
        usage={
            "promptTokens": result.usage.prompt_tokens,
            "completionTokens": result.usage.completion_tokens,
        },
        faithfulness=result.faithfulness,
    )


@router.post(
    "/v1/chat/stream",
    dependencies=[Depends(require_bridge_token)],
    tags=["chat"],
    response_class=StreamingResponse,
)
async def chat_stream(payload: ChatRequest, request: Request) -> StreamingResponse:
    """Streams the answer as SSE: citations, status, tokens, then done."""

    async def frames() -> AsyncIterator[bytes]:
        started = time.perf_counter()
        try:
            async for event in SERVICE.answer_stream(
                session=payload.session,
                question=payload.question,
                history=list(payload.session.history),
            ):
                if await request.is_disconnected():
                    logger.info("client disconnected; stopping generation")
                    break
                name = event["event"]
                data = json.dumps(event["data"], ensure_ascii=False)
                yield f"event: {name}\ndata: {data}\n\n".encode()
        except RagdollError as error:
            payload_error = {"code": error.code, "message": error.message}
            yield f"event: error\ndata: {json.dumps(payload_error)}\n\n".encode()
        except Exception as error:
            logger.exception("stream failed")
            payload_error = {
                "code": "engine_error",
                "message": "The RAG engine failed while streaming the answer.",
            }
            del error
            yield f"event: error\ndata: {json.dumps(payload_error)}\n\n".encode()
        finally:
            logger.info("stream finished in %dms", int((time.perf_counter() - started) * 1000))

    return StreamingResponse(frames(), media_type="text/event-stream", headers=SSE_HEADERS)


@router.post(
    "/v1/evaluate",
    response_model=EvaluationReport,
    dependencies=[Depends(require_bridge_token)],
    tags=["evaluate"],
)
async def evaluate(payload: EvaluateRequest) -> EvaluationReport:
    """Runs the Ragas-style metric suite."""

    return await run_evaluation(session=payload.session, sample_count=payload.sample_count)


@router.get(
    "/v1/session/{session_id}/citations",
    dependencies=[Depends(require_bridge_token)],
    tags=["chat"],
)
async def session_citations(session_id: str) -> dict[str, Any]:
    """Returns the citation catalogue for an indexed session."""

    record = STORE.get(session_id)
    if record is None:
        raise ValidationError("No pipeline exists in this session.")
    return {
        "sessionId": session_id,
        "multimodal": record.multimodal,
        "chunks": [
            {
                "chunkId": f"{owned.document_id}:{owned.chunk.index}",
                "documentId": owned.document_id,
                "documentName": owned.document_name,
                "page": owned.chunk.page,
                "text": owned.chunk.text,
            }
            for owned in record.chunks[:200]
        ],
    }


@router.delete(
    "/v1/session/{session_id}",
    response_model=ResetResponse,
    dependencies=[Depends(require_bridge_token)],
    tags=["pipeline"],
)
async def reset_session(session_id: str) -> ResetResponse:
    """Purges the index, documents and history for a session."""

    result = await SERVICE.reset(session_id)
    return ResetResponse.model_validate(result)


__all__ = ["GuardrailError", "build_provider", "router"]
