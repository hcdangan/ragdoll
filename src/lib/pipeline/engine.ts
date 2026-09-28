import "server-only";

import { AppError, appError } from "../errors";
import { getServerEnv, isEngineConfigured, isRelativeEngineUrl } from "../env";
import { requestOrigin } from "../request-origin";
import { createEngineClient, type EngineClientOptions } from "./engine-client";
import type { EngineClient } from "./engine-contract";

/**
 * Resolves the engine client for this deployment.
 *
 * `RAGDOLL_API_URL` points at the FastAPI engine when it is deployed separately. On
 * Vercel the engine is a function in this same project, so the default is the
 * same-origin `/engine` path that `vercel.json` rewrites to `api/index.py` — that
 * default is what makes an imported deployment work with no extra configuration.
 *
 * The engine is never called from a browser, so the shared token is the only
 * credential and there is no CORS surface.
 */

/** Clients are cheap and hold no per-request state, so they are memoised by key. */
const clients = new Map<string, EngineClient>();

export const engineConfigured = (): boolean => isEngineConfigured(getServerEnv());

/**
 * Absolute base URL for the engine, resolved against the request in flight.
 * @throws AppError when a path-based URL has no request to resolve against.
 */
export const resolveEngineBaseUrl = async (): Promise<string> => {
  const env = getServerEnv();
  if (!isRelativeEngineUrl(env.engineUrl)) {
    return env.engineUrl;
  }

  const origin = await requestOrigin();
  if (origin.length === 0) {
    throw appError("engine_error", undefined, {
      cause: new Error(
        `The engine URL "${env.engineUrl}" is a path and there is no request in flight to resolve it against.`,
      ),
    });
  }
  return `${origin}${env.engineUrl}`;
};

/**
 * Returns the engine client for the current request.
 * @throws AppError with an actionable message when the engine is unconfigured.
 */
export const getEngine = async (): Promise<EngineClient> => {
  const env = getServerEnv();
  if (!isEngineConfigured(env)) {
    throw appError("engine_error", undefined, {
      cause: new Error(
        "The engine is not reachable: set RAGDOLL_API_TOKEN on the deployment (and RAGDOLL_API_URL if the engine is deployed separately).",
      ),
    });
  }

  const baseUrl = await resolveEngineBaseUrl();
  const key = `${baseUrl}|${env.engineToken}`;
  const existing = clients.get(key);
  if (existing !== undefined) {
    return existing;
  }

  const options: EngineClientOptions = { baseUrl, token: env.engineToken };
  const client = createEngineClient(options);
  clients.set(key, client);
  return client;
};

/** Test hook: forget the memoised clients. */
export const resetEngineClient = (): void => {
  clients.clear();
};

/**
 * Asserts that the deployment can serve pipeline requests, failing with an
 * actionable message rather than a generic 500.
 */
export const requireEngine = async (): Promise<EngineClient> => {
  try {
    return await getEngine();
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw appError("engine_error", undefined, { cause: error });
  }
};
