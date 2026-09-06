import { describe, expect, it } from "vitest";
import { PRESETS } from "../simulation";
import { DEFAULT_RUN_CONFIG, validateRunConfig } from "./config";

describe("pinned, bounded research configuration", () => {
  it("defines the reproducible default experiment and returns detached arrays/weights", () => {
    const result = validateRunConfig(DEFAULT_RUN_CONFIG);
    expect(result).toEqual({
      name: "Experiment",
      size: 49,
      steps: 96,
      seed: "cross",
      trainingSeeds: [1729],
      validationSeeds: [],
      objective: "complexity",
      aggregation: "mean",
      weights: {
        diversity: 0.34,
        activity: 0.3,
        density: 0.24,
        variation: 0.12,
      },
      seedGenome: PRESETS[0].genome,
      initialization: "mutants",
      populationSize: 64,
      eliteCount: 4,
      selection: "tournament",
      tournamentSize: 4,
      crossover: "uniform",
      crossoverRate: 0.7,
      mutationRate: 0.03,
      immigrantRate: 0.05,
      randomSeed: 1729,
      cacheSize: 2048,
      evaluationWorkers: 2,
      maxGenerations: 0,
      checkpointSeconds: 10,
      snapshotEvery: 100,
      retainedSnapshots: 48,
      resumeOnRestart: true,
    });
    result.seedGenome[1] = 4;
    result.trainingSeeds.push(2);
    result.weights.activity = 9;
    expect(DEFAULT_RUN_CONFIG.seedGenome).toEqual(PRESETS[0].genome);
    expect(DEFAULT_RUN_CONFIG.trainingSeeds).toEqual([1729]);
    expect(DEFAULT_RUN_CONFIG.weights.activity).toBe(0.3);
  });
  it.each([
    { size: 8 },
    { size: 10 },
    { size: 131 },
    { steps: 7 },
    { steps: 1025 },
    { size: 129, steps: 1024 },
    { populationSize: 7 },
    { populationSize: 513 },
    { populationSize: NaN },
    { eliteCount: -1 },
    { eliteCount: 64 },
    { tournamentSize: 1 },
    { tournamentSize: 33 },
    { populationSize: 8, tournamentSize: 9 },
    { mutationRate: -0.01 },
    { crossoverRate: 1.01 },
    { immigrantRate: 0.51 },
    { eliteCount: 63, immigrantRate: 0.05 },
    { trainingSeeds: [] },
    { trainingSeeds: Array(9).fill(1) },
    { trainingSeeds: [Infinity] },
    { trainingSeeds: [1.5] },
    { trainingSeeds: [1, 1] },
    { validationSeeds: [2, 2] },
    { validationSeeds: [1729] },
    { trainingSeeds: [1, 4294967297] },
    { trainingSeeds: [1], validationSeeds: [4294967297] },
    { validationSeeds: Array(9).fill(1) },
    { validationSeeds: [Number.MAX_SAFE_INTEGER + 1] },
    { randomSeed: NaN },
    { evaluationWorkers: 0 },
    { evaluationWorkers: 7 },
    { cacheSize: -1 },
    { cacheSize: 8193 },
    { maxGenerations: -1 },
    { maxGenerations: 1_000_000_001 },
    { checkpointSeconds: 1.9 },
    { checkpointSeconds: 301 },
    { snapshotEvery: 0 },
    { snapshotEvery: 10001 },
    { retainedSnapshots: 1 },
    { retainedSnapshots: 129 },
    { name: "" },
    { name: "   " },
    { name: "x".repeat(81) },
    { name: 42 },
    { resumeOnRestart: "yes" },
    { initialization: "winner" },
    { selection: "random" },
    { crossover: "twoPoint" },
    { seed: "soup" },
    { objective: "entropy" },
    { aggregation: "median" },
    { weights: { diversity: 0, activity: 0, density: 0, variation: 0 } },
    { weights: { diversity: 11, activity: 1, density: 1, variation: 1 } },
    { weights: { diversity: NaN, activity: 1, density: 1, variation: 1 } },
    { seedGenome: Array(45).fill(1) },
    { seedGenome: Array(45) },
    { seedGenome: Array(44).fill(0) },
    { size: "49" },
    { stateCount: 8 },
    { boundary: "toroidal" },
  ])("rejects unsafe or silently changed settings: %j", (update) => {
    expect(() =>
      validateRunConfig({ ...DEFAULT_RUN_CONFIG, ...update }),
    ).toThrow(RangeError);
  });
  it.each([null, [], {}, 1, "defaults"])(
    "rejects incomplete/non-object configs: %j",
    (value) => {
      expect(() => validateRunConfig(value)).toThrow(RangeError);
    },
  );
  it("accepts boundaries without allocating their lattice/population", () => {
    expect(
      validateRunConfig({
        ...DEFAULT_RUN_CONFIG,
        size: 129,
        steps: 961,
        populationSize: 512,
        eliteCount: 256,
        immigrantRate: 0.5,
        evaluationWorkers: 6,
        trainingSeeds: Array.from(
          { length: 8 },
          (_, i) => Number.MIN_SAFE_INTEGER + i,
        ),
        validationSeeds: Array.from(
          { length: 8 },
          (_, i) => Number.MAX_SAFE_INTEGER - i,
        ),
        cacheSize: 8192,
        maxGenerations: 1e9,
        checkpointSeconds: 2.5,
        snapshotEvery: 10000,
        retainedSnapshots: 128,
      }),
    ).toBeDefined();
    expect(
      validateRunConfig({
        ...DEFAULT_RUN_CONFIG,
        size: 9,
        steps: 8,
        populationSize: 8,
        eliteCount: 0,
        immigrantRate: 0,
        cacheSize: 0,
      }),
    ).toBeDefined();
  });
});
