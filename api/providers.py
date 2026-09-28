"""Domain constants mirrored from `src/lib/providers.ts`.

The two tables must agree: the browser decides which model ids are offerable and
the engine decides which are callable. `tests/test_providers.py` asserts the
Euclidean dimension table matches the TypeScript one.
"""

from __future__ import annotations

from typing import Final, Literal, get_args

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

PROVIDER_IDS: Final[tuple[ProviderId, ...]] = get_args(ProviderId)

BASE_URLS: Final[dict[str, str]] = {
    "openai": "https://api.openai.com/v1",
    "vocareum": "https://openai.vocareum.com/v1",
    "deepseek": "https://api.deepseek.com/v1",
}

DEFAULT_MODELS: Final[dict[str, str]] = {
    "openai": "gpt-4o-mini",
    "vocareum": "gpt-4o-mini",
    "deepseek": "deepseek-flash",
    "ollama": "llama3.2",
}

EMBEDDING_MODELS: Final[dict[str, tuple[EmbeddingModel, ...]]] = {
    "openai": ("text-embedding-3-small", "text-embedding-3-large"),
    "vocareum": ("text-embedding-3-small", "text-embedding-3-large"),
    "deepseek": ("text-embedding-3-small", "text-embedding-3-large"),
    "ollama": ("nomic-embed-text", "bge-m3", "embeddinggemma", "mxbai-embed-large"),
}

EMBEDDING_DIMENSIONS: Final[dict[EmbeddingModel, int]] = {
    "text-embedding-3-small": 1536,
    "text-embedding-3-large": 3072,
    "nomic-embed-text": 768,
    "bge-m3": 1024,
    "embeddinggemma": 768,
    "mxbai-embed-large": 1024,
}

SELF_HOSTED_PROVIDERS: Final[frozenset[str]] = frozenset({"ollama"})

LOCAL_HOST_NAMES: Final[frozenset[str]] = frozenset({"localhost", "0.0.0.0", "::1", "[::1]"})

LOOPBACK_ERROR: Final[str] = (
    "Cannot reach localhost from a hosted deployment. Self-host RAGdoll to use local providers."
)

FALLBACK_ANSWER: Final[str] = "Sorry, I don't know the answer to that."

EVALUATION_METRICS: Final[tuple[str, ...]] = (
    "context_precision",
    "context_recall",
    "context_entity_recall",
    "noise_sensitivity",
    "response_relevancy",
    "faithfulness",
    "multimodal_faithfulness",
    "multimodal_relevance",
)

MULTIMODAL_METRICS: Final[frozenset[str]] = frozenset(
    {"multimodal_faithfulness", "multimodal_relevance"}
)
