import "server-only";

import { AppError, appError } from "../errors";
import { requireEngine } from "./engine";
import type { EngineSessionInput } from "./engine-contract";
import { toEngineSession } from "./wire";
import type { PipelineSummary, SessionState } from "../types";

/**
 * Session-scoped helpers shared by Server Actions and route handlers.
 *
 * The engine keeps its own copy of the index, and that copy can disappear when a
 * Function instance is recycled. Callers handle the `pipeline_missing` code by
 * rebuilding from the PDFs the session still holds — `ensureIndex` is idempotent,
 * so re-running it is always safe.
 */

/**
 * Builds the engine payload for a session.
 * @param session Session state.
 * @param apiKey Provider key held in the session.
 */
export const enginePayload = (session: SessionState, apiKey: string): EngineSessionInput => {
  if (session.pipeline === null) {
    throw appError("pipeline_missing");
  }
  return toEngineSession(session, apiKey);
};

/** True when the session holds a pipeline the engine can be asked about. */
export const hasPipeline = (session: SessionState): boolean => session.pipeline !== null;

/** Throws when the engine is not configured, with an actionable message. */
export const requireEngineClient = () => requireEngine();

/** Re-wraps an unknown failure, preserving AppErrors. */
export const asAppError = (error: unknown, fallbackMessage?: string): AppError =>
  error instanceof AppError
    ? error
    : new AppError("internal", fallbackMessage ?? "Something went wrong. Try again.", {
        cause: error,
      });

/** Summarises a session for the UI without exposing the API key. */
export const toPipelineSummary = (session: SessionState): PipelineSummary | null => {
  if (session.pipeline === null) {
    return null;
  }
  const documents = session.documents.map((document) => ({
    id: document.id,
    name: document.name,
    sizeBytes: document.sizeBytes,
    pageCount: document.pageCount,
    chunkCount: document.chunkCount,
    imageCount: document.imageCount,
    hasImages: document.imageCount > 0,
  }));

  return {
    config: session.pipeline,
    documents,
    chunkCount: documents.reduce((total, document) => total + document.chunkCount, 0),
    createdAt: new Date(session.createdAt).toISOString(),
    chatTurnCount: session.chat.length,
    multimodal: documents.some((document) => document.hasImages),
  };
};

/** Rebuilds an engine index from the PDFs the session still holds. */
export const rebuildIndex = async (
  session: SessionState,
  apiKey: string,
): Promise<{ readonly chunkCount: number; readonly documents: number }> => {
  const upsert = await requireEngine().ensureIndex(enginePayload(session, apiKey));
  return { chunkCount: upsert.chunkCount, documents: upsert.documents.length };
};
