"""Wire schemas for the RAG engine.

These models are the source of `openapi.json`, which the Next.js side compiles
into `web/src/lib/pipeline/api-schema.d.ts`. Field names and nullability must
match `web/src/lib/pipeline/engine-contract.ts` exactly.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .providers import EMBEDDING_DIMENSIONS, EMBEDDING_MODELS, PROVIDER_IDS

ProviderId = Literal["openai", "vocareum", "deepseek", "ollama"]
DistanceMetric = Literal["cosine", "dot", "euclidean"]
RetrievalMode = Literal["context-injection", "agentic"]
EmbeddingModel = Literal[
    "text-embedding-3-small",
    "text-embedding-3-large",
    "nomic-embed-text",
    "bge-m3",
    "embeddinggemma",
    "mxbai-embed-large",
]

_FROZEN = ConfigDict(extra="forbid", frozen=True)


class PipelineConfig(BaseModel):
    """Immutable pipeline configuration, validated on arrival."""

    model_config = _FROZEN

    provider: ProviderId
    base_url: str = Field(alias="baseUrl")
    model: str = Field(min_length=1, max_length=200)
    embedding_model: EmbeddingModel = Field(alias="embeddingModel")
    embedding_dimension: int = Field(alias="embeddingDimension", ge=1, le=8192)
    chunk_size: int = Field(alias="chunkSize", ge=128, le=2048, multiple_of=32)
    chunk_overlap_percent: int = Field(alias="chunkOverlapPercent", ge=10, le=20)
    chunk_overlap_tokens: int = Field(alias="chunkOverlapTokens", ge=0)
    max_input_tokens: int = Field(alias="maxInputTokens", ge=256, le=4096, multiple_of=32)
    distance_metric: DistanceMetric = Field(alias="distanceMetric")
    top_k: int = Field(alias="topK", ge=3, le=10)
    retrieval_mode: RetrievalMode = Field(alias="retrievalMode")

    @field_validator("base_url")
    @classmethod
    def _strip_trailing_slash(cls, value: str) -> str:
        trimmed = value.strip().rstrip("/")
        if not trimmed:
            raise ValueError("baseUrl must not be empty")
        return trimmed

    @field_validator("embedding_dimension")
    @classmethod
    def _dimension_matches_model(cls, value: int, info) -> int:  # type: ignore[no-untyped-def]
        model = info.data.get("embedding_model")
        if model is None:
            return value
        expected = EMBEDDING_DIMENSIONS[model]
        if value != expected:
            raise ValueError(f"embeddingDimension {value} does not match {model} ({expected})")
        return value


class EngineDocument(BaseModel):
    """A PDF handed to the engine for indexing."""

    model_config = _FROZEN

    id: str = Field(min_length=1, max_length=128)
    name: str = Field(min_length=1, max_length=256)
    size_bytes: int = Field(alias="sizeBytes", ge=1, le=2 * 1024 * 1024)
    base64: str = Field(min_length=1)
    page_count: int = Field(alias="pageCount", ge=0, le=5000)


class ChatTurn(BaseModel):
    """A retained conversation turn, used for query compression."""

    model_config = _FROZEN

    role: Literal["user", "assistant"]
    content: str
    citations: list[CitationModel] = Field(default_factory=list)
    created_at: str = Field(alias="createdAt", default="")
    fallback: bool = False


class CitationModel(BaseModel):
    """A retrieved source surfaced before the first token."""

    model_config = _FROZEN

    chunk_id: str = Field(alias="chunkId")
    document_id: str = Field(alias="documentId")
    document_name: str = Field(alias="documentName")
    page: int
    score: float
    snippet: str


class DocumentSummary(BaseModel):
    """Indexed document summary returned to the browser."""

    model_config = _FROZEN

    id: str
    name: str
    size_bytes: int = Field(alias="sizeBytes")
    page_count: int = Field(alias="pageCount")
    chunk_count: int = Field(alias="chunkCount")
    image_count: int = Field(alias="imageCount")
    has_images: bool = Field(alias="hasImages")


class EngineSession(BaseModel):
    """Everything the engine needs to answer or evaluate for one session."""

    model_config = _FROZEN

    session_id: str = Field(alias="sessionId", min_length=1, max_length=128)
    config: PipelineConfig
    api_key: str = Field(alias="apiKey", default="")
    documents: list[EngineDocument] = Field(default_factory=list, max_length=3)
    history: list[ChatTurn] = Field(default_factory=list, max_length=200)

    @field_validator("documents")
    @classmethod
    def _enforce_combined_size(cls, value: list[EngineDocument]) -> list[EngineDocument]:
        total = sum(document.size_bytes for document in value)
        if total > 6 * 1024 * 1024:
            raise ValueError("combined upload exceeds the 6 MB session limit")
        return value


class TestConnectionRequest(BaseModel):
    """`POST /v1/test` body."""

    model_config = _FROZEN

    session: EngineSession


class TestConnectionResponse(BaseModel):
    """`POST /v1/test` result."""

    model_config = _FROZEN

    reachable: bool
    model_echo: str = Field(alias="modelEcho")
    latency_ms: int = Field(alias="latencyMs")
    embedding_dimension: int = Field(alias="embeddingDimension")
    embedding_probe: bool = Field(alias="embeddingProbe")


class UpsertResponse(BaseModel):
    """`POST /v1/pipeline` result."""

    model_config = _FROZEN

    engine_session_id: str = Field(alias="engineSessionId")
    documents: list[DocumentSummary]
    chunk_count: int = Field(alias="chunkCount")
    citations: list[CitationModel]
    multimodal: bool


class ChatRequest(BaseModel):
    """`POST /v1/chat` body."""

    model_config = _FROZEN

    session: EngineSession
    question: str = Field(min_length=1, max_length=8000)


class Usage(BaseModel):
    """Token accounting for cost attribution."""

    model_config = _FROZEN

    prompt_tokens: int = Field(alias="promptTokens", default=0)
    completion_tokens: int = Field(alias="completionTokens", default=0)


class ChatResponse(BaseModel):
    """`POST /v1/chat` result."""

    model_config = _FROZEN

    answer: str
    citations: list[CitationModel]
    fallback: bool
    standalone_query: str = Field(alias="standaloneQuery")
    retrieved: int
    usage: Usage
    faithfulness: float | None = None


class EvaluateRequest(BaseModel):
    """`POST /v1/evaluate` body."""

    model_config = _FROZEN

    session: EngineSession
    sample_count: int = Field(alias="sampleCount", ge=1, le=12, default=4)


class MetricResult(BaseModel):
    """One Ragas-style metric score."""

    model_config = _FROZEN

    metric: str
    score: float | Literal["N/A"]
    samples: int
    reason: str
    skipped_reason: str | None = Field(alias="skippedReason", default=None)


class EvaluationSample(BaseModel):
    """A single evaluated question, retained for inspection."""

    model_config = _FROZEN

    question: str
    answer: str
    ground_truth: str | None = Field(alias="groundTruth", default=None)
    contexts: list[str]
    citations: list[CitationModel]
    fallback: bool


class EvaluationReport(BaseModel):
    """`POST /v1/evaluate` result."""

    model_config = _FROZEN

    category: Literal["Retrieval Augmented Generation"] = "Retrieval Augmented Generation"
    created_at: str = Field(alias="createdAt")
    duration_ms: int = Field(alias="durationMs")
    sample_count: int = Field(alias="sampleCount")
    document_count: int = Field(alias="documentCount")
    metrics: list[MetricResult]
    samples: list[EvaluationSample]


class ResetResponse(BaseModel):
    """`DELETE /v1/session/{id}` result."""

    model_config = _FROZEN

    cleared: bool


class ErrorDetail(BaseModel):
    """Error envelope returned for every non-2xx response."""

    model_config = _FROZEN

    code: str
    message: str
    fields: dict[str, str] | None = None


class ErrorResponse(BaseModel):
    """Top-level FastAPI error body."""

    model_config = _FROZEN

    detail: ErrorDetail


class HealthResponse(BaseModel):
    """`GET /health` result."""

    model_config = _FROZEN

    status: Literal["ok"]
    version: str
    sessions: int
    hosted: bool
    providers: list[str]
    embedding_models: list[str]


ChatTurn.model_rebuild()


def all_embedding_models() -> list[str]:
    """Flattened embedding model ids, used by the health endpoint."""

    seen: list[str] = []
    for models in EMBEDDING_MODELS.values():
        for model in models:
            if model not in seen:
                seen.append(model)
    return seen


__all__ = [
    "PROVIDER_IDS",
    "ChatRequest",
    "ChatResponse",
    "ChatTurn",
    "CitationModel",
    "DocumentSummary",
    "EngineDocument",
    "EngineSession",
    "ErrorDetail",
    "ErrorResponse",
    "EvaluateRequest",
    "EvaluationReport",
    "EvaluationSample",
    "HealthResponse",
    "MetricResult",
    "PipelineConfig",
    "ResetResponse",
    "TestConnectionRequest",
    "TestConnectionResponse",
    "UpsertResponse",
    "Usage",
    "all_embedding_models",
]
