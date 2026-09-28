"""Tokenisation and chunking.

The chunker is the only place that decides how a PDF becomes retrievable spans,
so it is deliberately dependency-free and unit-tested against the exact numbers
the UI displays (chunk size, overlap percentage, overlap tokens).
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from errors import ValidationError

# Paragraph and sentence boundaries, in preference order.
_PARAGRAPH_SPLIT = re.compile(r"\n\s*\n")
_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9\"'(\[])")
_WORD_SPLIT = re.compile(r"\S+")
_TOKEN_CHARS = 4


def estimate_tokens(text: str) -> int:
    """Approximates a token count from characters.

    A character-based estimate keeps the engine free of model-specific
    tokenisers while staying within roughly ±10% of BPE counts on prose, which is
    all the chunker and the context-window guard need.
    """

    stripped = text.strip()
    if not stripped:
        return 0
    return max(1, (len(stripped) + _TOKEN_CHARS - 1) // _TOKEN_CHARS)


def split_words(text: str) -> list[str]:
    """Whitespace tokenisation used to size chunks precisely."""

    return _WORD_SPLIT.findall(text)


def normalise_text(text: str) -> str:
    """Collapses whitespace while preserving paragraph breaks."""

    without_nulls = text.replace("\x00", " ")
    collapsed_lines = re.sub(r"[ \t\f\v]+", " ", without_nulls)
    collapsed_blank_lines = re.sub(r"\n{3,}", "\n\n", collapsed_lines)
    return collapsed_blank_lines.strip()


@dataclass(frozen=True, slots=True)
class TextChunk:
    """A retrievable span with the metadata the citation panel needs.

    Document identity is intentionally absent: the owning document is tracked by
    the session record so a chunk cannot disagree with its source.
    """

    index: int
    text: str
    token_count: int
    page: int


def _windows(words: list[str], size: int, overlap: int) -> list[tuple[int, int]]:
    """Produces (start, end) word offsets for a sliding window."""

    if size <= 0:
        raise ValidationError("chunk size must be positive")
    step = max(1, size - overlap)
    spans: list[tuple[int, int]] = []
    start = 0
    total = len(words)
    while start < total:
        end = min(total, start + size)
        spans.append((start, end))
        if end >= total:
            break
        start += step
    return spans


def _sentence_boundaries(words: list[str]) -> set[int]:
    """Word offsets that follow a sentence terminator."""

    boundaries: set[int] = set()
    for position, word in enumerate(words):
        if word.endswith((".", "!", "?", ":", ";")):
            boundaries.add(position + 1)
    return boundaries


def chunk_page(
    page_text: str,
    *,
    chunk_size: int,
    chunk_overlap_tokens: int,
    page: int,
    start_index: int = 0,
) -> list[TextChunk]:
    """Splits one page into overlapping chunks.

    Overlap is expressed in tokens; words are converted at the same 4-chars
    approximation so the UI's "tokens" read-out matches reality.
    """

    if chunk_size <= 0:
        raise ValidationError("chunk size must be positive")
    if chunk_overlap_tokens >= chunk_size:
        raise ValidationError("chunk overlap must be smaller than the chunk size")

    normalised = normalise_text(page_text)
    if not normalised:
        return []

    size_words = max(8, round(chunk_size * _TOKEN_CHARS / 6))
    overlap_words = max(0, round(chunk_overlap_tokens * _TOKEN_CHARS / 6))

    paragraphs = [block for block in _PARAGRAPH_SPLIT.split(normalised) if block.strip()]
    chunks: list[TextChunk] = []
    index = start_index

    for paragraph in paragraphs:
        words = split_words(paragraph)
        if len(words) <= size_words:
            text = " ".join(words).strip()
            if text:
                chunks.append(
                    TextChunk(
                        index=index,
                        text=text,
                        token_count=estimate_tokens(text),
                        page=page,
                    )
                )
                index += 1
            continue

        boundaries = _sentence_boundaries(words)
        for start, end in _windows(words, size_words, overlap_words):
            window = words[start:end]
            if overlap_words > 0 and start > 0:
                # Prefer snapping the window start to a sentence boundary so a
                # citation does not begin mid-clause.
                candidates = [b for b in boundaries if start <= b <= start + overlap_words]
                if candidates:
                    window = words[min(candidates) : end]
            text = " ".join(window).strip()
            if text:
                chunks.append(
                    TextChunk(
                        index=index,
                        text=text,
                        token_count=estimate_tokens(text),
                        page=page,
                    )
                )
                index += 1

    return chunks


def chunk_document(
    pages: list[tuple[int, str]],
    *,
    chunk_size: int,
    chunk_overlap_tokens: int,
) -> list[TextChunk]:
    """Chunks a whole document, keeping a stable global index."""

    chunks: list[TextChunk] = []
    for page_number, page_text in pages:
        page_chunks = chunk_page(
            page_text,
            chunk_size=chunk_size,
            chunk_overlap_tokens=chunk_overlap_tokens,
            page=page_number,
            start_index=len(chunks),
        )
        chunks.extend(page_chunks)
    return chunks


def truncate_to_tokens(text: str, max_tokens: int) -> str:
    """Truncates text to fit a token budget, preserving word boundaries."""

    if max_tokens <= 0:
        return ""
    if estimate_tokens(text) <= max_tokens:
        return text
    max_words = max(1, round(max_tokens * _TOKEN_CHARS / 6))
    words = split_words(text)
    if len(words) <= max_words:
        return text
    return " ".join(words[:max_words]).strip()
