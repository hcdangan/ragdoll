/**
 * Configuration read from the environment.
 *
 * This module is intentionally *not* marked `server-only`: middleware needs the
 * session secret to verify the session cookie, and `server-only` cannot be
 * resolved in the Edge bundle. The secrets it exposes are only ever read by server
 * modules — no client component imports this file, and anything that did would
 * receive values that are undefined on the client rather than real ones.
 */

export interface ServerEnv {
  /**
   * Where the FastAPI engine lives.
   *
   * Either an absolute URL (the engine deployed separately, or a local uvicorn), or
   * a same-origin path such as `/engine` that `vercel.json` rewrites to the Python
   * function. A path is only usable while a request is in flight — see
   * `resolveEngineUrl`.
   */
  readonly engineUrl: string;
  /** Shared secret presented to the engine on every request. */
  readonly engineToken: string;
  /** Key material that signs the session cookie. */
  readonly sessionSecret: string;
  /** Upstash/Vercel-KV REST credentials, when a shared session store is used. */
  readonly kv: { readonly url: string; readonly token: string } | null;
  /** True when the deployment is hosted, where loopback providers are unreachable. */
  readonly hosted: boolean;
  readonly nodeEnv: "development" | "test" | "production";
}

const PLACEHOLDER_SECRET = "ragdoll-development-session-secret-do-not-use-in-production";

/**
 * Same-origin path that `vercel.json` rewrites to the Python function.
 *
 * This is what makes the deployment zero-config: rather than asking the operator to
 * discover an internal service URL, the bridge calls its own `/engine` route and
 * Vercel routes it to `api/index.py`. An explicit `RAGDOLL_API_URL` always wins, so
 * pointing the bridge at a separately deployed engine stays supported.
 */
export const ENGINE_PROXY_PATH = "/engine";

/** True when the engine URL is a path that needs an origin before it can be used. */
export const isRelativeEngineUrl = (url: string): boolean => url.startsWith("/");

/**
 * Reads and validates environment configuration.
 * Missing secrets are tolerated only outside production, where a well-known
 * development value keeps `next dev` frictionless.
 * @param source Environment source, injectable for tests.
 */
export const readServerEnv = (source: NodeJS.ProcessEnv = process.env): ServerEnv => {
  const nodeEnv = (source.NODE_ENV ?? "development") as ServerEnv["nodeEnv"];
  const isProduction = nodeEnv === "production";
  const hosted = source.RAGDOLL_HOSTED === "1" || (source.VERCEL ?? "") === "1";

  const configuredEngineUrl = (source.RAGDOLL_API_URL ?? "").trim().replace(/\/+$/, "");
  const engineToken = (source.RAGDOLL_API_TOKEN ?? "").trim();
  const sessionSecret = (source.RAGDOLL_SESSION_SECRET ?? "").trim();
  const kvUrl = (source.KV_REST_API_URL ?? "").trim();
  const kvToken = (source.KV_REST_API_TOKEN ?? "").trim();

  if (isProduction && sessionSecret.length < 32) {
    throw new Error(
      "RAGDOLL_SESSION_SECRET must be set to at least 32 characters in production.",
    );
  }
  // Only an *externally* configured engine needs a token to have been chosen up
  // front; the same-origin rewrite is still token-checked, and a missing token there
  // simply fails closed.
  if (isProduction && configuredEngineUrl.length > 0 && engineToken.length < 16) {
    throw new Error(
      "RAGDOLL_API_TOKEN must be set to at least 16 characters when RAGDOLL_API_URL is configured.",
    );
  }

  return {
    engineUrl: configuredEngineUrl.length > 0 ? configuredEngineUrl : ENGINE_PROXY_PATH,
    // No invented default. A hosted deployment without a token cannot reach its
    // engine — every call fails closed with a 401 — and `isEngineConfigured`
    // reports that plainly instead of the UI claiming the pipeline is ready.
    engineToken,
    sessionSecret: sessionSecret.length >= 32 ? sessionSecret : PLACEHOLDER_SECRET,
    kv: kvUrl.length > 0 && kvToken.length > 0 ? { url: kvUrl, token: kvToken } : null,
    hosted,
    nodeEnv,
  };
};

/**
 * True when the bridge has everything it needs to call the engine.
 *
 * Both halves matter: a URL with no token would only produce 401s. The Development
 * fallback token keeps `pnpm dev` working without ceremony.
 */
export const isEngineConfigured = (env: ServerEnv): boolean =>
  env.engineUrl.length > 0 && (env.engineToken.length > 0 || env.nodeEnv !== "production");

let cached: ServerEnv | null = null;

/** Memoised environment accessor for request handlers. */
export const getServerEnv = (): ServerEnv => {
  cached ??= readServerEnv();
  return cached;
};

/** Test hook: forget the memoised environment. */
export const resetServerEnvCache = (): void => {
  cached = null;
};
