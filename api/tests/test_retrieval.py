"""Unit tests for the retrieval core: chunking, scoring, the vector index and
PDF sandbox validation. These are the pieces where a subtle defect degrades
answer quality without ever raising an error, so they assert exact values rather
than invariants alone.
"""

from __future__ import annotations

import base64

import pytest

from app.chunking import (
    chunk_document,
    chunk_page,
    estimate_tokens,
    normalise_text,
    truncate_to_tokens,
)
from app.distance import IndexedChunk, VectorIndex, l2_normalise, similarity
from app.errors import PdfRejectedError, ValidationError
from app.pdf import decode_base64, enforce_upload_budget, parse_document
from tests.conftest import build_pdf


class TestEstimateTokens:
    def test_empty_input_is_zero(self) -> None:
        assert estimate_tokens("   \n  ") == 0

    def test_four_characters_per_token(self) -> None:
        assert estimate_tokens("abcd") == 1
        assert estimate_tokens("a" * 400) == 100

    def test_never_returns_zero_for_content(self) -> None:
        assert estimate_tokens("a") == 1


class TestNormaliseText:
    def test_collapses_horizontal_whitespace(self) -> None:
        assert normalise_text("a   \t b") == "a b"

    def test_keeps_paragraph_breaks(self) -> None:
        assert normalise_text("a\n\n\n\nb") == "a\n\nb"

    def test_drops_nulls(self) -> None:
        assert normalise_text("a\x00b") == "a b"


class TestChunkPage:
    def test_short_page_is_one_chunk(self) -> None:
        chunks = chunk_page(
            "Retention is seven years.", chunk_size=512, chunk_overlap_tokens=64, page=3
        )
        assert len(chunks) == 1
        assert chunks[0].page == 3
        assert chunks[0].index == 0

    def test_empty_page_yields_nothing(self) -> None:
        assert chunk_page("   ", chunk_size=512, chunk_overlap_tokens=64, page=1) == []

    def test_long_page_splits_into_overlapping_windows(self) -> None:
        words = [f"token{index}" for index in range(400)]
        chunks = chunk_page(" ".join(words), chunk_size=128, chunk_overlap_tokens=32, page=1)
        assert len(chunks) > 2
        # Consecutive windows must share vocabulary; that is what overlap means.
        assert set(chunks[0].text.split()) & set(chunks[1].text.split())

    def test_indices_are_sequential(self) -> None:
        words = [f"w{index}" for index in range(300)]
        chunks = chunk_page(" ".join(words), chunk_size=128, chunk_overlap_tokens=32, page=1)
        assert [chunk.index for chunk in chunks] == list(range(len(chunks)))

    def test_rejects_overlap_larger_than_chunk(self) -> None:
        with pytest.raises(ValidationError):
            chunk_page("text", chunk_size=32, chunk_overlap_tokens=64, page=1)

    def test_rejects_non_positive_chunk_size(self) -> None:
        with pytest.raises(ValidationError):
            chunk_page("text", chunk_size=0, chunk_overlap_tokens=0, page=1)


class TestChunkDocument:
    def test_indices_are_global_across_pages(self) -> None:
        chunks = chunk_document(
            [(1, "First page content."), (2, "Second page content.")],
            chunk_size=512,
            chunk_overlap_tokens=64,
        )
        assert [chunk.index for chunk in chunks] == [0, 1]
        assert [chunk.page for chunk in chunks] == [1, 2]


class TestTruncateToTokens:
    def test_short_text_is_unchanged(self) -> None:
        assert truncate_to_tokens("short text", 100) == "short text"

    def test_long_text_is_cut_on_a_word_boundary(self) -> None:
        text = " ".join(f"word{index}" for index in range(500))
        truncated = truncate_to_tokens(text, 32)
        assert len(truncated.split()) < 500
        assert not truncated.endswith(" ")

    def test_zero_budget_returns_empty(self) -> None:
        assert truncate_to_tokens("text", 0) == ""


class TestSimilarity:
    def test_cosine_ignores_magnitude(self) -> None:
        assert similarity("cosine", [1.0, 0.0], [5.0, 0.0]) == pytest.approx(1.0)

    def test_dot_product_rewards_magnitude(self) -> None:
        assert similarity("dot", [1.0, 0.0], [5.0, 0.0]) == pytest.approx(5.0)

    def test_euclidean_is_inverted_so_higher_is_closer(self) -> None:
        assert similarity("euclidean", [0.0, 0.0], [1.0, 0.0]) > similarity(
            "euclidean", [0.0, 0.0], [10.0, 0.0]
        )

    def test_dimension_mismatch_is_rejected(self) -> None:
        with pytest.raises(ValidationError):
            similarity("cosine", [1.0], [1.0, 2.0])

    def test_l2_normalise_handles_the_zero_vector(self) -> None:
        assert l2_normalise([0.0, 0.0]) == [0.0, 0.0]


def _indexed(text: str, index: int, page: int, vector: list[float], document: str) -> IndexedChunk:
    from app.chunking import TextChunk

    return IndexedChunk(
        chunk=TextChunk(index=index, text=text, token_count=1, page=page),
        document_id=document,
        document_name=f"{document}.pdf",
        vector=vector,
    )


def build_index(metric: str = "cosine") -> VectorIndex:
    index = VectorIndex(metric=metric, dimensions=2)  # type: ignore[arg-type]
    index.add(
        [
            _indexed("apples", 0, 1, [1.0, 0.0], "doc-1"),
            _indexed("oranges", 1, 1, [0.0, 1.0], "doc-1"),
            _indexed("pears", 2, 2, [0.7, 0.7], "doc-2"),
        ]
    )
    return index


class TestVectorIndex:
    def test_search_ranks_by_score(self) -> None:
        hits = build_index().search([1.0, 0.0], 2)
        assert [hit.chunk.text for hit in hits] == ["apples", "pears"]
        assert hits[0].score >= hits[1].score

    def test_search_respects_top_k(self) -> None:
        assert len(build_index().search([1.0, 0.0], 1)) == 1

    def test_search_returns_document_identity(self) -> None:
        hit = build_index().search([1.0, 0.0], 1)[0]
        assert hit.document_id == "doc-1"
        assert hit.document_name == "doc-1.pdf"
        assert hit.chunk.page == 1

    def test_empty_index_returns_no_hits(self) -> None:
        assert VectorIndex(metric="cosine", dimensions=2).search([1.0, 0.0], 5) == []

    def test_add_rejects_a_width_mismatch(self) -> None:
        index = VectorIndex(metric="cosine", dimensions=3)
        with pytest.raises(ValidationError):
            index.add([_indexed("x", 0, 1, [1.0, 0.0], "doc-1")])

    def test_tail_similarity_is_none_when_the_index_is_small(self) -> None:
        assert build_index().tail_similarity([1.0, 0.0], 5) is None

    def test_tail_similarity_averages_the_unretrieved_rest(self) -> None:
        tail = build_index().tail_similarity([1.0, 0.0], 1)
        assert tail is not None
        assert 0.0 <= tail <= 1.0

    def test_chunk_count_and_memory_estimate(self) -> None:
        index = build_index()
        assert index.chunk_count == 3
        assert index.memory_bytes() > 0


class TestDecodeBase64:
    def test_accepts_a_real_pdf(self) -> None:
        raw = build_pdf(["hello"])
        assert decode_base64(base64.b64encode(raw).decode(), document_name="a.pdf") == raw

    def test_rejects_invalid_base64(self) -> None:
        with pytest.raises(PdfRejectedError):
            decode_base64("not base64!!!", document_name="a.pdf")

    def test_rejects_a_non_pdf_payload(self) -> None:
        with pytest.raises(PdfRejectedError) as error:
            decode_base64(base64.b64encode(b"plain text").decode(), document_name="a.pdf")
        assert error.value.code == "pdf_invalid"

    def test_rejects_a_truncated_pdf(self) -> None:
        raw = build_pdf(["hello"])[:-40]
        with pytest.raises(PdfRejectedError):
            decode_base64(base64.b64encode(raw).decode(), document_name="a.pdf")

    def test_rejects_an_oversized_payload(self) -> None:
        payload = b"%PDF-1.7\n" + b"x" * (2 * 1024 * 1024)
        with pytest.raises(PdfRejectedError):
            decode_base64(base64.b64encode(payload).decode(), document_name="a.pdf")


class TestEnforceUploadBudget:
    def test_accepts_three_small_files(self) -> None:
        enforce_upload_budget([1024, 1024, 1024])

    def test_rejects_four_files(self) -> None:
        with pytest.raises(PdfRejectedError):
            enforce_upload_budget([1, 1, 1, 1])

    def test_rejects_an_oversized_file(self) -> None:
        with pytest.raises(PdfRejectedError):
            enforce_upload_budget([2 * 1024 * 1024 + 1])


class TestParseDocument:
    def test_extracts_text_and_chunks_it(self) -> None:
        raw = build_pdf(["Retention is seven years.", "Archiving happens quarterly."])
        parsed = parse_document(
            document_id="doc-1",
            name="handbook.pdf",
            payload_base64=base64.b64encode(raw).decode(),
            chunk_size=512,
            chunk_overlap_tokens=64,
        )
        assert parsed.id == "doc-1"
        assert parsed.page_count == 2
        assert len(parsed.chunks) >= 2
        assert any("Retention" in chunk.text for chunk in parsed.chunks)
        assert parsed.has_images is False

    def test_rejects_active_content(self) -> None:
        # A catalogue carrying /OpenAction is disqualifying regardless of payload.
        raw = build_pdf(["text"]).replace(b"/Type /Catalog", b"/Type /Catalog /OpenAction 5 0 R")
        with pytest.raises(PdfRejectedError) as error:
            parse_document(
                document_id="doc-1",
                name="nasty.pdf",
                payload_base64=base64.b64encode(raw).decode(),
                chunk_size=512,
                chunk_overlap_tokens=64,
            )
        assert error.value.code == "pdf_active_content"
