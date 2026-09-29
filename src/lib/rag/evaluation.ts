import "server-only";

import type { Citation, EvaluationMetric, EvaluationReport, EvaluationSample } from "../types";
import {
  answerClaimsSupported,
  assembleMetrics,
  contextPrecision,
  contextRecall,
  entityOverlap,
  lexicalOverlap,
  multimodalRelevance,
  noiseSensitivity,
} from "./evaluate";
import type { ChatMessage, LlmProvider } from "./llm";
import {
  buildQuestionMessages,
  buildReverseQuestionMessages,
  formatContextBlock,
  snippet,
  type OwnedChunk,
} from "./prompts";
import { answer, buildProvider, faithfulness, requireSession, type EngineRequest } from "./service";
import { ownedChunks, type EngineSession } from "./store";

/**
 * Evaluation runner.
 *
 * This is the half of Ragas that has to talk to a provider: it synthesises a
 * question per sampled passage, answers it through the *same* pipeline the chat
 * page uses, and hands the resolved evidence to the pure maths in `evaluate.ts`.
 * Going through `answer()` rather than a bespoke path is the point — a report is
 * only meaningful if it measures the pipeline the user will actually chat with,
 * including retrieval mode, top-K and the groundedness gate.
 *
 * Bounded work: `DEFAULT_SAMPLE_SIZE` samples, `MAX_SAMPLE_SIZE` as a ceiling, and
 * every judge is allowed to fail without failing the report.
 */

/** Samples per run when the caller does not choose; four fits the 300s budget. */
export const DEFAULT_SAMPLE_SIZE = 4;

/** Hard ceiling on samples, so a client cannot ask for an unbounded run. */
export const MAX_SAMPLE_SIZE = 12;

/** Context passed to a judge, in characters, to keep one sample's cost predictable. */
const JUDGE_CONTEXT_CHARS = 6_000;

/**
 * Picks the passages to sample, spread across the corpus.
 *
 * A stride rather than random selection: the same pipeline must produce the same
 * report twice in a row, otherwise two configurations cannot be compared.
 * @param owned Every chunk in the session.
 * @param count How many samples to take.
 */
export function sampleChunks(owned: readonly OwnedChunk[], count: number): OwnedChunk[] {
  if (owned.length === 0) {
    return [];
  }
  const wanted = Math.max(1, Math.min(count, owned.length));
  const stride = Math.max(1, Math.floor(owned.length / wanted));
  const picked: OwnedChunk[] = [];
  for (let index = 0; index < owned.length && picked.length < wanted; index += stride) {
    const chunk = owned[index];
    if (chunk !== undefined) {
      picked.push(chunk);
    }
  }
  return picked;
}

/** One provider call that may fail without failing the run. */
async function ask(provider: LlmProvider, messages: ChatMessage[], maxTokens: number): Promise<string> {
  try {
    const completion = await provider.complete(messages, { temperature: 0, maxTokens });
    return completion.text.trim();
  } catch (error) {
    console.warn(`[ragdoll] evaluation judge unavailable: ${String(error)}`);
    return "";
  }
}

/** Chunks whose page carried no usable text, so only a vision model could read it. */
function imageOnlyChunks(session: EngineSession, owned: readonly OwnedChunk[]): OwnedChunk[] {
  return owned.filter((item) => session.imageOnlyPageKeys.has(`${item.documentId}:${item.chunk.page}`));
}

const toSource = (citations: readonly Citation[]): readonly { documentId: string; page: number }[] =>
  citations.map((citation) => ({ documentId: citation.documentId, page: citation.page }));

/** Scores one answered sample. Never throws: a failed judge drops one metric. */
async function scoreSample(options: {
  provider: LlmProvider;
  session: EngineSession;
  request: EngineRequest;
  sample: OwnedChunk;
  question: string;
}): Promise<{ sample: EvaluationSample; scores: Partial<Record<EvaluationMetric, number[]>> }> {
  const { provider, session, request, sample, question } = options;
  const result = await answer(request, question, []);
  const contextText = result.contexts.join("\n\n").slice(0, JUDGE_CONTEXT_CHARS);
  const groundTruth = sample.chunk.text;
  const citations: Citation[] = [...result.citations];
  const imageKeys = [...session.imageOnlyPageKeys];

  const judged = {
    answer: result.answer,
    contexts: result.contexts,
    citations: toSource(citations),
    fallback: result.fallback,
    groundTruth,
    imageOnlyPageKeys: imageKeys,
  };

  const scores: Partial<Record<EvaluationMetric, number[]>> = {};
  const record = (metric: EvaluationMetric, value: number | null): void => {
    if (value !== null) {
      scores[metric] = [...(scores[metric] ?? []), value];
    }
  };

  record("context_precision", contextPrecision(judged));
  record("context_recall", contextRecall(groundTruth, contextText));
  record("context_entity_recall", entityOverlap(groundTruth, contextText));

  // The model's own claim-level judgement, with the lexical proxy as the floor:
  // a judge that returns nothing must not silently turn into a perfect score.
  const judgedFaithfulness = result.faithfulness;
  record(
    "faithfulness",
    judgedFaithfulness ?? (result.contexts.length > 0 ? answerClaimsSupported(result.answer, contextText) : null),
  );

  if (result.answer.length > 0 && !result.fallback) {
    const reverse = await ask(
      provider,
      buildReverseQuestionMessages(contextText, result.answer),
      120,
    );
    record("response_relevancy", reverse.length > 0 ? lexicalOverlap(question, reverse) : null);
  }

  record("multimodal_relevance", multimodalRelevance(judged));

  if (session.multimodal) {
    const gallery = imageOnlyChunks(session, ownedChunks(session));
    const imageBlock = formatContextBlock(gallery).slice(0, JUDGE_CONTEXT_CHARS);
    if (imageBlock.length > 0) {
      const imageScore = result.fallback
        ? 0
        : await faithfulness(provider, imageBlock, result.answer);
      record("multimodal_faithfulness", imageScore);
    }
  }

  if (session.index !== null) {
    const topK = Math.min(10, Math.max(1, request.config.topK));
    try {
      const vector = await provider.embedOne(result.standaloneQuery);
      record("noise_sensitivity", noiseSensitivity(session.index.tailSimilarity(vector, topK)));
    } catch (error) {
      console.warn(`[ragdoll] noise sensitivity needs a query embedding: ${String(error)}`);
    }
  }

  return {
    sample: {
      question,
      answer: result.answer,
      groundTruth: snippet(groundTruth, 400),
      contexts: result.contexts,
      citations,
      fallback: result.fallback,
    },
    scores,
  };
}

/**
 * Runs the metric suite against a session's pipeline.
 * @param request Engine request describing the pipeline and its documents.
 * @param options Sample count; clamped to `MAX_SAMPLE_SIZE`.
 */
export async function runEvaluation(
  request: EngineRequest,
  options: { readonly sampleCount?: number } = {},
): Promise<EvaluationReport> {
  const started = Date.now();
  const session = await requireSession(request);
  const provider = buildProvider(request);
  const owned = ownedChunks(session);
  const sampleCount = Math.max(
    1,
    Math.min(MAX_SAMPLE_SIZE, Math.round(options.sampleCount ?? DEFAULT_SAMPLE_SIZE)),
  );
  const samples = sampleChunks(owned, sampleCount);

  const scores: Partial<Record<EvaluationMetric, number[]>> = {};
  const judged: EvaluationSample[] = [];

  for (const sample of samples) {
    // A question the passage answers completely, so a low score means the pipeline
    // failed to use evidence it was given, not that the question was unanswerable.
    const question = await ask(
      provider,
      buildQuestionMessages(sample.chunk.text.slice(0, JUDGE_CONTEXT_CHARS)),
      120,
    );
    const asked = question.length > 0 ? question : snippet(sample.chunk.text, 120);
    try {
      const scored = await scoreSample({ provider, session, request, sample, question: asked });
      judged.push(scored.sample);
      for (const [metric, values] of Object.entries(scored.scores) as [
        EvaluationMetric,
        number[],
      ][]) {
        scores[metric] = [...(scores[metric] ?? []), ...values];
      }
    } catch (error) {
      // One unanswerable sample must not discard a run that already spent money.
      console.warn(`[ragdoll] evaluation sample failed: ${String(error)}`);
    }
  }

  return {
    category: "Retrieval Augmented Generation",
    createdAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    sampleCount: judged.length,
    documentCount: session.documents.length,
    metrics: assembleMetrics(scores, { multimodal: session.multimodal }),
    samples: judged,
  };
}
