import type { EngineDocumentInput, EngineSessionInput } from "./engine-contract";
import type { SessionState } from "../types";

/**
 * Converts session state into the engine wire format. Split out from the client
 * so the mapping is unit-testable without a network stub.
 */

export const bytesToBase64 = (bytes: Uint8Array): string =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");

export const base64ToBytes = (value: string): Uint8Array =>
  new Uint8Array(Buffer.from(value, "base64"));

export const toEngineDocuments = (session: SessionState): readonly EngineDocumentInput[] =>
  session.documents.map((document) => ({
    id: document.id,
    name: document.name,
    sizeBytes: document.sizeBytes,
    base64: bytesToBase64(document.bytes),
    pageCount: document.pageCount,
  }));

export const toEngineSession = (session: SessionState, apiKey: string): EngineSessionInput => {
  if (session.pipeline === null) {
    throw new Error("Cannot build an engine session without a pipeline.");
  }
  return {
    sessionId: session.id,
    config: session.pipeline,
    apiKey,
    documents: toEngineDocuments(session),
    history: session.chat,
  };
};
