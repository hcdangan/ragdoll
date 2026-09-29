/**
 * Provider client for chat completions and embeddings.
 *
 * Ported from the FastAPI engine's `llm.py`. Every provider the workbench offers is
 * reachable through one of exactly two wire protocols, so this module keeps a single
 * request path and branches only when the shapes genuinely differ — that is what makes
 * "the provider that works in the creation form is the provider that answers in chat"
 * true by construction rather than by careful duplication.
 *
 * Server-side only: `RAGDOLL_HOSTED` is read here to refuse loopback URLs from a hosted
 * deployment, which only makes sense in a Node runtime.
 */

/** Attempts per inference call, matching the engine's three-strike budget. */
const MAX_ATTEMPTS = 3;

/** Backoff base; attempt 1 waits ~400ms, attempt 2 ~800ms, plus jitter. */
const BACKOFF_BASE_MS = 400;

/** Upper bound on a single backoff sleep, keeping a retry loop inside the route budget. */
const BACKOFF_CAP_MS = 5_000;

/** Embedding inputs per request. Large enough to amortise latency, small enough to retry. */
const EMBED_BATCH_SIZE = 32;

/** Floor for a configured timeout — below this a cold provider always looks unreachable. */
const MIN_TIMEOUT_MS = 1_000;

/** Default request timeout; the chat route allows 60s end to end. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Tag applied by the probe request so a provider's echo is recognisable in logs. */
const PROBE_PROMPT = "Reply with the single word: ready";

/** Token ceiling for the probe; the point is latency, not prose. */
const PROBE_MAX_TOKENS = 8;

/** Input embedded by the probe to measure the vector width the provider actually returns. */
const PROBE_EMBED_TEXT = "ragdoll connection probe";

/** HTTP statuses worth a second attempt; everything else is deterministic. */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set<number>([
  408, 409, 425, 429, 500, 502, 503, 504,
]);

/** Node/undici error codes that mean the socket never produced a response. */
const TRANSPORT_ERROR_CODES: ReadonlySet<string> = new Set<string>([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/** Arguments accepted by chat completions; `undefined` means "let the provider decide". */
export interface CompletionOptions {
  readonly temperature?: number;
  readonly maxTokens?: number;
  /**
   * Caller-owned cancellation, composed with the configured timeout.
   *
   * Without it a route handler could not stop retrying a provider the user has already
   * navigated away from, which is exactly the abort path the chat UI offers.
   */
  readonly signal?: AbortSignal;
}

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface Usage {
  readonly promptTokens: number;
  readonly completionTokens: number;
}

export interface ChatCompletion {
  readonly text: string;
  readonly usage: Usage;
}

/**
 * One streamed fragment. `usage` is present only on the final delta, and only when the
 * provider reports counts — callers must not assume token totals are always available.
 */
export interface StreamDelta {
  readonly text: string;
  readonly usage?: Usage;
}

export interface ProviderOptions {
  readonly provider: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly embeddingModel: string;
  readonly timeoutMs?: number;
}

/** What the creation form shows after a successful "Test Connection". */
export interface ProbeResult {
  readonly latencyMs: number;
  readonly echo: string;
  readonly embeddingDimension: number;
  readonly embeddingOk: boolean;
}

export class ProviderError extends Error {
  readonly code: "invalid_api_key" | "provider_unreachable" | "provider_error";

  constructor(message: string, code: ProviderError["code"]) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
  }
}

/**
 * Raised when a hosted deployment is pointed at a local address.
 *
 * A distinct class, not a `ProviderError`, because it is a configuration mistake the
 * user must fix — retrying or re-keying cannot help.
 */
export class LoopbackBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoopbackBlockedError";
  }
}

/** Marks a response that arrived but did not match the expected shape. */
class ResponseFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResponseFormatError";
  }
}

/** Why a request failed, in the form the backoff loop reasons about. */
interface RequestFailure {
  readonly message: string;
  readonly retryable: boolean;
  /** Loopback/LAN and timeout failures are unreachable, not malformed. */
  readonly unreachable: boolean;
}

/** Terminal state of the retry loop: exactly one of the two fields is set. */
type RetryOutcome =
  | { readonly response: Response; readonly error: null }
  | { readonly response: null; readonly error: RequestFailure };

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const toFiniteNumber = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;

/** DOMException carries the abort name but is not an `Error` subclass everywhere. */
const errorName = (error: unknown): string =>
  typeof error === "object" && error !== null && "name" in error
    ? String((error as { readonly name: unknown }).name)
    : "";

/** Walks `error.cause` for a transport code, since undici nests the socket failure. */
const transportCode = (error: unknown): string | null => {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    const code = (current as { readonly code?: unknown }).code;
    if (typeof code === "string") {
      return code;
    }
    current = current.cause;
  }
  return null;
};

/**
 * Strips one trailing `/v1`.
 * @param baseUrl Provider base URL.
 * @returns The URL without an OpenAI-style version suffix.
 */
export const stripVersionSuffix = (baseUrl: string): string =>
  baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "");

/**
 * True when a URL points at the local machine or its private network.
 *
 * The hosted deployment path is the whole reason this exists: Vercel functions cannot
 * see the user's `localhost`, so the failure is reported before a socket is opened
 * rather than as an opaque timeout. Deliberately broader than a DNS check on name alone —
 * `10/8`, `172.16/12`, `192.168/16`, `169.254/16` and `127/8` are all unreachable too.
 * A URL that will not parse is not loopback, because refusing it is the schema's job.
 * @param url Candidate provider base URL.
 */
export const isLoopbackHost = (url: string): boolean => {
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
    hostname.endsWith(".internal") ||
    hostname === "::1" ||
    hostname === "0.0.0.0"
  ) {
    return true;
  }

  const octets = hostname.split(".");
  if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/.test(octet))) {
    return false;
  }
  const [first = 0, second = 0] = octets.map(Number);
  if (first === 127 || first === 10 || (first === 192 && second === 168)) {
    return true;
  }
  if (first === 172 && second >= 16 && second <= 31) {
    return true;
  }
  return first === 169 && second === 254;
};

/** True when the process believes it is running on a hosted platform. */
const isHostedDeployment = (): boolean =>
  process.env.RAGDOLL_HOSTED === "1" || process.env.VERCEL === "1";

/** Jittered, capped exponential backoff for a given zero-based attempt. */
const backoffDelayMs = (attempt: number): number =>
  Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS) + Math.floor(Math.random() * 250);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const resolveTimeoutMs = (timeoutMs: number | undefined): number =>
  typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
    ? Math.max(MIN_TIMEOUT_MS, Math.floor(timeoutMs))
    : DEFAULT_TIMEOUT_MS;

/**
 * Combines a caller signal with a timeout, degrading gracefully where `AbortSignal.any`
 * is unavailable so streaming is never impossible just because the runtime is older.
 */
const composeSignal = (timeoutMs: number, outer?: AbortSignal): AbortSignal => {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (outer === undefined) {
    return timeout;
  }
  const anySignal = (AbortSignal as { readonly any?: (signals: AbortSignal[]) => AbortSignal }).any;
  return typeof anySignal === "function" ? anySignal([timeout, outer]) : timeout;
};

/** Maps a `fetch` rejection to its API-facing failure, preserving the abort path. */
const classifyRequestFailure = (error: unknown, baseUrl: string): RequestFailure => {
  if (error instanceof ResponseFormatError) {
    return { message: error.message, retryable: false, unreachable: false };
  }
  const name = errorName(error);
  if (name === "TimeoutError") {
    return {
      message: `Could not reach the provider at ${baseUrl} (timed out).`,
      retryable: true,
      unreachable: true,
    };
  }
  if (name === "AbortError") {
    return {
      message: "The request was aborted by the caller.",
      retryable: false,
      unreachable: true,
    };
  }
  const code = transportCode(error);
  const detail = code !== null && TRANSPORT_ERROR_CODES.has(code) ? ` (${code})` : "";
  return {
    message: `Could not reach the provider at ${baseUrl}.${detail}`,
    retryable: true,
    unreachable: true,
  };
};

/** Maps a non-2xx response to its failure, calling out rejected keys. */
const classifyStatusFailure = (status: number, detail: string, baseUrl: string): RequestFailure => {
  const suffix = detail.length > 0 ? ` ${detail}` : "";
  if (status === 401 || status === 403) {
    return {
      message: "The provider rejected the API key. Check the key and provider selection.",
      retryable: false,
      unreachable: false,
    };
  }
  if (RETRYABLE_STATUSES.has(status)) {
    return {
      message: `The provider at ${baseUrl} returned HTTP ${status}.${suffix}`,
      retryable: true,
      unreachable: false,
    };
  }
  return {
    message: `The provider at ${baseUrl} returned HTTP ${status}.${suffix}`,
    retryable: false,
    unreachable: false,
  };
};

const toProviderError = (failure: RequestFailure): ProviderError =>
  new ProviderError(failure.message, failure.unreachable ? "provider_unreachable" : "provider_error");

/** Reads a response body, keeping a non-JSON error page readable for the message. */
const readBodyText = async (response: Response): Promise<string> => {
  try {
    return (await response.text()).trim();
  } catch {
    return "";
  }
};

/** Parses a JSON body, downgrading malformed payloads to a `ResponseFormatError`. */
const parseJsonBody = async (response: Response): Promise<unknown> => {
  const raw = await readBodyText(response);
  if (raw.length === 0) {
    throw new ResponseFormatError("The provider returned an empty response body.");
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ResponseFormatError(`The provider returned a non-JSON response: ${raw.slice(0, 200)}`);
  }
};

/** Short, non-secret excerpt of an error body for the failure message. */
const describeErrorBody = (raw: string): string => (raw.length === 0 ? "" : raw.slice(0, 200));

/** OpenAI-style choices[0].message.content. */
const readOpenAiText = (body: unknown): string => {
  if (!isRecord(body)) {
    throw new ResponseFormatError("The provider returned an unexpected payload.");
  }
  const choices = body.choices;
  const first = Array.isArray(choices) ? choices[0] : undefined;
  const message = isRecord(first) ? first.message : undefined;
  const content = isRecord(message) ? message.content : undefined;
  return typeof content === "string" ? content : "";
};

/** Ollama-native message.content. */
const readOllamaText = (body: unknown): string => {
  if (!isRecord(body)) {
    throw new ResponseFormatError("The provider returned an unexpected payload.");
  }
  const message = body.message;
  const content = isRecord(message) ? message.content : undefined;
  return typeof content === "string" ? content : "";
};

/** Token counts, tolerating a provider that omits the usage block entirely. */
const readOpenAiUsage = (body: unknown): Usage => {
  const usage = isRecord(body) && isRecord(body.usage) ? body.usage : {};
  return {
    promptTokens: toFiniteNumber(usage.prompt_tokens, 0),
    completionTokens: toFiniteNumber(usage.completion_tokens, 0),
  };
};

/** Ollama reports counts as `prompt_eval_count` / `eval_count` once the stream finishes. */
const readOllamaUsage = (chunk: Readonly<Record<string, unknown>>): Usage => ({
  promptTokens: toFiniteNumber(chunk.prompt_eval_count, 0),
  completionTokens: toFiniteNumber(chunk.eval_count, 0),
});

/** One embedding vector, or null when the provider sent something unusable. */
const readEmbeddingVector = (value: unknown): number[] | null => {
  if (!Array.isArray(value)) {
    return null;
  }
  const vector = value.filter((entry): entry is number => typeof entry === "number");
  return vector.length === value.length && vector.length > 0 ? vector : null;
};

/** OpenAI-compatible embedding rows, reordered by `index` because batching may shuffle them. */
const readOpenAiEmbeddings = (body: unknown): number[][] => {
  if (!isRecord(body) || !Array.isArray(body.data)) {
    throw new ResponseFormatError("The provider returned an unexpected embeddings payload.");
  }
  return body.data
    .map((entry: unknown, position: number) => ({
      position,
      index: isRecord(entry) ? toFiniteNumber(entry.index, position) : position,
      vector: isRecord(entry) ? readEmbeddingVector(entry.embedding) : null,
    }))
    .sort((left, right) => left.index - right.index)
    .map((row) => {
      if (row.vector === null) {
        throw new ResponseFormatError("The provider returned an embeddings row without a vector.");
      }
      return row.vector;
    });
};

/** Ollama-native single embedding. */
const readOllamaEmbedding = (body: unknown): number[] => {
  const vector = isRecord(body) ? readEmbeddingVector(body.embedding) : null;
  if (vector === null) {
    throw new ResponseFormatError("The provider returned an unexpected embeddings payload.");
  }
  return vector;
};

/** Accumulator shared by both SSE readers, so chunk-boundary handling exists exactly once. */
interface FrameReader {
  push(chunk: string): string[];
  flush(): string[];
}

/**
 * Builds a line-splitting reader for a text stream.
 *
 * Chunk boundaries fall anywhere — mid-line and mid-character — so a partial tail is
 * buffered until the next read; without this a citation marker or a JSON frame is
 * silently truncated and streaming appears to drop tokens at random.
 */
const createFrameReader = (): FrameReader => {
  let buffer = "";
  return {
    push(chunk: string): string[] {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      return lines;
    },
    flush(): string[] {
      if (buffer.length === 0) {
        return [];
      }
      const tail = buffer;
      buffer = "";
      return [tail];
    },
  };
};

/** A decoded response body, or null when the stream is unavailable. */
const openStream = async (response: Response): Promise<ReadableStream<Uint8Array> | null> =>
  response.body;

/** Strips the `data:` prefix, returning an empty string for keep-alive comments. */
const ssePayload = (line: string): string => {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) {
    return "";
  }
  return trimmed.slice("data:".length).trim();
};

/**
 * The provider surface the pipeline actually uses.
 *
 * Declared as an interface rather than left as the concrete class because the
 * offline provider (`dev-provider.ts`) is a second implementation, and the
 * pipeline must not care which one it was handed.
 */
export interface LlmProvider {
  complete(messages: readonly ChatMessage[], options?: CompletionOptions): Promise<ChatCompletion>;
  stream(
    messages: readonly ChatMessage[],
    options?: CompletionOptions,
  ): AsyncGenerator<StreamDelta, void, undefined>;
  embed(texts: readonly string[]): Promise<number[][]>;
  embedOne(text: string): Promise<number[]>;
  probe(): Promise<ProbeResult>;
}

/**
 * Async provider client for one pipeline configuration.
 *
 * Requests are pure functions of the options plus the arguments, so an instance is safe
 * to share across concurrent chat turns; nothing measured by `probe` is stored, because
 * the form owns that state and a stale echo would misreport a changed model.
 */
export class ProviderClient implements LlmProvider {
  private readonly options: ProviderOptions;
  private readonly baseUrl: string;
  private readonly ollama: boolean;
  private readonly timeoutMs: number;

  constructor(options: ProviderOptions) {
    const baseUrl = options.baseUrl.trim().replace(/\/+$/, "");
    if (isHostedDeployment() && isLoopbackHost(baseUrl)) {
      throw new LoopbackBlockedError(
        "Cannot reach localhost from a hosted deployment. Self-host RAGdoll to use local providers.",
      );
    }
    this.options = options;
    this.baseUrl = baseUrl;
    this.ollama = options.provider === "ollama";
    this.timeoutMs = resolveTimeoutMs(options.timeoutMs);
  }

  /** True when this client speaks the Ollama-native protocol. */
  private get usesOllama(): boolean {
    return this.ollama;
  }

  /** Origin used for native paths; the `/v1` suffix only exists for the OpenAI shim. */
  private get nativeBase(): string {
    return stripVersionSuffix(this.baseUrl);
  }

  private endpoint(path: string): string {
    const root = this.usesOllama ? this.nativeBase : this.baseUrl;
    return `${root}${path}`;
  }

  private headers(): Readonly<Record<string, string>> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const key = this.options.apiKey.trim();
    if (key.length > 0) {
      headers.authorization = `Bearer ${key}`;
    }
    return headers;
  }

  private chatBody(
    messages: readonly ChatMessage[],
    options?: CompletionOptions,
  ): Readonly<Record<string, unknown>> {
    const body: Record<string, unknown> = { model: this.options.model, messages, stream: false };
    // Fields are copied explicitly rather than spread: `options` also carries the caller's
    // AbortSignal, which is not JSON and must never reach the wire.
    if (options?.temperature !== undefined) {
      body.temperature = options.temperature;
    }
    if (options?.maxTokens !== undefined) {
      body.max_tokens = options.maxTokens;
      body.num_predict = options.maxTokens;
    }
    return body;
  }

  private embeddingBody(input: string | readonly string[]): Readonly<Record<string, unknown>> {
    const model = this.options.embeddingModel;
    return this.usesOllama ? { model, prompt: input } : { model, input };
  }

  /**
   * Issues one request and destructures its body.
   *
   * The retry decision lives here rather than at each call site so a transient 429 has
   * one definition. `ResponseFormatError` escapes the retry loop untouched: a provider
   * answering with the wrong shape will keep answering that way.
   */
  private async request<T>(
    url: string,
    body: Readonly<Record<string, unknown>>,
    parse: (payload: unknown) => T,
    signal?: AbortSignal,
  ): Promise<T> {
    const outcome = await this.withRetry(url, body, signal);
    if (outcome.error !== null) {
      throw toProviderError(outcome.error);
    }
    const response = outcome.response;
    return parse(await parseJsonBody(response));
  }

  /**
   * Runs the request up to `MAX_ATTEMPTS` times, honouring `Retry-After`.
   * @returns The response once one arrives, or the terminal failure.
   */
  private async withRetry(
    url: string,
    body: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<RetryOutcome> {
    let last: RequestFailure = {
      message: `Could not reach the provider at ${this.baseUrl}.`,
      retryable: false,
      unreachable: true,
    };

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      if (signal?.aborted === true) {
        return {
          response: null,
          error: {
            message: "The request was aborted by the caller.",
            retryable: false,
            unreachable: true,
          },
        };
      }
      let response: Response;
      try {
        response = await this.send(url, body, signal);
      } catch (error) {
        last = classifyRequestFailure(error, this.baseUrl);
        if (!last.retryable || attempt === MAX_ATTEMPTS - 1) {
          return { response: null, error: last };
        }
        await sleep(backoffDelayMs(attempt));
        continue;
      }

      if (response.ok) {
        return { response, error: null };
      }

      const raw = await readBodyText(response);
      last = classifyStatusFailure(response.status, describeErrorBody(raw), this.baseUrl);
      if (!last.retryable || attempt === MAX_ATTEMPTS - 1) {
        return { response: null, error: last };
      }
      const retryAfter = Number(response.headers.get("retry-after"));
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1_000, BACKOFF_CAP_MS)
          : backoffDelayMs(attempt);
      console.warn(`[ragdoll] retrying ${url} after HTTP ${response.status} in ${waitMs}ms.`);
      await sleep(waitMs);
    }

    return { response: null, error: last };
  }

  /** Performs a single fetch with the configured auth, timeout and caller signal. */
  private async send(
    url: string,
    body: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<Response> {
    return fetch(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: composeSignal(this.timeoutMs, signal),
      cache: "no-store",
    });
  }

  /**
   * Runs a non-streaming chat completion.
   * @param messages Conversation in provider order.
   * @param options Sampling controls; omitted fields are left to the provider.
   */
  async complete(
    messages: readonly ChatMessage[],
    options?: CompletionOptions,
  ): Promise<ChatCompletion> {
    const url = this.endpoint(this.usesOllama ? "/api/chat" : "/chat/completions");
    const body = this.chatBody(messages, options);
    const signal = options?.signal;
    return this.usesOllama
      ? this.request(
          url,
          body,
          (payload) => ({
            text: readOllamaText(payload),
            usage: readOllamaUsage(isRecord(payload) ? payload : {}),
          }),
          signal,
        )
      : this.request(
          url,
          body,
          (payload) => ({
            text: readOpenAiText(payload),
            usage: readOpenAiUsage(payload),
          }),
          signal,
        );
  }

  /**
   * Streams a chat completion.
   *
   * Aborts quietly and keeps whatever was already yielded: a user pressing stop must not
   * discard the partial answer, and the next turn resumes from the retained text.
   * @param messages Conversation in provider order.
   * @param options Sampling controls; omitted fields are left to the provider.
   */
  async *stream(
    messages: readonly ChatMessage[],
    options?: CompletionOptions,
  ): AsyncGenerator<StreamDelta, void, undefined> {
    const url = this.endpoint(this.usesOllama ? "/api/chat" : "/chat/completions");
    const body: Readonly<Record<string, unknown>> = {
      ...this.chatBody(messages, options),
      stream: true,
      ...(this.usesOllama ? {} : { stream_options: { include_usage: true } }),
    };
    const signal = composeSignal(this.timeoutMs, options?.signal);
    let response: Response;
    try {
      response = await this.send(url, body, signal);
    } catch (error) {
      throw toProviderError(classifyRequestFailure(error, this.baseUrl));
    }
    if (!response.ok) {
      const detail = describeErrorBody(await readBodyText(response));
      throw toProviderError(classifyStatusFailure(response.status, detail, this.baseUrl));
    }
    const stream = await openStream(response);
    if (stream === null) {
      throw new ProviderError("The provider returned a stream without a body.", "provider_error");
    }

    // Explicit reader rather than `for await`, because the DOM `ReadableStream` type does
    // not declare the async iterator, and this module must typecheck for both runtimes.
    const frames = createFrameReader();
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        const text =
          typeof value === "string" ? value : decoder.decode(value, { stream: true });
        for (const line of frames.push(text)) {
          const payload = this.parseStreamLine(line, this.usesOllama);
          if (payload !== null) {
            yield payload;
          }
        }
      }
      for (const line of frames.flush()) {
        const payload = this.parseStreamLine(line, this.usesOllama);
        if (payload !== null) {
          yield payload;
        }
      }
    } catch (error) {
      if (errorName(error) === "AbortError") {
        return;
      }
      throw toProviderError(classifyRequestFailure(error, this.baseUrl));
    } finally {
      reader.releaseLock();
    }
  }

  /** Turns one streamed line into a delta, or null when the line carries nothing. */
  private parseStreamLine(line: string, ollama: boolean): StreamDelta | null {
    if (ollama) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        return null;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed) as unknown;
      } catch {
        return null;
      }
      if (!isRecord(parsed)) {
        return null;
      }
      const message = parsed.message;
      const content = isRecord(message) ? message.content : undefined;
      const delta: { text: string; usage?: Usage } = {
        text: typeof content === "string" ? content : "",
      };
      if (parsed.done === true) {
        delta.usage = readOllamaUsage(parsed);
      }
      return delta;
    }

    const payload = ssePayload(line);
    if (payload.length === 0 || payload === "[DONE]") {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload) as unknown;
    } catch {
      return null;
    }
    if (!isRecord(parsed)) {
      return null;
    }
    const choices = parsed.choices;
    const first = Array.isArray(choices) ? choices[0] : undefined;
    const deltaBody = isRecord(first) ? first.delta : undefined;
    const content = isRecord(deltaBody) ? deltaBody.content : undefined;
    const delta: { text: string; usage?: Usage } = {
      text: typeof content === "string" ? content : "",
    };
    if (isRecord(parsed.usage)) {
      delta.usage = readOpenAiUsage(parsed);
    }
    return delta;
  }

  /**
   * Embeds texts in fixed-size batches, preserving input order.
   * @param texts Input strings; an empty list costs no request.
   * @returns One vector per input, in the same order.
   */
  async embed(texts: readonly string[]): Promise<number[][]> {
    const vectors: number[][] = [];
    for (let start = 0; start < texts.length; start += EMBED_BATCH_SIZE) {
      const batch = texts.slice(start, start + EMBED_BATCH_SIZE);
      const batchVectors = await this.embedBatch(batch);
      if (batchVectors.length !== batch.length) {
        throw new ProviderError(
          "The provider returned a different number of embeddings than requested.",
          "provider_error",
        );
      }
      vectors.push(...batchVectors);
    }
    return vectors;
  }

  /**
   * Embeds a single string.
   * @param text Input string.
   */
  async embedOne(text: string): Promise<number[]> {
    const [vector] = await this.embed([text]);
    if (vector === undefined) {
      throw new ProviderError("The provider returned no embedding.", "provider_error");
    }
    return vector;
  }

  /**
   * Measures a provider end to end for the creation form.
   *
   * Chat is the primary contract, so an embedding failure downgrades to
   * `embeddingOk: false` instead of failing the probe — a chat-only deployment is still
   * usable, and the form can decide whether embeddings are needed for its pipeline.
   */
  async probe(): Promise<ProbeResult> {
    const started = Date.now();
    const completion = await this.complete(
      [{ role: "user", content: PROBE_PROMPT }],
      { maxTokens: PROBE_MAX_TOKENS },
    );
    const latencyMs = Date.now() - started;

    try {
      const [vector] = await this.embed([PROBE_EMBED_TEXT]);
      return {
        latencyMs,
        echo: completion.text,
        embeddingDimension: vector?.length ?? 0,
        embeddingOk: vector !== undefined && vector.length > 0,
      };
    } catch (error) {
      console.warn("[ragdoll] connection probe could not embed; continuing chat-only.", error);
      return { latencyMs, echo: completion.text, embeddingDimension: 0, embeddingOk: false };
    }
  }

  /** One request's worth of embeddings, in the protocol this provider speaks. */
  private async embedBatch(batch: readonly string[]): Promise<number[][]> {
    if (this.usesOllama) {
      const vectors: number[][] = [];
      for (const text of batch) {
        vectors.push(
          await this.request(
            this.endpoint("/api/embeddings"),
            this.embeddingBody(text),
            readOllamaEmbedding,
          ),
        );
      }
      return vectors;
    }
    return this.request(this.endpoint("/embeddings"), this.embeddingBody(batch), readOpenAiEmbeddings);
  }
}
