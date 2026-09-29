import { describe, expect, it } from "vitest";

import {
  answerClaimsSupported,
  assembleMetrics,
  contextPrecision,
  contextRecall,
  entityOverlap,
  lexicalOverlap,
  multimodalRelevance,
  noiseSensitivity,
  type JudgedAnswer,
} from "@/lib/rag/evaluate";
import { EVALUATION_METRICS, type EvaluationMetric, type MetricResult } from "@/lib/types";

/**
 * The metric maths is the only place a pipeline's quality is reduced to numbers, so the
 * thresholds here are pinned to the specification values rather than to whatever the
 * implementation happens to produce.
 */

const MULTIMODAL_SKIPPED =
  "N/A: multimodal metrics need pages whose content is an image. Either no upload " +
  "contains one, or the pages that do also carry enough text that the text metrics " +
  "already cover them.";

const NO_SAMPLE_SKIPPED = "No sample produced a score for this metric.";

/** A sample with only the fields a given metric reads filled in. */
function judged(overrides: Partial<JudgedAnswer> = {}): JudgedAnswer {
  return {
    answer: "Alpha beta gamma delta.",
    contexts: [],
    citations: [],
    fallback: false,
    groundTruth: null,
    imageOnlyPageKeys: [],
    ...overrides,
  };
}

/** Fails loudly instead of returning an optional the assertions would have to unwrap. */
function metricOf(results: readonly MetricResult[], metric: EvaluationMetric): MetricResult {
  const found = results.find((result) => result.metric === metric);
  if (found === undefined) {
    throw new Error(`the report is missing ${metric}`);
  }
  return found;
}

describe("lexicalOverlap", () => {
  it("scores identical text as a full overlap", () => {
    expect(lexicalOverlap("alpha beta gamma", "alpha beta gamma")).toBe(1);
  });

  it("scores disjoint text as no overlap", () => {
    expect(lexicalOverlap("alpha beta gamma", "whiskey victor uniform")).toBe(0);
  });

  it("ignores one- and two-character words", () => {
    expect(lexicalOverlap("a of to", "a of to")).toBe(0);
    expect(lexicalOverlap("in on at", "alpha beta gamma")).toBe(0);
  });

  it("counts three-character words, because content words are longer than two characters", () => {
    // {the, cat} ∩ {the, dog} = {the}; the union is three words.
    expect(lexicalOverlap("the cat", "the dog")).toBe(0.3333);
  });

  it("returns 0 when there is no text at all", () => {
    expect(lexicalOverlap("", "")).toBe(0);
  });
});

describe("entityOverlap", () => {
  it("scores a fully preserved entity set as 1", () => {
    expect(entityOverlap("Alpha Beta", "Alpha Beta")).toBe(1);
  });

  it("returns 0 when the reference names no entities", () => {
    expect(entityOverlap("alpha beta", "Alpha Beta")).toBe(0);
  });

  it("returns 0 when no reference entity appears in the candidate", () => {
    expect(entityOverlap("Alpha Beta", "Gamma Delta")).toBe(0);
  });

  it("scores partial coverage as the share of reference entities", () => {
    expect(entityOverlap("Alpha Beta Gamma", "Alpha Beta")).toBe(0.6667);
  });
});

describe("answerClaimsSupported", () => {
  it("counts every claim when the context is the answer", () => {
    expect(answerClaimsSupported("Alpha beta gamma delta.", "Alpha beta gamma delta.")).toBe(1);
  });

  it("counts none when the context shares no content words", () => {
    expect(answerClaimsSupported("Alpha beta gamma delta.", "Whiskey victor uniform tango.")).toBe(
      0,
    );
  });

  it("halves the score when one of two claims is unsupported", () => {
    const answer = "Alpha beta gamma delta. Zulu yankee xray whiskey.";
    expect(answerClaimsSupported(answer, "Alpha beta gamma delta.")).toBe(0.5);
  });

  it("returns 0 for an empty answer", () => {
    expect(answerClaimsSupported("", "Alpha beta gamma delta.")).toBe(0);
  });
});

describe("contextPrecision", () => {
  const citation = { documentId: "doc-1", page: 2 };

  it("returns 0 for a withheld answer, which used no context", () => {
    expect(
      contextPrecision(
        judged({ fallback: true, contexts: ["doc-1:2 Alpha beta."], citations: [citation] }),
      ),
    ).toBe(0);
  });

  it("returns 0 when nothing was retrieved", () => {
    expect(contextPrecision(judged({ contexts: [], citations: [citation] }))).toBe(0);
  });

  it("returns 0 when the answer cited nothing", () => {
    expect(contextPrecision(judged({ contexts: ["doc-1:2 Alpha beta."], citations: [] }))).toBe(0);
  });

  it("returns 1 when the single retrieved chunk is the cited one", () => {
    expect(
      contextPrecision(judged({ contexts: ["doc-1:2 Alpha beta."], citations: [citation] })),
    ).toBe(1);
  });

  it("penalises a cited chunk that ranks below an unused one", () => {
    const rankedFirst = judged({
      contexts: ["doc-1:2 Alpha beta gamma.", "doc-9:9 Zulu yankee xray."],
      citations: [citation],
    });
    const rankedSecond = judged({
      contexts: ["doc-9:9 Zulu yankee xray.", "doc-1:2 Alpha beta gamma."],
      citations: [citation],
    });

    expect(contextPrecision(rankedFirst)).toBe(1);
    expect(contextPrecision(rankedSecond)).toBe(0.5);
    expect(contextPrecision(rankedSecond)).toBeLessThan(contextPrecision(rankedFirst));
  });

  it("returns 0 when tagged chunks carry none of the cited keys", () => {
    expect(
      contextPrecision(
        judged({
          contexts: ["doc-1:2 Alpha beta.", "doc-9:9 Zulu yankee."],
          citations: [{ documentId: "doc-7", page: 7 }],
        }),
      ),
    ).toBe(0);
  });

  it("aligns untagged chunks with citations by retrieval order", () => {
    // Bare chunk text carries no source identity, so the best-first citation order is
    // the only available alignment.
    const contexts = ["Alpha beta.", "Zulu yankee."];

    expect(contextPrecision(judged({ contexts, citations: [citation] }))).toBe(1);
  });
});

describe("contextRecall", () => {
  const groundTruth = "Retrieval quality depends on chunk overlap and embedding distance.";

  it("returns 1 when the context repeats the ground truth", () => {
    expect(contextRecall(groundTruth, groundTruth)).toBe(1);
  });

  it("returns 0 for an unrelated context", () => {
    const unrelated = "Zulu yankee xray whiskey victor uniform tango sierra.";

    expect(contextRecall(groundTruth, unrelated)).toBe(0);
  });

  it("falls back to a whole-string overlap when no sentence is longer than 24 characters", () => {
    const short = "Chunk overlap matters.";

    expect(short.length).toBeLessThanOrEqual(24);
    expect(contextRecall(short, short)).toBe(1);
    expect(contextRecall(short, "Nothing here resembles that sentence.")).toBe(0);
  });

  it("excludes short sentences from the denominator instead of scoring them", () => {
    const mixed = `Too short. ${groundTruth}`;

    // Counting "Too short." would have scored 0.5.
    expect(contextRecall(mixed, groundTruth)).toBe(1);
  });
});

describe("noiseSensitivity", () => {
  it("propagates a null tail", () => {
    expect(noiseSensitivity(null)).toBeNull();
  });

  it("reports no noise when the tail is fully similar", () => {
    expect(noiseSensitivity(0)).toBe(1);
  });

  it("reports maximum noise when the tail is fully dissimilar", () => {
    expect(noiseSensitivity(1)).toBe(0);
  });

  it("clamps out-of-range tails into a proportion", () => {
    expect(noiseSensitivity(-0.25)).toBe(1);
    expect(noiseSensitivity(1.25)).toBe(0);
  });

  it("treats a non-finite tail as no evidence", () => {
    expect(noiseSensitivity(Number.NaN)).toBeNull();
  });
});

describe("multimodalRelevance", () => {
  it("returns 0 for a withheld answer", () => {
    expect(
      multimodalRelevance(
        judged({
          fallback: true,
          citations: [{ documentId: "doc-1", page: 1 }],
          imageOnlyPageKeys: ["doc-1:1"],
        }),
      ),
    ).toBe(0);
  });

  it("returns null when there are no citations to judge", () => {
    const sample = judged({ citations: [], imageOnlyPageKeys: ["doc-1:1"] });

    expect(multimodalRelevance(sample)).toBeNull();
  });

  it("returns the share of citations that landed on image-only pages", () => {
    expect(
      multimodalRelevance(
        judged({
          citations: [
            { documentId: "doc-1", page: 1 },
            { documentId: "doc-2", page: 4 },
          ],
          imageOnlyPageKeys: ["doc-1:1"],
        }),
      ),
    ).toBe(0.5);
  });

  it("returns 0 when no citation landed on an image-only page", () => {
    expect(
      multimodalRelevance(
        judged({
          citations: [{ documentId: "doc-2", page: 4 }],
          imageOnlyPageKeys: ["doc-1:1"],
        }),
      ),
    ).toBe(0);
  });
});

describe("assembleMetrics", () => {
  it("returns the eight metrics in EVALUATION_METRICS order", () => {
    const results = assembleMetrics({}, { multimodal: true });

    expect(results.map((result) => result.metric)).toEqual([...EVALUATION_METRICS]);
    expect(results).toHaveLength(8);
  });

  it("skips the multimodal pair with the multimodal reason when the session is text-only", () => {
    const results = assembleMetrics({ multimodal_relevance: [1] }, { multimodal: false });
    const relevance = metricOf(results, "multimodal_relevance");
    const multimodalFaithfulness = metricOf(results, "multimodal_faithfulness");

    expect(relevance.score).toBe("N/A");
    expect(relevance.samples).toBe(0);
    expect(relevance.skippedReason).toBe(MULTIMODAL_SKIPPED);
    expect(multimodalFaithfulness.score).toBe("N/A");
    expect(multimodalFaithfulness.skippedReason).toBe(MULTIMODAL_SKIPPED);
  });

  it("reports a metric that produced no sample with the no-sample reason", () => {
    for (const result of assembleMetrics({}, { multimodal: true })) {
      expect(result.score).toBe("N/A");
      expect(result.samples).toBe(0);
      expect(result.skippedReason).toBe(NO_SAMPLE_SKIPPED);
    }
  });

  it("averages the samples of a mixed input and counts them", () => {
    const results = assembleMetrics(
      { context_precision: [0.4, 0.9], faithfulness: [0.8] },
      { multimodal: false },
    );

    expect(metricOf(results, "context_precision").score).toBe(0.65);
    expect(metricOf(results, "context_precision").samples).toBe(2);
    expect(metricOf(results, "faithfulness").score).toBe(0.8);
    expect(metricOf(results, "faithfulness").samples).toBe(1);
    expect(metricOf(results, "noise_sensitivity").score).toBe("N/A");
    expect(metricOf(results, "noise_sensitivity").samples).toBe(0);
  });

  it("prefers a caller-supplied reason over the default definition", () => {
    const results = assembleMetrics(
      {},
      { multimodal: true, reasons: { context_recall: "Custom rationale." } },
    );

    expect(metricOf(results, "context_recall").reason).toBe("Custom rationale.");
    expect(metricOf(results, "context_precision").reason).toBe(
      "Rank-weighted share of retrieved context the answer cited.",
    );
  });

  it("clamps an out-of-range mean into a proportion", () => {
    const results = assembleMetrics({ context_recall: [1.4, 1.4] }, { multimodal: false });

    expect(metricOf(results, "context_recall").score).toBe(1);
    expect(metricOf(results, "context_recall").samples).toBe(2);
  });
});
