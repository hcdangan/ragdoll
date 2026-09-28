"""RAGdoll settings.

Every value is read from the environment so the same image runs self-hosted
(single process, in-memory session store) and on Vercel (multi-instance, KV
backed). Nothing here is secret; secrets arrive per request.
"""

from __future__ import annotations

import os
from functools import lru_cache

from pydantic import BaseModel, Field


def _flag(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name, "").strip().lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "on"}


class Settings(BaseModel):
    """Runtime configuration for the RAG engine."""

    app_name: str = "RAGdoll RAG Engine"
    version: str = "1.0.0"

    # Shared secret required from the Next.js bridge. Empty disables the check,
    # which is only acceptable when the engine is bound to loopback.
    api_token: str = Field(default="")

    # True when the engine runs behind a hosted provider (Vercel). Loopback and
    # LAN provider URLs are then refused up front instead of timing out.
    hosted: bool = Field(default=False)

    # Offline deterministic provider. Refused on hosted deployments: it exists for
    # local demos, E2E runs and CI, never to answer real questions.
    dev_provider: bool = Field(default=False)

    # Session sliding window in seconds; mirrors the Next.js session TTL.
    session_ttl_seconds: int = Field(default=900)

    # Guardrail thresholds for the built-in heuristics.
    enable_guardrails: bool = Field(default=True)
    guardrail_model_pass: bool = Field(default=False)

    # Embedding + generation budgets.
    embedding_batch_size: int = Field(default=32)
    max_chunks: int = Field(default=4000)
    requestion_timeout_seconds: float = Field(default=20.0)

    # Ragas-style groundedness gate from AGENTS.md.
    groundedness_threshold: float = Field(default=0.5)

    @property
    def allowed_origins(self) -> list[str]:
        raw = os.environ.get("RAGDOLL_ALLOWED_ORIGINS", "").strip()
        if not raw:
            return []
        return [origin.strip() for origin in raw.split(",") if origin.strip()]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Memoised settings accessor."""

    hosted = _flag("RAGDOLL_HOSTED", bool(os.environ.get("VERCEL")))
    return Settings(
        api_token=os.environ.get("RAGDOLL_API_TOKEN", "").strip(),
        hosted=hosted,
        # The offline provider is refused on a hosted deployment regardless of how
        # the flag is set, so a stray environment variable cannot fake answers.
        dev_provider=_flag("RAGDOLL_DEV_PROVIDER") and not hosted,
        session_ttl_seconds=int(os.environ.get("RAGDOLL_SESSION_TTL_SECONDS", "900")),
        enable_guardrails=not _flag("RAGDOLL_DISABLE_GUARDRAILS"),
        guardrail_model_pass=_flag("RAGDOLL_GUARDRAIL_MODEL_PASS"),
        embedding_batch_size=int(os.environ.get("RAGDOLL_EMBEDDING_BATCH", "32")),
        max_chunks=int(os.environ.get("RAGDOLL_MAX_CHUNKS", "4000")),
        requestion_timeout_seconds=float(os.environ.get("RAGDOLL_REQUEST_TIMEOUT", "20")),
        groundedness_threshold=float(os.environ.get("RAGDOLL_GROUNDEDNESS_THRESHOLD", "0.5")),
    )


def reset_settings_cache() -> None:
    """Test hook: drop the memoised settings."""

    get_settings.cache_clear()
