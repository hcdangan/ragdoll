/**
 * Tokenisation and chunking.
 *
 * Ported from the FastAPI engine's `chunking.py`, including the deliberate
 * character-based token estimate rather than a model-specific tokeniser: it keeps
 * the bundle free of BPE tables while staying within roughly ±10% of real counts on
 * prose, which is all the chunker and the context-window guard need.
 *
 * The chunker is the only place that decides how a PDF becomes retrievable spans, so
 * it is pure and unit-tested against the exact numbers the UI displays.
 */

/** Characters per token, matching the FastAPI implementation. */
const TOKEN_CHARS = 4;

/** Words per token, used to size windows without a tokeniser. */
const WORD_CHARS = 6;

const PARAGRAPH_SPLIT = /\n\s*\n/;
const WORD_SPLIT = /\S+/g;
const SENTENCE_END = /[.!?:;]$/;

export function estimateTokens(text: string): number {
  const stripped = text.trim();
  if (stripped.length === 0) {
    return 0;
  }
  return Math.max(1, Math.ceil(stripped.length / TOKEN_CHARS));
}

export function splitWords(text: string): string[] {
  return text.match(WORD_SPLIT) ?? [];
}

/** Collapses horizontal whitespace while preserving paragraph breaks. */
export function normaliseText(text: string): string {
  const withoutNulls = text.replace(/\0/g, " ");
  const collapsed = withoutNulls.replace(/[ \t\f\v]+/g, " ");
  return collapsed.replace(/\n{3,}/g, "\n\n").trim();
}

/** A retrievable span with the metadata a citation needs. */
export interface TextChunk {
  readonly index: number;
  readonly text: string;
  readonly tokenCount: number;
  readonly page: number;
}

/** Raised for chunker inputs that cannot produce a valid window. */
export class ChunkingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChunkingError";
  }
}

/**
 * Word offsets for a sliding window over `words`.
 * @param size Window size in words.
 * @param overlap Overlap in words.
 */
function windows(words: readonly string[], size: number, overlap: number): [number, number][] {
  if (size <= 0) {
    throw new ChunkingError("chunk size must be positive");
  }
  const step = Math.max(1, size - overlap);
  const spans: [number, number][] = [];
  let start = 0;
  while (start < words.length) {
    const end = Math.min(words.length, start + size);
    spans.push([start, end]);
    if (end >= words.length) {
      break;
    }
    start += step;
  }
  return spans;
}

/** Word offsets that follow a sentence terminator. */
function sentenceBoundaries(words: readonly string[]): number[] {
  const boundaries: number[] = [];
  words.forEach((word, position) => {
    if (SENTENCE_END.test(word)) {
      boundaries.push(position + 1);
    }
  });
  return boundaries;
}

/**
 * Splits one page into overlapping chunks.
 *
 * Overlap arrives in tokens and is converted at the same approximation the UI uses,
 * so the "N tokens" read-out matches what is actually built.
 */
export function chunkPage(
  pageText: string,
  options: {
    readonly chunkSize: number;
    readonly chunkOverlapTokens: number;
    readonly page: number;
    readonly startIndex?: number;
  },
): TextChunk[] {
  const { chunkSize, chunkOverlapTokens, page, startIndex = 0 } = options;
  if (chunkSize <= 0) {
    throw new ChunkingError("chunk size must be positive");
  }
  if (chunkOverlapTokens >= chunkSize) {
    throw new ChunkingError("chunk overlap must be smaller than the chunk size");
  }

  const normalised = normaliseText(pageText);
  if (normalised.length === 0) {
    return [];
  }

  const sizeWords = Math.max(8, Math.round((chunkSize * TOKEN_CHARS) / WORD_CHARS));
  const overlapWords = Math.max(0, Math.round((chunkOverlapTokens * TOKEN_CHARS) / WORD_CHARS));

  const paragraphs = normalised
    .split(PARAGRAPH_SPLIT)
    .filter((block: string) => block.trim().length > 0);
  const chunks: TextChunk[] = [];
  let index = startIndex;

  for (const paragraph of paragraphs) {
    const words = splitWords(paragraph);

    if (words.length <= sizeWords) {
      const text = words.join(" ").trim();
      if (text.length > 0) {
        chunks.push({ index, text, tokenCount: estimateTokens(text), page });
        index += 1;
      }
      continue;
    }

    const boundaries = sentenceBoundaries(words);
    for (const [start, end] of windows(words, sizeWords, overlapWords)) {
      let from = start;
      if (overlapWords > 0 && start > 0) {
        // Prefer starting on a sentence boundary so a citation does not begin mid-clause.
        const candidates = boundaries.filter(
          (boundary) => boundary >= start && boundary <= start + overlapWords,
        );
        if (candidates.length > 0) {
          from = Math.min(...candidates);
        }
      }
      const text = words.slice(from, end).join(" ").trim();
      if (text.length > 0) {
        chunks.push({ index, text, tokenCount: estimateTokens(text), page });
        index += 1;
      }
    }
  }

  return chunks;
}

/** Chunks a whole document, keeping a stable global index across pages. */
export function chunkDocument(
  pages: readonly (readonly [number, string])[],
  options: { readonly chunkSize: number; readonly chunkOverlapTokens: number },
): TextChunk[] {
  const chunks: TextChunk[] = [];
  for (const [page, pageText] of pages) {
    chunks.push(
      ...chunkPage(pageText, {
        chunkSize: options.chunkSize,
        chunkOverlapTokens: options.chunkOverlapTokens,
        page,
        startIndex: chunks.length,
      }),
    );
  }
  return chunks;
}

/**
 * Truncates text to a token budget, preserving word boundaries.
 *
 * The word estimate is only a starting point: `estimateTokens` counts characters,
 * so a passage of short words can fit in the estimated word allowance and still
 * exceed the budget. The result is therefore re-measured and trimmed again rather
 * than trusted, because the caller is using this to stay inside a context window.
 */
export function truncateToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) {
    return "";
  }
  if (estimateTokens(text) <= maxTokens) {
    return text;
  }
  const maxWords = Math.max(1, Math.round((maxTokens * TOKEN_CHARS) / WORD_CHARS));
  const words = splitWords(text);
  let kept = words.length <= maxWords ? [...words] : words.slice(0, maxWords);
  while (kept.length > 0 && estimateTokens(kept.join(" ")) > maxTokens) {
    kept = kept.slice(0, -1);
  }
  return kept.join(" ").trim();
}
