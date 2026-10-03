import "server-only";

import { cookies } from "next/headers";

import { getServerEnv } from "./env";
import { LIMITS } from "./rules";
import {
  newSessionId,
  sessionCookieName,
  sessionCookieOptions,
  sessionSecret,
  signId,
  verifyId,
} from "./session-token";

export { readSessionToken } from "./session-token";
import type { ChatTurn, SessionState, UploadedDocument } from "./types";

/**
 * Session persistence.
 *
 * Three layers, each covering the failure mode of the one above:
 *
 *  1. **the signed cookie** — carries a session *id* and nothing else, so it is a
 *     handle rather than a container. It is the only layer a browser can see, and
 *     it reveals nothing but an opaque identifier.
 *  2. **process memory** — the working set: session state plus the decoded PDF
 *     bytes. Fast, and the only layer that needs to hold bytes at all.
 *  3. **Upstash/Vercel KV** — the shared mirror. Present when configured, and what
 *     makes a session survive a cold start or a request landing on a different
 *     Function instance.
 *
 * The provider API key lives in the session, so it is visible to the two
 * server-side layers and never to the browser.
 *
 * Two failure modes shaped this design, and both are worth knowing before changing
 * anything here:
 *
 *  * The id must come from the request (`adoptSession`), never from a fresh
 *    `createEmptySession()`. If the store invents an id, the browser's cookie still
 *    names the old one, middleware sees a *valid* cookie and never re-mints it, and
 *    every lookup misses — the pipeline was saved and immediately invisible.
 *  * The in-process map hangs off `globalThis` rather than this module. Next.js
 *    compiles Server Actions and Route Handlers as separate bundles, so a
 *    module-level `Map` exists once per bundle *within one process*: an action wrote
 *    the pipeline into its copy while a route handler read an empty one.
 */

const KV_PREFIX = "ragdoll:session:";
/** KV TTL is one minute longer than the sliding window so it cannot expire mid-request. */
const KV_TTL_SECONDS = Math.ceil(LIMITS.sessionTtlMs / 1000) + 60;
/** Per-request ceiling of the Upstash REST API on free and pay-as-you-go plans. */
const KV_VALUE_LIMIT_BYTES = 10 * 1024 * 1024;

interface MemoryEntry {
  session: SessionState;
  expiresAt: number;
}

interface MemoryRegistry {
  sessions: Map<string, MemoryEntry>;
}

/**
 * The in-process store, hung off `globalThis`.
 *
 * Next.js compiles Server Actions and Route Handlers as separate bundles, so a
 * module-level `Map` exists once *per bundle* within the same process: an action
 * could write the pipeline into its copy while a route handler read an empty one.
 * `globalThis` is the one object both bundles share, which makes this a genuine
 * process-wide store. On Vercel it is still per-instance, which is exactly what
 * the KV layer is for.
 */
const registry: MemoryRegistry = (() => {
  const key = Symbol.for("ragdoll.session.store");
  const holder = globalThis as typeof globalThis & { [key]?: MemoryRegistry };
  holder[key] ??= { sessions: new Map<string, MemoryEntry>() };
  return holder[key];
})();

const memory = registry.sessions;

/** Drops expired entries; the maps are tiny because sessions expire in 15 minutes. */
const sweep = (now: number): void => {
  for (const [key, entry] of memory) {
    if (entry.expiresAt <= now) {
      memory.delete(key);
    }
  }
};

/* --------------------------------------------------------------------- KV */

const kvConfigured = (): boolean => getServerEnv().kv !== null;

/**
 * True when a hosted deployment has no shared session store configured.
 *
 * Reported rather than thrown: such a deployment still works while requests happen
 * to land on the same instance, and failing every route with a configuration error
 * would be worse than degrading. The snapshot surfaces it as
 * `capabilities.sharedStore` so the UI can say so out loud.
 */
export const sharedStoreMissing = (): boolean =>
  getServerEnv().hosted && getServerEnv().kv === null;

const kvCommand = async (command: readonly (string | number)[]): Promise<unknown> => {
  const kv = getServerEnv().kv;
  if (kv === null) {
    return null;
  }
  const response = await fetch(kv.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${kv.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
    cache: "no-store",
    signal: AbortSignal.timeout(4_000),
  });
  if (!response.ok) {
    throw new Error(`Session store responded ${response.status}.`);
  }
  const payload = (await response.json()) as { result?: unknown };
  return payload.result ?? null;
};

/**
 * Shape written to KV.
 *
 * PDF bytes are included as base64 because a request that lands on a cold instance
 * has nothing else to rebuild the index from, and re-uploading is not something a
 * user can be asked to do mid-conversation. The value is capped at one session's
 * upload budget.
 */
interface StoredSession {
  readonly id: string;
  readonly pipeline: SessionState["pipeline"];
  readonly documents: readonly {
    readonly id: string;
    readonly name: string;
    readonly sizeBytes: number;
    readonly base64: string;
    readonly pageCount: number;
    readonly chunkCount: number;
    readonly imageCount: number;
  }[];
  readonly chat: readonly ChatTurn[];
  readonly apiKey: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

const kvKey = (id: string): string => `${KV_PREFIX}${id}`;

const kvSet = async (session: SessionState): Promise<void> => {
  const value = JSON.stringify({
    id: session.id,
    pipeline: session.pipeline,
    documents: session.documents.map((document) => ({
      id: document.id,
      name: document.name,
      sizeBytes: document.sizeBytes,
      base64: Buffer.from(document.bytes).toString("base64"),
      pageCount: document.pageCount,
      chunkCount: document.chunkCount,
      imageCount: document.imageCount,
    })),
    chat: session.chat,
    apiKey: session.apiKey,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  } satisfies StoredSession);

  // Upstash rejects a request body over 10 MB on its free and pay-as-you-go plans,
  // and the app's own upload allowance (15 MB of PDFs, ~20 MB once base64-encoded)
  // can exceed that. Skipping with a warning is clearer than a failing request on
  // every write, and it names the consequence: this session stops being shared.
  if (Buffer.byteLength(value, "utf8") > KV_VALUE_LIMIT_BYTES) {
    console.warn(
      "[ragdoll] session is larger than the shared store accepts; it now lives only on this instance.",
    );
    return;
  }

  await kvCommand(["SET", kvKey(session.id), value, "EX", KV_TTL_SECONDS]);
};

const kvGet = async (id: string): Promise<SessionState | null> => {
  const raw = await kvCommand(["GET", kvKey(id)]);
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }
  const stored = JSON.parse(raw) as StoredSession;
  return {
    id: stored.id,
    pipeline: stored.pipeline,
    documents: stored.documents.map<UploadedDocument>((document) => ({
      id: document.id,
      name: document.name,
      sizeBytes: document.sizeBytes,
      bytes: new Uint8Array(Buffer.from(document.base64, "base64")),
      pageCount: document.pageCount,
      chunkCount: document.chunkCount,
      imageCount: document.imageCount,
    })),
    chat: [...stored.chat] as ChatTurn[],
    apiKey: stored.apiKey,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  };
};

const kvDelete = async (id: string): Promise<void> => {
  await kvCommand(["DEL", kvKey(id)]);
};

/* ------------------------------------------------------------------ loading */

export interface ResolvedSession {
  readonly session: SessionState;
  /** True when the session was rebuilt from KV rather than this process's memory. */
  readonly restored: boolean;
}

/**
 * Loads the session named by a request's signed token.
 * @param token Signed token from `readSessionToken`.
 * @param options.touch When false the read does not extend the sliding window. The
 *   status poll behind the header countdown uses this: a poll is the app observing
 *   the session, not the user using it, so it must report the real remaining
 *   lifetime instead of silently resetting it every few seconds.
 * @returns The session, or null when the token is absent, forged, or unknown.
 */
export const loadSession = async (
  token: string | null,
  options: { readonly touch?: boolean } = {},
): Promise<ResolvedSession | null> => {
  if (token === null) {
    return null;
  }
  const id = await verifyId(sessionSecret(), token);
  if (id === null) {
    return null;
  }

  const touch = options.touch ?? true;
  const now = Date.now();
  sweep(now);

  const cached = memory.get(id);
  if (cached !== undefined && cached.expiresAt > now) {
    if (touch) {
      // Refresh the sliding window without re-writing KV on every read.
      memory.set(id, { session: cached.session, expiresAt: now + LIMITS.sessionTtlMs });
    }
    return { session: cached.session, restored: false };
  }

  if (kvConfigured()) {
    try {
      const fromKv = await kvGet(id);
      if (fromKv !== null) {
        // An untouched read restores the entry for the lifetime it already had, so
        // the countdown and the store agree about when the session dies.
        const expiry = Math.max(now, (touch ? now : fromKv.updatedAt + LIMITS.sessionTtlMs));
        memory.set(id, { session: fromKv, expiresAt: expiry });
        return { session: fromKv, restored: true };
      }
    } catch (error) {
      console.warn(`[ragdoll] session store unavailable: ${String(error)}`);
    }
  }

  return null;
};

/**
 * Adopts the session identity middleware minted for this request.
 *
 * The id must come from the request, never from a fresh `createSession()`: the
 * browser's cookie already names a session, and if the store invents a different
 * id those two never meet — the cookie stays valid, so middleware never re-mints
 * it, and every lookup misses. That mismatch is what made a freshly built pipeline
 * invisible one navigation later.
 * @param token Signed token from `readSessionToken`.
 * @param options.touch Passed through to `loadSession`; see its note on polling.
 * @returns The existing session, or a new one carrying the request's id.
 */
export const adoptSession = async (
  token: string | null,
  options: { readonly touch?: boolean } = {},
): Promise<ResolvedSession> => {
  const resolved = await loadSession(token, options);
  if (resolved !== null) {
    return resolved;
  }

  const id = token === null ? null : await verifyId(sessionSecret(), token);
  return { session: createEmptySession(id ?? undefined), restored: false };
};

/**
 * Persists a session across the configured layers and re-mints the cookie.
 *
 * `updatedAt` is a compare-and-set token: a write whose stamp is behind the copy
 * already held is discarded, so a request that loaded the session before a
 * mutation cannot revert it by saving afterwards.
 * @param session Session to persist.
 */
export const saveSession = async (session: SessionState): Promise<SessionState> => {
  const now = Date.now();
  sweep(now);

  const existing = memory.get(session.id);
  if (existing !== undefined && existing.session.updatedAt > session.updatedAt) {
    return existing.session;
  }

  memory.set(session.id, { session, expiresAt: now + LIMITS.sessionTtlMs });

  if (kvConfigured()) {
    try {
      await kvSet(session);
    } catch (error) {
      console.warn(`[ragdoll] could not mirror session to KV: ${String(error)}`);
    }
  }

  const secret = sessionSecret();
  if (secret.length >= 32) {
    try {
      const store = await cookies();
      store.set(sessionCookieName(), await signId(secret, session.id), sessionCookieOptions());
    } catch {
      // Expected during a Server Component render, where cookies are immutable.
      // Middleware keeps the existing cookie alive for those requests.
    }
  }

  return session;
};

/** Purges a session from every layer. */
export const destroySession = async (id: string): Promise<void> => {
  memory.delete(id);
  if (kvConfigured()) {
    try {
      await kvDelete(id);
    } catch {
      // Best effort: the TTL will collect it.
    }
  }
  try {
    const store = await cookies();
    store.delete(sessionCookieName());
  } catch {
    // Nothing else to clean up.
  }
};

/**
 * Creates an empty session ready for the first pipeline configuration.
 * @param id Identity to adopt; a fresh one is minted when omitted. Callers that
 *   already have a request token must pass its id so the cookie and the store
 *   name the same session.
 */
export const createEmptySession = (id?: string): SessionState => {
  const now = Date.now();
  return {
    id: id ?? newSessionId(),
    pipeline: null,
    documents: [],
    chat: [],
    apiKey: "",
    createdAt: now,
    updatedAt: now,
  };
};

/** Remaining sliding-window lifetime, in milliseconds. */
export const remainingTtlMs = (session: SessionState): number =>
  Math.max(0, session.updatedAt + LIMITS.sessionTtlMs - Date.now());

/**
 * Re-stamps a session for a write, keeping `updatedAt` monotonic.
 *
 * `updatedAt` is the compare-and-set token in `saveSession`, so it must only ever
 * move forward: two writes inside the same millisecond would otherwise compare
 * equal and let a stale write through.
 */
export const stampSession = (session: SessionState): SessionState => {
  const now = Date.now();
  return { ...session, updatedAt: now > session.updatedAt ? now : session.updatedAt + 1 };
};

/** Test hook: clears the in-process store. */
export const resetSessionMemory = (): void => {
  memory.clear();
};
