"""Similarity scoring and the per-session vector index.

A pure-Python implementation is deliberate: the engine runs as a Vercel Python
function, where NumPy keeps the bundle small and everything else (FAISS, torch,
sentence-transformers) would blow the size limit. Vectors are L2-normalised once
at insert time, which makes cosine a dot product and keeps retrieval O(n·d) with
a small constant.
"""

from __future__ import annotations

import math
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Literal

from .chunking import TextChunk
from .errors import ValidationError

DistanceMetric = Literal["cosine", "dot", "euclidean"]


def l2_normalise(vector: list[float]) -> list[float]:
    """Scales a vector to unit length; zero vectors pass through unchanged."""

    norm = math.sqrt(sum(component * component for component in vector))
    if norm == 0.0:
        return list(vector)
    return [component / norm for component in vector]


def dot_product(left: list[float], right: list[float]) -> float:
    """Inner product of two equal-length vectors."""

    if len(left) != len(right):
        raise ValidationError("vector dimensions differ")
    return sum(a * b for a, b in zip(left, right, strict=True))


def similarity(metric: DistanceMetric, query: list[float], candidate: list[float]) -> float:
    """Returns a score where higher always means more relevant.

    Both sides are normalised for cosine rather than trusting the caller: the
    index stores unit vectors, but a query vector arrives straight from the
    provider and the evaluation path compares two arbitrary texts.
    """

    if metric == "cosine":
        return dot_product(l2_normalise(query), l2_normalise(candidate))
    if metric == "dot":
        return dot_product(query, candidate)

    # Euclidean distance is inverted so every metric shares one ranking direction.
    distance = math.sqrt(sum((a - b) ** 2 for a, b in zip(query, candidate, strict=True)))
    return 1.0 / (1.0 + distance)


@dataclass(frozen=True, slots=True)
class IndexedChunk:
    """A chunk plus its embedding, ready to score."""

    chunk: TextChunk
    document_id: str
    document_name: str
    vector: list[float]


@dataclass(slots=True)
class RetrievedChunk:
    """A scored retrieval hit."""

    chunk: TextChunk
    document_id: str
    document_name: str
    score: float


@dataclass(slots=True)
class VectorIndex:
    """In-memory index for one session.

    The index is rebuilt whenever documents or the configuration change; it is
    never persisted, which is what makes "nothing is stored on disk" true.
    """

    metric: DistanceMetric
    dimensions: int
    chunks: list[IndexedChunk] = field(default_factory=list)

    def add(self, entries: Iterable[IndexedChunk]) -> None:
        """Appends normalised entries, validating the vector width."""

        for entry in entries:
            width = len(entry.vector)
            if width != self.dimensions:
                raise ValidationError(
                    f"embedding width {width} does not match the index width {self.dimensions}"
                )
            vector = l2_normalise(entry.vector) if self.metric == "cosine" else entry.vector
            self.chunks.append(
                IndexedChunk(
                    chunk=entry.chunk,
                    document_id=entry.document_id,
                    document_name=entry.document_name,
                    vector=vector,
                )
            )

    def search(self, query: list[float], top_k: int) -> list[RetrievedChunk]:
        """Returns the top-K chunks, highest score first."""

        if not self.chunks:
            return []
        scored = [
            RetrievedChunk(
                chunk=entry.chunk,
                document_id=entry.document_id,
                document_name=entry.document_name,
                score=similarity(self.metric, query, entry.vector),
            )
            for entry in self.chunks
        ]
        scored.sort(key=lambda hit: hit.score, reverse=True)
        return scored[: max(1, top_k)]

    def tail_similarity(self, query: list[float], top_k: int) -> float | None:
        """Mean score of the ranked chunks beyond `top_k`.

        This is the evidence behind noise sensitivity: how much irrelevant
        material sits just outside the context window. Returns None when the
        index is too small for the tail to mean anything.
        """

        if len(self.chunks) <= top_k:
            return None
        scored = sorted(
            (similarity(self.metric, query, entry.vector) for entry in self.chunks),
            reverse=True,
        )
        tail = scored[top_k:]
        if not tail:
            return None
        return sum(tail) / len(tail)

    @property
    def chunk_count(self) -> int:
        """Number of indexed chunks."""

        return len(self.chunks)

    def memory_bytes(self) -> int:
        """Rough resident size, used by the session store's memory guard."""

        return sum(len(entry.vector) * 8 + len(entry.chunk.text) for entry in self.chunks)
