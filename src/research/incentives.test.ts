import { describe, expect, it } from "vitest";
import { compileExpression, VARIABLES, type Measurements } from "./expressions";
import {
  incentivesForConfig,
  presetIncentive,
  scoreIncentives,
  validateIncentives,
} from "./incentives";
import { DEFAULT_RUN_CONFIG, validateRunConfig } from "./config";
import { evaluateGenome } from "./evaluate";
import {
  advanceGeneration,
  initializePopulation,
  validateEngineState,
} from "./engine";
import { sampleTrajectory } from "./sample";
import type { RunConfig } from "./types";

const values = Object.fromEntries(
  VARIABLES.map(([key]) => [key, 0]),
) as Measurements;
const config = (overrides: Partial<RunConfig> = {}): RunConfig => ({
  ...structuredClone(DEFAULT_RUN_CONFIG),
  size: 17,
  steps: 8,
  seed: "point",
  populationSize: 8,
  eliteCount: 2,
  boundaryPolicy: { spatial: false, horizon: false },
  ...overrides,
});
const incentive = (expression: string, weight = 1) => ({
  name: "Custom",
  expression,
  weight,
});

describe("bounded math expressions", () => {
  it.each([
    ["2 + 3 * 4", 14],
    ["(2 + 3) * 4", 20],
    ["2^3^2", 512],
    ["-2^2", -4],
    ["2**-2", 0.25],
    [".5 + 1e-2", 0.51],
    ["if(lifetime > 0, 1 / lifetime, 0.7)", 0.7],
    ["min(3, 2, 1) + max(1, 2)", 3],
    ["clamp(-1) + clamp(4, 0, 2)", 2],
    ["abs(-2) + sqrt(9) + pow(2, 3)", 13],
    ["round(pi) + floor(e) + ceil(.1)", 6],
    ["log(exp(1))", 1],
    ["7 % 3", 1],
    ["(1 <= 1) + (2 >= 1) + (2 != 3) + (0 == 0)", 4],
  ])("evaluates %s", (expression, expected) => {
    expect(compileExpression(expression)(values)).toBeCloseTo(expected, 14);
  });
  it.each([
    "globalThis",
    "process.exit()",
    "Math.random()",
    "constructor(1)",
    "__proto__",
    "this",
    "({}).constructor",
    "occupancy = 1",
    "1; process.exit()",
    "()=>1",
    "[1][0]",
    "eval(1)",
    "Function(1)",
    "fetch(1)",
    "import(1)",
    "random()",
    "'1'",
    "`x`",
    "1/*comment*/+1",
    "min()",
    "abs(1, 2)",
    "clamp(1, 2)",
    "if(1, 2)",
    "(1 + 2",
    "1 2",
    "1e999",
    "",
    "(".repeat(30) + "1" + ")".repeat(30),
    "1+".repeat(100) + "1",
    "1".repeat(513),
  ])("rejects unsafe or malformed source: %s", (source) => {
    expect(() => compileExpression(source)).toThrow(RangeError);
  });
  it.each(["1/0", "sqrt(-1)", "exp(1000)", "min(1 / 0, 1)", "0 * (1 / 0)"])(
    "rejects invalid arithmetic %s",
    (source) => {
      expect(() => compileExpression(source)(values)).toThrow(/non-finite/);
    },
  );
  it("bounds weighted shares, normalizes subnormal weights, and isolates numerical failures", () => {
    expect(
      scoreIncentives([incentive("4", 3), incentive("-1", 1)], values),
    ).toBe(0.75);
    expect(
      scoreIncentives([incentive("1/0", 3), incentive("1", 1)], values),
    ).toBe(0.25);
    expect(
      scoreIncentives(
        [incentive("1/0", 0), incentive("0.5", Number.MIN_VALUE)],
        values,
      ),
    ).toBe(0.5);
  });
  it("strictly validates names, list bounds, weights, syntax and detached persistence", () => {
    for (const invalid of [
      [],
      Array(17).fill(incentive("1")),
      [incentive("1", 0)],
      [incentive("1", -1)],
      [incentive("1", Infinity)],
      [incentive("1", 10001)],
      [incentive("process")],
      [{ ...incentive("1"), name: " " }],
      [{ ...incentive("1"), extra: true }],
    ])
      expect(() => validateIncentives(invalid)).toThrow();
    const cfg = config({
      incentives: [incentive("occupancy", 3), presetIncentive("longevity")],
    });
    const checked = validateRunConfig(JSON.parse(JSON.stringify(cfg)));
    expect(checked).toEqual(cfg);
    checked.incentives![0].weight = 2;
    expect(cfg.incentives![0].weight).toBe(3);
    expect(validateRunConfig(config())).not.toHaveProperty("incentives");
  });
});

describe("composable fixture scoring", () => {
  it("exposes raw measurements against independently materialized trajectories", () => {
    const cfg = config({
      seed: "soup",
      soupSize: 5,
      trainingSeeds: [42],
      validationSeeds: [],
    });
    const full = sampleTrajectory(cfg.seedGenome, cfg, 42).simulation;
    const population = full.population;
    const total = population.reduce((a, b) => a + b, 0);
    const mean = total / cfg.steps;
    const expectations: Record<string, number> = {
      initialPopulation: population[0],
      finalPopulation: population.at(-1)!,
      peakPopulation: Math.max(...population),
      totalCells: total,
      meanPopulation: mean,
      populationVariance:
        population.reduce((sum, count) => sum + (count - mean) ** 2, 0) /
        cfg.steps,
      size: cfg.size,
      area: cfg.size ** 2,
      steps: cfg.steps,
      stateCount: cfg.stateCount,
      lifetime: population.filter((count) => count > 0).length,
      extinct: Number(population.at(-1) === 0),
      cutoffContact: Number(population.at(-1)! > 0),
      occupancy: total / (cfg.size ** 2 * cfg.steps),
      persistence: population.filter((count) => count > 0).length / cfg.steps,
    };
    for (const [variable, expected] of Object.entries(expectations)) {
      const result = evaluateGenome(cfg.seedGenome, {
        ...cfg,
        incentives: [incentive(`${variable} / 1000000`)],
      });
      expect(result.fitness, variable).toBeCloseTo(expected / 1000000, 14);
    }
  });
  it("preserves legacy scores while translating each old objective into new-draft incentives", () => {
    for (const objective of [
      "complexity",
      "longevity",
      "growth",
      "finiteSparse",
      "finiteDense",
    ] as const) {
      const cfg = config({ objective });
      for (const genome of [cfg.seedGenome, Array(45).fill(0)]) {
        expect(
          evaluateGenome(genome, {
            ...cfg,
            incentives: incentivesForConfig(cfg),
          }).fitness,
        ).toBeCloseTo(evaluateGenome(genome, cfg).fitness, 14);
      }
    }
  });
  it("finite incentives zero locally; hard boundaries zero the fixture; mean and minimum aggregate afterwards", () => {
    const survivor = Array(45).fill(0);
    survivor[9] = 1;
    const cfg = config({
      objective: "finiteSparse",
      incentives: [presetIncentive("finiteDense"), incentive("persistence", 3)],
    });
    expect(evaluateGenome(survivor, cfg)).toMatchObject({
      fitness: 0.75,
      disqualified: false,
    });
    expect(
      evaluateGenome(survivor, {
        ...cfg,
        boundaryPolicy: { spatial: false, horizon: true },
      }),
    ).toMatchObject({ fitness: 0, disqualified: true });
    const soup = config({
      seed: "soup",
      soupSize: 3,
      trainingSeeds: [1, 2, 3],
      validationSeeds: [4, 5],
      incentives: [
        incentive("initialPopulation / area", 2),
        incentive("extinct"),
      ],
    });
    const result = evaluateGenome(Array(45).fill(0), soup);
    const expected = (seed: number) =>
      ((2 *
        sampleTrajectory(Array(45).fill(0), soup, seed).simulation
          .population[0]) /
        soup.size ** 2 +
        1) /
      3;
    result.trainingScores.forEach((score, index) =>
      expect(score).toBeCloseTo(expected(soup.trainingSeeds[index]), 14),
    );
    expect(result.fitness).toBeCloseTo(
      result.trainingScores.reduce((a, b) => a + b, 0) / 3,
      14,
    );
    expect(result.validationFitness).toBeCloseTo(
      soup.validationSeeds.map(expected).reduce((a, b) => a + b, 0) / 2,
      14,
    );
    expect(
      evaluateGenome(Array(45).fill(0), { ...soup, aggregation: "minimum" })
        .fitness,
    ).toBe(Math.min(...result.trainingScores));
  });
  it("retains formulas, cache, RNG and deterministic next generation through checkpoints", async () => {
    const cfg = config({
      incentives: [
        incentive("if(extinct, 1 - occupancy, persistence / 2)", 3),
        presetIncentive("activity"),
      ],
    });
    const state = await advanceGeneration(await initializePopulation(cfg));
    const restored = validateEngineState(JSON.parse(JSON.stringify(state)));
    expect(restored).toEqual(state);
    expect(await advanceGeneration(restored)).toEqual(
      await advanceGeneration(state),
    );
  });
});
