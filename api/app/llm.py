"""Provider client for chat completions and embeddings.

Two wire protocols cover every supported provider:
  * OpenAI-compatible (`/chat/completions`, `/embeddings`) — OpenAI, Vocareum,
    DeepSeek, and llama.cpp's OpenAI shim;
  * Ollama native (`/api/chat`, `/api/embeddings`) — selected automatically when
    the provider is `ollama`.

Failures are translated into RagdollError subclasses so the bridge can tell an
expired key apart from an unreachable host.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass
from typing import Any, cast
from urllib.parse import urlparse

import httpx

from .config import get_settings
from .errors import (
    LoopbackBlockedError,
    ProviderAuthError,
    ProviderRequestError,
    ProviderUnreachableError,
    ValidationError,
)
from .providers import LOCAL_HOST_NAMES, LOOPBACK_ERROR

logger = logging.getLogger("ragdoll.provider")

RETRYABLE_STATUS = frozenset({408, 409, 425, 429, 500, 502, 503, 504})
MAX_ATTEMPTS = 3
BACKOFF_SECONDS = 0.4


def is_loopback_host(url: str) -> bool:
    """True when a base URL points at the caller's own machine or local network.

    Kept in step with `web/src/lib/providers.ts::isLoopbackUrl`: if the two
    disagree, the creation form accepts a URL the engine then refuses, or the
    engine blocks a provider the form said was fine. RFC1918 ranges (including the
    commonly forgotten `172.16/12`), link-local addresses and mDNS `.local` names
    all count, because an Ollama server on a LAN is the normal self-hosted case.
    """

    try:
        host = (urlparse(url).hostname or "").lower()
    except ValueError:
        return False
    if not host:
        return False

    if host in LOCAL_HOST_NAMES or host.endswith((".localhost", ".local", ".internal")):
        return True

    octets = host.split(".")
    if len(octets) != 4 or not all(octet.isdigit() and len(octet) <= 3 for octet in octets):
        return False
    first, second = int(octets[0]), int(octets[1])
    if first in {10, 127}:
        return True
    if first == 192 and second == 168:
        return True
    if first == 172 and 16 <= second <= 31:
        return True
    return first == 169 and second == 254


@dataclass(frozen=True, slots=True)
class ChatMessage:
    """One message in a chat completion request."""

    role: str
    content: str


@dataclass(frozen=True, slots=True)
class Usage:
    """Token accounting returned by the provider."""

    prompt_tokens: int = 0
    completion_tokens: int = 0


@dataclass(frozen=True, slots=True)
class ChatCompletion:
    """A completed non-streaming generation."""

    text: str
    usage: Usage


@dataclass(frozen=True, slots=True)
class StreamDelta:
    """One increment of a streaming generation."""

    text: str
    usage: Usage | None = None


class ProviderClient:
    """Async client bound to one provider base URL."""

    def __init__(
        self,
        *,
        provider: str,
        base_url: str,
        api_key: str,
        model: str,
        embedding_model: str,
        timeout_seconds: float | None = None,
    ) -> None:
        settings = get_settings()
        self.provider = provider
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.embedding_model = embedding_model
        self.timeout = httpx.Timeout(timeout_seconds or settings.requestion_timeout_seconds)
        self._native_ollama = provider == "ollama"
        self._batch_size = settings.embedding_batch_size

        if not self.base_url:
            raise ValidationError("A base URL is required for this provider.")
        if settings.hosted and is_loopback_host(self.base_url):
            raise LoopbackBlockedError(LOOPBACK_ERROR)

    # ------------------------------------------------------------------ helpers

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    def _url(self, path: str) -> str:
        if self._native_ollama:
            stripped = self.base_url
            if stripped.endswith("/v1"):
                stripped = stripped[: -len("/v1")]
            return f"{stripped}{path}"
        return f"{self.base_url}{path}"

    async def _post_json(self, url: str, payload: dict[str, Any]) -> dict[str, Any]:
        """POSTs JSON with retry on transport and retryable-status failures."""

        last_error: Exception | None = None
        for attempt in range(1, MAX_ATTEMPTS + 1):
            try:
                async with httpx.AsyncClient(timeout=self.timeout) as client:
                    response = await client.post(url, json=payload, headers=self._headers())
                if response.status_code in RETRYABLE_STATUS and attempt < MAX_ATTEMPTS:
                    last_error = ProviderRequestError(
                        f"The provider returned {response.status_code}."
                    )
                    await asyncio.sleep(BACKOFF_SECONDS * 2 ** (attempt - 1))
                    continue
                self._raise_for_status(response)
                return cast(dict[str, Any], response.json())
            except (
                httpx.ConnectError,
                httpx.ConnectTimeout,
                httpx.ReadTimeout,
                httpx.RemoteProtocolError,
            ) as error:
                last_error = error
                if attempt == MAX_ATTEMPTS:
                    raise ProviderUnreachableError(
                        f"Could not reach the provider at {self.base_url}.", cause=error
                    ) from error
                await asyncio.sleep(BACKOFF_SECONDS * 2 ** (attempt - 1))
            except httpx.HTTPError as error:
                raise ProviderUnreachableError(
                    f"Could not reach the provider at {self.base_url}.", cause=error
                ) from error

        raise ProviderUnreachableError(
            f"Could not reach the provider at {self.base_url}.", cause=last_error
        )

    def _raise_for_status(self, response: httpx.Response) -> None:
        if response.status_code < 400:
            return
        detail = ""
        try:
            body = response.json()
            detail = json.dumps(body)[:400]
        except ValueError:
            detail = response.text[:400]

        if response.status_code in {401, 403}:
            raise ProviderAuthError(
                "The provider rejected the API key. Check the key and provider selection."
            )
        if response.status_code == 404:
            raise ProviderRequestError(
                f"The provider has no endpoint or model at {self.model}. {detail}"
            )
        if response.status_code == 429:
            raise ProviderRequestError("The provider rate-limited the request.")
        raise ProviderRequestError(f"The provider returned {response.status_code}. {detail}")

    # --------------------------------------------------------------------- chat

    def _chat_payload(
        self, messages: Sequence[ChatMessage], *, stream: bool, temperature: float
    ) -> dict[str, Any]:
        if self._native_ollama:
            return {
                "model": self.model,
                "messages": [{"role": m.role, "content": m.content} for m in messages],
                "stream": stream,
                "options": {"temperature": temperature},
            }
        return {
            "model": self.model,
            "messages": [{"role": m.role, "content": m.content} for m in messages],
            "stream": stream,
            "temperature": temperature,
        }

    def _chat_path(self) -> str:
        return "/api/chat" if self._native_ollama else "/chat/completions"

    async def complete(
        self,
        messages: Sequence[ChatMessage],
        *,
        temperature: float = 0.0,
        max_tokens: int | None = None,
    ) -> ChatCompletion:
        """Runs one non-streaming generation."""

        payload = self._chat_payload(messages, stream=False, temperature=temperature)
        if max_tokens is not None and not self._native_ollama:
            payload["max_tokens"] = max_tokens

        body = await self._post_json(self._url(self._chat_path()), payload)

        if self._native_ollama:
            text = str(body.get("message", {}).get("content", "")).strip()
            usage = Usage(
                prompt_tokens=int(body.get("prompt_eval_count", 0) or 0),
                completion_tokens=int(body.get("eval_count", 0) or 0),
            )
            return ChatCompletion(text=text, usage=usage)

        choices = body.get("choices") or []
        if not choices:
            raise ProviderRequestError("The provider returned no completion choices.")
        text = str(choices[0].get("message", {}).get("content", "")).strip()
        raw_usage = body.get("usage") or {}
        return ChatCompletion(
            text=text,
            usage=Usage(
                prompt_tokens=int(raw_usage.get("prompt_tokens", 0) or 0),
                completion_tokens=int(raw_usage.get("completion_tokens", 0) or 0),
            ),
        )

    async def stream(
        self, messages: Sequence[ChatMessage], *, temperature: float = 0.0
    ) -> AsyncIterator[StreamDelta]:
        """Streams a generation, yielding text deltas as they arrive."""

        payload = self._chat_payload(messages, stream=True, temperature=temperature)
        url = self._url(self._chat_path())

        try:
            async with (
                httpx.AsyncClient(timeout=self.timeout) as client,
                client.stream("POST", url, json=payload, headers=self._headers()) as response,
            ):
                if response.status_code >= 400:
                    await response.aread()
                    self._raise_for_status(response)
                async for line in response.aiter_lines():
                    delta = self._parse_stream_line(line)
                    if delta is not None:
                        yield delta
        except (httpx.ConnectError, httpx.ConnectTimeout, httpx.ReadTimeout) as error:
            raise ProviderUnreachableError(
                f"Could not reach the provider at {self.base_url}.", cause=error
            ) from error
        except httpx.HTTPError as error:
            raise ProviderUnreachableError(
                f"The streaming connection to {self.base_url} failed.", cause=error
            ) from error

    def _parse_stream_line(self, line: str) -> StreamDelta | None:
        """Parses one SSE line into a delta.

        Returns None for keep-alives, `[DONE]` and role-only frames, so the
        caller can simply skip nulls. The branch count is inherent: three wire
        protocols (OpenAI SSE, Ollama NDJSON, and the terminal usage frame) all
        arrive on this one path.
        """

        if not line or not line.startswith("data:"):
            if self._native_ollama and line.strip():
                return self._parse_ollama_stream_line(line)
            return None

        data = line[len("data:") :].strip()
        if data == "[DONE]":
            return None
        try:
            body = json.loads(data)
        except json.JSONDecodeError:
            return None

        choices = body.get("choices") or []
        if not choices:
            return None
        delta = choices[0].get("delta") or {}
        text = delta.get("content")
        usage_block = body.get("usage")
        usage = (
            Usage(
                prompt_tokens=int(usage_block.get("prompt_tokens", 0) or 0),
                completion_tokens=int(usage_block.get("completion_tokens", 0) or 0),
            )
            if usage_block
            else None
        )
        if not text and usage is None:
            return None
        return StreamDelta(text=str(text or ""), usage=usage)

    def _parse_ollama_stream_line(self, line: str) -> StreamDelta | None:
        try:
            body = json.loads(line)
        except json.JSONDecodeError:
            return None
        text = str(body.get("message", {}).get("content", ""))
        if body.get("done"):
            return StreamDelta(
                text=text,
                usage=Usage(
                    prompt_tokens=int(body.get("prompt_eval_count", 0) or 0),
                    completion_tokens=int(body.get("eval_count", 0) or 0),
                ),
            )
        return StreamDelta(text=text) if text else None

    # --------------------------------------------------------------- embeddings

    def _embedding_path(self) -> str:
        return "/api/embeddings" if self._native_ollama else "/embeddings"

    async def embed(self, texts: Sequence[str]) -> list[list[float]]:
        """Embeds texts in batches, preserving input order."""

        if not texts:
            return []

        vectors: list[list[float]] = []
        for start in range(0, len(texts), self._batch_size):
            batch = list(texts[start : start + self._batch_size])
            vectors.extend(await self._embed_batch(batch))
        return vectors

    async def _embed_batch(self, batch: list[str]) -> list[list[float]]:
        if self._native_ollama:
            vectors = []
            for text in batch:
                body = await self._post_json(
                    self._url(self._embedding_path()),
                    {"model": self.embedding_model, "prompt": text},
                )
                vector = body.get("embedding")
                if not isinstance(vector, list):
                    raise ProviderRequestError("The embedding provider returned no vector.")
                vectors.append([float(component) for component in vector])
            return vectors

        body = await self._post_json(
            self._url(self._embedding_path()),
            {"model": self.embedding_model, "input": batch},
        )
        data = body.get("data")
        if not isinstance(data, list):
            raise ProviderRequestError("The embedding provider returned no vectors.")
        ordered = sorted(data, key=lambda item: int(item.get("index", 0)))
        return [[float(component) for component in item.get("embedding", [])] for item in ordered]

    async def embed_one(self, text: str) -> list[float]:
        """Embeds a single string."""

        vectors = await self.embed([text])
        if not vectors:
            raise ProviderRequestError("The embedding provider returned no vector.")
        return vectors[0]

    # ------------------------------------------------------------------- probes

    async def probe(self) -> ProbeResult:
        """Cheap liveness probe: one chat call plus one embedding call.

        Returns the observed embedding width, the model echo and the latency so
        `/v1/test` can build its response from measurements rather than guesses.
        """

        started = time.perf_counter()
        completion = await self.complete(
            [ChatMessage(role="user", content="Reply with the single word: ready")],
            temperature=0.0,
            max_tokens=8,
        )
        latency_ms = int((time.perf_counter() - started) * 1000)

        embedding_ok = False
        dimension = 0
        try:
            vector = await self.embed_one("ragdoll connection probe")
            dimension = len(vector)
            embedding_ok = dimension > 0
        except (ProviderRequestError, ProviderUnreachableError) as error:
            # Some chat-only deployments (and a few Ollama setups) cannot embed;
            # the chat probe is what decides reachability.
            logger.warning("embedding probe failed: %s", error)

        logger.info(
            "provider probe provider=%s model=%s latency_ms=%d embedding=%s echo=%r",
            self.provider,
            self.model,
            latency_ms,
            dimension,
            completion.text[:32],
        )
        return ProbeResult(
            latency_ms=latency_ms,
            echo=completion.text,
            embedding_dimension=dimension,
            embedding_ok=embedding_ok,
        )


@dataclass(frozen=True, slots=True)
class ProbeResult:
    """Outcome of a provider liveness probe."""

    latency_ms: int
    echo: str
    embedding_dimension: int
    embedding_ok: bool


def provider_for(
    *,
    provider: str,
    base_url: str,
    api_key: str,
    model: str,
    embedding_model: str,
) -> ProviderClient:
    """Factory used by the routes; keeps construction in one place."""

    return ProviderClient(
        provider=provider,
        base_url=base_url,
        api_key=api_key,
        model=model,
        embedding_model=embedding_model,
    )
