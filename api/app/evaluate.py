"""Ragas-style evaluation.

Eight metrics, reported under the single "Retrieval Augmented Generation"
category. They split into three kinds:

  * deterministic ranking scores (context precision, noise sensitivity) — free,
    reproducible, and immune to judge drift;
  * deterministic entity and coverage scores (context entity recall, context
    recall) — the parts of Ragas' metrics that do not need a model call;
  * judged scores (response relevancy, faithfulness, plus the multimodal pair)
    — strict JSON judgements over the same definitions Ragas uses.

The question set is synthesised from sampled chunks and the answers come from
the pipeline's own answering path, so the report measures the configured
pipeline rather than a model in isolation.
"""

from __future__ import annotations

import json
import logging
import re
import time
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any, Protocol

from .distance import VectorIndex, similarity
from .errors import ProviderRequestError, ValidationError
from .llm import ChatMessage
from .prompts import (
    build_groundedness_messages,
    build_question_messages,
    format_context_block,
    snippet,
)
from .providers import EVALUATION_METRICS, MULTIMODAL_METRICS
from .rag import (
    SERVICE,
    AnswerResult,
    RagdollService,
    build_provider,
    entity_overlap,
    sanitise_chunks,
)
from .schemas import EngineSession, EvaluationReport, EvaluationSample, MetricResult
from .store import STORE, OwnedChunk

logger = logging.getLogger("ragdoll.evaluate")

MIN_CHUNK_CHARS = 240
MAX_CONTEXT_CHARS = 1200
MAX_JUDGE_CONTEXT_CHARS = 4000


class Judge(Protocol):
    """Minimal provider surface the evaluator needs; a stub keeps tests offline."""

    async def complete(
        self,
        messages: Sequence[ChatMessage],
        *,
        temperature: float = 0.0,
        max_tokens: int | None = None,
    ) -> Any: ...

    async def embed(self, texts: Sequence[str]) -> list[list[float]]: ...

    async def embed_one(self, text: str) -> list[float]: ...


def _content_words(text: str) -> set[str]:
    return {token for token in re.findall(r"[a-z0-9]+", text.lower()) if len(token) > 2}


def _lexical_overlap(left: str, right: str) -> float:
    """Jaccard overlap over content words."""

    left_tokens = _content_words(left)
    right_tokens = _content_words(right)
    if not left_tokens or not right_tokens:
        return 0.0
    return len(left_tokens & right_tokens) / len(left_tokens | right_tokens)


def _answer_claims_to_context(answer: str, context: str) -> float:
    """Sentence-level support ratio, used when the judge is unavailable."""

    sentences = [
        segment.strip() for segment in re.split(r"(?<=[.!?])\s+", answer) if segment.strip()
    ]
    if not sentences:
        return 0.0
    supported = sum(1 for sentence in sentences if _lexical_overlap(sentence, context) >= 0.35)
    return supported / len(sentences)


def _supported_claims(text: str) -> list[bool]:
    """Parses a groundedness judgement into a support vector."""

    match = re.search(r"\{.*\}", text, re.S)
    if match is None:
        return []
    try:
        body = json.loads(match.group(0))
    except json.JSONDecodeError:
        return []
    raw = body.get("claims")
    if not isinstance(raw, list):
        return []
    return [
        bool(claim["supported"])
        for claim in raw
        if isinstance(claim, dict) and isinstance(claim.get("supported"), bool)
    ]


def _pick_chunks(chunks: Sequence[OwnedChunk], count: int) -> list[OwnedChunk]:
    """Evenly samples chunks, preferring ones long enough to yield a question."""

    eligible = [item for item in chunks if len(item.chunk.text) >= MIN_CHUNK_CHARS]
    pool = eligible or list(chunks)
    if not pool:
        return []
    if len(pool) <= count:
        return list(pool)
    step = len(pool) / count
    return [pool[min(len(pool) - 1, int(index * step))] for index in range(count)]


class Evaluator:
    """Runs the metric suite for one session."""

    def __init__(self, service: RagdollService | None = None) -> None:
        self._service = service or SERVICE

    async def run(
        self,
        *,
        session: EngineSession,
        sample_count: int,
        provider: Judge | None = None,
    ) -> EvaluationReport:
        """Executes every metric and assembles the report."""

        started = time.perf_counter()
        # One object fills both roles: `judge` is the narrow protocol the metrics
        # need, and the same value goes to the service so indexing and answering
        # use the caller's provider instead of constructing a real one.
        judge: Judge = provider or build_provider(session.config, session.api_key)
        active: Any = provider

        record = STORE.get(session.session_id)
        if record is None or record.index is None:
            await self._service.ensure_index(session, active)
            record = STORE.get(session.session_id)
        if record is None or record.index is None:
            raise ValidationError("The pipeline has no index to evaluate.")
        if record.index.chunk_count == 0:
            raise ValidationError(
                "Add at least one PDF and rebuild the pipeline before evaluating."
            )

        samples = _pick_chunks(record.owned_chunks(), max(1, min(12, sample_count)))
        multimodal = record.multimodal

        collected: list[EvaluationSample] = []
        per_metric: dict[str, list[float]] = {metric: [] for metric in EVALUATION_METRICS}

        for index, owned in enumerate(samples):
            question = await self._question_for(judge, owned.chunk.text)
            result: AnswerResult = await self._service.answer(
                session=session, question=question, history=[], provider=active
            )

            sanitised = sanitise_chunks(result.retrieved_chunks)
            context_text = "\n\n".join(item.chunk.text for item in sanitised)
            precision = self._precision(result, context_text)
            noise = await self._noise_sensitivity(judge, question, record.index)
            relevancy = await self._relevance(judge, question, result)

            faithfulness = result.faithfulness
            if faithfulness is None:
                faithfulness = _answer_claims_to_context(result.answer, context_text)

            per_metric["context_precision"].append(precision)
            per_metric["context_recall"].append(
                self._context_recall(owned.chunk.text, context_text)
            )
            per_metric["context_entity_recall"].append(
                entity_overlap(owned.chunk.text, context_text)
            )
            if noise is not None:
                per_metric["noise_sensitivity"].append(noise)
            per_metric["response_relevancy"].append(relevancy)
            per_metric["faithfulness"].append(faithfulness)

            if multimodal:
                multimodal_faithfulness = await self._multimodal_faithfulness(judge, result)
                if multimodal_faithfulness is not None:
                    per_metric["multimodal_faithfulness"].append(multimodal_faithfulness)
                # Scored only against citations that point at image-only pages, so
                # this is not a second copy of `response_relevancy`: it answers
                # "did the answer use the pages that needed vision at all?".
                visual_relevance = self._visual_relevance(result, record.image_only_pages)
                if visual_relevance is not None:
                    per_metric["multimodal_relevance"].append(visual_relevance)

            collected.append(
                EvaluationSample(
                    question=question,
                    answer=result.answer,
                    groundTruth=snippet(owned.chunk.text, MAX_CONTEXT_CHARS),
                    contexts=[snippet(item.chunk.text, 400) for item in sanitised],
                    citations=result.citations,
                    fallback=result.fallback,
                )
            )
            logger.info(
                "evaluated sample=%d/%d fallback=%s precision=%.3f faithfulness=%.3f",
                index + 1,
                len(samples),
                result.fallback,
                precision,
                faithfulness,
            )

        return EvaluationReport(
            createdAt=datetime.now(UTC).isoformat(),
            durationMs=int((time.perf_counter() - started) * 1000),
            sampleCount=len(samples),
            documentCount=len(record.documents),
            metrics=self._assemble(per_metric, multimodal),
            samples=collected,
        )

    # ------------------------------------------------------------------ metrics

    def _precision(self, result: AnswerResult, context_text: str) -> float:
        """Rank-weighted share of retrieved context the answer actually used.

        A fallback answer used no context, so its precision is zero by
        definition — that is the signal the gate is meant to send.
        """

        if result.fallback or not result.retrieved_chunks or not context_text:
            return 0.0

        used = [
            item
            for item in result.retrieved_chunks
            if any(
                citation.document_id == item.document_id and citation.page == item.chunk.page
                for citation in result.citations
            )
        ]
        if not used:
            return 0.0

        flags = [
            1.0
            if any(
                citation.document_id == item.document_id and citation.page == item.chunk.page
                for citation in result.citations
            )
            else 0.0
            for item in result.retrieved_chunks
        ]
        hits = 0
        weighted = 0.0
        for rank, flag in enumerate(flags, start=1):
            if flag:
                hits += 1
                weighted += hits / rank
        return round(weighted / hits, 4) if hits else 0.0

    def _context_recall(self, ground_truth: str, context_text: str) -> float:
        """Share of ground-truth sentences covered by the retrieved context."""

        sentences = [
            segment.strip()
            for segment in re.split(r"(?<=[.!?])\s+", ground_truth)
            if len(segment.strip()) > 24
        ]
        if not sentences:
            return round(_lexical_overlap(ground_truth, context_text), 4)
        covered = sum(
            1 for sentence in sentences if _lexical_overlap(sentence, context_text) >= 0.4
        )
        return round(covered / len(sentences), 4)

    async def _noise_sensitivity(
        self, provider: Judge, question: str, index: VectorIndex
    ) -> float | None:
        """Mean similarity of the chunks the retriever did *not* surface.

        Lower is better: it means irrelevant material stayed out of the context
        window. One embedding call per sample is the only cost.
        """

        try:
            vector = await provider.embed_one(question)
        except Exception as error:
            logger.warning("noise sensitivity skipped: %s", error)
            return None

        tail = index.tail_similarity(vector, 5)
        if tail is None:
            return None
        return round(1.0 - max(0.0, min(1.0, tail)), 4)

    async def _relevance(self, provider: Judge, question: str, result: AnswerResult) -> float:
        """Response relevancy: similarity between the question and its reverse."""

        if result.fallback or not result.answer.strip():
            return 0.0

        context_block = format_context_block(sanitise_chunks(result.retrieved_chunks))
        try:
            completion = await provider.complete(
                build_question_messages(
                    context_block[:MAX_JUDGE_CONTEXT_CHARS], result.answer[:2000]
                ),
                temperature=0.0,
                max_tokens=80,
            )
        except ProviderRequestError as error:
            logger.warning("reverse question failed: %s", error)
            return round(_lexical_overlap(question, result.answer), 4)

        reverse = completion.text.strip().splitlines()[0] if completion.text.strip() else ""
        if not reverse:
            return round(_lexical_overlap(question, result.answer), 4)

        try:
            vectors = await provider.embed([question, reverse])
        except Exception as error:
            logger.warning("relevancy embedding failed: %s", error)
            return round(_lexical_overlap(question, reverse), 4)

        if len(vectors) != 2:
            return round(_lexical_overlap(question, reverse), 4)
        return round(max(0.0, min(1.0, similarity("cosine", vectors[0], vectors[1]))), 4)

    async def _multimodal_faithfulness(self, provider: Judge, result: AnswerResult) -> float | None:
        """Faithfulness of an answer against the pages whose content is an image.

        The engine does not rasterise pages — an image extraction and vision stack
        would not fit a Vercel Python function — so this judges the text the parser
        could recover from image-only pages. That is the evidence the answer could
        actually have used, and it is reported separately from text faithfulness so
        the two are never conflated.
        """

        context_block = format_context_block(sanitise_chunks(result.retrieved_chunks))
        if not context_block or result.fallback:
            return 0.0
        try:
            completion = await provider.complete(
                build_groundedness_messages(
                    context_block[:MAX_JUDGE_CONTEXT_CHARS], result.answer[:2000]
                ),
                temperature=0.0,
                max_tokens=500,
            )
        except ProviderRequestError as error:
            logger.warning("multimodal faithfulness failed: %s", error)
            return None

        claims = _supported_claims(completion.text)
        if not claims:
            return None
        return round(sum(1 for claim in claims if claim) / len(claims), 4)

    def _visual_relevance(
        self, result: AnswerResult, image_only_pages: set[tuple[str, int]]
    ) -> float | None:
        """Share of a non-fallback answer's citations that land on image-only pages.

        A distinct question from text relevancy: it measures whether the answer
        reached for the material that needed vision. Returns None when the answer
        was withheld, because a withheld answer used nothing.
        """

        if result.fallback:
            return 0.0
        if not result.citations:
            return None
        visual = sum(
            1
            for citation in result.citations
            if (citation.document_id, citation.page) in image_only_pages
        )
        return round(visual / len(result.citations), 4)

    # ------------------------------------------------------------------ assembly

    async def _question_for(self, provider: Judge, chunk_text: str) -> str:
        """Derives a question whose answer lives in the sampled chunk."""

        messages = [
            ChatMessage(
                role="system",
                content=(
                    "Write one specific question that the PASSAGE answers completely. "
                    "Reply with the question only, no preamble."
                ),
            ),
            ChatMessage(role="user", content=f"PASSAGE:\n{chunk_text[:2400]}"),
        ]
        try:
            completion = await provider.complete(messages, temperature=0.0, max_tokens=80)
        except ProviderRequestError as error:
            logger.warning("question generation failed: %s", error)
            return "What does the passage say?"

        question = completion.text.strip().splitlines()[0] if completion.text.strip() else ""
        return question or "What does the passage say?"

    def _assemble(self, per_metric: dict[str, list[float]], multimodal: bool) -> list[MetricResult]:
        """Turns collected scores into the reported metric list."""

        reasons = {
            "context_precision": "Rank-weighted share of retrieved context the answer cited.",
            "context_recall": "Ground-truth sentence coverage by the retrieved set.",
            "context_entity_recall": "Named-entity coverage of the sampled chunk.",
            "noise_sensitivity": (
                "1 minus the mean similarity of non-retrieved chunks; lower means less noise "
                "reached the context window."
            ),
            "response_relevancy": (
                "Similarity between the question and its reverse-generated question."
            ),
            "faithfulness": "Share of answer claims supported by the retrieved context.",
            "multimodal_faithfulness": (
                "Share of answer claims supported by the recovered text of pages whose "
                "content is an image."
            ),
            "multimodal_relevance": (
                "Share of citations that landed on image-only pages: did the answer "
                "reach for the material that needed vision?"
            ),
        }

        metrics: list[MetricResult] = []
        for metric in EVALUATION_METRICS:
            scores = per_metric[metric]
            if metric in MULTIMODAL_METRICS and not multimodal:
                metrics.append(
                    MetricResult(
                        metric=metric,
                        score="N/A",
                        samples=0,
                        reason=reasons[metric],
                        skippedReason=(
                            "N/A: multimodal metrics need pages whose content is an image. "
                            "Either no upload contains one, or the pages that do also carry "
                            "enough text that the text metrics already cover them."
                        ),
                    )
                )
                continue
            if not scores:
                metrics.append(
                    MetricResult(
                        metric=metric,
                        score="N/A",
                        samples=0,
                        reason=reasons[metric],
                        skippedReason="No sample produced a score for this metric.",
                    )
                )
                continue
            metrics.append(
                MetricResult(
                    metric=metric,
                    score=round(sum(scores) / len(scores), 4),
                    samples=len(scores),
                    reason=reasons[metric],
                )
            )
        return metrics


EVALUATOR = Evaluator()


async def run_evaluation(
    *, session: EngineSession, sample_count: int, provider: Judge | None = None
) -> EvaluationReport:
    """Module-level entry point used by the route and by tests."""

    return await EVALUATOR.run(session=session, sample_count=sample_count, provider=provider)
