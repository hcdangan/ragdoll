"""Deterministic offline provider.

Enabled with `RAGDOLL_DEV_PROVIDER=1` and refused on a hosted deployment. It
exists so the whole application — indexing, retrieval, citations, the
groundedness gate, streaming and the metric suite — can be exercised without an
API key and without a network call: local demos, E2E runs and CI.

The vectors are hashed bag-of-words projections, which are not semantic, so the
*ranking* is only as good as lexical overlap. Every other code path is the real
one, which is what makes this useful for verification: a bug in chunking,
retrieval plumbing, citation shape or the gate still shows up here.
"""

from __future__ import annotations

import asyncio
import json
import math
import re
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass

from .llm import ChatCompletion, ChatMessage, ProbeResult, StreamDelta, Usage

TOKEN_PATTERN = re.compile(r"[a-z0-9]+")
STREAM_CHUNK_DELAY_SECONDS = 0.01


@dataclass(frozen=True, slots=True)
class DevProvider:
    """Offline stand-in for `ProviderClient` with the same async surface."""

    dimension: int = 256
    model: str = "dev-deterministic"

    # ------------------------------------------------------------ embeddings

    def _vector(self, text: str) -> list[float]:
        buckets = [0.0] * self.dimension
        for token in TOKEN_PATTERN.findall(text.lower()):
            if len(token) < 3:
                continue
            buckets[hash_token(token) % self.dimension] += 1.0
        norm = math.sqrt(sum(value * value for value in buckets))
        return [value / norm for value in buckets] if norm else buckets

    async def embed(self, texts: Sequence[str]) -> list[list[float]]:
        return [self._vector(text) for text in texts]

    async def embed_one(self, text: str) -> list[float]:
        return self._vector(text)

    # ------------------------------------------------------------------ chat

    async def complete(
        self,
        messages: Sequence[ChatMessage],
        *,
        temperature: float = 0.0,
        max_tokens: int | None = None,
    ) -> ChatCompletion:
        del temperature, max_tokens
        system = messages[0].content if messages else ""
        prompt = messages[-1].content if messages else ""
        return ChatCompletion(
            text=self._respond(system, prompt),
            usage=Usage(prompt_tokens=max(1, len(prompt) // 4), completion_tokens=32),
        )

    async def stream(
        self, messages: Sequence[ChatMessage], *, temperature: float = 0.0
    ) -> AsyncIterator[StreamDelta]:
        completion = await self.complete(messages, temperature=temperature)
        tokens = completion.text.split(" ")
        for index, token in enumerate(tokens):
            if index > 0:
                await asyncio.sleep(STREAM_CHUNK_DELAY_SECONDS)
            suffix = "" if index == len(tokens) - 1 else " "
            yield StreamDelta(text=f"{token}{suffix}")
        yield StreamDelta(text="", usage=completion.usage)

    async def probe(self) -> ProbeResult:
        return ProbeResult(
            latency_ms=1,
            echo=self.model,
            embedding_dimension=self.dimension,
            embedding_ok=True,
        )

    # --------------------------------------------------------------- responses

    def _respond(self, system: str, prompt: str) -> str:
        if "fact-checker" in system:
            # Support the draft only when its content words actually appear in the
            # context block, so the groundedness gate is genuinely exercised.
            answer = _section(prompt, "ANSWER:")
            context = _section(prompt, "CONTEXT:")
            supported = _lexical_support(answer, context) >= 0.5
            body = {
                "claims": [
                    {"claim": sentence, "supported": supported} for sentence in _sentences(answer)
                ]
                or [{"claim": answer[:120], "supported": supported}]
            }
            return json.dumps(body)

        if "standalone search query" in system:
            return _last_user_message(prompt)

        if "PASSAGE:" in prompt or "specific question" in system:
            passage = _section(prompt, "PASSAGE:")
            return f"What does the document say about {_keywords(passage)}?"

        if "reverse" in system or "Generate the single question" in system:
            return "What does the document say about the retention policy?"

        if '{"tool":"answer"}' in system:
            return '{"tool":"answer"}'

        context = _section(prompt, "CONTEXT:")
        if not context.strip():
            return "Sorry, I don't know the answer to that."
        return (
            f"Based on the retrieved sources, {_keywords(context)} is documented in the "
            "provided material."
        )


def hash_token(token: str) -> int:
    """Stable hash across processes, unlike the built-in `hash` for strings."""

    value = 2166136261
    for character in token:
        value = (value ^ ord(character)) * 16777619 & 0xFFFFFFFF
    return value


def _section(prompt: str, heading: str) -> str:
    """Extracts the text after `heading` up to the next blank-line section."""

    index = prompt.find(heading)
    if index == -1:
        return ""
    remainder = prompt[index + len(heading) :]
    stop = remainder.find("\n\nQUESTION:")
    return remainder[:stop] if stop != -1 else remainder


def _last_user_message(prompt: str) -> str:
    cleaned = " ".join(prompt.split())
    return cleaned[:160] or "the document contents"


def _sentences(text: str) -> list[str]:
    return [segment.strip() for segment in re.split(r"(?<=[.!?])\s+", text) if segment.strip()]


def _content_words(text: str) -> set[str]:
    return {token for token in TOKEN_PATTERN.findall(text.lower()) if len(token) > 3}


def _lexical_support(answer: str, context: str) -> float:
    answer_words = _content_words(answer)
    if not answer_words:
        return 0.0
    return len(answer_words & _content_words(context)) / len(answer_words)


def _keywords(text: str) -> str:
    """Picks a few salient words so generated questions read like questions."""

    words: list[str] = []
    for token in TOKEN_PATTERN.findall(text.lower()):
        if len(token) > 4 and token not in words:
            words.append(token)
        if len(words) == 3:
            break
    return " ".join(words) if words else "the material"
