"""Shared pytest fixtures.

The engine is designed to run against a provider over HTTP, which is exactly what
a unit test must not do. `FakeProvider` implements the same surface as
`ProviderClient` — `complete`, `stream`, `embed`, `embed_one`, `probe` — with
deterministic behaviour, so chunking, retrieval, prompting, the groundedness gate
and every metric are all exercised without a network or an API key.
"""

from __future__ import annotations

import base64
import io
import json
import math
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass, field
from typing import Any

import pytest

from chunking import TextChunk
from config import reset_settings_cache
from llm import ChatCompletion, ChatMessage, ProbeResult, StreamDelta, Usage
from schemas import EngineDocument, EngineSession, PipelineConfig
from store import STORE, OwnedChunk


@dataclass
class FakeProvider:
    """Deterministic stand-in for a real provider client."""

    dimension: int = 768
    answer: str = "The handbook says the retention period is seven years."
    claims_supported: bool = True
    embed_calls: int = 0
    complete_calls: int = 0
    prompts: list[list[ChatMessage]] = field(default_factory=list)

    # ------------------------------------------------------------------ chat

    async def complete(
        self,
        messages: Sequence[ChatMessage],
        *,
        temperature: float = 0.0,
        max_tokens: int | None = None,
    ) -> ChatCompletion:
        del temperature, max_tokens
        self.complete_calls += 1
        self.prompts.append(list(messages))
        system = messages[0].content if messages else ""

        if "fact-checker" in system:
            supported = self.claims_supported
            body = {
                "claims": [
                    {"claim": "retention is seven years", "supported": supported},
                    {"claim": "records are archived", "supported": supported},
                ]
            }
            return ChatCompletion(text=json.dumps(body), usage=Usage(11, 7))

        if "standalone search query" in system:
            return ChatCompletion(text="retention period policy", usage=Usage(5, 4))

        if "specific question" in system:
            return ChatCompletion(text="What is the retention period?", usage=Usage(5, 6))

        if "single question that the" in system:
            return ChatCompletion(text="What is the retention period?", usage=Usage(5, 6))

        if '{"tool":"answer"}' in system:
            return ChatCompletion(text='{"tool":"answer"}', usage=Usage(4, 3))

        return ChatCompletion(text=self.answer, usage=Usage(120, 24))

    async def stream(
        self, messages: Sequence[ChatMessage], *, temperature: float = 0.0
    ) -> AsyncIterator[StreamDelta]:
        completion = await self.complete(messages, temperature=temperature)
        words = completion.text.split(" ")
        for index, word in enumerate(words):
            suffix = "" if index == len(words) - 1 else " "
            yield StreamDelta(text=f"{word}{suffix}")
        yield StreamDelta(text="", usage=completion.usage)

    # ------------------------------------------------------------ embeddings

    def _vector(self, text: str) -> list[float]:
        """Hashed bag-of-words vector: similar text lands close together."""

        buckets = [0.0] * self.dimension
        for token in text.lower().split():
            cleaned = "".join(character for character in token if character.isalnum())
            if not cleaned:
                continue
            buckets[hash(cleaned) % self.dimension] += 1.0
        norm = math.sqrt(sum(value * value for value in buckets)) or 1.0
        return [value / norm for value in buckets]

    async def embed(self, texts: Sequence[str]) -> list[list[float]]:
        self.embed_calls += 1
        return [self._vector(text) for text in texts]

    async def embed_one(self, text: str) -> list[float]:
        vectors = await self.embed([text])
        return vectors[0]

    async def probe(self) -> ProbeResult:
        return ProbeResult(
            latency_ms=12,
            echo="ready",
            embedding_dimension=self.dimension,
            embedding_ok=True,
        )


def build_pdf(page_texts: Sequence[str]) -> bytes:
    """Builds a minimal, valid single-font PDF with one page per text entry.

    Written by hand rather than pulled from a fixture library: the engine's PDF
    validation is part of what these tests cover, and a real byte stream keeps
    that honest.
    """

    objects: list[bytes] = []
    page_count = len(page_texts)
    font_object = 3 + page_count * 2
    kids = " ".join(f"{3 + index * 2} 0 R" for index in range(page_count))

    objects.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    objects.append(f"<< /Type /Pages /Count {page_count} /Kids [{kids}] >>".encode())

    for index, text in enumerate(page_texts):
        contents_object = 4 + index * 2
        objects.append(
            (
                f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
                f"/Resources << /Font << /F1 {font_object} 0 R >> >> "
                f"/Contents {contents_object} 0 R >>"
            ).encode()
        )
        escaped = text.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")
        stream = f"BT /F1 12 Tf 72 720 Td ({escaped}) Tj ET".encode()
        objects.append(
            b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream"
        )

    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")

    output = io.BytesIO()
    output.write(b"%PDF-1.7\n")
    offsets: list[int] = []
    for number, body in enumerate(objects, start=1):
        offsets.append(output.tell())
        output.write(f"{number} 0 obj\n".encode())
        output.write(body)
        output.write(b"\nendobj\n")

    xref_offset = output.tell()
    output.write(f"xref\n0 {len(objects) + 1}\n".encode())
    output.write(b"0000000000 65535 f \n")
    for offset in offsets:
        output.write(f"{offset:010d} 00000 n \n".encode())
    output.write(
        (
            f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
            f"startxref\n{xref_offset}\n%%EOF\n"
        ).encode()
    )
    return output.getvalue()


def make_config(**overrides: Any) -> PipelineConfig:
    """Builds a valid pipeline configuration, with overrides for a test's focus."""

    payload: dict[str, Any] = {
        "provider": "openai",
        "baseUrl": "https://api.openai.com/v1",
        "model": "gpt-4o-mini",
        "embeddingModel": "nomic-embed-text",
        "embeddingDimension": 768,
        "chunkSize": 512,
        "chunkOverlapPercent": 10,
        "chunkOverlapTokens": 64,
        "maxInputTokens": 1024,
        "distanceMetric": "cosine",
        "topK": 3,
        "retrievalMode": "context-injection",
    }
    payload.update(overrides)
    return PipelineConfig.model_validate(payload)


def make_document(
    *, document_id: str = "doc-1", name: str = "handbook.pdf", pages: Sequence[str] = ()
) -> EngineDocument:
    """Wraps PDF bytes into the engine's document envelope."""

    raw = build_pdf(pages or ["Retention is seven years."])
    return EngineDocument.model_validate(
        {
            "id": document_id,
            "name": name,
            "sizeBytes": len(raw),
            "base64": base64.b64encode(raw).decode(),
            "pageCount": len(pages) or 1,
        }
    )


def make_session(
    *,
    documents: Sequence[EngineDocument] = (),
    config: PipelineConfig | None = None,
    session_id: str = "test-session",
    history: Sequence[dict[str, Any]] = (),
) -> EngineSession:
    """Builds an engine session for a route or service call."""

    return EngineSession.model_validate(
        {
            "sessionId": session_id,
            "config": (config or make_config()).model_dump(by_alias=True),
            "apiKey": "test-key",
            "documents": [document.model_dump(by_alias=True) for document in documents],
            "history": list(history),
        }
    )


@pytest.fixture(autouse=True)
def clean_state(monkeypatch: pytest.MonkeyPatch) -> None:
    """Isolates every test from the process-wide store and settings cache."""

    STORE._records.clear()
    reset_settings_cache()
    monkeypatch.setenv("RAGDOLL_HOSTED", "0")
    monkeypatch.setenv("RAGDOLL_API_TOKEN", "")
    yield
    STORE._records.clear()
    reset_settings_cache()


@pytest.fixture
def provider() -> FakeProvider:
    """A deterministic provider double."""

    return FakeProvider()


@pytest.fixture
def chunk() -> TextChunk:
    """A representative chunk."""

    return TextChunk(index=0, text="Retention is seven years.", token_count=7, page=1)


@pytest.fixture
def owned_chunk(chunk: TextChunk) -> OwnedChunk:
    """A chunk paired with its document identity."""

    return OwnedChunk(document_id="doc-1", document_name="handbook.pdf", chunk=chunk)
