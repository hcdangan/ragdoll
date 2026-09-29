/**
 * Ragas-style evaluation maths, ported from the FastAPI engine's `evaluate.py`.
 *
 * Every judge-heavy step (claim extraction, reverse-question generation, entity
 * spotting) runs upstream and arrives here as a resolved sample, so the metrics stay
 * pure: one sample in, one number out. That is what makes a report reproducible and
 * therefore diffable between two pipeline configurations.
 */

import { EVALUATION_METRICS, type EvaluationMetric, type MetricResult } from "../types";

/** Everything a metric needs for one answered question; no provider call remains. */
export interface JudgedAnswer {
  readonly answer: string;
  /** Retrieved chunk texts, best first. */
  readonly contexts: readonly string[];
  readonly citations: readonly { readonly documentId: string; readonly page: number }[];
  /** True when the groundedness gate withheld the answer. */
  readonly fallback: boolean;
  /** The sampled source chunk text. */
  readonly groundTruth: string | null;
  /** `"documentId:page"` keys of pages whose content is an image. */
  readonly imageOnlyPageKeys: readonly string[];
}

/** Words at or below this length carry no lexical signal, so they never score. */
const MIN_CONTENT_WORD = 3;

/** A claim needs this share of its words in the context before it counts as supported. */
const CLAIM_SUPPORT_THRESHOLD = 0.35;

/** Ground-truth sentences shorter than this are too thin to score individually. */
const RECALL_SENTENCE_MIN = 24;

/** Overlap a ground-truth sentence needs before it counts as covered. */
const RECALL_OVERLAP_THRESHOLD = 0.4;

const WORD_SPLIT = /[^\p{L}\p{N}]+/u;
const SENTENCE_SPLIT = /(?<=[.!?])\s+/;
const ENTITY_PATTERN = /\b[A-Z][a-zA-Z0-9]{2,}\b/g;
const SOURCE_KEY_TOKENS = /[^\p{L}\p{N}:_-]+/u;
/**
 * A `documentId:page` token, requiring a letter in the id so a clock reading such as
 * `12:30` inside prose is not mistaken for a source tag.
 */
const SOURCE_KEY_SHAPE = /^(?=[A-Za-z0-9_-]*[A-Za-z_])[A-Za-z0-9_-]+:\d+$/;

/** The multimodal pair, skipped wholesale when no upload had an image-only page. */
const MULTIMODAL_METRICS: ReadonlySet<EvaluationMetric> = new Set<EvaluationMetric>([
  "multimodal_faithfulness",
  "multimodal_relevance",
]);

const MULTIMODAL_SKIPPED =
  "N/A: multimodal metrics need pages whose content is an image. Either no upload " +
  "contains one, or the pages that do also carry enough text that the text metrics " +
  "already cover them.";

const NO_SAMPLE_SKIPPED = "No sample produced a score for this metric.";

/** Definitions shown next to each score in the report. */
const METRIC_REASONS: Readonly<Record<EvaluationMetric, string>> = {
  context_precision: "Rank-weighted share of retrieved context the answer cited.",
  context_recall: "Ground-truth sentence coverage by the retrieved set.",
  context_entity_recall: "Named-entity coverage of the sampled chunk.",
  noise_sensitivity:
    "1 minus the mean similarity of non-retrieved chunks; lower means less noise " +
    "reached the context window.",
  response_relevancy: "Similarity between the question and its reverse-generated question.",
  faithfulness: "Share of answer claims supported by the retrieved context.",
  multimodal_faithfulness:
    "Share of answer claims supported by the recovered text of pages whose content " +
    "is an image.",
  multimodal_relevance:
    "Share of citations that landed on image-only pages: did the answer reach for " +
    "the material that needed vision?",
};

/** Quantises to the four decimals the report displays. */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** Rounds and clamps a value whose definition implies a share. */
function proportion(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return round4(Math.min(1, Math.max(0, value)));
}

/** Distinct content words, lowercased; punctuation and filler are dropped. */
function contentWords(text: string): Set<string> {
  const words = new Set<string>();
  for (const token of text.toLowerCase().split(WORD_SPLIT)) {
    if (token.length >= MIN_CONTENT_WORD) {
      words.add(token);
    }
  }
  return words;
}

/** Sentence-ish spans, trimmed; empty fragments never become claims. */
function sentences(text: string): string[] {
  return text
    .split(SENTENCE_SPLIT)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/** Capitalised tokens, lowercased, which stand in for named entities without an NER call. */
function entities(text: string): Set<string> {
  const found = text.match(ENTITY_PATTERN) ?? [];
  return new Set(found.map((entity) => entity.toLowerCase()));
}

/** The `documentId:page` identity a citation and an image-only page key share. */
function sourceKey(source: { readonly documentId: string; readonly page: number }): string {
  return `${source.documentId}:${source.page}`;
}

/** Splits a context into word-ish tokens, keeping the characters a source key uses. */
function keyTokens(context: string): string[] {
  return context.split(SOURCE_KEY_TOKENS);
}

/**
 * Lexical Jaccard overlap over content words (words longer than 2 chars).
 *
 * A set comparison rather than a count: repetition is a style choice, not evidence, and
 * the score has to stay comparable between a terse chunk and a padded one.
 */
export function lexicalOverlap(left: string, right: string): number {
  const leftWords = contentWords(left);
  if (leftWords.size === 0) {
    return 0;
  }
  const rightWords = contentWords(right);
  let shared = 0;
  for (const word of leftWords) {
    if (rightWords.has(word)) {
      shared += 1;
    }
  }
  const union = leftWords.size + rightWords.size - shared;
  return union === 0 ? 0 : proportion(shared / union);
}

/** Share of sentences in `answer` with lexical support >= 0.35 in `context`. */
export function answerClaimsSupported(answer: string, context: string): number {
  const claims = sentences(answer);
  if (claims.length === 0) {
    return 0;
  }
  const supported = claims.filter(
    (claim) => lexicalOverlap(claim, context) >= CLAIM_SUPPORT_THRESHOLD,
  ).length;
  return proportion(supported / claims.length);
}

/** Named-entity proxy: overlap of capitalised tokens (3+ chars) between reference and candidate. */
export function entityOverlap(reference: string, candidate: string): number {
  const referenceEntities = entities(reference);
  if (referenceEntities.size === 0) {
    return 0;
  }
  const candidateEntities = entities(candidate);
  let shared = 0;
  for (const entity of referenceEntities) {
    if (candidateEntities.has(entity)) {
      shared += 1;
    }
  }
  return proportion(shared / referenceEntities.size);
}

/**
 * Rank-weighted precision: share of retrieved chunks the answer cited, weighted by rank.
 *
 * A citation only names `documentId:page`, so a chunk is recognised either by a source
 * tag written into its text or, when the caller passed bare chunk text, by retrieval
 * order — citations come from the same best-first list. A fallback answer used no
 * context at all, which is why it scores 0 rather than "unknown".
 */
export function contextPrecision(input: JudgedAnswer): number {
  if (input.fallback || input.contexts.length === 0 || input.citations.length === 0) {
    return 0;
  }

  const citedKeys = new Set(input.citations.map(sourceKey));
  const tokens = input.contexts.map(keyTokens);
  const tagged = tokens.some((words) =>
    words.some((word) => SOURCE_KEY_SHAPE.test(word)),
  );

  let hits = 0;
  let total = 0;
  input.contexts.forEach((_, index) => {
    const words = tokens[index] ?? [];
    const used = tagged
      ? words.some((word) => citedKeys.has(word))
      : index < input.citations.length;
    if (!used) {
      return;
    }
    hits += 1;
    total += hits / (index + 1);
  });

  return hits === 0 ? 0 : proportion(total / hits);
}

/**
 * Share of ground-truth sentences (longer than 24 chars) covered by the context.
 *
 * Falls back to a whole-string overlap for a one-line ground truth, where per-sentence
 * scoring would divide by zero and report a perfect miss.
 */
export function contextRecall(groundTruth: string, contextText: string): number {
  const scorable = sentences(groundTruth).filter(
    (sentence) => sentence.length > RECALL_SENTENCE_MIN,
  );
  if (scorable.length === 0) {
    return lexicalOverlap(groundTruth, contextText);
  }
  const covered = scorable.filter(
    (sentence) => lexicalOverlap(sentence, contextText) >= RECALL_OVERLAP_THRESHOLD,
  ).length;
  return proportion(covered / scorable.length);
}

/**
 * 1 - mean similarity of non-retrieved chunks.
 *
 * A null tail means the index was too small for a tail to exist, so there is no noise
 * evidence to report and the metric must be skipped rather than scored as 0.
 */
export function noiseSensitivity(tailSimilarity: number | null): number | null {
  if (tailSimilarity === null || !Number.isFinite(tailSimilarity)) {
    return null;
  }
  return proportion(1 - tailSimilarity);
}

/**
 * Share of citations that landed on image-only pages: did the answer reach for material
 * that needed vision?
 *
 * Null (not 0) when there is nothing to judge, so a text-only answer is not reported as
 * a multimodal failure. A fallback answer cited nothing at all, which is a real 0.
 */
export function multimodalRelevance(input: JudgedAnswer): number | null {
  if (input.fallback) {
    return 0;
  }
  if (input.citations.length === 0) {
    return null;
  }
  const imageOnly = new Set(input.imageOnlyPageKeys);
  const hits = input.citations.filter((citation) => imageOnly.has(sourceKey(citation))).length;
  return proportion(hits / input.citations.length);
}

/**
 * Assembles the eight-metric report.
 *
 * Order follows `EVALUATION_METRICS` so the UI table and the JSON export agree, and a
 * metric with no samples is emitted as `"N/A"` with a reason instead of being dropped —
 * a missing metric the user can see is better than a report that quietly shrinks.
 */
export function assembleMetrics(
  scores: Readonly<Partial<Record<EvaluationMetric, readonly number[]>>>,
  options: {
    readonly multimodal: boolean;
    readonly reasons?: Readonly<Partial<Record<EvaluationMetric, string>>>;
  },
): MetricResult[] {
  return EVALUATION_METRICS.map((metric) => {
    const reason = options.reasons?.[metric] ?? METRIC_REASONS[metric];

    if (!options.multimodal && MULTIMODAL_METRICS.has(metric)) {
      return { metric, score: "N/A", samples: 0, reason, skippedReason: MULTIMODAL_SKIPPED };
    }

    // Non-finite samples are dropped: one broken score should not turn a whole metric
    // into NaN, and the sample count has to describe what was actually averaged.
    const samples = (scores[metric] ?? []).filter((value) => Number.isFinite(value));
    if (samples.length === 0) {
      return { metric, score: "N/A", samples: 0, reason, skippedReason: NO_SAMPLE_SKIPPED };
    }

    const mean = samples.reduce((total, value) => total + value, 0) / samples.length;
    return { metric, score: proportion(mean), samples: samples.length, reason };
  });
}
