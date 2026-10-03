# Deploying RAGdoll to Vercel

RAGdoll deploys as **one Vercel project importing the repository root unchanged**.
The RAG pipeline is TypeScript inside the Next.js server (`src/lib/rag/`), so there
is no second runtime, no Python function and no internal service URL to configure.

```
browser ──▶ Next.js (App Router, Server Actions, Route Handlers)
              repository root
              session cookie + KV, in-process index per session
                    └──▶ LLM provider
```

The layout is deliberate. Vercel's importer walks the repo, finds the nearest
`package.json` with a framework, and pre-fills **Root Directory** with it. With the
app at the root, that suggestion is already correct — you accept the defaults and
change nothing.

## 1. Import the project

1. Push this repository to GitHub.
2. Vercel → **Add New… → Project → Import Git Repository**.
3. Change **nothing**. Root Directory stays at the repository root, Framework Preset
   stays **Next.js**, and `vercel.json` supplies the install and build commands.
4. Deploy. It will fail at runtime until step 2 below — that is expected, and this
   first deployment is what gives you the environment to configure.

## 2. Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `RAGDOLL_SESSION_SECRET` | **yes** | ≥32 characters. Signs the `__Host-ragdoll-sid` cookie and seals the provider API key the session carries. Generate with `openssl rand -hex 32`. |
| `KV_REST_API_URL` | **yes on Vercel** | Upstash Redis REST URL. The in-process session store is per-instance, so without this a session created on one instance is invisible to the next. |
| `KV_REST_API_TOKEN` | **yes on Vercel** | Read-write token for the same database — not the read-only one. |
| `RAGDOLL_HOSTED` | no | Vercel's own `VERCEL=1` already marks the deployment as hosted. Set it to `1` only if you self-host behind a proxy but want hosted semantics. |

Set each one for **Production**, **Preview** and **Development**. Nothing else is
needed: there is deliberately no engine URL or engine token, because the pipeline
runs in the same process that serves the page.

Do **not** set `RAGDOLL_DEV_PROVIDER` on a deployment that should answer real
questions — it replaces the configured provider with a deterministic offline one.

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
```

`/api/session` should report `capabilities.engine: true` and
`capabilities.sharedStore: true`.

| Symptom | Cause |
| --- | --- |
| `sharedStore: false`, or a **No shared store** badge in the header | the KV variables are missing from the running environment |
| Deploy log mentions `RAGDOLL_SESSION_SECRET` | it is set but shorter than 32 characters |
| Chat answers with the fallback string immediately | the session has no usable pipeline, the provider key is gone, or retrieval found nothing |
| `capabilities.engine: false` | should not happen — the engine ships with the app; a value of false means an old deployment is being served |

## 5. Session and credential storage

The `__Host-ragdoll-sid` cookie carries an opaque, HMAC-signed **session id** and
nothing else, so its size is the same for an empty session as for one holding the
full 15 MB upload allowance. Everything else lives server-side:

| Layer | Holds | Survives |
| --- | --- | --- |
| Process memory | session state, PDF bytes and the vector index | repeat requests to the same instance |
| Upstash/Vercel KV | session state + PDF bytes, TTL 16 min | cold starts and other instances |

The provider API key is part of the session, so it is in those two server-side layers
and never in the cookie, which is `HttpOnly`. Rotating `RAGDOLL_SESSION_SECRET`
invalidates every live session and credential at once — that is the kill switch.

The vector index itself is **not** mirrored to KV; it is rebuilt from the PDF bytes the
session still holds, which is why the uploads travel in the KV value. A cold instance
therefore costs one embedding pass, not a re-upload.

### Upload ceilings versus platform limits

The app's own limits are 5 MB per PDF and 15 MB per session (`LIMITS.files` in
`src/lib/rules.ts`). Two platform ceilings sit below that, and both are quiet failures
rather than errors, so raise them deliberately:

| Limit | Value | Consequence |
| --- | --- | --- |
| Vercel Function request body | 4.5 MB | A Server Action POST larger than this is rejected by the platform, so on Vercel an upload is realistically capped at ~3 MB of PDF bytes (base64 inflates by a third) regardless of `bodySizeLimit` in `next.config.ts`. Self-host, or upload straight to blob storage, to use the full allowance. |
| Upstash per-request value | 10 MB on free/pay-as-you-go | A session whose base64 PDFs exceed this cannot be mirrored to KV. The write is skipped with a warning and the session lives only on the instance that created it — which is exactly the multi-instance failure KV exists to prevent. |

The in-process session always holds the full allowance; only the shared mirror is
bounded by these. Raising the upload limit beyond what KV can store turns a
cross-instance session into a per-instance one.

## 6. Region alignment

`vercel.json` pins `sin1`. Keep the KV database and the LLM provider in the same
region: retrieval is then a single intra-region round trip rather than a
cross-continent one. Change `regions` if your provider lives elsewhere — DeepSeek is
fastest from `sin1`, OpenAI from `iad1`.

## 7. Function limits

Chat streams through `src/app/api/chat/route.ts`, which declares `maxDuration = 60`.
Streaming waits on the provider rather than burning CPU, so Fluid compute keeps that
cheap; under Active CPU pricing the wait is not billed.

Evaluation runs as a Server Action under a `maxDuration = 300` segment limit
(`src/app/evaluate/page.tsx`), and the dashboard gives up at the same five minutes with
a message that says the run hit the deployment's limit. Every sample costs several
provider calls, and a cold self-hosted model can spend a minute just loading, so the
60-second default truncated legitimate runs. Five minutes is the ceiling on Vercel Pro;
if a run still does not fit, lower the question count (the suite defaults to four, twelve
at most) or self-host, where no such limit applies. Both values are compiled into
`.next/server/functions-config-manifest.json`, so a change is visible after a build.

## 8. Local development

```bash
pnpm install
cp .env.example .env.local       # then fill in the session secret
pnpm dev                         # http://localhost:3000
```

There is no second process to start. Set `RAGDOLL_DEV_PROVIDER=1` in `.env.local` to
answer from the deterministic offline provider, so the whole flow can be exercised
without an API key. Because a local run is not hosted, localhost and LAN providers
(Ollama, llama.cpp) work normally.

## 9. Operational notes

- **Rate limits.** The chat route and the Server Actions are public endpoints. Put
  Vercel Firewall rules in front of them on a public deployment if abuse is a risk;
  there is no bridge token any more, because there is no bridge.
- **Provider keys stay server-side.** They live in the session, so they are held by
  the memory and KV layers and never by the browser's cookie.
- **Logs.** The pipeline logs failed judges and provider retries with a `[ragdoll]`
  prefix. Chat turns record duration implicitly through those lines; add
  OpenTelemetry only if fuller traces become necessary.
