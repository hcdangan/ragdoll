"""The RAG pipeline itself.

Request flow for a question:

1. guardrail the input;
2. compress multi-turn history into a standalone query (avoids the retrieval
   degradation AGENTS.md calls out for ambiguous references);
3. retrieve top-K chunks (context injection), or expose retrieval as a tool when
   the pipeline is configured for agentic mode;
4. generate an answer grounded in the retrieved context only;
5. run a Ragas `faithfulness` pass and fall back to the canned "I don't know"
   string when the score is below 0.5.

Token usage and per-stage timings are logged on every call so cost attribution
and latency regressions are visible without a tracing stack.
"""

from __future__ import annotations

import json
import logging
import re
import time
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass, field
from typing import Any

from . import guardrails
from .chunking import TextChunk
from .config import get_settings
from .dev_provider import DevProvider
from .distance import DistanceMetric, IndexedChunk, VectorIndex, similarity
from .errors import ProviderRequestError, ValidationError
from .llm import ChatMessage, ProviderClient, Usage, provider_for
from .pdf import parse_document
from .prompts import (
    build_answer_messages,
    build_compression_messages,
    build_groundedness_messages,
    clamp_history,
    format_context_block,
    snippet,
    truncate_context,
    truncate_question,
)
from .providers import FALLBACK_ANSWER
from .schemas import ChatTurn, CitationModel, DocumentSummary, EngineSession, PipelineConfig
from .store import STORE, OwnedChunk, SessionRecord, new_record

logger = logging.getLogger("ragdoll.pipeline")

DEFAULT_SAMPLE_COUNT = 4
MAX_AGENTIC_HOPS = 3
GROUNDEDNESS_CONTEXT_TOKENS = 2400


@dataclass(slots=True)
class AnswerResult:
    """A generated answer with everything the UI needs to justify it."""

    answer: str
    citations: list[CitationModel]
    fallback: bool
    standalone_query: str
    retrieved: int
    usage: Usage
    faithfulness: float | None = None
    retrieved_chunks: list[OwnedChunk] = field(default_factory=list)


@dataclass(frozen=True, slots=True)
class RetrievalOutcome:
    """Result of one retrieval pass."""

    chunks: list[OwnedChunk]
    scores: list[float]
    noise_floor: float


def build_provider(config: PipelineConfig, api_key: str) -> Any:
    """Creates the provider described by a pipeline configuration.

    Returns the real HTTP client, or the offline deterministic provider when
    `RAGDOLL_DEV_PROVIDER=1` is set on a non-hosted deployment. Returning `Any`
    is deliberate: both satisfy the same async surface, and callers only ever use
    that surface.
    """

    if get_settings().dev_provider:
        logger.warning("offline dev provider in use: answers are synthetic")
        return DevProvider(dimension=config.embedding_dimension)

    return provider_for(
        provider=config.provider,
        base_url=config.base_url,
        api_key=api_key,
        model=config.model,
        embedding_model=config.embedding_model,
    )


def _to_owned(record: SessionRecord, hits: Sequence[Any]) -> list[OwnedChunk]:
    del record
    return [
        OwnedChunk(
            document_id=hit.document_id,
            document_name=hit.document_name,
            chunk=hit.chunk,
        )
        for hit in hits
    ]


def to_citations(owned: Sequence[OwnedChunk], scores: Sequence[float]) -> list[CitationModel]:
    """Projects retrieved chunks into citation records."""

    citations: list[CitationModel] = []
    for index, item in enumerate(owned):
        score = float(scores[index]) if index < len(scores) else 0.0
        citations.append(
            CitationModel(
                chunkId=f"{item.document_id}:{item.chunk.index}",
                documentId=item.document_id,
                documentName=item.document_name,
                page=item.chunk.page,
                score=round(score, 4),
                snippet=snippet(item.chunk.text),
            )
        )
    return citations


def sanitise_chunks(owned: Sequence[OwnedChunk]) -> list[OwnedChunk]:
    """Strips instruction-like content out of retrieved text.

    Retrieved PDF text is data. Anything shaped like a system/assistant tag is
    neutralised before it can reach a prompt, for both answering and evaluation.
    """

    return [
        OwnedChunk(
            document_id=item.document_id,
            document_name=item.document_name,
            chunk=TextChunk(
                index=item.chunk.index,
                text=guardrails.sanitise_retrieved_text(item.chunk.text),
                token_count=item.chunk.token_count,
                page=item.chunk.page,
            ),
        )
        for item in owned
    ]


class RagdollService:
    """Stateless orchestration over the session store."""

    # ------------------------------------------------------------------ testing

    async def test_connection(self, session: EngineSession, provider: Any = None) -> dict[str, Any]:
        """Validates credentials against the provider before any indexing.

        `provider` is typed `Any` because two different callers inject one: unit
        tests pass a structural double, the routes pass a real `ProviderClient`,
        and production passes nothing at all.
        """

        active = provider or build_provider(session.config, session.api_key)
        probe = await active.probe()
        if probe.embedding_ok and probe.embedding_dimension != session.config.embedding_dimension:
            raise ValidationError(
                "The embedding model returned "
                f"{probe.embedding_dimension} dimensions but the pipeline is configured for "
                f"{session.config.embedding_dimension}. Reselect the embedding model."
            )
        return {
            "reachable": True,
            "modelEcho": probe.echo or session.config.model,
            "latencyMs": probe.latency_ms,
            "embeddingDimension": probe.embedding_dimension or session.config.embedding_dimension,
            "embeddingProbe": probe.embedding_ok,
        }

    # ------------------------------------------------------------------ indexing

    async def ensure_index(self, session: EngineSession, provider: Any = None) -> dict[str, Any]:
        """Parses, chunks and embeds the session documents.

        Re-running with the same documents replaces the index rather than
        appending, which is what "Create RAG pipeline" means when a pipeline
        already exists.

        `provider` is injectable so unit tests can drive the whole pipeline
        without a network call; production always passes None and gets a real
        client built from the session's own configuration.
        """

        started = time.perf_counter()
        config = session.config
        active = provider or build_provider(config, session.api_key)

        record = new_record(session.session_id, list(session.history))
        summaries: list[DocumentSummary] = []
        owned: list[OwnedChunk] = []

        for document in session.documents:
            parsed = parse_document(
                document_id=document.id,
                name=document.name,
                payload_base64=document.base64,
                chunk_size=config.chunk_size,
                chunk_overlap_tokens=config.chunk_overlap_tokens,
                declared_page_count=document.page_count,
            )
            for chunk in parsed.chunks:
                owned.append(
                    OwnedChunk(document_id=parsed.id, document_name=parsed.name, chunk=chunk)
                )
            summaries.append(
                DocumentSummary(
                    id=parsed.id,
                    name=parsed.name,
                    sizeBytes=parsed.size_bytes,
                    pageCount=parsed.page_count,
                    chunkCount=len(parsed.chunks),
                    imageCount=parsed.image_count,
                    hasImages=parsed.has_images,
                )
            )
            record.documents.append(parsed)

        max_chunks = get_settings().max_chunks
        if len(owned) > max_chunks:
            logger.warning("truncating %d chunks to the %d budget", len(owned), max_chunks)
            owned = owned[:max_chunks]

        record.chunks = owned
        # Only image-only pages make the multimodal metrics meaningful: a chart
        # embedded in a page of prose is already represented by that prose.
        record.image_only_pages = {
            (document.id, page)
            for document in record.documents
            for page in document.image_only_page_numbers
        }
        record.multimodal = bool(record.image_only_pages)

        if owned:
            vectors = await active.embed([item.chunk.text for item in owned])
            if len(vectors) != len(owned):
                raise ProviderRequestError(
                    "The embedding provider returned a different number of vectors than inputs."
                )
            index = VectorIndex(
                metric=config.distance_metric,
                dimensions=config.embedding_dimension,
            )
            index.add(
                IndexedChunk(
                    chunk=indexed.chunk,
                    document_id=indexed.document_id,
                    document_name=indexed.document_name,
                    vector=vector,
                )
                for indexed, vector in zip(owned, vectors, strict=True)
            )
            record.index = index
        else:
            # A pipeline with no documents still answers, from the model alone.
            record.index = VectorIndex(
                metric=config.distance_metric, dimensions=config.embedding_dimension
            )

        STORE.put(record)
        await STORE.mirror(record)

        citations = [
            CitationModel(
                chunkId=f"{item.document_id}:{item.chunk.index}",
                documentId=item.document_id,
                documentName=item.document_name,
                page=item.chunk.page,
                score=0.0,
                snippet=snippet(item.chunk.text),
            )
            for item in owned[:12]
        ]

        logger.info(
            "index built session=%s documents=%d chunks=%d duration_ms=%d multimodal=%s",
            session.session_id,
            len(summaries),
            len(owned),
            int((time.perf_counter() - started) * 1000),
            record.multimodal,
        )

        return {
            "engineSessionId": session.session_id,
            "documents": summaries,
            "chunkCount": len(owned),
            "citations": citations,
            "multimodal": record.multimodal,
        }

    # ----------------------------------------------------------------- retrieval

    async def retrieve(
        self,
        *,
        session: EngineSession,
        provider: ProviderClient,
        query: str,
        top_k: int | None = None,
        record: SessionRecord | None = None,
    ) -> RetrievalOutcome:
        """Embeds a query and returns the top-K chunks for it."""

        active = record or STORE.require(session.session_id)
        index = active.index
        if index is None:
            raise ValidationError("The pipeline has no index yet.")

        k = min(10, max(1, top_k or session.config.top_k))
        if index.chunk_count == 0:
            return RetrievalOutcome(chunks=[], scores=[], noise_floor=0.0)

        vector = await provider.embed_one(query)
        hits = index.search(vector, k)
        owned = _to_owned(active, hits)
        tail = index.tail_similarity(vector, k)
        return RetrievalOutcome(
            chunks=owned,
            scores=[hit.score for hit in hits],
            noise_floor=tail if tail is not None else 0.0,
        )

    async def _compress_query(
        self,
        *,
        provider: ProviderClient,
        question: str,
        history: Sequence[ChatTurn],
    ) -> str:
        """Rewrites the latest message as a standalone query when needed."""

        usable = [turn for turn in history if turn.role in {"user", "assistant"}][-6:]
        if not usable:
            return question

        messages = build_compression_messages(
            [
                *[
                    ChatMessage(
                        role=turn.role,
                        content=turn.content[:1500],
                    )
                    for turn in usable
                ],
                ChatMessage(role="user", content=question),
            ]
        )
        try:
            completion = await provider.complete(messages, temperature=0.0, max_tokens=120)
        except ProviderRequestError as error:
            logger.warning("query compression failed, using the raw question: %s", error)
            return question

        rewritten = completion.text.strip().splitlines()[0] if completion.text.strip() else ""
        if not rewritten or len(rewritten) > 600:
            return question
        return rewritten

    def _clamp_context(
        self, config: PipelineConfig, owned: Sequence[OwnedChunk]
    ) -> list[OwnedChunk]:
        """Reserves room for history and the answer inside the context window."""

        history_budget = min(1024, config.max_input_tokens // 4)
        context_budget = max(256, config.max_input_tokens - history_budget - 512)
        return truncate_context(owned, context_budget)

    async def _agentic_retrieve(
        self,
        *,
        session: EngineSession,
        provider: ProviderClient,
        question: str,
        history: Sequence[ChatTurn],
    ) -> RetrievalOutcome:
        """Multi-hop retrieval: models call `retrieve` until they stop asking.

        Tool calls are expressed as a JSON protocol in the prompt because not
        every supported provider implements native tool calling — DeepSeek and
        Ollama both ship models that ignore the `tools` field silently. A JSON
        ask works uniformly and degrades to plain retrieval when the model does
        not answer with a tool call.
        """

        collected: list[OwnedChunk] = []
        scores: list[float] = []
        seen: set[str] = set()
        query = question
        instruction = (
            "You may request evidence before answering. To do so reply with JSON only: "
            '{"tool":"retrieve","query":"<search query>","top_k":5}. '
            'Otherwise reply with JSON only: {"tool":"answer"}.'
        )

        for hop in range(MAX_AGENTIC_HOPS):
            messages = [
                ChatMessage(role="system", content=instruction),
                *[
                    ChatMessage(role=turn.role, content=turn.content[:1200])
                    for turn in history[-4:]
                ],
                ChatMessage(role="user", content=f"Question so far: {query}"),
            ]
            completion = await provider.complete(messages, temperature=0.0, max_tokens=200)
            decision = _parse_tool_decision(completion.text)
            if decision is None or decision.get("tool") != "retrieve":
                logger.info("agentic loop finished after %d hops", hop)
                break

            hop_query = str(decision.get("query") or query)
            top_k = int(decision.get("top_k") or session.config.top_k)
            outcome = await self.retrieve(
                session=session, provider=provider, query=hop_query, top_k=top_k
            )
            for item, score in zip(outcome.chunks, outcome.scores, strict=True):
                key = f"{item.document_id}:{item.chunk.index}"
                if key in seen:
                    continue
                seen.add(key)
                collected.append(item)
                scores.append(score)
            query = hop_query

        if not collected:
            return await self.retrieve(session=session, provider=provider, query=question)

        return RetrievalOutcome(chunks=collected, scores=scores, noise_floor=0.0)

    # ---------------------------------------------------------------- answering

    async def answer(
        self,
        *,
        session: EngineSession,
        question: str,
        history: Sequence[ChatTurn] = (),
        provider: Any = None,
    ) -> AnswerResult:
        """Produces a grounded, cited answer."""

        guardrails.enforce(question)
        started = time.perf_counter()
        config = session.config
        active = provider or build_provider(config, session.api_key)

        record = STORE.get(session.session_id)
        if record is None or record.index is None:
            logger.info("index missing for %s; rebuilding before answering", session.session_id)
            await self.ensure_index(session, active)
            record = STORE.require(session.session_id)

        effective_history = list(history) if history else list(record.history)
        question = truncate_question(question, max(64, config.max_input_tokens // 3))

        standalone = await self._compress_query(
            provider=active, question=question, history=effective_history
        )

        if config.retrieval_mode == "agentic":
            outcome = await self._agentic_retrieve(
                session=session,
                provider=active,
                question=standalone,
                history=effective_history,
            )
        else:
            outcome = await self.retrieve(
                session=session, provider=active, query=standalone, record=record
            )

        clamped = self._clamp_context(config, outcome.chunks)
        context_block = format_context_block(sanitise_chunks(clamped))

        history_budget = min(1024, config.max_input_tokens // 4)
        messages = build_answer_messages(
            question=standalone,
            context_block=context_block or "(no context retrieved)",
            history=[
                ChatMessage(role=message.role, content=message.content)
                for message in clamp_history(
                    [
                        ChatMessage(role=turn.role, content=turn.content)
                        for turn in effective_history
                    ],
                    history_budget,
                )
            ],
            agentic=False,
        )

        completion = await active.complete(messages, temperature=0.0)
        usage = completion.usage

        faithfulness: float | None = None
        answer_text = completion.text.strip()
        fallback = False

        if clamped:
            faithfulness = await self.faithfulness(
                provider=active, context_block=context_block, answer=answer_text
            )
            if faithfulness is not None and faithfulness < get_settings().groundedness_threshold:
                logger.info(
                    "groundedness gate rejected an answer session=%s score=%.3f",
                    session.session_id,
                    faithfulness,
                )
                answer_text = FALLBACK_ANSWER
                fallback = True
        elif not answer_text:
            answer_text = FALLBACK_ANSWER
            fallback = True

        citations = [] if fallback else to_citations(clamped, outcome.scores)

        logger.info(
            "answer session=%s mode=%s retrieved=%d kept=%d prompt_tokens=%d completion_tokens=%d "
            "faithfulness=%s duration_ms=%d fallback=%s",
            session.session_id,
            config.retrieval_mode,
            len(outcome.chunks),
            len(clamped),
            usage.prompt_tokens,
            usage.completion_tokens,
            faithfulness,
            int((time.perf_counter() - started) * 1000),
            fallback,
        )

        return AnswerResult(
            answer=answer_text,
            citations=citations,
            fallback=fallback,
            standalone_query=standalone,
            retrieved=len(outcome.chunks),
            usage=usage,
            faithfulness=faithfulness,
            retrieved_chunks=clamped,
        )

    async def answer_stream(
        self,
        *,
        session: EngineSession,
        question: str,
        history: Sequence[ChatTurn] = (),
        provider: Any = None,
    ) -> AsyncIterator[dict[str, Any]]:
        """Streams a grounded answer as engine events.

        Yields `citations` before the first token so the panel is populated while
        generation is still running, then `token` frames, then `done` with the
        usage summary.
        """

        guardrails.enforce(question)
        config = session.config
        active = provider or build_provider(config, session.api_key)

        record = STORE.get(session.session_id)
        if record is None or record.index is None:
            await self.ensure_index(session, active)
            record = STORE.require(session.session_id)

        effective_history = list(history) if history else list(record.history)
        question = truncate_question(question, max(64, config.max_input_tokens // 3))
        standalone = await self._compress_query(
            provider=active, question=question, history=effective_history
        )

        yield {"event": "status", "data": {"phase": "retrieval", "message": "Retrieving sources"}}

        outcome = await self.retrieve(
            session=session, provider=active, query=standalone, record=record
        )
        clamped = self._clamp_context(config, outcome.chunks)
        citations = to_citations(clamped, outcome.scores)

        yield {
            "event": "citations",
            "data": {
                "citations": [citation.model_dump(by_alias=True) for citation in citations],
                "standaloneQuery": standalone,
                "retrieved": len(outcome.chunks),
            },
        }

        context_block = format_context_block(sanitise_chunks(clamped))

        history_budget = min(1024, config.max_input_tokens // 4)
        messages = build_answer_messages(
            question=standalone,
            context_block=context_block or "(no context retrieved)",
            history=[
                ChatMessage(role=message.role, content=message.content)
                for message in clamp_history(
                    [
                        ChatMessage(role=turn.role, content=turn.content)
                        for turn in effective_history
                    ],
                    history_budget,
                )
            ],
            agentic=False,
        )

        yield {"event": "status", "data": {"phase": "generation", "message": "Writing the answer"}}

        buffer: list[str] = []
        usage = Usage()
        async for delta in active.stream(messages, temperature=0.0):
            if delta.usage is not None:
                usage = delta.usage
            if delta.text:
                buffer.append(delta.text)
                yield {"event": "token", "data": {"text": delta.text}}

        answer_text = "".join(buffer).strip()
        faithfulness: float | None = None
        fallback = False

        if clamped and answer_text:
            yield {
                "event": "status",
                "data": {"phase": "groundedness", "message": "Checking groundedness"},
            }
            faithfulness = await self.faithfulness(
                provider=active, context_block=context_block, answer=answer_text
            )
            if faithfulness is not None and faithfulness < get_settings().groundedness_threshold:
                answer_text = FALLBACK_ANSWER
                fallback = True
                yield {"event": "replacement", "data": {"answer": FALLBACK_ANSWER}}
        elif not answer_text:
            answer_text = FALLBACK_ANSWER
            fallback = True
            yield {"event": "replacement", "data": {"answer": FALLBACK_ANSWER}}

        logger.info(
            "stream answer session=%s retrieved=%d kept=%d faithfulness=%s fallback=%s",
            session.session_id,
            len(outcome.chunks),
            len(clamped),
            faithfulness,
            fallback,
        )

        yield {
            "event": "done",
            "data": {
                "answer": answer_text,
                "fallback": fallback,
                "faithfulness": faithfulness,
                "usage": {
                    "promptTokens": usage.prompt_tokens,
                    "completionTokens": usage.completion_tokens,
                },
                "citations": [citation.model_dump(by_alias=True) for citation in citations],
            },
        }

    # -------------------------------------------------------------- groundedness

    async def faithfulness(
        self, *, provider: ProviderClient, context_block: str, answer: str
    ) -> float | None:
        """Scores answer support against the retrieved context.

        This is the Ragas `faithfulness` definition — supported claims over total
        claims — implemented directly as a strict JSON judgement so the engine
        does not need the `ragas` package and its dependency tree on Vercel.
        Returns None when the judge is unusable, in which case the caller keeps
        the answer rather than discarding a possibly fine response.
        """

        if not answer.strip():
            return 0.0

        messages = build_groundedness_messages(
            context_block[: GROUNDEDNESS_CONTEXT_TOKENS * 4], answer
        )
        try:
            completion = await provider.complete(messages, temperature=0.0, max_tokens=600)
        except ProviderRequestError as error:
            logger.warning("groundedness judge unavailable: %s", error)
            return None

        claims = _parse_claims(completion.text)
        if not claims:
            return None
        supported = sum(1 for claim in claims if claim)
        return round(supported / len(claims), 4)

    # ------------------------------------------------------------------ reset

    async def reset(self, session_id: str) -> dict[str, Any]:
        """Purges the session's index, documents and history."""

        existed = STORE.drop(session_id)
        await STORE.forget(session_id)
        return {"cleared": existed or True}


def _parse_tool_decision(text: str) -> dict[str, Any] | None:
    """Extracts a JSON tool decision from a model reply."""

    candidate = text.strip()
    if not candidate:
        return None
    match = re.search(r"\{.*\}", candidate, re.S)
    if match is None:
        return None
    try:
        parsed = json.loads(match.group(0))
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _parse_claims(text: str) -> list[bool]:
    """Parses the groundedness judge reply into a support vector."""

    match = re.search(r"\{.*\}", text, re.S)
    if match is None:
        return []
    try:
        body = json.loads(match.group(0))
    except json.JSONDecodeError:
        return []
    claims = body.get("claims")
    if not isinstance(claims, list):
        return []
    verdicts: list[bool] = []
    for claim in claims:
        if isinstance(claim, dict):
            value = claim.get("supported")
            if isinstance(value, bool):
                verdicts.append(value)
            elif isinstance(value, str):
                verdicts.append(value.strip().lower() in {"true", "yes", "supported"})
    return verdicts


def cosine_keyword_overlap(left: str, right: str) -> float:
    """Deterministic lexical similarity, used by metrics that must not spend tokens."""

    left_tokens = {token for token in re.findall(r"[a-z0-9]+", left.lower()) if len(token) > 2}
    right_tokens = {token for token in re.findall(r"[a-z0-9]+", right.lower()) if len(token) > 2}
    if not left_tokens or not right_tokens:
        return 0.0
    overlap = left_tokens & right_tokens
    return round(len(overlap) / len(left_tokens | right_tokens), 4)


def score_similarity(
    metric: DistanceMetric,
    left: str,
    right: str,
    embeddings: tuple[list[float], list[float]],
) -> float:
    """Similarity between two texts under the configured metric.

    `left` and `right` are accepted for logging symmetry with the caller; the
    comparison itself is vector-based, which is why they are otherwise unused.
    """

    del left, right
    return round(similarity(metric, embeddings[0], embeddings[1]), 4)


def entity_overlap(reference: str, candidate: str) -> float:
    """Approximates context entity recall with capitalised-token overlap.

    A full NER pass would mean shipping spaCy; capitalised tokens are a good
    proxy for the named entities Ragas' metric actually cares about.
    """

    def entities(text: str) -> set[str]:
        return {token.lower() for token in re.findall(r"\b[A-Z][a-zA-Z0-9]{2,}\b", text)}

    reference_entities = entities(reference)
    if not reference_entities:
        return 0.0
    candidate_entities = entities(candidate)
    return round(len(reference_entities & candidate_entities) / len(reference_entities), 4)


SERVICE = RagdollService()
