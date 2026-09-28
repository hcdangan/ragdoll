import type { EmbeddingModel, PipelineConfig } from "./types";


/**
 * Numeric constraints and sliders. Kept free of React so the exact same rules
 * run in the browser, in Server Actions, and in unit tests.
 */

export const LIMITS = {
  chunkSize: { min: 128, max: 2048, step: 32, default: 512 },
  chunkOverlapPercent: { min: 10, max: 20, step: 1, default: 10 },
  maxInputTokens: { min: 256, max: 4096, step: 32, default: 1024 },
  topK: { min: 3, max: 10, step: 1, default: 5 },
  files: { maxCount: 3, maxFileBytes: 2 * 1024 * 1024, maxTotalBytes: 6 * 1024 * 1024 },
  sessionTtlMs: 15 * 60 * 1000,
  streamingTimeoutMs: 60_000,
} as const;

export const FALLBACK_ANSWER = "Sorry, I don't know the answer to that.";
export const GROUNDEDNESS_THRESHOLD = 0.5;

export interface SliderSpec {
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly default: number;
}

/**
 * Clamps a value into a range and snaps it to the step grid.
 * @param value Raw value, possibly NaN.
 * @param spec Slider specification.
 * @returns A valid value on the step grid.
 */
export const snapToStep = (value: number, spec: SliderSpec): number => {
  if (!Number.isFinite(value)) {
    return spec.default;
  }
  const clamped = Math.min(spec.max, Math.max(spec.min, value));
  const steps = Math.round((clamped - spec.min) / spec.step);
  return spec.min + steps * spec.step;
};

/**
 * Converts a chunk-overlap percentage into an absolute token count.
 * AGENTS.md requires rounding to the nearest multiple of 32 and clamping back
 * into the 10–20% band *after* rounding, so this deliberately rounds first and
 * only then clamps — the reverse order can leave the value outside the band.
 * @param chunkSize Chunk size in tokens.
 * @param percent Overlap percentage between 10 and 20.
 * @returns Overlap in tokens: a multiple of 32 within the 10–20% band.
 */
export const computeOverlapTokens = (chunkSize: number, percent: number): number => {
  const safeChunk = Number.isFinite(chunkSize) ? Math.max(1, Math.round(chunkSize)) : LIMITS.chunkSize.default;
  // `Math.min(20, Math.max(10, NaN))` is NaN, so non-finite input is defaulted
  // explicitly rather than clamped.
  const safePercent = Number.isFinite(percent)
    ? Math.min(20, Math.max(10, Math.round(percent)))
    : LIMITS.chunkOverlapPercent.default;

  const rounded = Math.round((safeChunk * safePercent) / 100 / 32) * 32;
  const lower = Math.ceil(Math.max(32, (safeChunk * 10) / 100) / 32) * 32;
  const upperCandidate = Math.floor((safeChunk * 20) / 100 / 32) * 32;
  const upper = Math.max(lower, upperCandidate);

  return Math.min(upper, Math.max(lower, rounded));
};

/**
 * Derives the read-only vector width for a model.
 * @param dimensionLookup Model → dimension table.
 * @param embeddingModel Selected model.
 */
export const embeddingDimensionFor = (
  dimensionLookup: Readonly<Record<EmbeddingModel, number>>,
  embeddingModel: EmbeddingModel,
): number => dimensionLookup[embeddingModel];

/**
 * Checks a UI token budget against the configured context window.
 * The chat page uses this to ask the user to confirm a fresh session.
 * @param estimatedTokens Approximate tokens for the next prompt.
 * @param maxInputTokens Configured context window.
 */
export const exceedsContextWindow = (estimatedTokens: number, maxInputTokens: number): boolean =>
  estimatedTokens >= maxInputTokens;

/** Rough token estimate that matches the FastAPI chunker (±10% on prose). */
export const estimateTokens = (text: string): number => {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return 0;
  }
  return Math.ceil(trimmed.length / 4);
};

/**
 * Estimates the prompt size of a chat turn so the UI can warn before the
 * configured context window is exceeded.
 * @param config Active pipeline configuration.
 * @param promptText Draft or completed prompt text.
 * @param historyChars Total characters of retained history.
 */
export const estimatePromptTokens = (
  config: PipelineConfig,
  promptText: string,
  historyChars: number,
): number => estimateTokens(promptText) + Math.ceil(historyChars / 4) + config.topK * 96;
