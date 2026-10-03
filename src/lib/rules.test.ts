import { describe, expect, it } from "vitest";

import { LIMITS, computeOverlapTokens, estimateTokens, megabytes, snapToStep, uploadLimits } from "@/lib/rules";

/**
 * Chunk-overlap maths is the one place where an off-by-one silently degrades
 * retrieval quality, and the specification is explicit: round to the nearest
 * multiple of 32 *then* clamp to 10–20% of the chunk size.
 */
describe("computeOverlapTokens", () => {
  it("returns the default 10% of the default chunk size, rounded to the 32 grid", () => {
    // 512 × 10% = 51.2 → nearest multiple of 32 is 64.
    expect(computeOverlapTokens(512, 10)).toBe(64);
  });

  it("scales with the percentage and stays inside the band", () => {
    // 1024 × 10% = 102.4 → 128 on the 32 grid; 1024 × 20% = 204.8 → 192. Note
    // that 96 (9.4%) is *below* the 10% floor, which the band clamp rejects.
    expect(computeOverlapTokens(1024, 10)).toBe(128);
    expect(computeOverlapTokens(1024, 20)).toBe(192);
    expect(computeOverlapTokens(2048, 10)).toBe(224);
    expect(computeOverlapTokens(2048, 20)).toBe(384);
  });

  it("always lands on a multiple of 32", () => {
    for (let chunk = 128; chunk <= 2048; chunk += 32) {
      for (let percent = 10; percent <= 20; percent += 1) {
        expect(computeOverlapTokens(chunk, percent) % 32).toBe(0);
      }
    }
  });

  it("never leaves the 10–20% band after rounding", () => {
    for (let chunk = 128; chunk <= 2048; chunk += 32) {
      for (let percent = 10; percent <= 20; percent += 1) {
        const overlap = computeOverlapTokens(chunk, percent);
        expect(overlap).toBeGreaterThanOrEqual(Math.ceil((chunk * 10) / 100 / 32) * 32);
        expect(overlap).toBeLessThanOrEqual(Math.floor((chunk * 20) / 100 / 32) * 32 + 32);
        expect(overlap).toBeLessThan(chunk);
      }
    }
  });

  it("clamps out-of-range percentages instead of extrapolating", () => {
    expect(computeOverlapTokens(512, 0)).toBe(computeOverlapTokens(512, 10));
    expect(computeOverlapTokens(512, 99)).toBe(computeOverlapTokens(512, 20));
  });

  it("survives NaN input", () => {
    expect(computeOverlapTokens(512, Number.NaN)).toBe(computeOverlapTokens(512, 10));
  });
});

describe("uploadLimits", () => {
  it("gives a self-hosted deployment the full app allowance", () => {
    expect(uploadLimits(false)).toEqual({
      maxFileBytes: 5 * 1024 * 1024,
      maxTotalBytes: 15 * 1024 * 1024,
    });
  });

  it("holds a hosted deployment below the platform's 4.5 MB request cap", () => {
    const limits = uploadLimits(true);

    // Three megabytes of PDF is four megabytes of base64, which still fits the
    // platform's body limit — the point is that the app refuses the upload itself
    // rather than letting the platform answer with an opaque 413.
    expect(limits.maxFileBytes).toBe(3 * 1024 * 1024);
    expect(limits.maxTotalBytes).toBe(9 * 1024 * 1024);
    expect(limits.maxFileBytes * (4 / 3)).toBeLessThan(4_500_000);
    expect(megabytes(limits.maxFileBytes)).toBe("3 MB");
  });
});

describe("snapToStep", () => {
  it("clamps and quantises", () => {
    expect(snapToStep(513, LIMITS.chunkSize)).toBe(512);
    expect(snapToStep(5000, LIMITS.chunkSize)).toBe(2048);
    expect(snapToStep(0, LIMITS.chunkSize)).toBe(128);
    expect(snapToStep(700, LIMITS.chunkSize)).toBe(704);
  });

  it("returns the default for NaN", () => {
    expect(snapToStep(Number.NaN, LIMITS.chunkSize)).toBe(LIMITS.chunkSize.default);
  });
});

describe("estimateTokens", () => {
  it("is zero for empty input", () => {
    expect(estimateTokens("   ")).toBe(0);
  });

  it("approximates four characters per token", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });
});
