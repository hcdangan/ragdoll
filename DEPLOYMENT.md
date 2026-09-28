# Deploying RAGdoll to Vercel

RAGdoll deploys as **one Vercel project importing the repository root unchanged**:
the Next.js app *is* the root, and the FastAPI engine lives in `api/`, which Vercel
treats as a Python function automatically.

```
browser ──▶ Next.js (BFF) ──Bearer token──▶ FastAPI  ──▶ LLM provider
            repository root                  api/index.py
            session cookie + KV              in-memory index per session
```

The layout is deliberate. Vercel's importer walks the repo, finds the nearest
`package.json` with a framework, and pre-fills **Root Directory** with it. With the
app at the root and the engine in `api/`, that suggestion is already correct — you
accept the defaults and change nothing.

## 1. Import the project

1. Push this repository to GitHub.
2. Vercel → **Add New… → Project → Import Git Repository**.
3. Change **nothing**. Root Directory stays at the repository root, Framework Preset
   stays **Next.js**, and `vercel.json` supplies the install and build commands.
4. Deploy. It will fail at runtime until step 3 below — that is expected, and this
   first deployment is what gives you the environment to configure.

## 2. Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `RAGDOLL_SESSION_SECRET` | **yes** | ≥32 characters. Signs the `__Host-ragdoll-sid` cookie. Generate with `openssl rand -hex 32`. |
| `RAGDOLL_API_TOKEN` | **yes** | ≥16 characters. Shared secret between the bridge and the engine; every engine route, including `/health`, rejects a request without it. Generate with `openssl rand -hex 32`. |
| `KV_REST_API_URL` | **yes on Vercel** | Upstash Redis REST URL. The in-process session store is per-instance, so without this a session created on one instance is invisible to the next. |
| `KV_REST_API_TOKEN` | **yes on Vercel** | Read-write token for the same database — not the read-only one. |
| `RAGDOLL_HOSTED` | no | Vercel's own `VERCEL=1` already marks the deployment as hosted, so both runtimes detect it. Set it to `1` only if you self-host behind a proxy but want hosted semantics. |

Set each one for **Production**, **Preview** and **Development**. There is
deliberately **no `RAGDOLL_API_URL`**: `vercel.json` rewrites `/engine/*` to the
Python function, and the bridge's default is that same origin, so there is no
internal service URL to discover.

`RAGDOLL_SESSION_SECRET` and `RAGDOLL_API_TOKEN` must be identical for the web app and
the engine. Vercel project variables are shared, so this happens on its own.

### Creating the KV database

Vercel → **Storage → Create Database → Upstash for Redis**, region **Singapore
(`ap-southeast-1`)** to match `regions: ["sin1"]`. Vercel injects
`KV_REST_API_URL` and `KV_REST_API_TOKEN` into the project, so you can skip those two
rows. Verify in **Settings → Environment Variables** that the names came through as
`KV_REST_API_*`, which is what the code reads.

## 3. Redeploy

Environment variables are applied at deploy time, so the variables you just added do
not affect the existing deployment. **Deployments → ⋯ → Redeploy**, and untick
"use existing build cache" for a clean run.

## 4. Verifying a deployment

```bash
curl -s https://<deployment>/api/session | jq
curl -s -H "Authorization: Bearer $RAGDOLL_API_TOKEN" https://<deployment>/engine/health | jq
```

`/api/session` should report `capabilities.engine: true` and
`capabilities.sharedStore: true`.  `/engine/health` reports the engine version, live
session count, the hosted flag and the registered providers.

| Symptom | Cause |
| --- | --- |
| `capabilities.engine: false` | `vercel.json` was not picked up — check that Root Directory is the repository root |
| `/engine/health` returns 401 | `RAGDOLL_API_TOKEN` differs between the two runtimes |
| `/engine/health` returns 404 | the rewrite did not apply; redeploy without the build cache |
| `sharedStore: false`, or a **No shared store** badge in the header | the KV variables are missing from the running environment |
| Deploy log mentions `RAGDOLL_SESSION_SECRET` | it is set but shorter than 32 characters |
| Deploy log mentions `RAGDOLL_API_TOKEN must be set` | the engine refuses to boot when hosted without a token |

The engine is reachable from the internet at `/engine/*`, so it is token-guarded on
every route, `/health` included. It is never called from the browser, so no CORS
surface is opened; `RAGDOLL_ALLOWED_ORIGINS` exists only for deliberately exposing it.

## 5. Session and credential storage

The `__Host-ragdoll-sid` cookie carries an opaque, HMAC-signed **session id** and
nothing else, so its size is the same for an empty session as for one holding the
full 6 MB upload allowance. Everything else lives server-side:

| Layer | Holds | Survives |
| --- | --- | --- |
| Process memory | session state + decoded PDF bytes | repeat requests to the same instance |
| Upstash/Vercel KV | session state + PDF bytes, TTL 16 min | cold starts and other instances |

The provider API key is part of the session, so it is in those two server-side layers
and never in the cookie, which is `HttpOnly`. Rotating `RAGDOLL_SESSION_SECRET`
invalidates every live session and credential at once — that is the kill switch.

Upstash's per-request ceiling is 10 MB on the free and pay-as-you-go plans. A
worst-case session (three 2 MB PDFs base64-encoded, plus chat history) lands around
8 MB, which fits — but raising the upload limits in `src/lib/rules.ts` would not.

## 6. Region alignment

`vercel.json` pins `sin1`. Keep the engine, the KV database and the LLM provider in
the same region: retrieval is a single intra-region round trip when they are, and a
cross-continent one when they are not. Change `regions` if your provider lives
elsewhere — DeepSeek is fastest from `sin1`, OpenAI from `iad1`.

## 7. Function limits

`api/index.py` is declared with 1024 MB and `maxDuration: 300`. Streaming chat waits
on the provider rather than burning CPU, so Fluid compute keeps that cheap; under
Active CPU pricing the wait is not billed. The Next.js chat route keeps its own 60 s
abort budget so a stuck stream cannot pin a browser tab open.

## 8. Local development

```bash
pnpm install

# terminal 1 — the engine
python -m venv .venv
.venv/Scripts/activate           # Windows; source .venv/bin/activate elsewhere
pip install -r api/requirements.txt
RAGDOLL_DEV_PROVIDER=1 RAGDOLL_API_TOKEN=dev-token \
  python -m uvicorn main:app --reload --port 8000 --app-dir api

# terminal 2 — the app
cp .env.example .env.local       # then fill in the two secrets
pnpm dev                         # http://localhost:3000
```

With `RAGDOLL_API_URL=http://127.0.0.1:8000` in `.env.local` the bridge talks to the
local engine, and because the deployment is not hosted, localhost and LAN providers
(Ollama, llama.cpp) work normally. `RAGDOLL_DEV_PROVIDER=1` makes the engine answer
from a deterministic offline provider, so the whole flow can be exercised without an
API key; it is refused whenever the deployment is hosted.

## 9. Operational notes

- **Rate limits.** Vercel Firewall rules (or `RAGDOLL_ALLOWED_ORIGINS` plus a
  gateway) should front `/engine/*` on a public deployment. The bridge token
  authenticates the caller; it does not throttle one.
- **Provider keys stay server-side.** They live in the session, so they are held by
  the memory and KV layers and never by the browser's cookie.
- **Logs.** The engine logs duration, retrieval hit count, faithfulness score and
  token usage per RAG call, which is enough to attribute cost without a tracing
  stack. Add OpenTelemetry only if cross-service traces become necessary.
