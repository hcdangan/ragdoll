"""Sandboxed PDF parsing.

`pypdf` only — no shell-outs — with three explicit guards from AGENTS.md:
reject files containing JavaScript, embedded files, or launch actions; reject
encrypted files; and cap the work a single upload can trigger.
"""

from __future__ import annotations

import base64
import binascii
import io
from dataclasses import dataclass

from pypdf import PdfReader
from pypdf.errors import PdfReadError

from .chunking import TextChunk, chunk_document, normalise_text
from .errors import PdfRejectedError

MAX_DOCUMENTS = 3
MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_TOTAL_BYTES = 6 * 1024 * 1024
MAX_PAGES = 400
MAX_TEXT_CHARS = 2_000_000
# A page carrying an image and less text than this is essentially the image.
IMAGE_ONLY_TEXT_CHARS = 120

PDF_MAGIC = b"%PDF-"
PDF_EOF = b"%%EOF"

# Names that indicate active content. pypdf exposes /Names trees for these, and
# their presence is disqualifying regardless of whether anything executes.
_DANGEROUS_KEYS = ("/JavaScript", "/JS", "/Launch", "/EmbeddedFile", "/RichMedia", "/OpenAction")


@dataclass(frozen=True, slots=True)
class ParsedDocument:
    """Everything the index needs from one uploaded PDF."""

    id: str
    name: str
    size_bytes: int
    page_count: int
    image_count: int
    has_images: bool
    # Pages whose content is effectively the image, so no text can stand in for it.
    # Recorded by page number, not just counted: the multimodal metrics are scored
    # against exactly these pages.
    image_only_page_numbers: tuple[int, ...]
    chunks: tuple[TextChunk, ...]


def decode_base64(payload: str, *, document_name: str) -> bytes:
    """Decodes a base64 payload, rejecting anything that is not really a PDF."""

    try:
        raw = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError) as error:
        raise PdfRejectedError(
            f"{document_name} is not valid base64 data.", code="pdf_invalid", cause=error
        ) from error

    if len(raw) > MAX_FILE_BYTES:
        raise PdfRejectedError(
            f"{document_name} exceeds the 2 MB per-file limit.",
            code="pdf_invalid",
        )
    if not raw.startswith(PDF_MAGIC):
        raise PdfRejectedError(f"{document_name} is not a PDF file.", code="pdf_invalid")
    if PDF_EOF not in raw[-2048:]:
        # A missing trailer almost always means a truncated upload.
        raise PdfRejectedError(
            f"{document_name} is truncated and could not be read.", code="pdf_invalid"
        )
    return raw


def _assert_no_active_content(reader: PdfReader, document_name: str) -> None:
    """Rejects PDFs carrying JavaScript, embedded files or launch actions."""

    root = reader.trailer.get("/Root")
    if root is None:
        return
    try:
        root_keys = set(root.keys())
    except AttributeError:
        return

    for key in _DANGEROUS_KEYS:
        if key in root_keys:
            raise PdfRejectedError(
                f"{document_name} contains active content ({key}) and was rejected.",
                code="pdf_active_content",
            )

    names = root.get("/Names")
    if names is not None:
        try:
            name_keys = set(names.keys())
        except AttributeError:
            name_keys = set()
        if "/JavaScript" in name_keys or "/EmbeddedFiles" in name_keys:
            raise PdfRejectedError(
                f"{document_name} embeds scripts or files and was rejected.",
                code="pdf_active_content",
            )

    catalog = root.get("/OpenAction")
    if catalog is not None and not isinstance(catalog, int | float):
        raise PdfRejectedError(
            f"{document_name} declares an open action and was rejected.",
            code="pdf_active_content",
        )


def _count_images(page: object) -> int:
    """Counts extractable raster images on a page."""

    try:
        resources = page.get("/Resources")  # type: ignore[attr-defined]
        if resources is None:
            return 0
        xobject = resources.get("/XObject")
        if xobject is None:
            return 0
        resolved = xobject.get_object() if hasattr(xobject, "get_object") else xobject
        count = 0
        for name in resolved:
            entry = resolved[name]
            candidate = entry.get_object() if hasattr(entry, "get_object") else entry
            subtype = candidate.get("/Subtype")
            if subtype == "/Image":
                count += 1
        return count
    except Exception:
        return 0


def parse_document(
    *,
    document_id: str,
    name: str,
    payload_base64: str,
    chunk_size: int,
    chunk_overlap_tokens: int,
    declared_page_count: int = 0,
) -> ParsedDocument:
    """Validates and chunks a single PDF upload."""

    raw = decode_base64(payload_base64, document_name=name)

    try:
        reader = PdfReader(io.BytesIO(raw), strict=False)
    except PdfReadError as error:
        raise PdfRejectedError(
            f"{name} could not be parsed as a PDF.", code="pdf_invalid", cause=error
        ) from error

    if reader.is_encrypted:
        try:
            # Empty-password PDFs (owner-password only) are safe to open; anything
            # else must not be brute-forced inside a request.
            reader.decrypt("")
        except Exception as error:
            raise PdfRejectedError(
                f"{name} is password protected and cannot be indexed.",
                code="pdf_encrypted",
                cause=error,
            ) from error
        if reader.is_encrypted:
            raise PdfRejectedError(
                f"{name} is password protected and cannot be indexed.",
                code="pdf_encrypted",
            )

    _assert_no_active_content(reader, name)

    pages: list[tuple[int, str]] = []
    image_count = 0
    image_only_pages: list[int] = []
    text_budget = MAX_TEXT_CHARS

    for page_index, page in enumerate(reader.pages):
        if page_index >= MAX_PAGES:
            break
        page_images = _count_images(page)
        image_count += page_images
        try:
            extracted = page.extract_text() or ""
        except Exception:
            extracted = ""
        text = normalise_text(extracted)
        if page_images > 0 and len(text) < IMAGE_ONLY_TEXT_CHARS:
            # A page whose content is essentially the image itself. Those are the
            # only pages a vision model could add something to, so they are what
            # decides whether the multimodal metrics have anything to measure.
            image_only_pages.append(page_index + 1)
        if text_budget <= 0:
            continue
        if len(text) > text_budget:
            text = text[:text_budget]
        text_budget -= len(text)
        pages.append((page_index + 1, text))

    chunks = chunk_document(
        pages,
        chunk_size=chunk_size,
        chunk_overlap_tokens=chunk_overlap_tokens,
    )

    return ParsedDocument(
        id=document_id,
        name=name,
        size_bytes=len(raw),
        page_count=len(pages) if not declared_page_count else max(declared_page_count, len(pages)),
        image_count=image_count,
        has_images=image_count > 0,
        image_only_page_numbers=tuple(image_only_pages),
        chunks=tuple(chunks),
    )


def enforce_upload_budget(sizes: list[int]) -> None:
    """Applies the count and size limits before any parsing happens."""

    if len(sizes) > MAX_DOCUMENTS:
        raise PdfRejectedError(
            f"At most {MAX_DOCUMENTS} PDFs can be indexed per session.", code="pdf_invalid"
        )
    for size in sizes:
        if size > MAX_FILE_BYTES:
            raise PdfRejectedError("A file exceeds the 2 MB per-file limit.", code="pdf_invalid")
    if sum(sizes) > MAX_TOTAL_BYTES:
        raise PdfRejectedError(
            "Combined uploads exceed the 6 MB session limit.", code="pdf_invalid"
        )
