# Deploying RAGdoll to Vercel

RAGdoll ships as **one Vercel project with two runtimes**: the Next.js 15 app and
the Python FastAPI retrieval engine. `vercel.json` declares them with
[Services](https://vercel.com/docs/services/experimental), so a single `git push`
deploys both and the browser only ever talks to the Next.js origin.

```
browser ──▶ Next.js (BFF) ──Bearer token──▶ FastAPI engine ──▶ LLM provider
            web/                             api/index.py
            session cookie + KV              in-memory index / KV metadata
```

## 1. Import the project

1. Push this repository to GitHub.
2. Vercel → **Add New… → Project → Import Git Repository**.
3. Leave **Root Directory** at the repository root. `vercel.json` declares the two
   services with their own roots, and overriding the root breaks the pnpm
   workspace that holds `web/`.

The two service names in `vercel.json` matter: `web` and `ragdoll-engine`. Vercel
derives each service's internal hostname and its environment variables from those
names, so renaming one without updating `RAGDOLL_API_URL` breaks the bridge.

## 2. Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `RAGDOLL_SESSION_SECRET` | **yes** | ≥32 characters. Signs and AES-256-GCM-seals the `__Host-ragdoll-sid` cookie, and derives the key that encrypts the provider credential inside it. Generate with `openssl rand -hex 32`. |
| `RAGDOLL_API_TOKEN` | **yes** | ≥16 characters. Shared secret the BFF presents to the engine; every engine route, including `/health`, rejects a request without it. Generate with `openssl rand -hex 32`. |
| `RAGDOLL_API_URL` | **yes** | Where the BFF reaches the engine. Inside the project, use the internal URL Vercel generates for the `ragdoll-engine` service (see below); for a separately deployed engine, use its full public URL. |
| `KV_REST_API_URL` | recommended | Upstash Redis / Vercel KV REST URL. Without it, sessions live in one Function instance. |
| `KV_REST_API_TOKEN` | recommended | Token for the KV REST endpoint. |
| `RAGDOLL_HOSTED` | yes (`1`) | Makes loopback and LAN provider URLs fail fast with the self-hosting message instead of timing out. |
| `RAGDOLL_ALLOWED_ORIGINS` | no | Only when the engine is deliberately exposed to a browser. |

`RAGDOLL_SESSION_SECRET` and `RAGDOLL_API_TOKEN` must be identical for the web and
engine services — Vercel project variables are shared, which is exactly what the
architecture needs.

**Finding the internal engine URL.** Services publish generated environment
variables for their peers, listed under **Project → Settings → Environment
Variables** on the deployment that first created them. Copy the engine service's
URL into `RAGDOLL_API_URL` (it is an internal `http://…:8000` origin, reachable only
from other services in the project). If the generated variable is not present, the
public `https://<deployment>/engine` origin also works and costs one extra hop
through the edge; it is token-protected either way.

## 3. Session and credential storage on Vercel

The `__Host-ragdoll-sid` cookie carries an opaque, HMAC-signed **session id** and
nothing else: it is a handle, so its size is the same for an empty session and one
holding the full 6 MB upload allowance. Everything else lives server-side, in the
two layers AGENTS.md specifies:

| Layer | Holds | Survives |
| --- | --- | --- |
| Process memory | session state + decoded PDF bytes | repeat requests to the same instance |
| Upstash/Vercel KV | session state + PDF bytes, TTL 16 min | cold starts and other instances |

The provider API key is part of the session, so it is in those two server-side
layers and never in the cookie, which is `HttpOnly`. Rotating the session secret
invalidates every live session and credential at once — that is the kill switch.

**Configure Upstash.** Without it, a session exists only in the instance that
created it: the next request may land elsewhere and be told the session is unknown.
The engine side has the same property, which is why `lib/pipeline/session-helpers`
exposes a `rebuildIndex` path — `ensureIndex` is idempotent, so a lost index is
rebuilt from the PDFs the store still holds.

## 4. Region alignment

`vercel.json` pins `sin1`. Keep the engine and the LLM provider in the same region:
retrieval is a single intra-region round trip when they are, and a cross-continent
one when they are not. Change `regions` if your provider lives elsewhere — DeepSeek
is fastest from `sin1`, OpenAI from `iad1`.

## 5. Function limits

`api/index.py` is declared with 1024 MB and `maxDuration: 300`. Streaming chat
waits on the provider rather than burning CPU, so Fluid compute keeps that cheap;
under Active CPU pricing the wait is not billed. The Next.js chat route keeps its
own 60 s abort budget so a stuck stream cannot pin a browser tab open.

## 6. Local development

```bash
pnpm install

# terminal 1 — the engine
python -m venv .venv
.venv/Scripts/activate           # Windows; source .venv/bin/activate elsewhere
pip install -r api/requirements.txt
RAGDOLL_DEV_PROVIDER=1 RAGDOLL_API_TOKEN=dev-token \
  python -m uvicorn app.main:app --reload --port 8000 --app-dir api

# terminal 2 — the app
cp web/.env.example web/.env.local   # then fill in the two secrets
pnpm dev                             # http://localhost:3000
```

With `RAGDOLL_API_URL=http://127.0.0.1:8000` in `web/.env.local` the bridge talks to
the local engine, and because the deployment is not hosted, localhost and LAN
providers (Ollama, llama.cpp) work normally. `RAGDOLL_DEV_PROVIDER=1` makes the
engine answer from a deterministic offline provider, so the whole flow can be
exercised without an API key; it is refused whenever `RAGDOLL_HOSTED=1`.

## 7. Verifying a deployment

```bash
curl -s https://<deployment>/api/session | jq
curl -s -H "Authorization: Bearer $RAGDOLL_API_TOKEN" https://<deployment>/engine/health | jq
```

`/api/session` should answer with a `sessionId`, `pipeline: null` and
`capabilities.engine: true`. `/engine/health` reports the engine version, live
session count, the hosted flag and the registered providers.

Both are token-guarded where it matters:

- `/engine/*` is served by the Python service, so it *is* reachable from the
  internet on a hosted deployment. Every route depends on the bridge token, and
  `/health` is included, so an unauthenticated caller learns nothing. The engine
  refuses to boot at all when `RAGDOLL_HOSTED=1` and no token is set, turning a
  misconfiguration into a failed deployment instead of an open endpoint. If a live
  deployment returns 401, `RAGDOLL_API_TOKEN` differs between the services; if it
  404s, the service routes in `vercel.json` did not apply and a clean redeploy is
  needed.
- The engine is never called from the browser, so no CORS surface is opened.
  `RAGDOLL_ALLOWED_ORIGINS` is only for deliberately exposing it.

## 8. What `vercel.json` owns

Two levels, deliberately:

- **Top level** — `installCommand` (the pnpm workspace needs a root install),
  `regions`, the function budget for `api/index.py`, and the brand-asset cache
  header. These apply project-wide.
- **`experimentalServices`** — one entry per runtime, each with its own `root`, and
  each owning a slice of the URL space. Route ownership is what actually routes
  traffic: the negative lookahead on `web` sends everything except `/engine/*` to
  Next.js, so a future `/engine-room` page cannot be swallowed by the engine, and
  the engine's `routes` entry strips the `/engine` prefix before FastAPI sees it.

The web service carries its own `buildCommand` and `framework` so the Next.js build
is unambiguous even though the app lives one directory down. If you later split the
engine into a separate project, only `ragdoll-engine` and the `/engine` route need
to be removed — nothing in `web/` depends on the service layout, only on
`RAGDOLL_API_URL`.

## 9. Operational notes

- **Rate limits.** Vercel Firewall rules (or `RAGDOLL_ALLOWED_ORIGINS` plus a
  gateway) should front `/engine/*` if the deployment is public. The bridge token
  authenticates the caller; it does not throttle one.
- **Provider keys stay server-side.** They live in the session, so they are held by
  the memory and KV layers and never by the browser's cookie. Rotating
  `RAGDOLL_SESSION_SECRET` invalidates every live session and credential, which is
  the intended kill switch.
- **KV values are one session each.** A session's KV entry is capped in practice by
  the 6 MB upload allowance, which is well inside Upstash's request limit, and it
  expires on the same sliding TTL as the cookie.
- **Logs.** The engine logs duration, retrieval hit count, faithfulness score and
  token usage per RAG call, which is enough to attribute cost without a tracing
  stack. Add OpenTelemetry only if cross-service traces become necessary.

