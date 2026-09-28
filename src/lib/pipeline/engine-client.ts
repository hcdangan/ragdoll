import "server-only";

import { AppError, appError, type AppErrorCode } from "../errors";
import type { EvaluationReport } from "../types";
import type {
  ChatAnswer,
  ChatRequest,
  EngineClient,
  EngineErrorBody,
  EngineSessionInput,
  EvaluateRequest,
  ResetResult,
  TestConnectionResult,
  UpsertResult,
} from "./engine-contract";

/**
 * HTTP driver for the FastAPI RAG engine.
 *
 * Every non-streaming call goes through `request`, which owns timeouts, retry
 * with jittered backoff, and the translation of HTTP status codes into the
 * application's error taxonomy. Streaming cannot be retried (tokens may already
 * have been consumed) so it takes the abort signal from the caller instead.
 */

export const ENGINE_TIMEOUT_MS = {
  test: 20_000,
  upsert: 60_000,
  chat: 45_000,
  evaluate: 120_000,
  reset: 5_000,
  stream: 60_000,
} as const;

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 250;

export interface EngineClientOptions {
  readonly baseUrl: string;
  readonly token: string;
}

const STATUS_TO_CODE: Readonly<Record<number, AppErrorCode>> = {
  400: "validation",
  401: "provider_auth",
  403: "unauthorized",
  404: "pipeline_missing",
  409: "pipeline_missing",
  410: "pipeline_missing",
  413: "validation",
  429: "rate_limited",
  502: "provider_unreachable",
  503: "provider_unreachable",
  504: "timeout",
};

const UPSTREAM_CODE_TO_CODE = (code: string | undefined): AppErrorCode | null => {
  switch (code) {
    case "jailbreak":
      return "guardrail_jailbreak";
    case "prompt_injection":
      return "guardrail_injection";
    case "invalid_api_key":
      return "provider_auth";
    case "provider_unreachable":
      return "provider_unreachable";
    case "pdf_invalid":
      return "pdf_invalid";
    case "pdf_encrypted":
      return "pdf_encrypted";
    case "pdf_active_content":
      return "pdf_active_content";
    case "pipeline_missing":
      return "pipeline_missing";
    case "unauthorized":
      return "unauthorized";
    case "validation":
      return "validation";
    default:
      return null;
  }
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Builds the engine client. Documents are sent once per session; subsequent
 * calls reuse the engine-side index unless it reports `pipeline_missing`, in
 * which case the caller re-runs `ensureIndex`.
 */
export const createEngineClient = ({ baseUrl, token }: EngineClientOptions): EngineClient => {
  const endpoint = (path: string): string => `${baseUrl}${path}`;

  const request = async <T>(
    path: string,
    body: unknown,
    options: {
      readonly timeoutMs: number;
      readonly attempts?: number;
      readonly signal?: AbortSignal;
      readonly method?: "POST" | "DELETE";
    },
  ): Promise<T> => {
    const attempts = options.attempts ?? MAX_ATTEMPTS;
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await fetch(endpoint(path), {
          method: options.method ?? "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: options.method === "DELETE" ? undefined : JSON.stringify(body),
          cache: "no-store",
          signal: options.signal ?? AbortSignal.timeout(options.timeoutMs),
        });

        if (response.ok) {
          return (await response.json()) as T;
        }

        const failure = await readEngineError(response);
        if (failure.retryable && attempt < attempts) {
          lastError = failure;
          await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1) + Math.random() * 100);
          continue;
        }
        throw failure;
      } catch (error) {
        if (error instanceof AppError) {
          if (!error.retryable || attempt === attempts) {
            throw error;
          }
          lastError = error;
          await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1) + Math.random() * 100);
          continue;
        }
        if (error instanceof Error && error.name === "AbortError") {
          throw appError("timeout", undefined, { cause: error });
        }
        lastError = appError("network", undefined, { cause: error });
        if (attempt === attempts) {
          throw lastError;
        }
        await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
      }
    }

    throw lastError ?? appError("network");
  };

  return {
    // The engine wraps every payload in `{ session }`, so the envelope is built
    // here rather than at each call site; `/v1/session/{id}` is the exception.
    testConnection: (session: EngineSessionInput) =>
      request<TestConnectionResult>("/v1/test", { session }, { timeoutMs: ENGINE_TIMEOUT_MS.test }),

    ensureIndex: (session: EngineSessionInput) =>
      request<UpsertResult>("/v1/pipeline", { session }, { timeoutMs: ENGINE_TIMEOUT_MS.upsert }),

    chat: (session: EngineSessionInput, chatRequest: ChatRequest) =>
      request<ChatAnswer>(
        "/v1/chat",
        { session, question: chatRequest.question },
        { timeoutMs: ENGINE_TIMEOUT_MS.chat },
      ),

    evaluate: (session: EngineSessionInput, evaluateRequest: EvaluateRequest) =>
      request<EvaluationReport>(
        "/v1/evaluate",
        { session, sampleCount: evaluateRequest.sampleCount },
        { timeoutMs: ENGINE_TIMEOUT_MS.evaluate },
      ),

    reset: (sessionId: string) =>
      request<ResetResult>(
        `/v1/session/${encodeURIComponent(sessionId)}`,
        null,
        { timeoutMs: ENGINE_TIMEOUT_MS.reset, method: "DELETE", attempts: 1 },
      ),

    streamChat: async (session, chatRequest, signal) => {
      const response = await fetch(endpoint("/v1/chat/stream"), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({ session, question: chatRequest.question }),
        cache: "no-store",
        signal: combineSignals(signal, AbortSignal.timeout(ENGINE_TIMEOUT_MS.stream)),
      });

      if (!response.ok || response.body === null) {
        throw await readEngineError(response);
      }
      return response;
    },
  };
};

/**
 * Reads a FastAPI error envelope and maps it onto the app error taxonomy.
 * @param response Failed upstream response.
 */
export const readEngineError = async (response: Response): Promise<AppError> => {
  let body: EngineErrorBody | null = null;
  try {
    body = (await response.json()) as EngineErrorBody;
  } catch {
    body = null;
  }

  const upstreamCode = body?.detail?.code;
  const mapped = UPSTREAM_CODE_TO_CODE(upstreamCode) ?? STATUS_TO_CODE[response.status] ?? "engine_error";
  const message =
    body?.detail?.message ??
    (mapped === "engine_error"
      ? `The RAG engine responded with ${response.status}.`
      : undefined);

  const fields = body?.detail?.fields;
  return new AppError(mapped, message ?? defaultMessageFor(mapped), {
    ...(fields === undefined ? {} : { fields }),
  });
};

const defaultMessageFor = (code: AppErrorCode): string => {
  switch (code) {
    case "provider_auth":
      return "The provider rejected the API key. Check the key and provider selection.";
    case "provider_unreachable":
      return "The provider could not be reached. Check the base URL and network access.";
    case "guardrail_jailbreak":
      return "This request looks like a jailbreak attempt and was blocked.";
    case "guardrail_injection":
      return "This request looks like a prompt injection attempt and was blocked.";
    case "pipeline_missing":
      return "No pipeline exists in this session. Create one to continue.";
    case "timeout":
      return "The RAG engine timed out. Try again.";
    case "validation":
      return "The request was rejected as invalid.";
    default:
      return "The RAG engine returned an unexpected error.";
  }
};

/**
 * Combines a caller abort signal with a hard timeout.
 * @param signals Signals to merge; the first abort wins.
 */
export const combineSignals = (...signals: readonly AbortSignal[]): AbortSignal => {
  const controller = new AbortController();
  const onAbort = (): void => {
    controller.abort();
  };
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }
  return controller.signal;
};
