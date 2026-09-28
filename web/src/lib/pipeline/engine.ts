import "server-only";

import { AppError, appError } from "../errors";
import { getServerEnv } from "../env";
import { createEngineClient, type EngineClientOptions } from "./engine-client";
import type { EngineClient } from "./engine-contract";

/**
 * Resolves the engine client for this deployment.
 *
 * `RAGDOLL_API_URL` points at the FastAPI service — the Python function in the
 * same Vercel project, or `http://127.0.0.1:8000` for local development. The
 * engine is never called from a browser, so the shared token is the only
 * credential and there is no CORS surface.
 */

let cached: EngineClient | null = null;
let cachedKey = "";

export const engineConfigured = (): boolean => getServerEnv().engineUrl.length > 0;
export const getEngine = (): EngineClient => {
  const env = getServerEnv();
  if (env.engineUrl.length === 0) {
    throw appError("engine_error", undefined, {
      cause: new Error(
        "RAGDOLL_API_URL is not set. Point it at the FastAPI engine to enable the pipeline.",
      ),
    });
  }

  const key = `${env.engineUrl}|${env.engineToken}`;
  if (cached === null || cachedKey !== key) {
    const options: EngineClientOptions = {
      baseUrl: env.engineUrl,
      token: env.engineToken,
    };
    cached = createEngineClient(options);
    cachedKey = key;
  }
  return cached;
};

/** Test hook: forget the memoised client. */
export const resetEngineClient = (): void => {
  cached = null;
  cachedKey = "";
};

/**
 * Asserts that the deployment can serve pipeline requests, failing with an
 * actionable message rather than a generic 500.
 */
export const requireEngine = (): EngineClient => {
  try {
    return getEngine();
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw appError("engine_error", undefined, { cause: error });
  }
};
