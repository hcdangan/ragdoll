# DeepSeek Agent Instructions

## Project Description
RAGdoll is a RAG pipeline workbench and chatbot. It allows the custom creation of a RAG pipeline, evaluate it, and use it via a chatbot interface. All without writing a single line of code.

## Role & Objective
You are an elite, production-grade software engineer optimized for **deepseek-flash**. Your goal is to provide highly efficient, deterministic, and type-safe code that adheres strictly to the architectural constraints outlined below.

## Technology Stack
- **Languages:** TypeScript (Strict Mode), Python 3.13
- **Frontend:** Next.js 15 (App Router), React 19, TailwindCSS, Vercel AI SDK
- **Backend:** Python, FastAPI, Pydantic, Vercel AI SDK
- **State/Data Fetching:** TanStack Query (React Query)
- **Testing:** Vitest (TS unit), Playwright (E2E), pytest (Python unit/integration)

## Code Style & Architectural Patterns
- **Paradigm:** Functional over object-oriented. Use pure functions, immutable data patterns, and composition.
- **Type Safety:** Zero `any` usage. Explicitly type all function signatures, API payloads, and component props.
- **Components:** Server Components by default. Use `"use client"` only at the leaf nodes where interactivity or state is required.
- **Data Flow:** Unidirectional data flow. Use Server Actions for mutations and standard API routes or layout fetches for queries.

### RAG Pipeline
- RAG pipeline creation should be stored in-memory in the user's session.
- Retrieval strategy:
  - Single-shot queries: Retrieve top-K chunks and inject them as a tagged context block before generation (Context Injection).
  - Agentic / multi-hop queries: Expose retrieval as a tool call the LLM can invoke repeatedly.
  - Default to Context Injection; enable tool-call retrieval only when the pipeline is configured for agentic mode.
- Multi-Turn Handling: For multi-turn conversations, compress recent history into a standalone query before embedding. This avoids retrieval degradation from ambiguous references.
- Fallback Strategy: If retrieval returns no results or the answer fails a groundedness check, the output should be "Sorry, I don't know the answer to that."
- Groundedness Check: After generation, run a Ragas `faithfulness` pass of the answer against the retrieved chunks. If score < 0.5, discard the answer and emit the fallback string.

### API Bridge & Data Flow
- Server Action Wrapping: Each non-streaming RAG operation (e.g., testConnection, createPipeline, runEvaluation) corresponds to a Server Action. The action fetches the FastAPI endpoint, handles errors, timeouts, and retries, then returns clean TypeScript types to the component.
- Streaming Exception: Server Actions cannot stream responses to the browser. Streaming chat MUST use a Next.js Route Handler (`app/api/chat/route.ts`) that proxies the FastAPI SSE stream and re-emits it via the Vercel AI SDK Data Stream Protocol.
- Session Store: Server-side in-memory store keyed by a signed session cookie (`__Host-ragdoll-sid`). TTL 15 minutes, sliding — refreshed on any Server Action or Route Handler call. On Vercel (multi-instance), use Vercel KV or Upstash Redis; Function instances do not share memory. After expiry, the pipeline, uploaded PDFs, API key, and chat history are purged.
- Type Synchronization: FastAPI emits `openapi.json`; run `openapi-typescript` in CI to generate `packages/api-types/schema.d.ts`. Commit generated types; CI fails on drift.

### Streaming Responses
- SSE Streaming: FastAPI exposes a `StreamingResponse` endpoint for chat. Next.js proxies via a Route Handler (`app/api/chat/route.ts`) — not a Server Action.
- AI SDK Integration: The Route Handler adapts the FastAPI SSE stream to the Vercel AI SDK Data Stream Protocol. Frontend consumes it with `useChat`.
- Citation-First Streaming: Before emitting assistant tokens, send retrieved sources as Vercel AI SDK `data` stream parts (AI SDK v5 Data Stream Protocol) with a `citation` payload type. The `useChat` `onData` callback populates the citation panel immediately. Sources are keyed by document ID and page number.
- Timeout & Abort: 60s per streaming request. Client aborts via `AbortController` on unmount or user interrupt.
- Platform Limit Note: 60s fits Vercel Hobby/Pro defaults. Raise `maxDuration` explicitly if a longer timeout is needed on Enterprise.

### Vercel Deployment Architecture
- Single Project, Dual Runtime: Vercel supports deploying Next.js and Python functions in the same project. Configure vercel.json or use Services to run FastAPI as a Python Function alongside the Next.js frontend.
- Python Entrypoint: Vercel auto-detects a FastAPI app instance in app.py, main.py, server.py, wsgi.py, or asgi.py at the root or inside src/ or app/. You can also specify it via tool.vercel.entrypoint in pyproject.toml.
- Fluid Compute & Active CPU: FastAPI functions run on Fluid compute by default. Under Active CPU pricing, time spent waiting for tokens during streaming is not billed as CPU, and a single instance can serve multiple concurrent streams.
- Vector DB Region Alignment: Deploy your vector database in the same region as your Vercel Functions to keep retrieval queries to a single intra-region round trip, significantly reducing latency.
- Vector Store: In-memory NumPy/FAISS index per session by default. For persistent pipelines, support Qdrant or pgvector with region pinned to the Vercel Function region.

### Cost & Telemetry
- Token Metering: Track token usage (prompt + completion) per call on the FastAPI side, recording by route or user dimension for cost attribution.
- Start with Lightweight Logging: Begin with structured logs capturing duration, retrieval hit count, reranker results, and LLM latency per RAG call.
- OpenTelemetry Extension: When full trace visibility is needed, add OpenTelemetry SDK and OTLP exporter to trace the full path from Next.js to FastAPI to the LLM provider.

### Security & Guardrails
- Pydantic Output Validation: Enforce structured LLM output with Pydantic models. Reject or retry when the format doesn't match.
- Input Filtering (Jailbreak): Use Guardrails AI Detect Jailbreak (https://guardrailsai.com/hub/validator/guardrails/detect_jailbreak). Reject the input and notify the user of an attempted jailbreak if detected.
- Input Filtering (Prompt Injection): Use Guardrails AI Detect Prompt Injection (https://guardrailsai.com/hub/validator/guardrails/detect_prompt_injection). Reject the input and notify the user of an attempted prompt injection if detected.
- API Protection: If the FastAPI endpoint must be exposed (e.g., for direct frontend streaming), add authentication, rate limiting, or Vercel Firewall rules.
- PDF Sandboxing: Parse PDFs in a sandboxed process (e.g., `pypdf` with a memory cap; no shell-outs to `pdftotext`). Reject PDFs containing JavaScript, embedded files, or launch actions.

### Critical Constraints & Quality Guardrails
- **Self-Correction:** Before outputting a solution, mentally verify syntax correctness, missing imports, and type alignment.
- **Error Handling:** Wrap async operations in try/catch blocks. Always return user-friendly error boundaries or actionable API response codes.
- **Performance:** Avoid unnecessary re-renders. Use `useMemo` and `useCallback` selectively when processing expensive data shapes.
- **Security:** Sanitize inputs. Never commit or leak hardcoded API tokens or secrets. Use environment variables.

#### GitHub Actions
- Triggers: `pull_request` to `main`, `push` to `main`.
- Frontend: `pnpm lint` (ESLint), `pnpm typecheck` (`tsc --noEmit`), `pnpm test` (Vitest), `pnpm exec playwright test` (E2E on PR only), `pnpm audit --audit-level=high`, CodeQL `javascript-typescript`.
- Backend: `ruff check`, `ruff format --check`, `mypy --strict`, `pytest`, `pip-audit`, CodeQL `python`.
- All jobs must pass before merge.

## Output Formatting Preference
- **Direct Output:** Skip conversational filler, conversational onboarding, or pleasantries (e.g., "Sure, I can help with that"). Go straight to the solution. This rule applies to code and documentation responses only; the RAGdoll chat persona retains its configured tone.
- **Code Blocks:** Provide clean, fully formed code chunks. Avoid code snippets that use `// ... rest of code goes here` placeholders.
- **Explanations:** Keep code explanations bulleted, punchy, and minimal. Focus on *why* a design choice was made rather than *what* the syntax means.

## Functional Requirements

### Sitemap
  - Home — `/` — describes the project and shows licensing information.
  - RAG Creation — `/create`
  - Evaluate — `/evaluate` — nav disabled until pipeline exists.
  - Chat — `/chat` — nav disabled until pipeline exists.

### General Requirements
- Responsive layout: mobile-first; target ≥ 360px width.
- Accessibility: WCAG 2.1 AA — keyboard navigation, focus rings, ARIA labels on all sliders and toggles.
- Error boundary per route segment; failures render an inline retry, never a white screen.
- All user-facing strings routed through a central i18n dictionary (English default).

#### RAG Creation
- Allows the user to input/select the following fields:
- Everything is stored in the user's session. Nothing is stored on disk.
- Session TTL: 15 minutes of inactivity. Sliding window refreshed on any Server Action or Route Handler call. After expiry, the pipeline, PDFs, API key, and chat history are purged server-side.
- Inform the user that everything is stored in the session and nothing is stored on disk.

##### Provider 
  - The user can select from the following:
    - OpenAI
    - Vocareum
    - DeepSeek
    - Ollama/Llama.cpp
  - Use and display the following base URL based on the user selection above. If the user selected Ollama/Llama.cpp, there should be a text input for the user to specify the base URL.
    - OpenAI: https://api.openai.com/v1 
    - Vocareum: https://openai.vocareum.com/v1
    - DeepSeek: https://api.deepseek.com/v1
    - Ollama/Llama.cpp: (user input)
  - Constraint: URLs are resolved from the Vercel Function's network, not the user's browser. Localhost and LAN URLs only work under self-hosted deployment. When running on Vercel, the "Test Connection" step must fail fast with: "Cannot reach localhost from a hosted deployment. Self-host RAGdoll to use local providers."

##### Model
  - A text input for the LLM to be used. With the following default values:
    - OpenAI: gpt-4o-mini
    - Vocareum: gpt-4o-mini
    - DeepSeek: deepseek-flash
    - Ollama/Llama.cpp: llama3.2

##### Embedding Model
  - Embedding Models should be selectable. Available selection is based on the selected provider, as shown below. The first item per provider is the default.
    - OpenAI: 
      - text-embedding-3-small
      - text-embedding-3-large
    - Vocareum:
      - text-embedding-3-small
      - text-embedding-3-large
    - DeepSeek:
      - text-embedding-3-small
      - text-embedding-3-large
    - Ollama/Llama.cpp
      - nomic-embed-text
      - bge-m3
      - embeddinggemma
      - mxbai-embed-large

##### Embedding Dimension (Vector Size)
  - Derived from the selected Embedding Model and shown read-only:
    - text-embedding-3-small: 1536
    - text-embedding-3-large: 3072
    - nomic-embed-text: 768
    - bge-m3: 1024
    - embeddinggemma: 768
    - mxbai-embed-large: 1024
  - Not user-editable to prevent index/model dimension mismatch.

##### API Key 
  - Manually entered by the user. It should be masked but with a button to toggle between masked and plain text.
  - Inform the user that the API Key is stored in the user's session only. 

##### File Upload
  - An interface where a user can add or remove PDF files.
    - Only PDF files are supported. 
    - Maximum of 3 files in total.
    - Maximum of 2 megabytes per file.
    - Maximum combined upload size: 6 MB per session.

##### Chunk Size
  - A slider that represents a value range between 128 to 2048 and by increments or decrements of 32. Default is 512.

##### Chunk Overlap (%)
  - A slider that represents the percentage of the selected Chunk Size. The range is 10% to 20%. Show the actual value of the Chunk Overlap as the user changes it. Default is 10%. Slider increments or decrements by 1%.
  - The computed overlap token count is rounded to the nearest multiple of 32 and clamped to [10%, 20%] of Chunk Size.

##### Max Input Tokens (Context Window):
  - A slider that represents a value range between 256 to 4096 and by increments or decrements of 32. Default is 1024.

##### Distance Metric
  - A selection between:
    - Cosine Similarity
    - Dot Product
    - Euclidean Distance

##### Top-K
  - A slider that represents a value range between 3 to 10 and by increments or decrements of 1. Default is 5.

##### Create RAG Pipeline
  - A button to:
    - Test if the API configuration works. If it doesn't, inform the user of the error (e.g. invalid API key).
    - If the API works, create the RAG pipeline and store it in the session.
    - Extract the PDF citations, if any. Store them in the session.

##### Clear existing RAG Pipeline
  - Clears the RAG Pipeline in the user's session and restore all input parameters in the page to default values. This button should only be enabled if there is an existing RAG pipeline in the session.

#### Evaluate
  - Check if the RAG pipeline exists first. If not, inform the user to create the RAG pipeline first.
  - There should be a button to run the evaluation and is only enabled if the RAG pipeline exists.
  - Once the button is clicked, the RAG pipeline will be evaluated via Ragas using the following metrics:
    - Context Precision
    - Context Recall
    - Context Entity Recall
    - Noise Sensitivity
    - Response Relevancy
    - Faithfulness
    - Multimodal Faithfulness
    - Multimodal Relevance
  - Results are reported under a "Retrieval Augmented Generation" evaluation category.
  - Multimodal metrics require image-extractable PDFs. If all uploads are text-only, these metrics are skipped and reported as N/A.
  - Show a progress indicator while the eval is being executed.

#### Chat
  - Chatbot interface. Enabled only if the user created a RAG pipeline.
  - If there is no RAG pipeline, the user will be instructed to create one.
  - The chat can be interrupted. The user can abort an in-flight assistant response via an `AbortController`; the partial response is retained and the next turn resumes normally.
  - The chatbot avatar should be the cat in the RAGdoll logo.
  - There should be an indicator while the chatbot is trying to respond:
    - The cat avatar will show an image of it thinking with a spinning wheel animation somewhere.
  - If a context window limit is reached, inform the user that the context window of the chat has been reached and that a new chat session will be created. There should be a confirm button. After the user clicks the confirm button, a new chat session will begin.
    - The RAG pipeline, uploaded PDFs, and configuration persist across chat resets. Only chat message history is cleared.
  - There should be a section to show citations of the PDF sources, if available in the session.