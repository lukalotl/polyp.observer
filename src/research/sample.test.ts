import { describe, expect, it } from "vitest";
import { mutate, PRESETS, simulate } from "../simulation";
import { DEFAULT_RUN_CONFIG } from "./config";
import { evaluateGenome } from "./evaluate";
import { MAX_CA_STEPS, MAX_GRID_SIZE, maxHorizon } from "./limits";
import {
  MAX_PREVIEW_LAYER_BYTES,
  MAX_PREVIEW_VOXELS,
  sampleTrajectory,
} from "./sample";

function checkBounds(frame: ReturnType<typeof sampleTrajectory>) {
  expect(frame.layerTimes[0]).toBe(0);
  expect(frame.layerTimes.at(-1)).toBe(frame.totalSteps - 1);
  expect(frame.simulation.layers.length).toBeLessThanOrEqual(128);
  expect(
    frame.simulation.layers.reduce(
      (bytes, layer) => bytes + layer.byteLength,
      0,
    ),
  ).toBeLessThanOrEqual(MAX_PREVIEW_LAYER_BYTES);
  expect(
    frame.layerTimes.reduce(
      (voxels, time) => voxels + frame.simulation.population[time],
      0,
    ),
  ).toBeLessThanOrEqual(MAX_PREVIEW_VOXELS);
  for (let i = 1; i < frame.layerTimes.length - 1; i++)
    expect(frame.layerTimes[i] - frame.layerTimes[i - 1]).toBe(frame.stride);
}

describe("bounded previews of full-depth scientific trajectories", () => {
  it("matches independent full-history trajectories, including changing bounds and extinction", () => {
    for (const seed of ["point", "cross", "islands"] as const)
      for (let i = 0; i < 9; i++) {
        const config = { ...DEFAULT_RUN_CONFIG, size: 17, steps: 259, seed };
        const genome =
          i < 3
            ? PRESETS[i].genome
            : mutate(PRESETS[i % 3].genome, i / 10, i * 37);
        const expected = simulate(genome, { ...config, randomSeed: -91 });
        const actual = sampleTrajectory(genome, config, -91);
        const { layers, ...summary } = expected;
        const { layers: sampled, ...metrics } = actual.simulation;
        expect(metrics).toEqual(summary);
        actual.layerTimes.forEach((time, index) =>
          expect(sampled[index]).toEqual(layers[time]),
        );
        checkBounds(actual);
      }
  });

  it("decimates dense trajectories without dropping cells from retained planes", () => {
    const genome = Array<number>(45).fill(1);
    genome[0] = 0;
    const config = { ...DEFAULT_RUN_CONFIG, size: 49, steps: 2048 };
    const expected = simulate(genome, config);
    const actual = sampleTrajectory(genome, config, config.randomSeed);
    actual.layerTimes.forEach((time, index) =>
      expect(actual.simulation.layers[index]).toEqual(expected.layers[time]),
    );
    expect(actual.simulation.population).toEqual(expected.population);
    checkBounds(actual);
  });

  it("scores and previews 65,536 real timesteps with a closed-form four-state oscillator", () => {
    const genome = Array<number>(45).fill(0);
    genome[9] = 2;
    genome[18] = 3;
    genome[27] = 4;
    genome[36] = 1;
    const config = {
      ...DEFAULT_RUN_CONFIG,
      size: 127,
      steps: MAX_CA_STEPS,
      seed: "point" as const,
    };
    const result = evaluateGenome(genome, config);
    expect(result.metrics).toMatchObject({
      lifetime: 65_536,
      persistence: 1,
      diversity: 1,
      extinctFraction: 0,
      occupancy: 1 / 127 ** 2,
    });
    const frame = sampleTrajectory(genome, config, 1729);
    expect(frame.simulation.population).toHaveLength(65_536);
    expect(frame.simulation.population.every((value) => value === 1)).toBe(
      true,
    );
    frame.layerTimes.forEach((time, index) => {
      const plane = frame.simulation.layers[index];
      expect(plane[(127 ** 2 - 1) / 2]).toBe(1 + (time % 4));
      expect(
        plane.reduce((count, value) => count + Number(value !== 0), 0),
      ).toBe(1);
    });
    checkBounds(frame);
  });

  it("bounds retained plane memory at the maximum grid, even when occupancy is sparse", () => {
    const genome = Array<number>(45).fill(0);
    genome[9] = 1;
    const config = {
      ...DEFAULT_RUN_CONFIG,
      size: MAX_GRID_SIZE,
      steps: maxHorizon(MAX_GRID_SIZE),
      seed: "point" as const,
    };
    const frame = sampleTrajectory(genome, config, 1729);
    expect(frame.simulation.lifetime).toBe(config.steps);
    expect(
      frame.simulation.layers.every((plane) => plane.length === 1025 ** 2),
    ).toBe(true);
    checkBounds(frame);
  });

  it("keeps the final empty plane and full population series after immediate extinction", () => {
    const frame = sampleTrajectory(
      Array(45).fill(0),
      { ...DEFAULT_RUN_CONFIG, size: 127, steps: MAX_CA_STEPS },
      1729,
    );
    expect(frame.simulation.lifetime).toBe(1);
    expect(frame.simulation.extinct).toBe(true);
    expect(frame.simulation.population[0]).toBe(9);
    expect(
      frame.simulation.population.slice(1).every((value) => value === 0),
    ).toBe(true);
    expect(frame.simulation.layers.at(-1)!.every((value) => value === 0)).toBe(
      true,
    );
    checkBounds(frame);
  });

  it("reports a complete-plane rendering limit instead of silently cropping a large dense field", () => {
    const genome = Array<number>(45).fill(1);
    genome[0] = 0;
    expect(() =>
      sampleTrajectory(
        genome,
        { ...DEFAULT_RUN_CONFIG, size: 425, steps: 220 },
        1729,
      ),
    ).toThrow(/complete first\/last spatial layers/);
  });
});
