import type {
  ChatTurn,
  Citation,
  DocumentSummary,
  EvaluationReport,
  PipelineConfig,
} from "../types";

/**
 * Wire contract between the Next.js bridge and the FastAPI RAG engine.
 * `api/app/schemas.py` mirrors these shapes field for field; the CI drift check
 * regenerates types from `openapi.json` and fails when they diverge.
 */

export interface EngineDocumentInput {
  readonly id: string;
  readonly name: string;
  readonly sizeBytes: number;
  /** base64 payload — JSON keeps the contract identical to the OpenAPI schema. */
  readonly base64: string;
  readonly pageCount: number;
}

export interface EngineSessionInput {
  readonly sessionId: string;
  readonly config: PipelineConfig;
  readonly apiKey: string;
  readonly documents: readonly EngineDocumentInput[];
  readonly history: readonly ChatTurn[];
}

export interface TestConnectionResult {
  readonly reachable: boolean;
  readonly modelEcho: string;
  readonly latencyMs: number;
  readonly embeddingDimension: number;
  readonly embeddingProbe: boolean;
}

export interface UpsertResult {
  readonly engineSessionId: string;
  readonly documents: readonly DocumentSummary[];
  readonly chunkCount: number;
  readonly citations: readonly Citation[];
  readonly multimodal: boolean;
}

export interface ChatRequest {
  readonly sessionId: string;
  readonly question: string;
}

export interface ChatAnswer {
  readonly answer: string;
  readonly citations: readonly Citation[];
  readonly fallback: boolean;
  readonly standaloneQuery: string;
  readonly retrieved: number;
  readonly usage: { readonly promptTokens: number; readonly completionTokens: number };
  readonly faithfulness: number | null;
}

export interface EvaluateRequest {
  readonly sessionId: string;
  readonly sampleCount: number;
}

export interface ResetResult {
  readonly cleared: boolean;
}

export interface EngineClient {
  testConnection(session: EngineSessionInput): Promise<TestConnectionResult>;
  ensureIndex(session: EngineSessionInput): Promise<UpsertResult>;
  chat(session: EngineSessionInput, request: ChatRequest): Promise<ChatAnswer>;
  evaluate(session: EngineSessionInput, request: EvaluateRequest): Promise<EvaluationReport>;
  reset(sessionId: string): Promise<ResetResult>;
  /** Raw SSE body from the engine, forwarded verbatim by the chat route. */
  streamChat(session: EngineSessionInput, request: ChatRequest, signal: AbortSignal): Promise<Response>;
}

/** Error envelope returned by FastAPI for every non-2xx response. */
export interface EngineErrorBody {
  readonly detail?: {
    readonly code?: string;
    readonly message?: string;
    readonly fields?: Readonly<Record<string, string>>;
  };
}
