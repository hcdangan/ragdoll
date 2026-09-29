import { describe, expect, it } from "vitest";

import type { TextChunk } from "@/lib/rag/chunking";
import {
  VectorError,
  VectorIndex,
  dotProduct,
  l2Normalise,
  similarity,
  type IndexedChunk,
  type RetrievedChunk,
} from "@/lib/rag/distance";

/**
 * Retrieval quality is decided entirely by this arithmetic, so the scores here are
 * hand-computed rather than asserted against the implementation's own output.
 *
 * The one convention worth stating explicitly: every metric returns a *similarity*, so
 * a higher score always means more relevant — euclidean is inverted distance
 * (`1 / (1 + d)`), not a distance the caller has to flip.
 */

/** A chunk carrying only the fields the index and its hits surface. */
function chunkOf(text: string, index: number): TextChunk {
  return {
    index,
    text,
    tokenCount: Math.max(1, Math.ceil(text.trim().length / 4)),
    page: 1,
  };
}

/** An indexed chunk in `doc-N`, so hits can be traced back to their source. */
function indexed(
  documentId: string,
  text: string,
  vector: readonly number[],
  index: number,
): IndexedChunk {
  return {
    chunk: chunkOf(text, index),
    documentId,
    documentName: `${documentId}.pdf`,
    vector,
  };
}

/** Fails loudly instead of making every assertion unwrap an optional. */
function hitAt(hits: readonly RetrievedChunk[], position: number): RetrievedChunk {
  const found = hits[position];
  if (found === undefined) {
    throw new Error(`hit ${position} is missing`);
  }
  return found;
}

describe("l2Normalise", () => {
  it("scales a vector to unit length", () => {
    const normalised = l2Normalise([3, 4]);

    expect(normalised[0]).toBeCloseTo(0.6, 10);
    expect(normalised[1]).toBeCloseTo(0.8, 10);
  });

  it("returns a zero vector unchanged rather than dividing by zero", () => {
    expect(l2Normalise([0, 0, 0])).toEqual([0, 0, 0]);
    expect(l2Normalise([])).toEqual([]);
  });

  it("leaves an already-unit vector alone", () => {
    expect(l2Normalise([1, 0])).toEqual([1, 0]);
  });
});

describe("dotProduct", () => {
  it("sums the component products", () => {
    expect(dotProduct([1, 2, 3], [4, 5, 6])).toBe(32);
    expect(dotProduct([1, 0], [0, 1])).toBe(0);
    expect(dotProduct([], [])).toBe(0);
  });

  it("rejects vectors of different widths", () => {
    expect(() => dotProduct([1, 2], [1, 2, 3])).toThrow(VectorError);
    expect(() => dotProduct([1, 2], [1, 2, 3])).toThrow("vector dimensions differ");
  });
});

describe("similarity", () => {
  it("normalises both sides for cosine, so magnitude does not change the score", () => {
    expect(similarity("cosine", [3, 4], [6, 8])).toBeCloseTo(1, 10);
    expect(similarity("cosine", [1, 0], [0, 1])).toBe(0);
    // cos([1,2],[2,1]) = 4/5.
    expect(similarity("cosine", [1, 2], [2, 1])).toBeCloseTo(0.8, 10);
  });

  it("returns the raw inner product for dot, without normalising", () => {
    expect(similarity("dot", [1, 2, 3], [4, 5, 6])).toBe(32);
    expect(similarity("dot", [3, 4], [6, 8])).toBe(50);
  });

  it("returns 1/(1+distance) for euclidean, a similarity rather than a distance", () => {
    // Identical vectors are the best possible score, which is what makes the ranking
    // direction uniform across the three metrics.
    expect(similarity("euclidean", [1, 2], [1, 2])).toBe(1);
    // d([1,2],[4,6]) = 5.
    expect(similarity("euclidean", [1, 2], [4, 6])).toBeCloseTo(1 / 6, 10);
    expect(similarity("euclidean", [0, 0], [3, 4])).toBeCloseTo(1 / 6, 10);
  });

  it("rejects vectors of different widths for every metric", () => {
    expect(() => similarity("cosine", [1, 2], [1])).toThrow(VectorError);
    expect(() => similarity("dot", [1, 2], [1])).toThrow(VectorError);
    expect(() => similarity("euclidean", [1, 2], [1])).toThrow(VectorError);
  });
});

describe("VectorIndex", () => {
  it("exposes the metric and width it was built with", () => {
    const index = new VectorIndex("euclidean", 768);

    expect(index.metric).toBe("euclidean");
    expect(index.dimensions).toBe(768);
    expect(index.chunkCount).toBe(0);
  });

  it("rejects a vector whose width differs from the index width", () => {
    const index = new VectorIndex("cosine", 3);

    expect(() => index.add([indexed("doc-1", "alpha", [1, 0], 0)])).toThrow(VectorError);
    expect(() => index.add([indexed("doc-1", "alpha", [1, 0], 0)])).toThrow(
      "embedding width 2 does not match the index width 3",
    );
    // The width check precedes the insert, so nothing half-added is left behind.
    expect(index.chunkCount).toBe(0);
  });

  it("counts the chunks it holds", () => {
    const index = new VectorIndex("cosine", 2);
    index.add([
      indexed("doc-1", "alpha", [1, 0], 0),
      indexed("doc-1", "bravo", [0, 1], 1),
    ]);

    expect(index.chunkCount).toBe(2);
  });
});

describe("VectorIndex.search", () => {
  /** Cosines against the query [1, 0] are 1, 0.7071 and 0. */
  const cosineIndex = (): VectorIndex => {
    const index = new VectorIndex("cosine", 2);
    index.add([
      indexed("doc-1", "alpha", [1, 0], 0),
      indexed("doc-2", "bravo", [0, 1], 1),
      indexed("doc-3", "charlie", [1, 1], 2),
    ]);
    return index;
  };

  it("returns hits highest score first, carrying their chunk and provenance", () => {
    const hits = cosineIndex().search([1, 0], 2);

    expect(hits).toHaveLength(2);
    expect(hits.map((hit) => hit.documentId)).toEqual(["doc-1", "doc-3"]);
    expect(hitAt(hits, 0)).toEqual({
      chunk: { index: 0, text: "alpha", tokenCount: 2, page: 1 },
      documentId: "doc-1",
      documentName: "doc-1.pdf",
      score: 1,
    });
    expect(hitAt(hits, 1).documentName).toBe("doc-3.pdf");
    expect(hitAt(hits, 1).score).toBeCloseTo(Math.SQRT1_2, 10);
    expect(hitAt(hits, 0).score).toBeGreaterThan(hitAt(hits, 1).score);
  });

  it("returns every entry, still ranked, when top-K exceeds the index", () => {
    const hits = cosineIndex().search([1, 0], 10);

    expect(hits.map((hit) => hit.documentId)).toEqual(["doc-1", "doc-3", "doc-2"]);
  });

  it("ranks the nearest vector first under the euclidean metric", () => {
    const index = new VectorIndex("euclidean", 2);
    index.add([
      indexed("doc-far", "far", [10, 10], 0),
      indexed("doc-near", "near", [0, 1], 1),
    ]);

    const hits = index.search([0, 0], 5);

    expect(hits.map((hit) => hit.documentId)).toEqual(["doc-near", "doc-far"]);
    expect(hitAt(hits, 0).score).toBeCloseTo(0.5, 10);
  });

  it("keeps raw vectors for the dot metric, so magnitude drives the score", () => {
    const index = new VectorIndex("dot", 2);
    index.add([
      indexed("doc-1", "alpha", [1, 0], 0),
      indexed("doc-2", "bravo", [3, 0], 1),
    ]);

    const hits = index.search([1, 0], 5);

    expect(hits.map((hit) => hit.documentId)).toEqual(["doc-2", "doc-1"]);
    expect(hitAt(hits, 0).score).toBe(3);
    expect(hitAt(hits, 1).score).toBe(1);
  });

  it("returns no hits for an empty index", () => {
    expect(new VectorIndex("cosine", 2).search([1, 0], 5)).toEqual([]);
  });
});

describe("VectorIndex.tailSimilarity", () => {
  /** Cosines against the query [1, 0] are 1, 0 and -1. */
  const cosineIndex = (): VectorIndex => {
    const index = new VectorIndex("cosine", 2);
    index.add([
      indexed("doc-1", "alpha", [1, 0], 0),
      indexed("doc-2", "bravo", [0, 1], 1),
      indexed("doc-3", "charlie", [-1, 0], 2),
    ]);
    return index;
  };

  it("returns null when there is no tail beyond top-K", () => {
    expect(cosineIndex().tailSimilarity([1, 0], 3)).toBeNull();
    expect(cosineIndex().tailSimilarity([1, 0], 5)).toBeNull();
  });

  it("averages the scores of the chunks ranked below top-K", () => {
    // Beyond rank 1 the remaining scores are 0 and -1.
    expect(cosineIndex().tailSimilarity([1, 0], 1)).toBeCloseTo(-0.5, 10);
    // Beyond rank 2 only the worst chunk is left.
    expect(cosineIndex().tailSimilarity([1, 0], 2)).toBeCloseTo(-1, 10);
  });

  it("returns null for an empty index", () => {
    expect(new VectorIndex("cosine", 2).tailSimilarity([1, 0], 5)).toBeNull();
  });
});

describe("VectorIndex.memoryBytes", () => {
  it("is zero for an empty index", () => {
    expect(new VectorIndex("cosine", 3).memoryBytes()).toBe(0);
  });

  it("grows with each chunk by its vector width and text length", () => {
    const index = new VectorIndex("cosine", 3);

    index.add([indexed("doc-1", "alpha", [1, 0, 0], 0)]);
    // 3 components * 8 bytes + 5 characters.
    expect(index.memoryBytes()).toBe(29);

    index.add([indexed("doc-2", "bravo bravo", [0, 1, 0], 1)]);
    // 29 + 3 * 8 + 11 characters.
    expect(index.memoryBytes()).toBe(64);
    expect(index.memoryBytes()).toBeGreaterThan(29);
  });
});
