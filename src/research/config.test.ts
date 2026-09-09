import { describe, expect, it } from "vitest";
import { PRESETS } from "../simulation";
import {
  DEFAULT_RUN_CONFIG,
  migrateLegacyRunConfig,
  validateRunConfig,
} from "./config";
import { LEGACY_MODEL_VERSION, PREVIOUS_MODEL_VERSION } from "./types";
import {
  MAX_GRID_SIZE,
  MAX_CA_STEPS,
  MAX_FIXTURE_SITES,
  SIMULATION_SCALES,
  maxHorizon,
} from "./limits";

describe("pinned, bounded research configuration", () => {
  it("defines the reproducible default experiment and returns detached arrays/weights", () => {
    const result = validateRunConfig(DEFAULT_RUN_CONFIG);
    expect(result).toEqual({
      name: "Experiment",
      stateCount: 5,
      size: 129,
      steps: 2048,
      seed: "cross",
      trainingSeeds: [1729],
      validationSeeds: [],
      objective: "longevity",
      boundaryPolicy: { spatial: true, horizon: true },
      aggregation: "mean",
      fixtureFailures: "aggregate",
      weights: {
        diversity: 0.34,
        activity: 0.3,
        density: 0.24,
        variation: 0.12,
      },
      seedGenome: PRESETS[0].genome,
      initialization: "random",
      randomRuleBias: "sparse",
      populationSize: 64,
      eliteCount: 2,
      elitism: "distinct",
      selection: "tournament",
      tournamentSize: 2,
      crossover: "uniform",
      crossoverRate: 0.7,
      mutationRate: 0.034,
      mutationPolicy: "heavyTailed",
      mutationBeta: 1.5,
      immigrantRate: 0.05,
      randomSeed: 1729,
      cacheSize: 2048,
      evaluationWorkers: 2,
      maxGenerations: 0,
      stallGenerations: 0,
      checkpointSeconds: 10,
      snapshotEvery: 100,
      retainedSnapshots: 48,
      resumeOnRestart: true,
    });
    result.seedGenome[1] = 4;
    result.trainingSeeds.push(2);
    result.weights.activity = 9;
    result.boundaryPolicy.spatial = false;
    expect(DEFAULT_RUN_CONFIG.boundaryPolicy.spatial).toBe(true);
    expect(DEFAULT_RUN_CONFIG.seedGenome).toEqual(PRESETS[0].genome);
    expect(DEFAULT_RUN_CONFIG.trainingSeeds).toEqual([1729]);
    expect(DEFAULT_RUN_CONFIG.weights.activity).toBe(0.3);
  });
  it.each([
    { size: 8 },
    { size: 10 },
    { size: MAX_GRID_SIZE + 2 },
    { steps: 7 },
    { steps: MAX_CA_STEPS + 1 },
    { size: MAX_GRID_SIZE, steps: maxHorizon(MAX_GRID_SIZE) + 1 },
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
    { evaluationWorkers: 14 },
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
    { randomRuleBias: "dense" },
    { randomRuleBias: undefined },
    { elitism: "top" },
    { elitism: undefined },
    { mutationPolicy: "gaussian" },
    { mutationPolicy: undefined },
    { mutationPolicy: "independent" },
    { mutationBeta: 0.99 },
    { mutationBeta: 4.01 },
    { mutationBeta: NaN },
    { mutationBeta: "1.5" },
    { mutationBeta: undefined },
    { stallGenerations: -1 },
    { stallGenerations: 1.5 },
    { stallGenerations: 1_000_000_001 },
    { stallGenerations: undefined },
    { selection: "lexicase" },
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
    { fixtureFailures: "ignore" },
    { boundaryPolicy: undefined },
    { boundaryPolicy: { spatial: true } },
    { boundaryPolicy: { spatial: "yes", horizon: true } },
    { boundaryPolicy: { spatial: true, horizon: 1 } },
    { boundaryPolicy: { spatial: true, horizon: true, extra: false } },
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
        size: MAX_GRID_SIZE,
        steps: maxHorizon(MAX_GRID_SIZE),
        populationSize: 512,
        eliteCount: 256,
        immigrantRate: 0.5,
        evaluationWorkers: 13,
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
  it("requires mutationBeta exactly when the policy is heavy-tailed", () => {
    const { mutationBeta: _beta, ...withoutBeta } = DEFAULT_RUN_CONFIG;
    const { mutationPolicy: _policy, ...withoutPolicy } = DEFAULT_RUN_CONFIG;
    expect(() => validateRunConfig(withoutBeta)).toThrow(
      /Mutation beta is required/,
    );
    expect(() => validateRunConfig(withoutPolicy)).toThrow(
      /applies only to heavy-tailed/,
    );
    expect(() =>
      validateRunConfig({ ...DEFAULT_RUN_CONFIG, mutationPolicy: "independent" }),
    ).toThrow(/applies only to heavy-tailed/);
    expect(
      validateRunConfig({ ...withoutBeta, mutationPolicy: "independent" }),
    ).toMatchObject({ mutationPolicy: "independent", mutationRate: 0.034 });
    expect(
      validateRunConfig({ ...withoutBeta, mutationPolicy: "independent" }),
    ).not.toHaveProperty("mutationBeta");
    for (const mutationBeta of [1, 1.5, 4])
      expect(
        validateRunConfig({ ...DEFAULT_RUN_CONFIG, mutationBeta }).mutationBeta,
      ).toBe(mutationBeta);
  });
  it("accepts each new optional field within its documented range", () => {
    for (const elitism of ["slots", "distinct"] as const)
      expect(validateRunConfig({ ...DEFAULT_RUN_CONFIG, elitism }).elitism).toBe(
        elitism,
      );
    for (const stallGenerations of [0, 5, 1_000_000_000])
      expect(
        validateRunConfig({ ...DEFAULT_RUN_CONFIG, stallGenerations })
          .stallGenerations,
      ).toBe(stallGenerations);
    expect(
      validateRunConfig({
        ...DEFAULT_RUN_CONFIG,
        selection: "lexicase",
        trainingSeeds: [1, 2],
      }).selection,
    ).toBe("lexicase");
  });
  it("rejects lexicase selection with one training fixture and explains why", () => {
    expect(() =>
      validateRunConfig({ ...DEFAULT_RUN_CONFIG, selection: "lexicase" }),
    ).toThrow(/Lexicase selection needs at least 2 training seeds/);
    expect(() =>
      validateRunConfig({
        ...DEFAULT_RUN_CONFIG,
        selection: "lexicase",
        trainingSeeds: [1, 2],
        validationSeeds: [3],
      }),
    ).not.toThrow();
  });
  it("validates and migrates saved configurations that predate the operator keys, leaving them absent", () => {
    const legacy = {
      ...DEFAULT_RUN_CONFIG,
      eliteCount: 4,
      tournamentSize: 4,
      mutationRate: 0.03,
    };
    delete legacy.elitism;
    delete legacy.mutationPolicy;
    delete legacy.mutationBeta;
    delete legacy.stallGenerations;
    const validated = validateRunConfig(legacy);
    expect(validated).toEqual(legacy);
    for (const key of [
      "elitism",
      "mutationPolicy",
      "mutationBeta",
      "stallGenerations",
    ])
      expect(validated).not.toHaveProperty(key);
    expect(Object.keys(validated).sort()).toEqual(Object.keys(legacy).sort());
    const { boundaryPolicy: _boundary, stateCount: _states, ...v1 } = legacy;
    const migrated = migrateLegacyRunConfig(v1, LEGACY_MODEL_VERSION);
    expect(migrated).toEqual({
      ...legacy,
      stateCount: 5,
      boundaryPolicy: { spatial: false, horizon: false },
    });
    expect(migrated).not.toHaveProperty("mutationPolicy");
    const { boundaryPolicy: _policy, ...v2 } = legacy;
    expect(migrateLegacyRunConfig(v2, PREVIOUS_MODEL_VERSION)).toEqual({
      ...legacy,
      boundaryPolicy: { spatial: false, horizon: false },
    });
    expect(
      migrateLegacyRunConfig(
        { ...v2, elitism: "distinct", stallGenerations: 7 },
        PREVIOUS_MODEL_VERSION,
      ),
    ).toMatchObject({ elitism: "distinct", stallGenerations: 7 });
    expect(() =>
      migrateLegacyRunConfig({ ...v2, elitism: "top" }, PREVIOUS_MODEL_VERSION),
    ).toThrow(RangeError);
  });
  it("admits deep and wide experiments, with a separate per-fixture work ceiling", () => {
    for (const { size, steps } of [
      ...SIMULATION_SCALES,
      { size: 513, steps: 2048 },
    ]) {
      expect(
        validateRunConfig({ ...DEFAULT_RUN_CONFIG, size, steps }),
      ).toMatchObject({ size, steps });
      expect(size * size * steps).toBeLessThanOrEqual(MAX_FIXTURE_SITES);
    }
    expect(
      validateRunConfig({
        ...DEFAULT_RUN_CONFIG,
        size: 127,
        steps: MAX_CA_STEPS,
      }).steps,
    ).toBe(65_536);
    expect(() =>
      validateRunConfig({ ...DEFAULT_RUN_CONFIG, size: 1025, steps: 2048 }),
    ).toThrow(/At grid size 1025.*Reduce the grid or horizon/);
  });
});
