import { describe, expect, it } from "vitest";
import {
  heavyTailedMaxChanges,
  heavyTailedWeights,
  mutationChangeDistribution,
  rateForExpectedChanges,
  unlockedLoci,
} from "./mutation";

describe("mutation change-count distributions", () => {
  it.each([2, 5, 16])(
    "counts 9·states − 1 unlocked loci and caps heavy-tailed changes at half of them for %i states",
    (stateCount) => {
      expect(unlockedLoci(stateCount)).toBe(9 * stateCount - 1);
      expect(heavyTailedMaxChanges(stateCount)).toBe(
        Math.max(1, Math.floor((9 * stateCount - 1) / 2)),
      );
    },
  );
  it.each([
    [2, 1],
    [5, 1.5],
    [5, 4],
    [16, 4],
  ])(
    "normalizes heavy-tailed weights for %i states at beta %d, with index 0 holding k = 1",
    (stateCount, beta) => {
      const weights = heavyTailedWeights(stateCount, beta);
      expect(weights).toHaveLength(heavyTailedMaxChanges(stateCount));
      expect(weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
      expect(weights.every((w, i) => i === 0 || w < weights[i - 1])).toBe(
        true,
      );
      weights.forEach((w, i) =>
        expect(w / weights[0]).toBeCloseTo((i + 1) ** -beta, 12),
      );
    },
  );
  it("describes the heavy-tailed policy with zero clone probability and the exact power-law mean", () => {
    const distribution = mutationChangeDistribution({
      stateCount: 5,
      mutationPolicy: "heavyTailed",
      mutationRate: 0.03,
      mutationBeta: 1.5,
    });
    expect(distribution.unlocked).toBe(44);
    expect(distribution.probabilities).toHaveLength(23);
    expect(distribution.probabilities[0]).toBe(0);
    expect(distribution.probabilities.reduce((a, b) => a + b, 0)).toBeCloseTo(
      1,
      12,
    );
    const weights = heavyTailedWeights(5, 1.5);
    expect(distribution.probabilities.slice(1)).toEqual(weights);
    expect(distribution.mean).toBeCloseTo(
      weights.reduce((sum, p, i) => sum + p * (i + 1), 0),
      12,
    );
    // The new-draft default: about 3.7 changes per child, 46% single changes.
    expect(distribution.mean).toBeGreaterThan(3.6);
    expect(distribution.mean).toBeLessThan(3.75);
    expect(distribution.probabilities[1]).toBeGreaterThan(0.45);
    expect(distribution.probabilities[1]).toBeLessThan(0.47);
    expect(
      mutationChangeDistribution({
        stateCount: 5,
        mutationPolicy: "heavyTailed",
        mutationRate: 0.03,
        mutationBeta: 4,
      }).mean,
    ).toBeLessThan(distribution.mean);
  });
  it("describes the independent policy as Binomial(unlocked, rate), including degenerate rates", () => {
    const distribution = mutationChangeDistribution({
      stateCount: 5,
      mutationPolicy: "independent",
      mutationRate: 0.034,
    });
    expect(distribution.unlocked).toBe(44);
    expect(distribution.probabilities).toHaveLength(45);
    expect(distribution.probabilities.reduce((a, b) => a + b, 0)).toBeCloseTo(
      1,
      12,
    );
    expect(distribution.probabilities[0]).toBeCloseTo(0.966 ** 44, 12);
    expect(distribution.probabilities[1]).toBeCloseTo(
      44 * 0.034 * 0.966 ** 43,
      12,
    );
    expect(distribution.mean).toBeCloseTo(44 * 0.034, 12);
    expect(
      distribution.probabilities.reduce((sum, p, k) => sum + p * k, 0),
    ).toBeCloseTo(distribution.mean, 10);
    expect(
      mutationChangeDistribution({ stateCount: 5, mutationRate: 0.03 }),
    ).toEqual(
      mutationChangeDistribution({
        stateCount: 5,
        mutationPolicy: "independent",
        mutationRate: 0.03,
      }),
    );
    expect(
      mutationChangeDistribution({ stateCount: 2, mutationRate: 0 })
        .probabilities,
    ).toEqual([1, ...Array(17).fill(0)]);
    expect(
      mutationChangeDistribution({ stateCount: 2, mutationRate: 1 })
        .probabilities,
    ).toEqual([...Array(17).fill(0), 1]);
    expect(
      mutationChangeDistribution({ stateCount: 2, mutationRate: 1 }).mean,
    ).toBe(17);
  });
  it("converts expected changes to a clamped per-locus rate", () => {
    expect(rateForExpectedChanges(5, 1.5)).toBeCloseTo(1.5 / 44, 15);
    expect(rateForExpectedChanges(5, 1.5) * 44).toBeCloseTo(1.5, 12);
    expect(rateForExpectedChanges(5, 0)).toBe(0);
    expect(rateForExpectedChanges(5, -2)).toBe(0);
    expect(rateForExpectedChanges(5, 44)).toBe(1);
    expect(rateForExpectedChanges(5, 1000)).toBe(1);
    expect(rateForExpectedChanges(2, 17)).toBe(1);
    expect(rateForExpectedChanges(16, 1.5)).toBeCloseTo(1.5 / 143, 15);
  });
});
