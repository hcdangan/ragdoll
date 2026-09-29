/**
 * Similarity scoring and the per-session vector index.
 *
 * Ported from the FastAPI engine's `distance.py`. Plain arrays rather than a native
 * library: the index is per-session and small, retrieval is the only hot path, and a
 * dependency here would be the largest thing in the deployment for no measurable
 * gain. Vectors are L2-normalised once at insert time, which makes cosine a dot
 * product and keeps retrieval O(n·d).
 */

import type { TextChunk } from "./chunking";

export type DistanceMetric = "cosine" | "dot" | "euclidean";

/** Raised when vectors cannot be compared. */
export class VectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VectorError";
  }
}

/** Scales a vector to unit length; a zero vector passes through unchanged. */
export function l2Normalise(vector: readonly number[]): number[] {
  let sumSquares = 0;
  for (const component of vector) {
    sumSquares += component * component;
  }
  const norm = Math.sqrt(sumSquares);
  return norm === 0 ? [...vector] : vector.map((component) => component / norm);
}

/** Inner product of two equal-length vectors. */
export function dotProduct(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length) {
    throw new VectorError("vector dimensions differ");
  }
  let total = 0;
  for (let index = 0; index < left.length; index += 1) {
    total += (left[index] ?? 0) * (right[index] ?? 0);
  }
  return total;
}

/**
 * Returns a score where higher always means more relevant.
 *
 * Both sides are normalised for cosine rather than trusting the caller: the index
 * stores unit vectors, but a query vector arrives straight from the provider and the
 * evaluation path compares two arbitrary texts.
 */
export function similarity(
  metric: DistanceMetric,
  query: readonly number[],
  candidate: readonly number[],
): number {
  if (metric === "cosine") {
    return dotProduct(l2Normalise(query), l2Normalise(candidate));
  }
  if (metric === "dot") {
    return dotProduct(query, candidate);
  }
  if (query.length !== candidate.length) {
    throw new VectorError("vector dimensions differ");
  }
  let sumSquares = 0;
  for (let index = 0; index < query.length; index += 1) {
    const difference = (query[index] ?? 0) - (candidate[index] ?? 0);
    sumSquares += difference * difference;
  }
  // Euclidean distance is inverted so every metric shares one ranking direction.
  return 1 / (1 + Math.sqrt(sumSquares));
}

/** A chunk plus its embedding, ready to score. */
export interface IndexedChunk {
  readonly chunk: TextChunk;
  readonly documentId: string;
  readonly documentName: string;
  readonly vector: readonly number[];
}

/** A scored retrieval hit. */
export interface RetrievedChunk {
  readonly chunk: TextChunk;
  readonly documentId: string;
  readonly documentName: string;
  readonly score: number;
}

/** In-memory index for one session. Never persisted, which is what makes "nothing on disk" true. */
export class VectorIndex {
  readonly metric: DistanceMetric;
  readonly dimensions: number;
  private readonly entries: IndexedChunk[] = [];

  constructor(metric: DistanceMetric, dimensions: number) {
    this.metric = metric;
    this.dimensions = dimensions;
  }

  /** Appends normalised entries, validating the vector width. */
  add(entries: Iterable<IndexedChunk>): void {
    for (const entry of entries) {
      if (entry.vector.length !== this.dimensions) {
        throw new VectorError(
          `embedding width ${entry.vector.length} does not match the index width ${this.dimensions}`,
        );
      }
      this.entries.push(
        this.metric === "cosine" ? { ...entry, vector: l2Normalise(entry.vector) } : entry,
      );
    }
  }

  /** Returns the top-K chunks, highest score first. */
  search(query: readonly number[], topK: number): RetrievedChunk[] {
    if (this.entries.length === 0) {
      return [];
    }
    const scored = this.entries.map((entry) => ({
      chunk: entry.chunk,
      documentId: entry.documentId,
      documentName: entry.documentName,
      score: similarity(this.metric, query, entry.vector),
    }));
    scored.sort((left, right) => right.score - left.score);
    // `topK` of 0 is meaningful: retrieve nothing and let the answer path fall
    // back, which is what the widened 0–100 slider exposes.
    return scored.slice(0, Math.max(0, topK));
  }

  /**
   * Mean score of the ranked chunks beyond `topK`.
   *
   * The evidence behind noise sensitivity: how much irrelevant material sits just
   * outside the context window. Null when the index is too small for a tail to mean
   * anything.
   */
  tailSimilarity(query: readonly number[], topK: number): number | null {
    if (this.entries.length <= topK) {
      return null;
    }
    const scored = this.entries
      .map((entry) => similarity(this.metric, query, entry.vector))
      .sort((left, right) => right - left);
    const tail = scored.slice(topK);
    if (tail.length === 0) {
      return null;
    }
    return tail.reduce((total, score) => total + score, 0) / tail.length;
  }

  get chunkCount(): number {
    return this.entries.length;
  }

  /** Rough resident size, used by the session store's memory guard. */
  memoryBytes(): number {
    return this.entries.reduce(
      (total, entry) => total + entry.vector.length * 8 + entry.chunk.text.length,
      0,
    );
  }
}
