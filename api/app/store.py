"""Per-session state: parsed chunks, the vector index and chat history.

Two backends, chosen the same way the Next.js bridge chooses its own store:
in-process memory for self-hosted single-instance deployments, and Upstash/Vercel
KV REST when `KV_REST_API_URL` is configured. A Vercel Function instance does not
share memory with its siblings, so KV is the only way chat survives a cold start
there; when KV is absent the bridge re-uploads the PDFs and the index is rebuilt.
"""

from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass, field
from typing import Any, Final

import httpx

from .chunking import TextChunk
from .config import get_settings
from .distance import VectorIndex
from .errors import PipelineMissingError
from .pdf import ParsedDocument
from .schemas import ChatTurn

logger = logging.getLogger("ragdoll.store")

KV_PREFIX: Final[str] = "ragdoll:engine:"
MAX_HISTORY_TURNS: Final[int] = 24
MAX_INDEX_BYTES: Final[int] = 24 * 1024 * 1024


@dataclass(slots=True)
class SessionRecord:
    """Everything retained for one browser session."""

    session_id: str
    created_at: float
    updated_at: float
    index: VectorIndex | None = None
    chunks: list[OwnedChunk] = field(default_factory=list)
    documents: list[ParsedDocument] = field(default_factory=list)
    history: list[ChatTurn] = field(default_factory=list)
    multimodal: bool = False
    # (document id, page) pairs whose content is essentially an image, so the
    # multimodal metrics can be scoped to them instead of aliasing the text ones.
    image_only_pages: set[tuple[str, int]] = field(default_factory=set)

    def touch(self) -> None:
        """Refreshes the sliding window."""

        self.updated_at = time.time()

    def remember(self, turn: ChatTurn) -> None:
        """Appends a turn, trimming the oldest beyond the retention window."""

        self.history.append(turn)
        if len(self.history) > MAX_HISTORY_TURNS:
            del self.history[: len(self.history) - MAX_HISTORY_TURNS]

    def replace_history(self, history: list[ChatTurn]) -> None:
        """Adopts the bridge's copy of the conversation (trimmed)."""

        self.history = history[-MAX_HISTORY_TURNS:]

    def clear_history(self) -> None:
        """Drops only the conversation; the index and documents persist."""

        self.history = []

    def owned_chunks(self) -> list[OwnedChunk]:
        """Chunks paired with their document identity, for embedding."""

        return list(self.chunks)


@dataclass(frozen=True, slots=True)
class OwnedChunk:
    """A chunk with the document identity it came from."""

    document_id: str
    document_name: str
    chunk: TextChunk


class SessionStore:
    """Session registry with a sliding TTL and an optional KV mirror."""

    def __init__(self) -> None:
        self._records: dict[str, SessionRecord] = {}
        self._kv_url = os.environ.get("KV_REST_API_URL", "").strip()
        self._kv_token = os.environ.get("KV_REST_API_TOKEN", "").strip()

    # ------------------------------------------------------------------ basics

    @property
    def kv_enabled(self) -> bool:
        """True when a shared KV store is configured."""

        return bool(self._kv_url and self._kv_token)

    def _ttl(self) -> int:
        return get_settings().session_ttl_seconds

    def sweep(self, now: float | None = None) -> None:
        """Drops expired sessions from memory."""

        moment = now if now is not None else time.time()
        expired = [
            key for key, record in self._records.items() if moment - record.updated_at > self._ttl()
        ]
        for key in expired:
            self._records.pop(key, None)

    def count(self) -> int:
        """Number of live sessions in this process."""

        self.sweep()
        return len(self._records)

    def get(self, session_id: str) -> SessionRecord | None:
        """Returns a live record, refreshing its TTL."""

        self.sweep()
        record = self._records.get(session_id)
        if record is None:
            return None
        record.touch()
        return record

    def require(self, session_id: str) -> SessionRecord:
        """Returns a record or raises `pipeline_missing`."""

        record = self.get(session_id)
        if record is None or record.index is None:
            raise PipelineMissingError(
                "No index exists for this session. Rebuild the pipeline to continue."
            )
        return record

    def put(self, record: SessionRecord) -> None:
        """Stores a record in memory, enforcing the memory guard."""

        record.touch()
        self._records[record.session_id] = record
        self._enforce_memory_guard()

    def drop(self, session_id: str) -> bool:
        """Removes a record from memory, reporting whether one was present."""

        return self._records.pop(session_id, None) is not None

    def _enforce_memory_guard(self) -> None:
        """Evicts the least recently used sessions past the size budget."""

        total = sum(
            record.index.memory_bytes() if record.index is not None else 0
            for record in self._records.values()
        )
        if total <= MAX_INDEX_BYTES:
            return
        ordered = sorted(self._records.values(), key=lambda item: item.updated_at)
        while total > MAX_INDEX_BYTES and ordered:
            victim = ordered.pop(0)
            self._records.pop(victim.session_id, None)
            total -= victim.index.memory_bytes() if victim.index is not None else 0
            logger.warning("evicted session %s to stay within the index budget", victim.session_id)

    # -------------------------------------------------------------------- KV

    async def _kv(self, command: list[Any]) -> Any:
        async with httpx.AsyncClient(timeout=httpx.Timeout(5.0)) as client:
            response = await client.post(
                self._kv_url,
                headers={
                    "Authorization": f"Bearer {self._kv_token}",
                    "Content-Type": "application/json",
                },
                content=json.dumps(command),
            )
        response.raise_for_status()
        return response.json().get("result")

    def serialise(self, record: SessionRecord) -> dict[str, Any]:
        """Projects a record into the KV-friendly shape (history only).

        Vectors are not persisted: they are cheap to recompute from the PDFs the
        bridge already holds, and keeping them out of KV avoids multi-megabyte
        values against Upstash's request-size limit.
        """

        return {
            "sessionId": record.session_id,
            "createdAt": record.created_at,
            "updatedAt": record.updated_at,
            "chunks": [
                {
                    "index": owned.chunk.index,
                    "text": owned.chunk.text,
                    "tokenCount": owned.chunk.token_count,
                    "page": owned.chunk.page,
                    "documentId": owned.document_id,
                    "documentName": owned.document_name,
                }
                for owned in record.chunks
            ],
            "documents": [
                {
                    "id": document.id,
                    "name": document.name,
                    "sizeBytes": document.size_bytes,
                    "pageCount": document.page_count,
                    "imageCount": document.image_count,
                    "imageOnlyPages": len(document.image_only_page_numbers),
                    "chunkCount": len(document.chunks),
                }
                for document in record.documents
            ],
            "history": [turn.model_dump(by_alias=True) for turn in record.history],
            "multimodal": record.multimodal,
        }

    async def mirror(self, record: SessionRecord) -> None:
        """Best-effort write of session metadata to KV."""

        if not self.kv_enabled:
            return
        try:
            await self._kv(
                [
                    "SET",
                    f"{KV_PREFIX}{record.session_id}",
                    json.dumps(self.serialise(record)),
                    "EX",
                    self._ttl() + 60,
                ]
            )
        except (httpx.HTTPError, ValueError) as error:
            logger.warning("session mirror failed for %s: %s", record.session_id, error)

    async def forget(self, session_id: str) -> None:
        """Removes the KV mirror for a session."""

        if not self.kv_enabled:
            return
        try:
            await self._kv(["DEL", f"{KV_PREFIX}{session_id}"])
        except (httpx.HTTPError, ValueError) as error:
            logger.warning("session purge failed for %s: %s", session_id, error)


STORE = SessionStore()


def new_record(session_id: str, history: list[ChatTurn]) -> SessionRecord:
    """Creates a record for a session the bridge just opened."""

    now = time.time()
    record = SessionRecord(session_id=session_id, created_at=now, updated_at=now)
    record.replace_history(history)
    return record
