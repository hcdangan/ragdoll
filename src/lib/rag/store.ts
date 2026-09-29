import "server-only";

import type { VectorIndex } from "./distance";
import { PdfRejectedError, type ParsedDocument } from "./pdf";
import type { OwnedChunk } from "./prompts";

/**
 * In-process store for parsed documents, vector indexes and chat history.
 *
 * The Python engine kept this in a FastAPI-side session registry because it was a
 * separate runtime. Now that the engine *is* the Next.js server, the store is simply
 * this process — which removes a whole class of failure (no second service to lose
 * state, no internal URL to configure, no cross-instance index rebuild).
 *
 * Like the session store, the registry hangs off `globalThis` because Next.js
 * compiles Server Actions and Route Handlers as separate bundles: a module-level Map
 * would exist once per bundle *within one process*, so an action could write an index
 * that a route handler could not see.
 */

const MAX_HISTORY_TURNS = 24;
const MAX_INDEX_BYTES = 24 * 1024 * 1024;

export interface EngineSession {
  readonly id: string;
  readonly documents: ParsedDocument[];
  index: VectorIndex | null;
  history: { readonly role: "user" | "assistant"; readonly content: string }[];
  multimodal: boolean;
  /** `${documentId}:${page}` for pages whose content is essentially an image. */
  imageOnlyPageKeys: Set<string>;
  updatedAt: number;
}

interface Registry {
  readonly sessions: Map<string, { session: EngineSession; expiresAt: number }>;
}

const registry: Registry = (() => {
  const key = Symbol.for("ragdoll.engine.store");
  const holder = globalThis as typeof globalThis & { [key]?: Registry };
  holder[key] ??= { sessions: new Map() };
  return holder[key];
})();

/** Session lifetime, mirrored from the web session TTL. */
const TTL_MS = 15 * 60 * 1000;

const sweep = (now: number): void => {
  for (const [id, entry] of registry.sessions) {
    if (entry.expiresAt <= now) {
      registry.sessions.delete(id);
    }
  }
};

/** Every chunk the session holds, paired with its document identity. */
export function ownedChunks(session: EngineSession): OwnedChunk[] {
  const owned: OwnedChunk[] = [];
  for (const document of session.documents) {
    for (const chunk of document.chunks) {
      owned.push({ documentId: document.id, documentName: document.name, chunk });
    }
  }
  return owned;
}

/** Returns a live session, refreshing its sliding window. */
export function getSession(id: string): EngineSession | null {
  const now = Date.now();
  sweep(now);
  const entry = registry.sessions.get(id);
  if (entry === undefined) {
    return null;
  }
  entry.expiresAt = now + TTL_MS;
  return entry.session;
}

/** Creates a session, replacing any existing one with the same id. */
export function createSession(id: string): EngineSession {
  const session: EngineSession = {
    id,
    documents: [],
    index: null,
    history: [],
    multimodal: false,
    imageOnlyPageKeys: new Set(),
    updatedAt: Date.now(),
  };
  putSession(session);
  return session;
}

/** Stores a session and enforces the aggregate index budget. */
export function putSession(session: EngineSession): void {
  const now = Date.now();
  session.updatedAt = now;
  registry.sessions.set(session.id, { session, expiresAt: now + TTL_MS });
  enforceMemoryGuard();
}

/** Removes a session. */
export function dropSession(id: string): boolean {
  return registry.sessions.delete(id);
}

/** Number of live sessions in this process. */
export function sessionCount(): number {
  sweep(Date.now());
  return registry.sessions.size;
}

/** Appends a turn, trimming the oldest beyond the retention window. */
export function rememberTurn(
  session: EngineSession,
  turn: { readonly role: "user" | "assistant"; readonly content: string },
): void {
  session.history.push(turn);
  if (session.history.length > MAX_HISTORY_TURNS) {
    session.history.splice(0, session.history.length - MAX_HISTORY_TURNS);
  }
  session.updatedAt = Date.now();
}

/** Evicts the least recently used sessions past the size budget. */
function enforceMemoryGuard(): void {
  const total = (): number =>
    [...registry.sessions.values()].reduce(
      (sum, entry) => sum + (entry.session.index?.memoryBytes() ?? 0),
      0,
    );

  if (total() <= MAX_INDEX_BYTES) {
    return;
  }
  const ordered = [...registry.sessions.values()].sort(
    (left, right) => left.session.updatedAt - right.session.updatedAt,
  );
  while (total() > MAX_INDEX_BYTES && ordered.length > 1) {
    const victim = ordered.shift();
    if (victim === undefined) {
      break;
    }
    registry.sessions.delete(victim.session.id);
  }
}

/** True when a PDF rejection should surface as a sandbox failure. */
export const isPdfRejection = (error: unknown): error is PdfRejectedError =>
  error instanceof PdfRejectedError;

/** Test hook: clears every session in this process. */
export function resetEngineStore(): void {
  registry.sessions.clear();
}
