/**
 * Domain types shared by the browser and the Next.js server. Everything here is
 * JSON-serialisable because pipeline state is persisted to KV and rehydrated into
 * a server-side session on the next request.
 */

export const PROVIDER_IDS = ["openai", "vocareum", "deepseek", "ollama"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const DISTANCE_METRICS = ["cosine", "dot", "euclidean"] as const;
export type DistanceMetric = (typeof DISTANCE_METRICS)[number];

export const RETRIEVAL_MODES = ["context-injection", "agentic"] as const;
export type RetrievalMode = (typeof RETRIEVAL_MODES)[number];

export const EMBEDDING_MODELS = [
  "text-embedding-3-small",
  "text-embedding-3-large",
  "nomic-embed-text",
  "bge-m3",
  "embeddinggemma",
  "mxbai-embed-large",
] as const;
export type EmbeddingModel = (typeof EMBEDDING_MODELS)[number];

/** Immutable pipeline configuration captured at creation time. */
export interface PipelineConfig {
  readonly provider: ProviderId;
  /** Resolved base URL — the user's value when the provider is self-hosted. */
  readonly baseUrl: string;
  readonly model: string;
  readonly embeddingModel: EmbeddingModel;
  /** Derived from `embeddingModel`; read-only to prevent index/model drift. */
  readonly embeddingDimension: number;
  readonly chunkSize: number;
  readonly chunkOverlapPercent: number;
  /** Rounded to the nearest multiple of 32 and clamped to 10–20% of chunkSize. */
  readonly chunkOverlapTokens: number;
  readonly maxInputTokens: number;
  readonly distanceMetric: DistanceMetric;
  readonly topK: number;
  readonly retrievalMode: RetrievalMode;
}

/** A single retrievable span of a source PDF. */
export interface Chunk {
  readonly id: string;
  readonly documentId: string;
  readonly documentName: string;
  readonly page: number;
  readonly index: number;
  readonly text: string;
  readonly tokenCount: number;
}

/** A PDF uploaded for this session, as summarised for the UI. */
export interface DocumentSummary {
  readonly id: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly pageCount: number;
  readonly chunkCount: number;
  readonly imageCount: number;
  /** True when the PDF carries extractable raster images (multimodal eval). */
  readonly hasImages: boolean;
}

/** Persisted shape of a session, stored in KV or sealed into the cookie. */
export interface PersistedSession {
  readonly id: string;
  readonly pipeline: PipelineConfig | null;
  readonly documents: readonly {
    readonly id: string;
    readonly name: string;
    readonly sizeBytes: number;
    /** base64 payload of the original PDF bytes. */
    readonly base64: string;
    readonly pageCount: number;
    readonly chunkCount: number;
    readonly imageCount: number;
  }[];
  readonly chat: readonly ChatTurn[];
  /** Ciphertext of the provider credential, sealed with the session secret. */
  readonly apiKeySealed: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** A retrieved source surfaced to the citation panel. */
export interface Citation {
  readonly chunkId: string;
  readonly documentId: string;
  readonly documentName: string;
  readonly page: number;
  readonly score: number;
  readonly snippet: string;
  /** Zero-based retrieval rank, so the panel can order sources without re-sorting. */
  readonly rank?: number;
}

export interface ChatTurn {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly citations: readonly Citation[];
  readonly createdAt: string;
  /** True when the answer was replaced by the groundedness fallback string. */
  readonly fallback?: boolean;
}

export interface PipelineSummary {
  readonly config: PipelineConfig;
  readonly documents: readonly DocumentSummary[];
  readonly chunkCount: number;
  readonly createdAt: string;
  readonly chatTurnCount: number;
  readonly multimodal: boolean;
}

/** Server-side session payload. Never leaves the Next.js process unencrypted. */
export interface SessionState {
  readonly id: string;
  /** Active pipeline configuration, null until the user creates one. */
  pipeline: PipelineConfig | null;
  readonly documents: UploadedDocument[];
  chat: ChatTurn[];
  /**
   * Provider credential for this session.
   *
   * It is re-encrypted into the sealed session cookie on every save, so it
   * survives an instance recycling without becoming readable from the browser
   * (the cookie is HttpOnly and AES-GCM sealed) and without touching disk.
   */
  apiKey: string;
  createdAt: number;
  updatedAt: number;
}

export interface UploadedDocument {
  readonly id: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly bytes: Uint8Array;
  readonly pageCount: number;
  readonly chunkCount: number;
  readonly imageCount: number;
}

export const EVALUATION_METRICS = [
  "context_precision",
  "context_recall",
  "context_entity_recall",
  "noise_sensitivity",
  "response_relevancy",
  "faithfulness",
  "multimodal_faithfulness",
  "multimodal_relevance",
] as const;
export type EvaluationMetric = (typeof EVALUATION_METRICS)[number];

export type MetricScore = number | "N/A";

export interface MetricResult {
  readonly metric: EvaluationMetric;
  readonly score: MetricScore;
  readonly samples: number;
  readonly reason: string;
  readonly skippedReason?: string;
}

export interface EvaluationSample {
  readonly question: string;
  readonly answer: string;
  readonly groundTruth: string | null;
  readonly contexts: readonly string[];
  readonly citations: readonly Citation[];
  readonly fallback: boolean;
}

export interface EvaluationReport {
  readonly category: "Retrieval Augmented Generation";
  readonly createdAt: string;
  readonly durationMs: number;
  readonly sampleCount: number;
  readonly documentCount: number;
  readonly metrics: readonly MetricResult[];
  readonly samples: readonly EvaluationSample[];
}

export interface ProviderKeyStatus {
  readonly hasKey: boolean;
  readonly maskedKey: string | null;
  readonly model: string;
  readonly baseUrl: string;
}
