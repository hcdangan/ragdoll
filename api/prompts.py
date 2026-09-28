"""Prompt construction and answer post-processing.

Keeping prompt text in one module makes the grounding contract ("answer only
from the context block") reviewable in isolation, and makes it impossible for a
route to accidentally emit retrieved text without the citation envelope.
"""

from __future__ import annotations

from collections.abc import Sequence

from chunking import truncate_to_tokens
from llm import ChatMessage
from providers import FALLBACK_ANSWER
from store import OwnedChunk

SYSTEM_PROMPT = (
    "You are RAGdoll, a retrieval-augmented assistant. Answer strictly from the "
    "CONTEXT block. Cite sources inline as [document name, p.page]. If the "
    "context does not contain the answer, reply exactly with: "
    f'"{FALLBACK_ANSWER}" '
    "Never invent facts, page numbers or document names."
)

AGENTIC_SYSTEM_PROMPT = (
    "You are RAGdoll, a retrieval-augmented assistant. You may call the "
    "`retrieve` tool as many times as you need to gather evidence, then answer "
    "strictly from what the tool returned, citing sources inline as "
    "[document name, p.page]. If the evidence is insufficient, reply exactly "
    f'with: "{FALLBACK_ANSWER}"'
)

COMPRESS_SYSTEM_PROMPT = (
    "Rewrite the user's latest message as a standalone search query. Resolve "
    "pronouns and references using the conversation. Reply with the query only."
)

GROUNDEDNESS_SYSTEM_PROMPT = (
    "You are a strict fact-checker. Given CONTEXT and ANSWER, list every atomic "
    "claim in ANSWER. For each claim state whether the CONTEXT supports it. "
    'Reply with JSON only: {"claims":[{"claim":"...","supported":true|false}]}'
)


def format_context_block(owned: Sequence[OwnedChunk]) -> str:
    """Renders retrieved chunks as a tagged context block.

    The tag carries document name and page so the model can cite without being
    handed a separate mapping it might misread.
    """

    blocks = [
        f'<source document="{item.document_name}" page="{item.chunk.page}">\n'
        f"{item.chunk.text}\n</source>"
        for item in owned
    ]
    return "\n\n".join(blocks)


def build_answer_messages(
    *,
    question: str,
    context_block: str,
    history: Sequence[ChatMessage],
    agentic: bool,
) -> list[ChatMessage]:
    """Assembles the chat completion request for a grounded answer."""

    system = AGENTIC_SYSTEM_PROMPT if agentic else SYSTEM_PROMPT
    messages: list[ChatMessage] = [ChatMessage(role="system", content=system)]
    messages.extend(history)

    if agentic:
        messages.append(
            ChatMessage(
                role="user",
                content=(
                    f"Question: {question}\n\n"
                    "Use the retrieve tool to gather evidence before answering."
                ),
            )
        )
    else:
        messages.append(
            ChatMessage(
                role="user",
                content=(
                    f"CONTEXT:\n{context_block}\n\n"
                    f"QUESTION: {question}\n\n"
                    "Answer from the CONTEXT and cite every source you use."
                ),
            )
        )
    return messages


def build_compression_messages(history: Sequence[ChatMessage]) -> list[ChatMessage]:
    """Builds the multi-turn query-compression request."""

    return [ChatMessage(role="system", content=COMPRESS_SYSTEM_PROMPT), *history]


def build_groundedness_messages(context_block: str, answer: str) -> list[ChatMessage]:
    """Builds the Ragas-style faithfulness judge request."""

    return [
        ChatMessage(role="system", content=GROUNDEDNESS_SYSTEM_PROMPT),
        ChatMessage(
            role="user",
            content=f"CONTEXT:\n{context_block}\n\nANSWER:\n{answer}\n\nReply with JSON only.",
        ),
    ]


def build_question_messages(context_block: str, answer: str) -> list[ChatMessage]:
    """Builds the reverse-question generator used by response relevancy."""

    return [
        ChatMessage(
            role="system",
            content=(
                "Generate the single question that the ANSWER most likely responds "
                "to, using only the CONTEXT. Reply with the question only."
            ),
        ),
        ChatMessage(role="user", content=f"CONTEXT:\n{context_block}\n\nANSWER:\n{answer}"),
    ]


def truncate_context(owned: Sequence[OwnedChunk], budget_tokens: int) -> list[OwnedChunk]:
    """Trims retrieved chunks to a token budget, best-ranked chunk first."""

    kept: list[OwnedChunk] = []
    remaining = max(0, budget_tokens)
    for item in owned:
        if remaining <= 0:
            break
        kept.append(item)
        remaining -= item.chunk.token_count
    return kept


def clamp_history(history: Sequence[ChatMessage], budget_tokens: int) -> list[ChatMessage]:
    """Keeps the most recent history turns that fit the budget."""

    kept: list[ChatMessage] = []
    remaining = max(0, budget_tokens)
    for message in reversed(history):
        cost = max(1, len(message.content) // 4)
        if cost > remaining:
            break
        kept.append(message)
        remaining -= cost
    kept.reverse()
    return kept


def snippet(text: str, limit: int = 240) -> str:
    """Single-line excerpt for the citation panel."""

    flat = " ".join(text.split())
    return flat if len(flat) <= limit else f"{flat[: limit - 1]}…"


def truncate_question(question: str, max_tokens: int) -> str:
    """Guards the question against absurdly long input."""

    return truncate_to_tokens(question, max_tokens)
