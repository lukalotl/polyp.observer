import { describe, expect, it } from "vitest";
import { DEFAULT_RUN_CONFIG } from "./config";
import { streamTrajectory } from "./trajectory";
import { evaluateGenome } from "./evaluate";
import { presetIncentive } from "./incentives";
import { simulate, mutate, PRESETS, type SeedMode } from "../simulation";
import type { RunConfig } from "./types";

const config = (overrides: Partial<RunConfig> = {}): RunConfig => ({
  ...structuredClone(DEFAULT_RUN_CONFIG),
  size: 9,
  steps: 16,
  seed: "point",
  boundaryPolicy: { spatial: false, horizon: false },
  incentives: [presetIncentive("lightExposure")],
  ...overrides,
});

describe("exposure to light from above in time", () => {
  it("counts one claim per position, independent of stacking, state changes and extinction", () => {
    const dead = Array(45).fill(0);
    const survivor = dead.slice();
    survivor[9] = 1;
    const cycling = dead.slice();
    cycling[9] = 2;
    cycling[18] = 1;
    for (const genome of [dead, survivor, cycling]) {
      const cfg = config();
      expect(streamTrajectory(genome, cfg, 1729).exposedCells).toBe(1);
      expect(evaluateGenome(genome, cfg).fitness).toBe(1 / 81);
    }
    const cross = streamTrajectory(dead, config({ seed: "cross" }), 1729);
    expect(cross.population[0]).toBe(9);
    expect(cross.population.at(-1)).toBe(0);
    expect(cross.exposedCells).toBe(9);
  });
  it("counts the actual footprint including seed and edges, with no empty or repeated claims", () => {
    const spreading = Array(45).fill(1);
    spreading[0] = 0;
    const full = streamTrajectory(spreading, config(), 1729);
    expect(full.exposedCells).toBe(81);
    expect(evaluateGenome(spreading, config()).fitness).toBe(1);
    expect(
      evaluateGenome(
        spreading,
        config({ boundaryPolicy: { spatial: true, horizon: false } }),
      ).fitness,
    ).toBe(0);
    const emptySoup = config({ seed: "soup", soupSize: 1, trainingSeeds: [7] });
    expect(streamTrajectory(Array(45).fill(0), emptySoup, 7).exposedCells).toBe(
      0,
    );
    expect(evaluateGenome(Array(45).fill(0), emptySoup).fitness).toBe(0);
  });
  it("matches an independent reverse-time raycast of materialized histories across seed patterns and rule mutations", () => {
    for (const seed of ["point", "cross", "islands", "soup"] as SeedMode[])
      for (let index = 0; index < 12; index++) {
        const cfg = config({
          seed,
          soupSize: 6,
          size: index % 2 ? 17 : 9,
          steps: index % 3 ? 24 : 64,
          trainingSeeds: [index - 4],
        });
        const genome =
          index < 3
            ? PRESETS[index].genome
            : mutate(PRESETS[index % 3].genome, (index % 5) / 4, index * 997);
        const full = simulate(genome, { ...cfg, randomSeed: index - 4 });
        let exposed = 0;
        // Each ray awards its point to the last occupied cell and then stops.
        for (let cell = 0; cell < cfg.size ** 2; cell++)
          for (let time = cfg.steps - 1; time >= 0; time--)
            if (full.layers[time][cell]) {
              exposed++;
              break;
            }
        const streamed = streamTrajectory(genome, cfg, index - 4);
        expect(streamed.exposedCells).toBe(exposed);
        expect(streamed.exposedCells).toBeGreaterThanOrEqual(
          Math.max(...full.population),
        );
        expect(streamed.exposedCells).toBeLessThanOrEqual(cfg.size ** 2);
        expect(evaluateGenome(genome, cfg).fitness).toBe(
          exposed / cfg.size ** 2,
        );
      }
  });
  it("aggregates exposure per fixture, keeping held-out claims separate", () => {
    const cfg = config({
      seed: "soup",
      soupSize: 6,
      trainingSeeds: [1, 2, 3],
      validationSeeds: [4, 5],
    });
    const genome = Array(45).fill(0);
    const scores = [...cfg.trainingSeeds, ...cfg.validationSeeds].map(
      (seed) =>
        simulate(genome, { ...cfg, randomSeed: seed }).population[0] /
        cfg.size ** 2,
    );
    const result = evaluateGenome(genome, cfg);
    expect(result.trainingScores).toEqual(scores.slice(0, 3));
    expect(result.validationScores).toEqual(scores.slice(3));
    expect(result.fitness).toBe((scores[0] + scores[1] + scores[2]) / 3);
    expect(result.validationFitness).toBe((scores[3] + scores[4]) / 2);
    expect(
      evaluateGenome(genome, { ...cfg, aggregation: "minimum" }).fitness,
    ).toBe(Math.min(...scores.slice(0, 3)));
  });
});
