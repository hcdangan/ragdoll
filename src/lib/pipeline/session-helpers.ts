import "server-only";

import { appError } from "../errors";
import type { EngineRequest } from "../rag/service";
import type { PipelineSummary, SessionState } from "../types";
import { toEngineRequest } from "./wire";

/**
 * Session-scoped helpers shared by Server Actions and route handlers.
 *
 * The pipeline keeps its own copy of the index, and that copy lives in process
 * memory — it disappears when a Function instance is recycled. Callers handle the
 * `pipeline_missing` code by rebuilding from the PDFs the session still holds,
 * which `ensureIndex` does on demand and safely, because it is idempotent.
 */

/**
 * Builds the engine request for a session.
 * @param session Session state.
 * @param apiKey Provider key held in the session.
 */
export const enginePayload = (session: SessionState, apiKey: string): EngineRequest => {
  if (session.pipeline === null) {
    throw appError("pipeline_missing");
  }
  return toEngineRequest(session, apiKey);
};

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
