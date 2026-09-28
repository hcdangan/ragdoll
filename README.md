# RAGdoll

**AI RAG Dashboard & Chatbot** — build a retrieval-augmented generation pipeline,
evaluate it, and chat with your own PDFs. No code required.

RAGdoll is a RAG pipeline workbench: pick a provider, drop in up to three PDFs,
tune chunking and retrieval, and the app assembles the index, scores it with
Ragas-style metrics, and answers questions with page-level citations.

<p align="center">
  <img src="public/brand/ragdoll-logo.png" alt="RAGdoll" width="360">
</p>

## What it does

| Route | Purpose |
| --- | --- |
| `/` | Project overview and licensing. |
| `/create` | Configure the provider, models, chunking and retrieval; build the index. |
| `/evaluate` | Run the eight-metric Ragas suite. Disabled until a pipeline exists. |
| `/chat` | Cited, grounded chat. Disabled until a pipeline exists. |

- **Four providers** — OpenAI, Vocareum, DeepSeek, Ollama/llama.cpp (self-hosted).
- **Six embedding models** with their vector widths resolved automatically.
- **Context injection or agentic retrieval**, chosen per pipeline.
- **Groundedness gate** — a Ragas `faithfulness` pass discards unsupported answers
  and emits *"Sorry, I don't know the answer to that."* instead.
- **Citation-first streaming** — sources arrive before the first token.
- **Nothing on disk** — the pipeline, PDFs, citations and chat live server-side in
  the session (15-minute sliding TTL) and are dropped when it expires.

## Architecture

```
browser ──▶ Next.js 15 (App Router, Server Actions, BFF)
              │  session: signed __Host-ragdoll-sid id cookie → server-side store
              │  store: process memory, mirrored to Upstash/Vercel KV when configured
              │  key: held in the session, never in the cookie
              ▼  bearer token (never exposed to the browser)
           FastAPI engine  ──▶  LLM + embedding provider
              │  PDF sandbox, chunker, in-memory vector index, Ragas-style metrics
              ▼
           SSE  ──▶  Next.js Route Handler  ──▶  AI SDK v5 data stream  ──▶  useChat
```

The cookie is an opaque, HMAC-signed session id — a handle, not a container — so its
size does not grow with the session. Everything else lives in the server-side store,
exactly as AGENTS.md specifies.

**One Vercel project, imported from the repository root with no settings changed.**
The Next.js app *is* the root, and `api/index.py` is a Python function that
`vercel.json` publishes at `/engine/*` — which the bridge calls by default, so there
is no service URL to configure. See [DEPLOYMENT.md](DEPLOYMENT.md).

## Repository layout

```
src/app/            routes, Server Actions, the chat streaming bridge
src/lib/            session, engine bridge, provider table, validation, i18n
src/components/     UI, chat, creation form, evaluation dashboard
src/middleware.ts   session handle, plus the local /engine proxy
e2e/                Playwright specs (shell + full pipeline journey)
public/brand/       logo and derived cat avatar / icons
api/                FastAPI engine (flat modules, one per concern)
  index.py          Vercel function entrypoint
  rag.py            ingest, retrieval, grounded generation
  evaluate.py       the eight Ragas-style metrics
  tests/            pytest suite with a deterministic provider double
  tools/            openapi export, end-to-end HTTP smoke test
tools/              brand asset pipeline (logo → avatar, icons)
scripts/            E2E PDF fixture generator
```

## Local development

```bash
pnpm install

# 1. the engine
python -m venv .venv
.venv/Scripts/activate            # Windows; source .venv/bin/activate elsewhere
pip install -r api/requirements.txt
RAGDOLL_DEV_PROVIDER=1 RAGDOLL_API_TOKEN=dev-token \
  python -m uvicorn main:app --reload --port 8000 --app-dir api

# 2. the app
cp .env.example .env.local        # RAGDOLL_API_URL is optional; the default is local
pnpm dev                          # http://localhost:3000
```

`RAGDOLL_DEV_PROVIDER=1` swaps in a deterministic offline provider, so the whole
pipeline — ingest, retrieval, citations, the groundedness gate, streaming and the
metric suite — runs with no API key and no network. It is refused on a hosted
deployment.

The engine's default location is the same-origin `/engine` path, which Vercel routes
from `vercel.json`. Locally there is no Vercel router, so `src/middleware.ts` proxies
`/engine/*` to `http://127.0.0.1:8000` (override with `RAGDOLL_LOCAL_ENGINE_URL`). Set
`RAGDOLL_API_URL` instead if you want the bridge to talk to the engine directly.

## Testing

```bash
pnpm lint        # ESLint
pnpm typecheck   # tsc --noEmit
pnpm test        # Vitest
pnpm e2e         # Playwright (shell always; the pipeline journey needs an engine)

cd api
ruff check . && ruff format --check .
mypy
pytest -q
```

The engine's HTTP surface has its own smoke test, run against a live server:

```bash
python api/tools/smoke.py http://127.0.0.1:8000 dev-token
```

## Configuration

| Variable | Where | Purpose |
| --- | --- | --- |
| `RAGDOLL_SESSION_SECRET` | web | ≥32 chars; signs the session cookie. Required in production. |
| `RAGDOLL_API_TOKEN` | both | Shared secret between the bridge and the engine. |
| `RAGDOLL_API_URL` | web | Only needed when the engine is deployed **separately**; the default is the same-origin `/engine` route. |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | both | Shared session store. Effectively required on Vercel — without it a session exists only on one instance. |
| `RAGDOLL_HOSTED` | both | Vercel's own `VERCEL=1` is detected, so this is only for self-hosting behind a proxy. |
| `RAGDOLL_DEV_PROVIDER` | api | Offline deterministic provider; ignored when hosted. |
| `RAGDOLL_GROUNDEDNESS_THRESHOLD` | api | Faithfulness cut-off, default `0.5`. |

## License

MIT — see [LICENSE](LICENSE). © 2026 Harley Dangan. Submitted as a mini project to
the Asian Institute of Management.
