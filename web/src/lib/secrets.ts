import "server-only";

import { maskSecret } from "./crypto";
import { AppError } from "./errors";
import type { ProviderKeyStatus, SessionState } from "./types";

/**
 * Provider credential access.
 *
 * The key lives in the session, from where it is re-encrypted into the sealed
 * `__Host-ragdoll-sid` cookie on every save. That gives the three properties the
 * UI promises, each enforced structurally rather than by convention:
 *
 *  * **session-only** — it is never written to a database or to disk;
 *  * **never exposed** — the cookie is HttpOnly and AES-GCM sealed, so nothing
 *    the browser can read contains it;
 *  * **purged on expiry** — the sliding TTL drops the cookie, and with it the
 *    only copy.
 *
 * This module exists so no route handles the raw key directly: a caller either
 * asks for a masked summary or gets a hard, actionable failure.
 */

/**
 * Returns the provider key held by a session.
 * @param session Session state.
 * @throws AppError when the session holds no key, so the user is told to
 *   re-enter it rather than being shown a provider 401 they cannot explain.
 */
export const requireApiKey = (session: SessionState): string => {
  if (session.apiKey.trim().length === 0) {
    throw new AppError(
      "provider_auth",
      "The API key is no longer in this session. Re-enter it on the RAG Creation page to continue.",
    );
  }
  return session.apiKey;
};

/** True when the session holds a usable credential. */
export const hasApiKey = (session: SessionState): boolean => session.apiKey.trim().length > 0;

/** Masked status of the session's credential, for display only. */
export const describeApiKey = (session: SessionState): ProviderKeyStatus | null => {
  if (session.pipeline === null) {
    return null;
  }
  return {
    hasKey: hasApiKey(session),
    maskedKey: hasApiKey(session) ? maskSecret(session.apiKey) : null,
    model: session.pipeline.model,
    baseUrl: session.pipeline.baseUrl,
  };
};
