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
  /** Base URL of the FastAPI RAG engine. */
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
 * Reads and validates environment configuration.
 * Missing secrets are tolerated only outside production, where a well-known
 * development value keeps `next dev` frictionless.
 * @param source Environment source, injectable for tests.
 */
export const readServerEnv = (source: NodeJS.ProcessEnv = process.env): ServerEnv => {
  const nodeEnv = (source.NODE_ENV ?? "development") as ServerEnv["nodeEnv"];
  const isProduction = nodeEnv === "production";

  const engineUrl = (source.RAGDOLL_API_URL ?? "").trim().replace(/\/+$/, "");
  const engineToken = (source.RAGDOLL_API_TOKEN ?? "").trim();
  const sessionSecret = (source.RAGDOLL_SESSION_SECRET ?? "").trim();
  const kvUrl = (source.KV_REST_API_URL ?? "").trim();
  const kvToken = (source.KV_REST_API_TOKEN ?? "").trim();

  if (isProduction && sessionSecret.length < 32) {
    throw new Error(
      "RAGDOLL_SESSION_SECRET must be set to at least 32 characters in production.",
    );
  }
  if (isProduction && engineUrl.length > 0 && engineToken.length < 16) {
    throw new Error(
      "RAGDOLL_API_TOKEN must be set to at least 16 characters when RAGDOLL_API_URL is configured.",
    );
  }

  return {
    engineUrl,
    engineToken: engineToken.length > 0 ? engineToken : "ragdoll-development-engine-token",
    sessionSecret: sessionSecret.length >= 32 ? sessionSecret : PLACEHOLDER_SECRET,
    kv: kvUrl.length > 0 && kvToken.length > 0 ? { url: kvUrl, token: kvToken } : null,
    hosted: source.RAGDOLL_HOSTED === "1" || (source.VERCEL ?? "") === "1",
    nodeEnv,
  };
};

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
