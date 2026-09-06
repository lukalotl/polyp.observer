import { describe, expect, it } from "vitest";
import {
  fitness,
  mutate,
  PRESETS,
  simulate,
  type Genome,
  type Objective,
  type SeedMode,
} from "../simulation";
import { DEFAULT_RUN_CONFIG } from "./config";
import { evaluateBatch, evaluateGenome } from "./evaluate";
import type { FitnessMetrics, RunConfig } from "./types";

const config = (updates: Partial<RunConfig> = {}): RunConfig => ({
  ...structuredClone(DEFAULT_RUN_CONFIG),
  size: 17,
  steps: 24,
  objective: "complexity",
  boundaryPolicy: { spatial: false, horizon: false },
  ...updates,
});
const clamp = (n: number) => Math.max(0, Math.min(1, n));
function referenceMetrics(
  genome: Genome,
  cfg: RunConfig,
  seed: number,
): FitnessMetrics {
  const sim = simulate(genome, { ...cfg, randomSeed: seed });
  const mean = sim.occupancy * cfg.size ** 2;
  const variance =
    sim.population.reduce((sum, count) => sum + (count - mean) ** 2, 0) /
    cfg.steps;
  return {
    diversity: sim.diversity,
    activity: clamp(sim.activity / Math.max(sim.occupancy, 0.01)),
    density:
      clamp(sim.occupancy / 0.1) *
      clamp(1 - Math.max(0, sim.occupancy - 0.25) / 0.55),
    variation: clamp(Math.sqrt(variance) / Math.max(1, mean)),
    persistence: sim.lifetime / cfg.steps,
    occupancy: sim.occupancy,
    lifetime: sim.lifetime,
    extinctFraction: Number(sim.extinct),
  };
}

describe("streaming scalar evaluator versus frozen space-time golden engine", () => {
  it("defaults to longer observed finite lives and gives censored survivors zero", () => {
    const cfg = { ...DEFAULT_RUN_CONFIG, seed: "point" as const };
    const short = Array<number>(45).fill(0);
    const longer = short.slice();
    longer[9] = 2;
    longer[18] = 3;
    longer[27] = 4;
    const survivor = short.slice();
    survivor[9] = 1;
    expect(evaluateGenome(short, cfg).fitness).toBe(1 / 2047);
    expect(evaluateGenome(longer, cfg).fitness).toBe(4 / 2047);
    expect(evaluateGenome(survivor, cfg).fitness).toBe(0);
  });
  it.each<Objective>(["complexity", "longevity", "growth"])(
    "matches randomized fixtures, all seed forms and boundary-reaching trajectories for %s within 1e-10",
    (objective) => {
      for (const seed of ["point", "cross", "islands"] as SeedMode[])
        for (const size of [9, 17, 31])
          for (let i = 0; i < 16; i++) {
            const genome =
              i < 3
                ? PRESETS[i].genome
                : mutate(PRESETS[i % 3].genome, (i % 5) / 4, i * 997);
            const cfg = config({
              objective,
              seed,
              size,
              steps: i % 3 === 0 ? 64 : 8 + i,
              trainingSeeds: [i - 8],
            });
            const actual = evaluateGenome(genome, cfg);
            const expected = fitness(
              simulate(genome, { ...cfg, randomSeed: cfg.trainingSeeds[0] }),
              objective,
            );
            expect(Math.abs(actual.fitness - expected)).toBeLessThanOrEqual(
              1e-10,
            );
            const metrics = referenceMetrics(genome, cfg, cfg.trainingSeeds[0]);
            for (const key of Object.keys(metrics) as (keyof FitnessMetrics)[])
              expect(
                Math.abs(actual.metrics[key] - metrics[key]),
              ).toBeLessThanOrEqual(1e-10);
          }
    },
  );
  it("matches the original full-history fixtures for all presets and all three objective semantics", () => {
    for (const preset of PRESETS)
      for (const objective of [
        "complexity",
        "growth",
        "longevity",
      ] as Objective[]) {
        const cfg = config({
          ...DEFAULT_RUN_CONFIG,
          boundaryPolicy: { spatial: false, horizon: false },
          size: 49,
          steps: 96,
          seed: preset.seed,
          objective,
        });
        expect(evaluateGenome(preset.genome, cfg).fitness).toBeCloseTo(
          fitness(simulate(preset.genome, cfg), objective),
          12,
        );
      }
  });
  it("pads early extinction mathematically exactly and distinguishes censored finite longevity", () => {
    const dead = Array(45).fill(0),
      cycle = dead.slice(),
      persistent = dead.slice();
    cycle[9] = 2;
    cycle[18] = 3;
    cycle[27] = 4;
    persistent[9] = 1;
    const cfg = config({
      size: 9,
      steps: 1024,
      seed: "point",
      objective: "longevity",
    });
    expect(evaluateGenome(dead, cfg).fitness).toBe(1 / 1023);
    expect(evaluateGenome(cycle, cfg).fitness).toBe(4 / 1023);
    expect(evaluateGenome(persistent, cfg).fitness).toBe(0);
    for (const genome of [dead, cycle, persistent]) {
      const actual = evaluateGenome(genome, cfg);
      expect(actual.metrics).toEqual(referenceMetrics(genome, cfg, 1729));
    }
  });
  it("handles expanding/contracting bounding boxes without stale-buffer resurrection", () => {
    for (let i = 0; i < 40; i++) {
      const genome = mutate(PRESETS[1].genome, 0.15, i);
      const cfg = config({
        size: 41,
        steps: 96,
        seed: "islands",
        trainingSeeds: [i],
      });
      expect(evaluateGenome(genome, cfg).fitness).toBeCloseTo(
        fitness(simulate(genome, { ...cfg, randomSeed: i }), "complexity"),
        12,
      );
    }
  });
  it("aggregates train metrics by mean, scores by mean/min, and never mixes held-out fixtures", () => {
    const genome = PRESETS[2].genome,
      cfg = config({
        seed: "islands",
        trainingSeeds: [1, 2, 3],
        validationSeeds: [101, 102],
      });
    const scores = [...cfg.trainingSeeds, ...cfg.validationSeeds].map((seed) =>
      evaluateGenome(genome, {
        ...cfg,
        trainingSeeds: [seed],
        validationSeeds: [],
      }),
    );
    for (const aggregation of ["mean", "minimum"] as const) {
      const actual = evaluateGenome(genome, { ...cfg, aggregation });
      expect(actual.trainingScores).toEqual(
        scores.slice(0, 3).map((result) => result.fitness),
      );
      expect(actual.validationScores).toEqual(
        scores.slice(3).map((result) => result.fitness),
      );
      expect(actual.fitness).toBe(
        aggregation === "mean"
          ? actual.trainingScores.reduce((a, b) => a + b, 0) / 3
          : Math.min(...actual.trainingScores),
      );
      expect(actual.validationFitness).toBe(
        aggregation === "mean"
          ? actual.validationScores.reduce((a, b) => a + b, 0) / 2
          : Math.min(...actual.validationScores),
      );
      for (const key of Object.keys(actual.metrics) as (keyof FitnessMetrics)[])
        expect(actual.metrics[key]).toBe(
          scores
            .slice(0, 3)
            .reduce((sum, result) => sum + result.metrics[key], 0) / 3,
        );
    }
    expect(
      evaluateGenome(genome, { ...cfg, validationSeeds: [999] }).fitness,
    ).toBe(evaluateGenome(genome, cfg).fitness);
  });
  it("normalizes complexity weights, preserving other objectives and default semantics", () => {
    const genome = PRESETS[0].genome,
      cfg = config();
    const actual = evaluateGenome(genome, {
      ...cfg,
      weights: { diversity: 10, activity: 0, density: 0, variation: 0 },
    });
    expect(actual.fitness).toBeCloseTo(
      actual.metrics.persistence * actual.metrics.diversity,
      14,
    );
    expect(
      evaluateGenome(genome, {
        ...cfg,
        weights: {
          diversity: Number.MIN_VALUE,
          activity: 0,
          density: 0,
          variation: 0,
        },
      }).fitness,
    ).toBe(actual.fitness);
    for (const objective of ["growth", "longevity"] as const) {
      expect(
        evaluateGenome(genome, {
          ...cfg,
          objective,
          weights: { diversity: 0, activity: 0, density: 0, variation: 10 },
        }),
      ).toEqual(evaluateGenome(genome, { ...cfg, objective }));
    }
    const scaled = Object.fromEntries(
      Object.entries(cfg.weights).map(([key, value]) => [key, 7 * value]),
    ) as unknown as RunConfig["weights"];
    expect(
      evaluateGenome(genome, { ...cfg, weights: scaled }).fitness,
    ).toBeCloseTo(evaluateGenome(genome, cfg).fitness, 14);
  });
  it("batches in input order, validates bounds, and leaves caller objects untouched", async () => {
    const cfg = config(),
      genomes = PRESETS.map((preset) => preset.genome.slice()),
      before = JSON.stringify({ cfg, genomes });
    expect(await evaluateBatch(genomes, cfg)).toEqual(
      genomes.map((genome) => evaluateGenome(genome, cfg)),
    );
    expect(JSON.stringify({ cfg, genomes })).toBe(before);
    expect(evaluateGenome(genomes[0], cfg).validationFitness).toBeNull();
    expect(() => evaluateGenome(Array(45).fill(5), cfg)).toThrow(RangeError);
    await expect(
      evaluateBatch(Array(513).fill(genomes[0]), cfg),
    ).rejects.toThrow(RangeError);
  });
});
