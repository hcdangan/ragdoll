import { describe, expect, it } from "vitest";

import {
  ChunkingError,
  chunkDocument,
  chunkPage,
  estimateTokens,
  normaliseText,
  splitWords,
  truncateToTokens,
  type TextChunk,
} from "@/lib/rag/chunking";

/**
 * The chunker decides what a citation can point at, so these tests pin the window
 * arithmetic itself — word counts, overlap and the token read-out the UI shows — rather
 * than the shape of the output. A sliding window that quietly lost its overlap would
 * still return plausible-looking chunks.
 *
 * Everything is derived from the module's own constants: chunk size arrives in tokens
 * and is converted at 4 characters per token and 6 characters per word, which is why a
 * 12-token chunk is an 8-word window (12 * 4 / 6).
 */

/** Words with no sentence terminators, so windows are never snapped to a boundary. */
const numberedWords = (count: number): string[] =>
  Array.from({ length: count }, (_, position) => `w${position + 1}`);

/** Fails loudly instead of making every assertion unwrap an optional. */
const chunkAt = (chunks: readonly TextChunk[], position: number): TextChunk => {
  const found = chunks[position];
  if (found === undefined) {
    throw new Error(`chunk ${position} is missing`);
  }
  return found;
};

describe("estimateTokens", () => {
  it("approximates one token per four characters, rounding up", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("a".repeat(8))).toBe(2);
    expect(estimateTokens("alpha beta gamma delta")).toBe(6);
  });

  it("never reports zero tokens for non-blank text", () => {
    expect(estimateTokens("a")).toBe(1);
  });

  it("measures the trimmed text", () => {
    expect(estimateTokens("  abcd  ")).toBe(1);
  });

  it("reports zero for empty and whitespace-only text", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("   \n\t ")).toBe(0);
  });
});

describe("splitWords", () => {
  it("splits on any run of whitespace, including newlines", () => {
    expect(splitWords("  alpha\tbeta\n gamma  ")).toEqual(["alpha", "beta", "gamma"]);
  });

  it("returns no words for blank text", () => {
    expect(splitWords(" \n\t ")).toEqual([]);
    expect(splitWords("")).toEqual([]);
  });
});

describe("normaliseText", () => {
  it("collapses runs of tabs, form feeds and vertical tabs to one space", () => {
    expect(normaliseText("alpha\t\tbeta\f\vgamma")).toBe("alpha beta gamma");
  });

  it("replaces null bytes and trims the result", () => {
    expect(normaliseText("  alpha\0beta  ")).toBe("alpha beta");
  });

  it("clamps a long run of newlines to a single paragraph break", () => {
    expect(normaliseText("alpha\n\n\n\n\nbeta")).toBe("alpha\n\nbeta");
    expect(normaliseText("alpha\n\nbeta")).toBe("alpha\n\nbeta");
  });

  it("keeps a single newline, which is a line break rather than a paragraph break", () => {
    expect(normaliseText("alpha\nbeta")).toBe("alpha\nbeta");
  });

  it("returns an empty string for blank text", () => {
    expect(normaliseText(" \n\n\n\t ")).toBe("");
  });
});

describe("chunkPage", () => {
  it("returns no chunks for a page that carries no text", () => {
    expect(chunkPage("   \n\n  ", { chunkSize: 64, chunkOverlapTokens: 6, page: 1 })).toEqual([]);
    expect(chunkPage("", { chunkSize: 64, chunkOverlapTokens: 6, page: 1 })).toEqual([]);
  });

  it("returns exactly one chunk when the page is shorter than a chunk", () => {
    const chunks = chunkPage("alpha beta gamma delta", {
      chunkSize: 64,
      chunkOverlapTokens: 6,
      page: 2,
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({
      index: 0,
      text: "alpha beta gamma delta",
      tokenCount: 6,
      page: 2,
    });
  });

  it("slides a window over a long page, numbering from startIndex on the given page", () => {
    const chunks = chunkPage(numberedWords(20).join(" "), {
      chunkSize: 12,
      chunkOverlapTokens: 3,
      page: 5,
      startIndex: 7,
    });

    expect(chunks.map((chunk) => chunk.index)).toEqual([7, 8, 9]);
    expect(chunks.map((chunk) => chunk.page)).toEqual([5, 5, 5]);
    expect(chunks.map((chunk) => chunk.text)).toEqual([
      "w1 w2 w3 w4 w5 w6 w7 w8",
      "w7 w8 w9 w10 w11 w12 w13 w14",
      "w13 w14 w15 w16 w17 w18 w19 w20",
    ]);
  });

  it("reports the token count of each window", () => {
    const chunks = chunkPage(numberedWords(20).join(" "), {
      chunkSize: 12,
      chunkOverlapTokens: 3,
      page: 1,
    });

    expect(chunks.map((chunk) => chunk.tokenCount)).toEqual([6, 7, 8]);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBe(estimateTokens(chunk.text));
    }
  });

  it("repeats the overlap words at the start of the next chunk", () => {
    const chunks = chunkPage(numberedWords(20).join(" "), {
      chunkSize: 12,
      chunkOverlapTokens: 3,
      page: 1,
    });

    // 3 overlap tokens convert to 2 words, so chunk two restarts where chunk one ended.
    expect(splitWords(chunkAt(chunks, 0).text).slice(-2)).toEqual(["w7", "w8"]);
    expect(splitWords(chunkAt(chunks, 1).text).slice(0, 2)).toEqual(["w7", "w8"]);
    expect(splitWords(chunkAt(chunks, 1).text).slice(-2)).toEqual(["w13", "w14"]);
    expect(splitWords(chunkAt(chunks, 2).text).slice(0, 2)).toEqual(["w13", "w14"]);
  });

  it("keeps every word exactly once in order when the overlap is zero", () => {
    const words = numberedWords(20);
    const chunks = chunkPage(words.join(" "), {
      chunkSize: 12,
      chunkOverlapTokens: 0,
      page: 1,
    });

    expect(chunks.map((chunk) => chunk.tokenCount)).toEqual([6, 8, 4]);
    expect(chunks.flatMap((chunk) => splitWords(chunk.text))).toEqual(words);
  });

  it("rejects a chunk size of zero or less", () => {
    expect(() => chunkPage("alpha beta", { chunkSize: 0, chunkOverlapTokens: 0, page: 1 })).toThrow(
      ChunkingError,
    );
    expect(() =>
      chunkPage("alpha beta", { chunkSize: -32, chunkOverlapTokens: 0, page: 1 }),
    ).toThrow("chunk size must be positive");
  });

  it("rejects an overlap that reaches or passes the chunk size", () => {
    expect(() =>
      chunkPage("alpha beta", { chunkSize: 64, chunkOverlapTokens: 64, page: 1 }),
    ).toThrow(ChunkingError);
    expect(() =>
      chunkPage("alpha beta", { chunkSize: 64, chunkOverlapTokens: 96, page: 1 }),
    ).toThrow("chunk overlap must be smaller than the chunk size");
  });

  it("accepts an overlap one token below the chunk size", () => {
    expect(() =>
      chunkPage(numberedWords(40).join(" "), {
        chunkSize: 64,
        chunkOverlapTokens: 63,
        page: 1,
      }),
    ).not.toThrow();
  });
});

describe("chunkDocument", () => {
  it("numbers chunk indexes continuously across pages", () => {
    const pages: [number, string][] = [
      [1, numberedWords(10).join(" ")],
      [2, numberedWords(10).join(" ")],
    ];
    const chunks = chunkDocument(pages, { chunkSize: 12, chunkOverlapTokens: 0 });

    expect(chunks.map((chunk) => chunk.index)).toEqual([0, 1, 2, 3]);
    expect(chunks.map((chunk) => chunk.page)).toEqual([1, 1, 2, 2]);
    expect(chunkAt(chunks, 2).text).toBe("w1 w2 w3 w4 w5 w6 w7 w8");
    expect(chunkAt(chunks, 3).text).toBe("w9 w10");
  });

  it("starts the next page's numbering after a single-chunk page", () => {
    const chunks = chunkDocument(
      [
        [1, "alpha beta gamma"],
        [2, numberedWords(20).join(" ")],
      ],
      { chunkSize: 12, chunkOverlapTokens: 3 },
    );

    expect(chunks.map((chunk) => chunk.index)).toEqual([0, 1, 2, 3]);
    expect(chunks.map((chunk) => chunk.page)).toEqual([1, 2, 2, 2]);
  });

  it("returns no chunks when every page is blank", () => {
    expect(
      chunkDocument(
        [
          [1, "   "],
          [2, "\n\n"],
        ],
        { chunkSize: 64, chunkOverlapTokens: 6 },
      ),
    ).toEqual([]);
  });
});

describe("truncateToTokens", () => {
  const text = "alpha bravo charlie delta echo foxtrot";

  it("returns the text unchanged when it already fits the budget", () => {
    expect(truncateToTokens(text, 10)).toBe(text);
    expect(truncateToTokens(text, 99)).toBe(text);
  });

  it("returns an empty string for a non-positive budget", () => {
    expect(truncateToTokens(text, 0)).toBe("");
    expect(truncateToTokens(text, -8)).toBe("");
  });

  it("cuts on a word boundary rather than mid-word", () => {
    const truncated = truncateToTokens(text, 5);

    // A 5-token budget is 3 words at 6 characters per word, and 3 words is 5 tokens.
    expect(truncated).toBe("alpha bravo charlie");
    expect(estimateTokens(truncated)).toBeLessThanOrEqual(5);
    expect(splitWords(text).slice(0, 3)).toEqual(splitWords(truncated));
  });

  it("stays inside the budget for prose at realistic budgets", () => {
    const prose = "Retention is seven years for financial records and archived offsite.";

    // Every budget, not a sample: the word allowance is a first guess and the
    // result is re-measured, so short words must not sneak past the limit.
    for (let budget = 1; budget <= 40; budget += 1) {
      const truncated = truncateToTokens(prose, budget);
      expect(estimateTokens(truncated), `budget ${budget}`).toBeLessThanOrEqual(budget);
    }
  });

  it("returns nothing rather than overshooting when one word exceeds the budget", () => {
    // Word-boundary truncation cannot satisfy this budget, and exceeding it would
    // breach the context window the caller is protecting.
    expect(truncateToTokens("supercalifragilisticexpialidocious", 2)).toBe("");
  });
});
