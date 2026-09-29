import type { EngineRequest } from "../rag/service";
import type { SessionState } from "../types";

/**
 * Converts session state into the engine request the in-process service consumes.
 *
 * Split out from the callers so the mapping is unit-testable without a provider
 * stub. The base64 hop is deliberate rather than incidental: it is the shape the
 * session store persists, so an index rebuilt on a cold instance is fed exactly
 * the bytes the user uploaded.
 */

const bytesToBase64 = (bytes: Uint8Array): string =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");

/**
 * Builds the engine request for a session.
 * @param session Session state, which must already hold a pipeline.
 * @param apiKey Provider credential held in the session.
 */
export const toEngineRequest = (session: SessionState, apiKey: string): EngineRequest => {
  if (session.pipeline === null) {
    throw new Error("Cannot build an engine request without a pipeline.");
  }
  const documents: EngineRequest["documents"][number][] = session.documents.map((document) => ({
    id: document.id,
    name: document.name,
    sizeBytes: document.sizeBytes,
    base64: bytesToBase64(document.bytes),
    pageCount: document.pageCount,
  }));

  return {
    sessionId: session.id,
    config: session.pipeline,
    apiKey,
    documents,
  };
};
