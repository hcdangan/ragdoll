import type { EmbeddingModel, PipelineConfig } from "./types";


/**
 * Numeric constraints and sliders. Kept free of React so the exact same rules
 * run in the browser, in Server Actions, and in unit tests.
 */

export const LIMITS = {
  chunkSize: { min: 128, max: 2048, step: 32, default: 512 },
  chunkOverlapPercent: { min: 10, max: 20, step: 1, default: 10 },
  maxInputTokens: { min: 256, max: 4096, step: 32, default: 1024 },
  topK: { min: 0, max: 100, step: 1, default: 5 },
  files: {
    maxCount: 3,
    // 5 MB per file, 15 MB per session — three files at the per-file ceiling. The
    // Server Action body limit and every piece of upload copy derive from these,
    // so moving the ceiling stays a one-line change.
    maxFileBytes: 5 * 1024 * 1024,
    maxTotalBytes: 15 * 1024 * 1024,
  },
  sessionTtlMs: 15 * 60 * 1000,
  streamingTimeoutMs: 60_000,
} as const;

export const FALLBACK_ANSWER = "Sorry, I don't know the answer to that.";
export const GROUNDEDNESS_THRESHOLD = 0.5;

/**
 * Formats a byte count as whole megabytes, for upload copy.
 * @param bytes Byte count, e.g. `LIMITS.files.maxFileBytes`.
 */
export const megabytes = (bytes: number): string => `${Math.round(bytes / (1024 * 1024))} MB`;

/**
 * Largest request body a hosted platform will carry into a Server Action.
 *
 * Vercel rejects a Function request over 4.5 MB, and the upload travels as base64
 * inside JSON, which inflates it by a third. Self-hosted deployments have no such
 * ceiling and get the full `LIMITS.files` allowance; everywhere else the app must
 * refuse the upload *before* sending it, because a platform 413 never reaches the
 * Server Action and surfaces as an opaque failure.
 */
const HOSTED_BODY_LIMIT_BYTES = 4_500_000;
/** Base64 grows an upload by 4/3; leave headroom for the JSON envelope. */
const BASE64_INFLATION = 4 / 3;
const HOSTED_FILE_BYTES = Math.floor(HOSTED_BODY_LIMIT_BYTES / BASE64_INFLATION / (1024 * 1024)) * 1024 * 1024;

/**
 * Upload ceilings this deployment can actually honour.
 * @param hosted True when requests are served by a platform with a body cap.
 */
export const uploadLimits = (
  hosted: boolean,
): { readonly maxFileBytes: number; readonly maxTotalBytes: number } =>
  hosted
    ? {
        maxFileBytes: Math.min(LIMITS.files.maxFileBytes, HOSTED_FILE_BYTES),
        maxTotalBytes: Math.min(
          LIMITS.files.maxTotalBytes,
          Math.min(LIMITS.files.maxFileBytes, HOSTED_FILE_BYTES) * LIMITS.files.maxCount,
        ),
      }
    : { maxFileBytes: LIMITS.files.maxFileBytes, maxTotalBytes: LIMITS.files.maxTotalBytes };

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

/** Rough token estimate that matches the engine's chunker (±10% on prose). */
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
