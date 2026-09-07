import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DEFAULT_RUN_CONFIG, validateRunConfig } from "./config";
import { advanceGeneration, initializePopulation } from "./engine";
import { resizeGenome } from "./genome";
import { streamTrajectory } from "./trajectory";
import type { BatchEvaluator, RunConfig } from "./types";

const neutral: BatchEvaluator = async (genomes, config) =>
  genomes.map(() => ({
    fitness: 0.5,
    validationFitness: null,
    disqualified: false,
    validationDisqualified: false,
    trainingScores: config.trainingSeeds.map(() => 0.5),
    validationScores: [],
    metrics: {
      diversity: 0.5,
      activity: 0.5,
      density: 0.5,
      variation: 0.5,
      persistence: 1,
      occupancy: 0.2,
      lifetime: config.steps,
      extinctFraction: 0,
    },
  }));
const configFor = (stateCount = 5): RunConfig => ({
  ...structuredClone(DEFAULT_RUN_CONFIG),
  stateCount,
  seedGenome: resizeGenome(DEFAULT_RUN_CONFIG.seedGenome, stateCount),
  size: 17,
  steps: 9,
  seed: "point",
  populationSize: 512,
  eliteCount: 0,
  immigrantRate: 0.5,
});

describe("sparse random rule sampling", () => {
  it.each([2, 5, 16])(
    "favors zero and makes low-neighbor births rare with %i states, including immigrants",
    async (stateCount) => {
      const genomes: number[][] = [];
      for (const randomSeed of [19, 71, 428, 1729]) {
        const state = await initializePopulation(
          { ...configFor(stateCount), randomSeed },
          neutral,
        );
        genomes.push(...state.population.map((item) => item.genome));
        const next = await advanceGeneration(state, neutral);
        const immigrants = next.population.filter(
          (item) => item.origin === "immigrant",
        );
        expect(immigrants).toHaveLength(256);
        genomes.push(...immigrants.map((item) => item.genome));
      }
      const births = [1, 2, 3].map(
        (locus) =>
          genomes.filter((genome) => genome[locus] !== 0).length /
          genomes.length,
      );
      expect(births[0]).toBeGreaterThan(0.005);
      expect(births[0]).toBeLessThan(0.035);
      for (const rate of births.slice(1)) {
        expect(rate).toBeGreaterThan(0.03);
        expect(rate).toBeLessThan(0.07);
      }
      const counts = Array(stateCount).fill(0);
      for (const genome of genomes) {
        expect(genome[0]).toBe(0);
        for (const output of genome.slice(4)) counts[output]++;
      }
      const total = counts.reduce((a, b) => a + b, 0);
      expect(counts[0] / total).toBeCloseTo(0.8, 2);
      const live = total - counts[0];
      const expectedShare = 1 / (stateCount - 1);
      const samplingTolerance =
        5 * Math.sqrt((expectedShare * (1 - expectedShare)) / live);
      for (const count of counts.slice(1))
        expect(Math.abs(count / live - expectedShare)).toBeLessThanOrEqual(
          samplingTolerance,
        );
    },
  );

  it("makes maximum-speed expansion from a point much rarer without forbidding it", async () => {
    const rates: number[] = [];
    for (const randomRuleBias of ["uniform", "sparse"] as const) {
      const config = { ...configFor(), randomRuleBias };
      const state = await initializePopulation(config, neutral);
      const fastest = state.population.filter((item) => {
        const contacts = streamTrajectory(
          item.genome,
          config,
          1729,
        ).boundaryContacts;
        return [
          contacts.left,
          contacts.right,
          contacts.front,
          contacts.back,
        ].includes(8);
      }).length;
      rates.push(fastest / state.population.length);
    }
    expect(rates[0]).toBeGreaterThan(0.6);
    expect(rates[1]).toBeGreaterThan(0);
    expect(rates[1]).toBeLessThan(0.06);
    expect(rates[1]).toBeLessThan(rates[0] / 10);
  });

  it("preserves the original engine's exact three-generation continuation when the bias is absent", async () => {
    const config: RunConfig = {
      ...structuredClone(DEFAULT_RUN_CONFIG),
      size: 9,
      steps: 8,
      populationSize: 8,
      eliteCount: 2,
      randomSeed: 9182,
      initialization: "random",
      immigrantRate: 0.25,
      evaluationWorkers: 1,
    };
    delete config.randomRuleBias;
    expect(validateRunConfig(config)).not.toHaveProperty("randomRuleBias");
    let state = await initializePopulation(config);
    for (let i = 0; i < 3; i++)
      state = await advanceGeneration(JSON.parse(JSON.stringify(state)));
    // Captured from the committed pre-bias engine (196b8cb), including cache and RNG.
    expect(
      createHash("sha256").update(JSON.stringify(state)).digest("hex"),
    ).toBe("6dc5193be45323ee3a29085e679eed260f366c559f4d3a6ac156959496ee7f8c");
    let explicit = await initializePopulation({
      ...config,
      randomRuleBias: "uniform",
    });
    for (let i = 0; i < 3; i++) explicit = await advanceGeneration(explicit);
    expect(explicit).toEqual({
      ...state,
      config: { ...config, randomRuleBias: "uniform" },
    });
  });
});
