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

## Tech stack

<p align="center">
  <img src="https://cdn.simpleicons.org/nextdotjs/094454" alt="Next.js" title="Next.js" height="34">
  &nbsp;
  <img src="https://cdn.simpleicons.org/react/094454" alt="React" title="React" height="34">
  &nbsp;
  <img src="https://cdn.simpleicons.org/typescript/094454" alt="TypeScript" title="TypeScript" height="34">
  &nbsp;
  <img src="https://cdn.simpleicons.org/tailwindcss/094454" alt="Tailwind CSS" title="Tailwind CSS" height="34">
  &nbsp;
  <img src="https://cdn.simpleicons.org/reactquery/094454" alt="TanStack Query" title="TanStack Query" height="34">
  &nbsp;
  <img src="https://cdn.simpleicons.org/zod/094454" alt="Zod" title="Zod" height="34">
</p>
<p align="center">
  <img src="https://cdn.simpleicons.org/vitest/094454" alt="Vitest" title="Vitest" height="34">
  &nbsp;
  <img src="https://cdn.simpleicons.org/vercel/094454" alt="Vercel AI SDK" title="Vercel AI SDK" height="34">
  &nbsp;
  <img src="https://cdn.simpleicons.org/nodedotjs/094454" alt="Node.js" title="Node.js" height="34">
  &nbsp;
  <img src="https://cdn.simpleicons.org/pnpm/094454" alt="pnpm" title="pnpm" height="34">
  &nbsp;
  <img src="https://cdn.simpleicons.org/githubactions/094454" alt="GitHub Actions" title="GitHub Actions" height="34">
</p>

| Layer | Choice |
| --- | --- |
| Language | TypeScript, strict — no `any` anywhere |
| Framework | Next.js 15 App Router, React 19 (Server Components by default) |
| Styling | Tailwind CSS 3 — six-colour brand palette, light and dark themes |
| Server state | TanStack Query |
| Streaming | Vercel AI SDK v5 data stream protocol, consumed with `useChat` |
| Retrieval | In-process typed-array vector index: cosine, dot product or euclidean |
| PDF parsing | `unpdf` (PDF.js compiled to WebAssembly), sandboxed in-process |
| Validation | Zod schemas shared by the creation form and the Server Action |
| Testing | Vitest (unit + in-process engine integration), Playwright (E2E) |
| CI | GitHub Actions: lint, typecheck, test, build, `pnpm audit`, CodeQL |
| Hosting | Vercel from the repository root; Vercel KV / Upstash for the session store |

## Architecture

```
browser ──▶ Next.js 15 (App Router, Server Actions, Route Handlers)
              │  session: signed __Host-ragdoll-sid id cookie → server-side store
              │  store: process memory, mirrored to Upstash/Vercel KV when configured
              │  key: held in the session, never in the cookie
              ▼  in-process call — no second service, no internal URL
           src/lib/rag/  ──▶  LLM + embedding provider
              │  PDF sandbox, chunker, in-memory vector index, Ragas-style metrics
              ▼
           typed StreamEvent  ──▶  AI SDK v5 data stream  ──▶  useChat
```

The cookie is an opaque, HMAC-signed session id — a handle, not a container — so its
size does not grow with the session. Everything else lives in the server-side store,
exactly as AGENTS.md specifies.

**One runtime.** The RAG pipeline is TypeScript inside the Next.js server
(`src/lib/rag/`), not a Python function beside it. That keeps the deployment a plain
Next.js project with nothing to configure, and it removes the failure modes a second
service brings: no internal token, no cross-service schema drift, and no rebuilt
index when a Function instance is recycled.

**One Vercel project, imported from the repository root with no settings changed.**
See [DEPLOYMENT.md](DEPLOYMENT.md).

## Repository layout

```
src/app/            routes, Server Actions, the chat streaming route handler
src/lib/rag/        the pipeline: pdf, chunking, distance, prompts, llm, guardrails,
                    store, service, evaluation, offline provider
src/lib/pipeline/   session ↔ engine mapping and error translation
src/lib/            session, provider table, validation, i18n
src/components/     UI, chat, creation form, evaluation dashboard
src/middleware.ts   mints and verifies the signed session handle
e2e/                Playwright specs (shell + full pipeline journey)
public/brand/       logo and derived cat avatar / icons
public/logos/       third-party marks (Asian Institute of Management)
tools/              brand asset pipeline (logo → avatar, icons)
scripts/            E2E PDF fixture generator
```

## Local development

```bash
pnpm install
cp .env.example .env.local
pnpm dev                          # http://localhost:3000
```

There is no second process to start. To try the whole pipeline — ingest, retrieval,
citations, the groundedness gate, streaming and the metric suite — with no API key
and no network, set `RAGDOLL_DEV_PROVIDER=1` in `.env.local`. It swaps in a
deterministic offline provider (hashed bag-of-words embeddings and canned answers),
so the flow is reproducible; it is opt-in through that variable only, which no
deployment sets.

## Testing

```bash
pnpm lint        # ESLint
pnpm typecheck   # tsc --noEmit
pnpm test        # Vitest (unit + in-process engine integration)
pnpm e2e         # Playwright: shell + full pipeline journey
```

The engine integration test drives the real pipeline against the offline provider,
including PDF parsing, retrieval ranking, the groundedness gate and stream ordering.
The Playwright journey covers the seams a unit test cannot: the session cookie,
Server Actions, the streaming route handler and `useChat`.

## Configuration

| Variable | Purpose |
| --- | --- |
| `RAGDOLL_SESSION_SECRET` | ≥32 chars; signs the session cookie and seals the provider key. Required in production. |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Shared session store. Effectively required on Vercel — without it a session exists only on one instance. |
| `RAGDOLL_HOSTED` | Forces hosted mode so loopback providers fail fast. Vercel's own `VERCEL=1` is detected, so this is only for self-hosting behind a proxy. |
| `RAGDOLL_DEV_PROVIDER` | `1` swaps in the deterministic offline provider. Never set on a deployment that answers real questions. |
| `RAGDOLL_DISABLE_GUARDRAILS` | `1` disables the jailbreak / prompt-injection input filter, for investigating a false positive. |

## Submitted to

<p align="center">
  <img src="public/logos/aim.svg" alt="Asian Institute of Management" width="220">
</p>

RAGdoll is submitted as a mini project to the **Asian Institute of Management**.

## License

MIT — see [LICENSE](LICENSE). © 2026 Harley Dangan.
