import { describe, expect, it } from "vitest";
import type { HistoryPoint, Individual } from "../../research/types";
import {
  alleleFrequencies,
  distinctEliteScale,
  fitnessGap,
  formatPercent,
  formatSigned,
  GAP_EMPHASIS,
  geneCase,
  geneLabel,
  historyReadout,
  historySegments,
  historyValue,
  nearestGeneration,
  rankPopulation,
  repeatShare,
  traceGene,
} from "./visualizerData";

const individual = (id: string, genome: number[], fitness = 0): Individual => ({
  id,
  genome,
  fitness,
  validationFitness: null,
  birthGeneration: 0,
  origin: "founder",
  parents: [],
  crossoverMask: [],
  mutatedLoci: [],
  disqualified: false,
  validationDisqualified: false,
  trainingScores: [],
  validationScores: [],
  metrics: {
    diversity: 0,
    activity: 0,
    density: 0,
    variation: 0,
    persistence: 0,
    occupancy: 0,
    lifetime: 0,
    extinctFraction: 0,
  },
});
const point = (
  generation: number,
  validationBest: number | null,
  extra: Partial<HistoryPoint> = {},
): HistoryPoint => ({
  generation,
  validationBest,
  best: 0,
  bestEver: 0,
  mean: 0,
  worst: 0,
  median: 0,
  diversity: 0,
  uniqueGenomes: 1,
  evaluations: 1,
  cacheHits: 0,
  distinctElites: 1,
  bestCopies: 1,
  generationsSinceImprovement: 0,
  elapsedMs: 0,
  generationMs: 0,
  evalsPerSecond: 0,
  ...extra,
});

describe("research visualization data", () => {
  it("labels all 45 loci by current state and active-neighbor count, including fixed quiescence", () => {
    expect(geneCase(0)).toEqual({ state: 0, neighbors: 0 });
    expect(geneLabel(0, 0)).toContain("quiescent, fixed");
    expect(geneCase(17)).toEqual({ state: 1, neighbors: 8 });
    expect(geneCase(44)).toEqual({ state: 4, neighbors: 8 });
    expect(geneLabel(44, 3)).toBe(
      "Current state 4; 8 active neighbors → output 3",
    );
  });
  it("traces crossover inheritance before recorded mutation, not merely differences with either parent", () => {
    const parent1 = individual("p1", Array(45).fill(1));
    const parent2 = individual("p2", Array(45).fill(2));
    const child = {
      ...individual("c1", Array(45).fill(2)),
      parents: [parent1, parent2],
      crossoverMask: Array(45).fill(1),
      mutatedLoci: [12],
    };
    child.genome[12] = 4;
    expect(traceGene(child, 12)).toMatchObject({
      source: 1,
      parent: { id: "p2" },
      before: 2,
      after: 4,
      mutated: true,
    });
    expect(traceGene(child, 13)).toMatchObject({
      source: 1,
      before: 2,
      after: 2,
      mutated: false,
    });
    expect(traceGene(parent1, 12)).toMatchObject({
      source: null,
      parent: null,
      before: null,
      after: 1,
      mutated: false,
    });
  });
  it("counts actual population alleles independently at each locus and handles no population", () => {
    const a = individual("a", Array(45).fill(0));
    const b = individual("b", Array(45).fill(4));
    b.genome[0] = 0;
    const c = individual("c", Array(45).fill(4));
    c.genome[0] = 0;
    const result = alleleFrequencies([a, b, c]);
    expect(result[0][0]).toBe(1);
    expect(result[4][0]).toBe(0);
    expect(result[4][44]).toBeCloseTo(2 / 3);
    expect(result[0][44]).toBeCloseTo(1 / 3);
    for (let locus = 0; locus < 45; locus++)
      expect(result.reduce((sum, row) => sum + row[locus], 0)).toBeCloseTo(1);
    expect(
      alleleFrequencies([])
        .flat()
        .every((value) => value === 0),
    ).toBe(true);
  });
  it("ranks without mutation and resolves ties in original order", () => {
    const population = [
      individual("z", [], 1),
      individual("a", [], 2),
      individual("c", [], 1),
    ];
    expect(rankPopulation(population).map((item) => item.id)).toEqual([
      "a",
      "z",
      "c",
    ]);
    expect(population.map((item) => item.id)).toEqual(["z", "a", "c"]);
  });
  it("retains true GA generation numbers and breaks held-out lines across null values", () => {
    const history = [
      point(0, 0),
      point(5, 0.2),
      point(10, null),
      point(20, 0.3),
      point(100, 0.3),
    ];
    expect(
      historySegments(history, "validationBest").map((segment) =>
        segment.map((item) => item.generation),
      ),
    ).toEqual([
      [0, 5],
      [20, 100],
    ]);
    expect(historySegments(history, "best")[0]).toHaveLength(5);
    expect(historySegments([], "best")).toEqual([]);
    expect(historySegments([point(0, 0)], "validationBest")).toHaveLength(1);
    expect(nearestGeneration([0, 20, 100], 61)).toBe(100);
    expect(nearestGeneration([0, 20, 100], 60)).toBe(20);
    expect(nearestGeneration([], 3)).toBeNull();
  });
  it("derives repeat share only from recorded per-generation counts, never NaN", () => {
    expect(
      repeatShare({ generationEvaluations: 58, generationRepeats: 6 }),
    ).toBeCloseTo(6 / 64);
    expect(
      repeatShare({ generationEvaluations: 0, generationRepeats: 62 }),
    ).toBe(1);
    expect(repeatShare({})).toBeNull();
    expect(repeatShare({ generationEvaluations: 58 })).toBeNull();
    expect(repeatShare({ generationRepeats: 6 })).toBeNull();
    expect(
      repeatShare({ generationEvaluations: 0, generationRepeats: 0 }),
    ).toBeNull();
    expect(formatPercent(6 / 64)).toBe("9.4%");
    expect(formatPercent(null)).toBe("—");
    expect(formatPercent(Number.NaN)).toBe("—");
  });
  it("signs the training-minus-held-out gap and leaves unevaluated held-out fitness as no gap", () => {
    expect(fitnessGap({ fitness: 0.5, validationFitness: 0.3 })).toBeCloseTo(
      0.2,
    );
    expect(fitnessGap({ fitness: 0.2, validationFitness: 0.35 })).toBeCloseTo(
      -0.15,
    );
    expect(fitnessGap({ fitness: 0.5, validationFitness: null })).toBeNull();
    expect(formatSigned(0.2)).toBe("+0.2000");
    expect(formatSigned(-0.0123)).toBe("−0.0123");
    expect(formatSigned(0)).toBe("+0.0000");
    expect(formatSigned(null)).toBe("—");
    expect(GAP_EMPHASIS).toBe(0.1);
  });
  it("normalizes distinct elites by elite count, then population size, then the largest recorded count", () => {
    const history = [
      point(0, null, { distinctElites: 1 }),
      point(1, null, { distinctElites: 3 }),
      point(2, null, { distinctElites: 2 }),
    ];
    expect(distinctEliteScale(history, { eliteCount: 4 })).toBe(4);
    expect(
      distinctEliteScale(history, { eliteCount: 4, populationSize: 64 }),
    ).toBe(4);
    expect(distinctEliteScale(history, { populationSize: 64 })).toBe(64);
    expect(distinctEliteScale(history)).toBe(3);
    expect(distinctEliteScale([])).toBe(1);
    expect(distinctEliteScale(history, { eliteCount: 0 })).toBe(3);
    expect(historyValue(history[2], "distinctElites", 4)).toBe(0.5);
    expect(historyValue(history[2], "distinctElites", 64)).toBeCloseTo(
      2 / 64,
    );
    expect(historyReadout(history[2], "distinctElites", { eliteCount: 4 })).toBe(
      "2 / 4",
    );
    expect(
      historyReadout(history[2], "distinctElites", { populationSize: 64 }),
    ).toBe("2 / 64");
    expect(historyReadout(history[2], "distinctElites")).toBe("2");
    expect(historyReadout(history[2], "best")).toBe("0.0000");
    const legacy = point(3, null);
    delete (legacy as Partial<HistoryPoint>).distinctElites;
    expect(historyValue(legacy, "distinctElites", 4)).toBeNull();
    expect(historyReadout(legacy, "distinctElites", { eliteCount: 4 })).toBe(
      "—",
    );
  });
  it("breaks repeat-share lines where a generation's counts were not recorded", () => {
    const history = [
      point(0, null, { generationEvaluations: 60, generationRepeats: 4 }),
      point(1, null, { generationEvaluations: 50, generationRepeats: 14 }),
      point(2, null),
      point(3, null, { generationEvaluations: 40, generationRepeats: 24 }),
    ];
    expect(
      historySegments(history, "repeatShare").map((segment) =>
        segment.map((item) => item.generation),
      ),
    ).toEqual([[0, 1], [3]]);
    expect(historyValue(history[3], "repeatShare")).toBeCloseTo(0.375);
    expect(historyValue(history[2], "repeatShare")).toBeNull();
    expect(historyReadout(history[3], "repeatShare")).toBe("37.5%");
    expect(historyReadout(history[2], "repeatShare")).toBe("—");
    expect(historySegments(history, "distinctElites", 4)).toHaveLength(1);
    expect(historySegments(history, "best")[0]).toHaveLength(4);
  });
});

it.each([2, 16])(
  "counts all alleles across every locus with %i states",
  (stateCount) => {
    const a = individual("a", Array(stateCount * 9).fill(0));
    const b = individual("b", Array(stateCount * 9).fill(stateCount - 1));
    b.genome[0] = 0;
    const frequencies = alleleFrequencies([a, b]);
    expect(frequencies).toHaveLength(stateCount);
    expect(frequencies.every((row) => row.length === stateCount * 9)).toBe(
      true,
    );
    expect(frequencies[0][0]).toBe(1);
    for (let locus = 1; locus < stateCount * 9; locus++) {
      expect(frequencies.reduce((sum, row) => sum + row[locus], 0)).toBe(1);
      expect(frequencies[stateCount - 1][locus]).toBe(0.5);
    }
  },
);
