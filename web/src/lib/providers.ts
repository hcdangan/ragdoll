import type { TranslationKey } from "./i18n";
import {
  DISTANCE_METRICS,
  EMBEDDING_MODELS,
  RETRIEVAL_MODES,
  type DistanceMetric,
  type EmbeddingModel,
  type ProviderId,
  type RetrievalMode,
} from "./types";

/**
 * Single source of truth for provider behaviour. The FastAPI engine mirrors
 * this table in `api/app/providers.py`; changing one without the other is the
 * one drift this project cannot tolerate, so both files carry the same order.
 */

export interface ProviderDefinition {
  readonly id: ProviderId;
  readonly labelKey: string;
  readonly baseUrl: string | null;
  readonly requiresBaseUrl: boolean;
  readonly defaultModel: string;
  readonly embeddingModels: readonly EmbeddingModel[];
  /** Suggested models offered as datalist hints; the field stays free text. */
  readonly modelSuggestions: readonly string[];
  /** Self-hosted providers cannot be reached from Vercel's network. */
  readonly selfHosted: boolean;
}

export const PROVIDERS: Readonly<Record<ProviderId, ProviderDefinition>> = {
  openai: {
    id: "openai",
    labelKey: "provider.openai",
    baseUrl: "https://api.openai.com/v1",
    requiresBaseUrl: false,
    defaultModel: "gpt-4o-mini",
    embeddingModels: ["text-embedding-3-small", "text-embedding-3-large"],
    modelSuggestions: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "o4-mini"],
    selfHosted: false,
  },
  vocareum: {
    id: "vocareum",
    labelKey: "provider.vocareum",
    baseUrl: "https://openai.vocareum.com/v1",
    requiresBaseUrl: false,
    defaultModel: "gpt-4o-mini",
    embeddingModels: ["text-embedding-3-small", "text-embedding-3-large"],
    modelSuggestions: ["gpt-4o-mini", "gpt-4o"],
    selfHosted: false,
  },
  deepseek: {
    id: "deepseek",
    labelKey: "provider.deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    requiresBaseUrl: false,
    defaultModel: "deepseek-flash",
    embeddingModels: ["text-embedding-3-small", "text-embedding-3-large"],
    modelSuggestions: ["deepseek-flash", "deepseek-chat", "deepseek-reasoner"],
    selfHosted: false,
  },
  ollama: {
    id: "ollama",
    labelKey: "provider.ollama",
    baseUrl: null,
    requiresBaseUrl: true,
    defaultModel: "llama3.2",
    embeddingModels: [
      "nomic-embed-text",
      "bge-m3",
      "embeddinggemma",
      "mxbai-embed-large",
    ],
    modelSuggestions: ["llama3.2", "llama3.1", "qwen2.5", "mistral"],
    selfHosted: true,
  },
};

export const PROVIDER_ORDER: readonly ProviderId[] = ["openai", "vocareum", "deepseek", "ollama"];

/** Vector width per embedding model — fixed by the model vendor. */
export const EMBEDDING_DIMENSIONS: Readonly<Record<EmbeddingModel, number>> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "nomic-embed-text": 768,
  "bge-m3": 1024,
  embeddinggemma: 768,
  "mxbai-embed-large": 1024,
};

export const DISTANCE_METRIC_LABEL_KEYS: Readonly<Record<DistanceMetric, TranslationKey>> = {
  cosine: "metric.cosine",
  dot: "metric.dot",
  euclidean: "metric.euclidean",
};

export const RETRIEVAL_MODE_LABEL_KEYS: Readonly<Record<RetrievalMode, TranslationKey>> = {
  "context-injection": "retrieval.contextInjection",
  agentic: "retrieval.agentic",
};

export const SIMILARITY_HINTS: Readonly<Record<DistanceMetric, string>> = {
  cosine: "Similarity 0–1 · length insensitive",
  dot: "Raw inner product · rewards long vectors",
  euclidean: "Lower is closer · converted to 1/(1+d)",
};

export const DEFAULT_PROVIDER: ProviderId = "openai";

export const isProviderId = (value: unknown): value is ProviderId =>
  typeof value === "string" && (PROVIDER_ORDER as readonly string[]).includes(value);

export const isEmbeddingModel = (value: unknown): value is EmbeddingModel =>
  typeof value === "string" && (EMBEDDING_MODELS as readonly string[]).includes(value);

export const isDistanceMetric = (value: unknown): value is DistanceMetric =>
  typeof value === "string" && (DISTANCE_METRICS as readonly string[]).includes(value);

export const isRetrievalMode = (value: unknown): value is RetrievalMode =>
  typeof value === "string" && (RETRIEVAL_MODES as readonly string[]).includes(value);

/**
 * Resolves the effective base URL for a provider selection.
 * @param provider Provider id.
 * @param customBaseUrl User-supplied URL, required for self-hosted providers.
 * @returns The absolute base URL, or null when the input is incomplete.
 */
export const resolveBaseUrl = (provider: ProviderId, customBaseUrl: string): string | null => {
  const definition = PROVIDERS[provider];
  if (definition.requiresBaseUrl) {
    const trimmed = customBaseUrl.trim().replace(/\/+$/, "");
    return trimmed.length > 0 ? trimmed : null;
  }
  return definition.baseUrl;
};

/**
 * Resolves the embedding model default for a provider, guaranteeing the
 * selection stays valid when the user switches providers.
 * @param provider Provider id.
 * @param current Currently selected embedding model, if any.
 * @returns A model supported by the provider.
 */
export const resolveEmbeddingModel = (
  provider: ProviderId,
  current: string | null,
): EmbeddingModel => {
  const allowed = PROVIDERS[provider].embeddingModels;
  if (current !== null && (allowed as readonly string[]).includes(current)) {
    return current as EmbeddingModel;
  }
  const fallback = allowed[0];
  if (fallback === undefined) {
    throw new Error(`Provider ${provider} has no embedding models configured.`);
  }
  return fallback;
};

/**
 * True when a URL points at the machine running the function or its local network.
 *
 * Mirrors `api/app/providers.py::is_loopback_host`; the two runtimes must agree or
 * the creation form will accept a URL the engine then refuses (or the reverse).
 * `172.16.0.0/12` and mDNS `.local` names are included because an Ollama server on
 * a LAN is the common self-hosted case.
 * @param url Candidate base URL.
 */
export const isLoopbackUrl = (url: string): boolean => {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return false;
  }

  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname === "::1" ||
    hostname === "0.0.0.0" ||
    hostname.endsWith(".internal")
  ) {
    return true;
  }

  const octets = hostname.split(".");
  if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/.test(octet))) {
    return false;
  }
  const [first = 0, second = 0] = octets.map(Number);
  if (first === 127 || first === 10) {
    return true;
  }
  if (first === 192 && second === 168) {
    return true;
  }
  if (first === 172 && second >= 16 && second <= 31) {
    return true;
  }
  return first === 169 && second === 254;
};
