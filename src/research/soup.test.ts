import { describe, expect, it } from "vitest";
import { DEFAULT_RUN_CONFIG, validateRunConfig } from "./config";
import { evaluateGenome } from "./evaluate";
import { streamTrajectory } from "./trajectory";
import { sampleTrajectory } from "./sample";
import { expandPreviewLayer } from "./previewLayers";
import {
  initializePopulation,
  advanceGeneration,
  validateEngineState,
} from "./engine";
import type { RunConfig } from "./types";

const config = (update: Partial<RunConfig> = {}): RunConfig => ({
  ...structuredClone(DEFAULT_RUN_CONFIG),
  size: 17,
  steps: 8,
  seed: "soup",
  soupSize: 6,
  objective: "finiteDense",
  populationSize: 8,
  eliteCount: 2,
  trainingSeeds: [1729, 1730, 1731, 1732],
  validationSeeds: [2718, 2719],
  ...update,
});

describe("random soup fixtures", () => {
  it.each([2, 5, 16])(
    "places a centered N×N square with all %i states, deterministically",
    (stateCount) => {
      const cfg = config({
        stateCount,
        soupSize: 12,
        seedGenome: Array(stateCount * 9).fill(0),
      });
      const genome = Array(stateCount * 9).fill(0);
      const first = sampleTrajectory(genome, cfg, 1729);
      const plane = expandPreviewLayer(first.simulation.layers[0], cfg.size);
      const start = Math.floor((cfg.size - cfg.soupSize!) / 2);
      const states = new Set<number>();
      for (let z = 0; z < cfg.size; z++)
        for (let x = 0; x < cfg.size; x++) {
          if (
            x < start ||
            z < start ||
            x >= start + cfg.soupSize! ||
            z >= start + cfg.soupSize!
          )
            expect(plane[z * cfg.size + x]).toBe(0);
          else states.add(plane[z * cfg.size + x]);
        }
      expect([...states].sort((a, b) => a - b)).toEqual(
        Array.from({ length: stateCount }, (_, i) => i),
      );
      expect(sampleTrajectory(genome, cfg, 1729)).toEqual(first);
      expect(
        sampleTrajectory(genome, cfg, 1730).simulation.layers[0],
      ).not.toEqual(first.simulation.layers[0]);
    },
  );
  it.each([undefined, 0, -1, 18, 2.5, "6", NaN])(
    "rejects invalid or missing soup size %s",
    (soupSize) => {
      expect(() => validateRunConfig({ ...config(), soupSize })).toThrow(
        /Soup size/,
      );
    },
  );
  it("keeps old configurations byte-for-byte and requires explicit soup dimensions", () => {
    expect(validateRunConfig(DEFAULT_RUN_CONFIG)).toEqual(DEFAULT_RUN_CONFIG);
    const { soupSize: _, ...missing } = config();
    expect(() => validateRunConfig(missing)).toThrow(/Soup size/);
    expect(validateRunConfig(config({ soupSize: 17 })).soupSize).toBe(17);
  });
  it("scores fewer/more occupied cells across the full horizon, requiring observed extinction", () => {
    const cfg = config({
      seed: "point",
      trainingSeeds: [1],
      validationSeeds: [],
      boundaryPolicy: { spatial: false, horizon: false },
    });
    const dead = Array(45).fill(0),
      longer = dead.slice(),
      survivor = dead.slice();
    longer[9] = 2;
    longer[18] = 3;
    longer[27] = 4;
    survivor[9] = 1;
    for (const objective of ["finiteSparse", "finiteDense"] as const) {
      const first = evaluateGenome(dead, { ...cfg, objective });
      const second = evaluateGenome(longer, { ...cfg, objective });
      const occupied = 1 / (cfg.size ** 2 * cfg.steps);
      expect(first.fitness).toBeCloseTo(
        objective === "finiteSparse" ? 1 - occupied : occupied,
        14,
      );
      expect(second.fitness).toBeCloseTo(
        objective === "finiteSparse" ? 1 - 4 * occupied : 4 * occupied,
        14,
      );
      expect(evaluateGenome(survivor, { ...cfg, objective })).toMatchObject({
        fitness: 0,
        disqualified: true,
      });
    }
  });
  it("evaluates each soup and held-out set separately using mean or worst-case aggregation", () => {
    const genome = Array(45).fill(0);
    for (const objective of ["finiteSparse", "finiteDense"] as const)
      for (const aggregation of ["mean", "minimum"] as const) {
        const cfg = config({ objective, aggregation });
        const scores = [...cfg.trainingSeeds, ...cfg.validationSeeds].map(
          (seed) => {
            const sim = streamTrajectory(genome, cfg, seed);
            return objective === "finiteSparse"
              ? 1 - sim.occupancy
              : sim.occupancy;
          },
        );
        const aggregate = (values: number[]) =>
          aggregation === "mean"
            ? values.reduce((a, b) => a + b, 0) / values.length
            : Math.min(...values);
        const result = evaluateGenome(genome, cfg);
        expect(result.trainingScores).toEqual(scores.slice(0, 4));
        expect(result.validationScores).toEqual(scores.slice(4));
        expect(result.fitness).toBe(aggregate(scores.slice(0, 4)));
        expect(result.validationFitness).toBe(aggregate(scores.slice(4)));
      }
  });
  it("gives failed soups zero and rewards partial success with mean aggregation", () => {
    // In a one-cell binary soup these two fixtures are occupied and empty respectively.
    const cfg = config({
      stateCount: 2,
      seedGenome: Array(18).fill(0),
      soupSize: 1,
      trainingSeeds: [1, 7],
      validationSeeds: [],
      boundaryPolicy: { spatial: false, horizon: false },
    });
    expect(streamTrajectory(cfg.seedGenome, cfg, 1).population[0]).toBe(1);
    expect(streamTrajectory(cfg.seedGenome, cfg, 7).population[0]).toBe(0);
    for (const objective of ["finiteSparse", "finiteDense"] as const) {
      const partial = evaluateGenome(cfg.seedGenome, { ...cfg, objective });
      expect(partial.disqualified).toBe(true);
      expect(partial.fitness).toBe(partial.trainingScores[0] / 2);
      expect(partial.fitness).toBeGreaterThan(0);
      expect(partial.fixturePasses?.training).toEqual([true, false]);
      expect(
        evaluateGenome(cfg.seedGenome, {
          ...cfg,
          objective,
          aggregation: "minimum",
        }).fitness,
      ).toBe(0);
      const survivor = cfg.seedGenome.slice();
      survivor[9] = 1;
      expect(evaluateGenome(survivor, { ...cfg, objective })).toMatchObject({
        fitness: 0,
        disqualified: true,
      });
    }
  });
  it("resumes soup evolution with identical fixtures, cached scores and RNG state", async () => {
    const engine = await initializePopulation(config());
    const checkpoint = validateEngineState(JSON.parse(JSON.stringify(engine)));
    expect(checkpoint.config.soupSize).toBe(6);
    expect(await advanceGeneration(checkpoint)).toEqual(
      await advanceGeneration(engine),
    );
  });
});
