import "server-only";

import type { PipelineConfig, ChatTurn, Citation, DocumentSummary } from "../types";
import { createDevProvider, isDevProviderEnabled } from "./dev-provider";
import { type IndexedChunk, VectorIndex } from "./distance";
import { enforce as enforceGuardrails, sanitiseRetrievedText } from "./guardrails";
import { ProviderClient, type ChatCompletion, type LlmProvider, type Usage, type ChatMessage } from "./llm";
import { parseDocument, type ParsedDocument } from "./pdf";
import {
  AGENTIC_TOOL_INSTRUCTION,
  FALLBACK_ANSWER,
  buildAnswerMessages,
  buildCompressionMessages,
  buildGroundednessMessages,
  clampHistory,
  formatContextBlock,
  snippet,
  truncateContext,
  truncateQuestion,
  type OwnedChunk,
} from "./prompts";
import {
  createSession,
  dropSession,
  getSession,
  putSession,
  rememberTurn,
  type EngineSession,
} from "./store";

/** Raised when the pipeline configuration cannot serve a request. */
export class PipelineError extends Error {
  readonly code: "pipeline_missing" | "validation" | "provider_auth" | "provider_error";

  constructor(message: string, code: PipelineError["code"]) {
    super(message);
    this.name = "PipelineError";
    this.code = code;
  }
}

const MAX_AGENTIC_HOPS = 3;
const GROUNDEDNESS_CONTEXT_TOKENS = 2400;
/** Below this, an answer is discarded in favour of the fallback string. */
export const GROUNDEDNESS_THRESHOLD = 0.5;

/** One retrieved chunk with its score. */
interface ScoredChunk {
  readonly owned: OwnedChunk;
  readonly score: number;
}

/** Inputs the service needs to build or query an index. */
export interface EngineRequest {
  readonly sessionId: string;
  readonly config: PipelineConfig;
  readonly apiKey: string;
  readonly documents: readonly {
    readonly id: string;
    readonly name: string;
    readonly sizeBytes: number;
    readonly base64: string;
    readonly pageCount: number;
  }[];
}

export interface UpsertResult {
  readonly documents: readonly DocumentSummary[];
  readonly chunkCount: number;
  readonly citations: readonly Citation[];
  readonly multimodal: boolean;
}

export interface AnswerResult {
  readonly answer: string;
  readonly citations: readonly Citation[];
  readonly fallback: boolean;
  readonly standaloneQuery: string;
  readonly retrieved: number;
  readonly usage: Usage;
  readonly faithfulness: number | null;
  readonly contexts: readonly string[];
}

/**
 * Builds the provider described by a pipeline configuration.
 *
 * The offline provider is a drop-in `LlmProvider` selected by
 * `RAGDOLL_DEV_PROVIDER=1`; it exists so the Playwright journey can cover the real
 * session, action and streaming seams without a paid key.
 */
export function buildProvider(request: EngineRequest): LlmProvider {
  if (isDevProviderEnabled()) {
    return createDevProvider(request.config.embeddingDimension);
  }
  return new ProviderClient({
    provider: request.config.provider,
    baseUrl: request.config.baseUrl,
    apiKey: request.apiKey,
    model: request.config.model,
    embeddingModel: request.config.embeddingModel,
  });
}

/** Validates credentials against the provider before any indexing. */
export async function testConnection(request: EngineRequest): Promise<{
  readonly reachable: boolean;
  readonly modelEcho: string;
  readonly latencyMs: number;
  readonly embeddingDimension: number;
  readonly embeddingProbe: boolean;
}> {
  const probe = await buildProvider(request).probe();

  if (probe.embeddingOk && probe.embeddingDimension !== request.config.embeddingDimension) {
    throw new PipelineError(
      `The embedding model returned ${probe.embeddingDimension} dimensions but the pipeline ` +
        `is configured for ${request.config.embeddingDimension}. Reselect the embedding model.`,
      "validation",
    );
  }

  return {
    reachable: true,
    modelEcho: probe.echo || request.config.model,
    latencyMs: probe.latencyMs,
    embeddingDimension: probe.embeddingDimension || request.config.embeddingDimension,
    embeddingProbe: probe.embeddingOk,
  };
}

/**
 * Parses, chunks and embeds the session documents.
 *
 * Re-running with the same documents replaces the index rather than appending, which
 * is what "Create RAG pipeline" means when a pipeline already exists.
 */
export async function ensureIndex(request: EngineRequest): Promise<UpsertResult> {
  const provider = buildProvider(request);
  const session = createSession(request.sessionId);

  const summaries: DocumentSummary[] = [];
  const owned: OwnedChunk[] = [];

  for (const document of request.documents) {
    const parsed: ParsedDocument = await parseDocument({
      id: document.id,
      name: document.name,
      payloadBase64: document.base64,
      chunkSize: request.config.chunkSize,
      chunkOverlapTokens: request.config.chunkOverlapTokens,
      declaredPageCount: document.pageCount,
    });

    session.documents.push(parsed);
    for (const chunk of parsed.chunks) {
      owned.push({ documentId: parsed.id, documentName: parsed.name, chunk });
    }
    for (const page of parsed.imageOnlyPageNumbers) {
      session.imageOnlyPageKeys.add(`${parsed.id}:${page}`);
    }

    summaries.push({
      id: parsed.id,
      name: parsed.name,
      sizeBytes: parsed.sizeBytes,
      pageCount: parsed.pageCount,
      chunkCount: parsed.chunks.length,
      imageCount: parsed.imageCount,
      hasImages: parsed.hasImages,
    });
  }

  session.multimodal = session.imageOnlyPageKeys.size > 0;

  if (owned.length > 0) {
    const vectors = await provider.embed(owned.map((item) => item.chunk.text));
    if (vectors.length !== owned.length) {
      throw new PipelineError(
        "The embedding provider returned a different number of vectors than inputs.",
        "provider_error",
      );
    }
    const index = new VectorIndex(request.config.distanceMetric, request.config.embeddingDimension);
    index.add(
      owned.map<IndexedChunk>((item, position) => ({
        chunk: item.chunk,
        documentId: item.documentId,
        documentName: item.documentName,
        vector: vectors[position] ?? [],
      })),
    );
    session.index = index;
  } else {
    // A pipeline with no documents is still a valid pipeline: it indexes, it just
    // never retrieves anything, and every answer is therefore the fallback string.
    session.index = new VectorIndex(
      request.config.distanceMetric,
      request.config.embeddingDimension,
    );
  }

  putSession(session);

  return {
    documents: summaries,
    chunkCount: owned.length,
    citations: owned.slice(0, 12).map((item, position) => ({
      chunkId: `${item.documentId}:${item.chunk.index}`,
      documentId: item.documentId,
      documentName: item.documentName,
      page: item.chunk.page,
      score: 0,
      snippet: snippet(item.chunk.text),
      rank: position,
    })),
    multimodal: session.multimodal,
  };
}

/** Returns the session, rebuilding the index when the engine has lost it. */
export async function requireSession(request: EngineRequest): Promise<EngineSession> {
  const existing = getSession(request.sessionId);
  if (existing !== null && existing.index !== null) {
    return existing;
  }
  if (request.documents.length > 0) {
    await ensureIndex(request);
    const rebuilt = getSession(request.sessionId);
    if (rebuilt !== null) {
      return rebuilt;
    }
  }
  throw new PipelineError("No pipeline exists in this session.", "pipeline_missing");
}

/** Embeds a query and returns the top-K chunks for it. */
async function retrieve(
  session: EngineSession,
  provider: LlmProvider,
  config: PipelineConfig,
  query: string,
  topK?: number,
): Promise<ScoredChunk[]> {
  if (session.index === null) {
    throw new PipelineError("The pipeline has no index yet.", "pipeline_missing");
  }
  if (session.index.chunkCount === 0) {
    return [];
  }
  const k = Math.min(10, Math.max(1, topK ?? config.topK));
  const vector = await provider.embedOne(query);
  return session.index.search(vector, k).map((hit) => ({
    owned: { documentId: hit.documentId, documentName: hit.documentName, chunk: hit.chunk },
    score: hit.score,
  }));
}

/** Projects retrieved chunks into citation records. */
export function toCitations(hits: readonly ScoredChunk[]): Citation[] {
  return hits.map((hit, rank) => ({
    chunkId: `${hit.owned.documentId}:${hit.owned.chunk.index}`,
    documentId: hit.owned.documentId,
    documentName: hit.owned.documentName,
    page: hit.owned.chunk.page,
    score: Math.round(hit.score * 10_000) / 10_000,
    snippet: snippet(hit.owned.chunk.text),
    rank,
  }));
}

/** Stable identity of a retrieved chunk, used to pair hits with their kept copies. */
const chunkKey = (owned: OwnedChunk): string => `${owned.documentId}:${owned.chunk.index}`;

/**
 * Keeps only the hits that survived the context-window trim.
 *
 * Matched by identity rather than by object reference: `truncateContext` receives
 * sanitised *copies*, so a reference comparison would silently drop every citation
 * while the contexts themselves still reached the prompt.
 */
const keptHits = (hits: readonly ScoredChunk[], kept: readonly OwnedChunk[]): ScoredChunk[] => {
  const keptKeys = new Set(kept.map((item) => `${item.documentId}:${item.chunk.index}`));
  return hits.filter((hit) => keptKeys.has(chunkKey(hit.owned)));
};

/** Strips instruction-like content out of retrieved text before it reaches a prompt. */
function sanitise(hits: readonly ScoredChunk[]): OwnedChunk[] {
  return hits.map((hit) => ({
    documentId: hit.owned.documentId,
    documentName: hit.owned.documentName,
    chunk: {
      index: hit.owned.chunk.index,
      text: sanitiseRetrievedText(hit.owned.chunk.text),
      tokenCount: hit.owned.chunk.tokenCount,
      page: hit.owned.chunk.page,
    },
  }));
}

/**
 * Rewrites the latest message as a standalone query when a conversation exists.
 *
 * Without this, a follow-up like "and for it?" is embedded verbatim and retrieval
 * degrades — the failure AGENTS.md calls out for multi-turn conversations.
 */
async function compressQuery(
  provider: LlmProvider,
  question: string,
  history: readonly ChatTurn[],
): Promise<string> {
  const usable = history.filter((turn) => turn.role === "user" || turn.role === "assistant");
  if (usable.length === 0) {
    return question;
  }

  try {
    const completion = await provider.complete(
      buildCompressionMessages([
        ...usable.slice(-6).map<ChatMessage>((turn) => ({
          role: turn.role,
          content: turn.content.slice(0, 1500),
        })),
        { role: "user", content: question },
      ]),
      { temperature: 0, maxTokens: 120 },
    );
    const rewritten = completion.text.trim().split("\n")[0]?.trim() ?? "";
    return rewritten.length === 0 || rewritten.length > 600 ? question : rewritten;
  } catch (error) {
    console.warn(`[ragdoll] query compression failed, using the raw question: ${String(error)}`);
    return question;
  }
}

/** Reserves room for history and the answer inside the configured context window. */
function clampToWindow(config: PipelineConfig, hits: readonly ScoredChunk[]): OwnedChunk[] {
  const historyBudget = Math.min(1024, Math.floor(config.maxInputTokens / 4));
  const contextBudget = Math.max(256, config.maxInputTokens - historyBudget - 512);
  return truncateContext(sanitise(hits), contextBudget);
}

function toChatHistory(history: readonly ChatTurn[]): ChatMessage[] {
  return history
    .filter((turn) => turn.role === "user" || turn.role === "assistant")
    .map((turn) => ({ role: turn.role, content: turn.content }));
}

function parseToolDecision(text: string): { tool?: string; query?: string; topK?: number } | null {
  const match = /\{[\s\S]*\}/.exec(text);
  if (match === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(match[0]);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as { tool?: string; query?: string; topK?: number })
      : null;
  } catch {
    return null;
  }
}

/**
 * Multi-hop retrieval for agentic pipelines.
 *
 * Tool calls are expressed as a JSON protocol in the prompt rather than native tool
 * calling, because not every supported provider implements it — DeepSeek and Ollama
 * both ship models that silently ignore a `tools` field. A JSON ask works uniformly
 * and degrades to plain retrieval when the model does not answer with a tool call.
 */
async function agenticRetrieve(
  session: EngineSession,
  provider: LlmProvider,
  config: PipelineConfig,
  question: string,
  history: readonly ChatTurn[],
): Promise<ScoredChunk[]> {
  const collected: ScoredChunk[] = [];
  const seen = new Set<string>();
  let query = question;



  for (let hop = 0; hop < MAX_AGENTIC_HOPS; hop += 1) {
    const completion: ChatCompletion = await provider.complete(
      [
        { role: "system", content: AGENTIC_TOOL_INSTRUCTION },
        ...toChatHistory(history.slice(-4)),
        { role: "user", content: `Question so far: ${query}` },
      ],
      { temperature: 0, maxTokens: 200 },
    );

    const decision = parseToolDecision(completion.text);
    if (decision === null || decision.tool !== "retrieve") {
      break;
    }

    const hopQuery = decision.query ?? query;
    const hits = await retrieve(session, provider, config, hopQuery, decision.topK ?? config.topK);
    for (const hit of hits) {
      const key = `${hit.owned.documentId}:${hit.owned.chunk.index}`;
      if (!seen.has(key)) {
        seen.add(key);
        collected.push(hit);
      }
    }
    query = hopQuery;
  }

  return collected.length > 0 ? collected : retrieve(session, provider, config, question);
}

/**
 * Scores answer support against the retrieved context.
 *
 * This is the Ragas `faithfulness` definition — supported claims over total claims —
 * implemented as a strict JSON judgement. Returns null when the judge is unusable, in
 * which case the caller keeps the answer rather than discarding a possibly fine one.
 */
export async function faithfulness(
  provider: LlmProvider,
  contextBlock: string,
  answer: string,
): Promise<number | null> {
  if (answer.trim().length === 0) {
    return 0;
  }
  try {
    const completion = await provider.complete(
      buildGroundednessMessages(contextBlock.slice(0, GROUNDEDNESS_CONTEXT_TOKENS * 4), answer),
      { temperature: 0, maxTokens: 600 },
    );
    const match = /\{[\s\S]*\}/.exec(completion.text);
    if (match === null) {
      return null;
    }
    const parsed: unknown = JSON.parse(match[0]);
    const claims =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { claims?: { supported?: unknown }[] }).claims
        : undefined;
    if (!Array.isArray(claims) || claims.length === 0) {
      return null;
    }
    const supported = claims.filter((claim) => claim.supported === true).length;
    return Math.round((supported / claims.length) * 10_000) / 10_000;
  } catch (error) {
    console.warn(`[ragdoll] groundedness judge unavailable: ${String(error)}`);
    return null;
  }
}

/** Produces a grounded, cited answer. */
export async function answer(
  request: EngineRequest,
  question: string,
  history: readonly ChatTurn[] = [],
): Promise<AnswerResult> {
  enforceGuardrails(question);

  const config = request.config;
  const provider = buildProvider(request);
  const session = await requireSession(request);

  const effectiveHistory = history.length > 0 ? history : session.history.map<ChatTurn>((turn) => ({
    role: turn.role,
    content: turn.content,
    createdAt: "",
    citations: [],
  }));
  const bounded = truncateQuestion(question, Math.max(64, Math.floor(config.maxInputTokens / 3)));
  const standalone = await compressQuery(provider, bounded, effectiveHistory);

  const hits =
    config.retrievalMode === "agentic"
      ? await agenticRetrieve(session, provider, config, standalone, effectiveHistory)
      : await retrieve(session, provider, config, standalone);

  const kept = clampToWindow(config, hits);

  // AGENTS.md: "If retrieval returns no results ... the output should be the
  // fallback". Answered before generation, so a pipeline with nothing to retrieve
  // cannot quietly become a general-purpose chatbot.
  if (kept.length === 0) {
    return {
      answer: FALLBACK_ANSWER,
      citations: [],
      fallback: true,
      standaloneQuery: standalone,
      retrieved: 0,
      usage: { promptTokens: 0, completionTokens: 0 },
      faithfulness: null,
      contexts: [],
    };
  }

  const contextBlock = formatContextBlock(kept);
  const historyBudget = Math.min(1024, Math.floor(config.maxInputTokens / 4));

  const completion = await provider.complete(
    buildAnswerMessages({
      question: standalone,
      contextBlock,
      history: clampHistory(toChatHistory(effectiveHistory), historyBudget),
      agentic: false,
    }),
    { temperature: 0 },
  );

  let answerText = completion.text.trim();
  let fallback = answerText.length === 0;
  if (fallback) {
    answerText = FALLBACK_ANSWER;
  }

  // A judge that cannot run keeps the answer: discarding a possibly fine answer on
  // an infrastructure failure would be worse than the unsupported claims risk.
  const score = fallback ? null : await faithfulness(provider, contextBlock, answerText);
  if (score !== null && score < GROUNDEDNESS_THRESHOLD) {
    answerText = FALLBACK_ANSWER;
    fallback = true;
  }

  // A withheld answer must not carry citations claiming support.
  const citations = fallback ? [] : toCitations(keptHits(hits, kept));

  return {
    answer: answerText,
    citations,
    fallback,
    standaloneQuery: standalone,
    retrieved: hits.length,
    usage: completion.usage,
    faithfulness: score,
    contexts: kept.map((item) => item.chunk.text),
  };
}

/** Events emitted by the streaming answer, mirrored by the SSE route. */
export type StreamEvent =
  | { readonly event: "status"; readonly data: { phase: string; message: string } }
  | {
      readonly event: "citations";
      readonly data: {
        citations: readonly Citation[];
        standaloneQuery: string;
        retrieved: number;
      };
    }
  | { readonly event: "token"; readonly data: { text: string } }
  | { readonly event: "replacement"; readonly data: { answer: string } }
  | {
      readonly event: "done";
      readonly data: {
        answer: string;
        fallback: boolean;
        faithfulness: number | null;
        usage: Usage;
        citations: readonly Citation[];
      };
    };

/**
 * Streams a grounded answer.
 *
 * Citations are yielded before the first token so the panel is populated while
 * generation is still running.
 * @param signal Caller's abort signal. An aborted stream stops generating but
 *   keeps the partial answer, which is what the chat page promises.
 */
export async function* answerStream(
  request: EngineRequest,
  question: string,
  history: readonly ChatTurn[] = [],
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  enforceGuardrails(question);

  const config = request.config;
  const provider = buildProvider(request);
  const session = await requireSession(request);

  const effectiveHistory = history.length > 0 ? history : session.history.map<ChatTurn>((turn) => ({
    role: turn.role,
    content: turn.content,
    createdAt: "",
    citations: [],
  }));
  const bounded = truncateQuestion(question, Math.max(64, Math.floor(config.maxInputTokens / 3)));
  const standalone = await compressQuery(provider, bounded, effectiveHistory);

  yield { event: "status", data: { phase: "retrieval", message: "Retrieving sources" } };

  const hits = await retrieve(session, provider, config, standalone);
  const kept = clampToWindow(config, hits);
  const citations = toCitations(keptHits(hits, kept));

  yield {
    event: "citations",
    data: { citations, standaloneQuery: standalone, retrieved: hits.length },
  };

  // No evidence means no answer: the fallback is emitted without a generation call
  // at all, which is both the documented behaviour and one fewer billed request.
  if (kept.length === 0) {
    yield { event: "replacement", data: { answer: FALLBACK_ANSWER } };
    yield {
      event: "done",
      data: {
        answer: FALLBACK_ANSWER,
        fallback: true,
        faithfulness: null,
        usage: { promptTokens: 0, completionTokens: 0 },
        citations: [],
      },
    };
    return;
  }

  const contextBlock = formatContextBlock(kept);
  const historyBudget = Math.min(1024, Math.floor(config.maxInputTokens / 4));
  const messages = buildAnswerMessages({
    question: standalone,
    contextBlock,
    history: clampHistory(toChatHistory(effectiveHistory), historyBudget),
    agentic: false,
  });

  yield { event: "status", data: { phase: "generation", message: "Writing the answer" } };

  let answerText = "";
  let usage: Usage = { promptTokens: 0, completionTokens: 0 };
  for await (const delta of provider.stream(messages, { temperature: 0, signal })) {
    if (delta.usage !== undefined) {
      usage = delta.usage;
    }
    if (delta.text.length > 0) {
      answerText += delta.text;
      yield { event: "token", data: { text: delta.text } };
    }
  }

  answerText = answerText.trim();
  let score: number | null = null;
  let fallback = false;

  // An interrupted answer is judged on nothing: the user stopped it, and spending
  // another provider round trip after an abort is exactly what stop is meant to
  // prevent. The partial text is kept as-is.
  const interrupted = signal?.aborted === true;

  if (!interrupted && answerText.length > 0) {
    yield { event: "status", data: { phase: "groundedness", message: "Checking groundedness" } };
    score = await faithfulness(provider, contextBlock, answerText);
    if (score !== null && score < GROUNDEDNESS_THRESHOLD) {
      answerText = FALLBACK_ANSWER;
      fallback = true;
      yield { event: "replacement", data: { answer: FALLBACK_ANSWER } };
    }
  } else if (!interrupted && answerText.length === 0) {
    answerText = FALLBACK_ANSWER;
    fallback = true;
    yield { event: "replacement", data: { answer: FALLBACK_ANSWER } };
  }

  yield {
    event: "done",
    data: {
      answer: answerText,
      fallback,
      faithfulness: score,
      usage,
      citations: fallback ? [] : citations,
    },
  };
}

/** Records a turn in the session so later questions can use it. */
export function recordTurn(
  sessionId: string,
  question: string,
  answerText: string,
  citations: readonly Citation[],
  fallback: boolean,
): void {
  const session = getSession(sessionId);
  if (session === null) {
    return;
  }
  rememberTurn(session, { role: "user", content: question });
  rememberTurn(session, {
    role: "assistant",
    content: fallback ? `${answerText} [${citations.length} citations]` : answerText,
  });
}

/** Purges the index, documents and history for a session. */
export function reset(sessionId: string): { readonly cleared: boolean } {
  dropSession(sessionId);
  // Dropping a session that was never created is already the requested end state,
  // so this reports success either way rather than making callers tolerate a 404.
  return { cleared: true };
}

/**
 * Clears the transcript while keeping the pipeline, the PDFs and the index.
 *
 * This is what the chat page's "start a new chat" confirmation means: history is
 * the only thing that resets.
 */
export function clearHistory(sessionId: string): void {
  const session = getSession(sessionId);
  if (session !== null) {
    session.history.length = 0;
  }
}
