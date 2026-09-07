import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import { mutate, PRESETS, simulate } from "../simulation";
import { DEFAULT_RUN_CONFIG } from "./config";
import { evaluateGenome } from "./evaluate";
import { expandPreviewLayer } from "./previewLayers";
import { MAX_CA_STEPS, MAX_GRID_SIZE, maxHorizon } from "./limits";
import { MAX_PREVIEW_LAYER_BYTES, sampleTrajectory } from "./sample";

function checkBounds(frame: ReturnType<typeof sampleTrajectory>) {
  expect(frame.layerTimes[0]).toBe(0);
  expect(frame.layerTimes.at(-1)).toBe(frame.totalSteps - 1);
  expect(frame.simulation.layers.length).toBe(frame.totalSteps);
  expect(frame.stride).toBe(1);
  expect(
    frame.simulation.layers.reduce(
      (bytes, layer) => bytes + layer.byteLength,
      0,
    ),
  ).toBeLessThanOrEqual(MAX_PREVIEW_LAYER_BYTES);
  for (let i = 1; i < frame.layerTimes.length - 1; i++)
    assert.equal(frame.layerTimes[i] - frame.layerTimes[i - 1], frame.stride);
}

describe("bounded previews of full-depth scientific trajectories", () => {
  it("matches independent full-history trajectories, including changing bounds and extinction", () => {
    for (const seed of ["point", "cross", "islands", "soup"] as const)
      for (let i = 0; i < 9; i++) {
        const config = {
          ...DEFAULT_RUN_CONFIG,
          size: 17,
          steps: 259,
          seed,
          soupSize: 8,
        };
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
          assert.deepEqual(
            expandPreviewLayer(sampled[index], config.size),
            layers[time],
          ),
        );
        checkBounds(actual);
      }
  }, 15_000);

  it("keeps every dense plane without dropping any cell or timestep", () => {
    const genome = Array<number>(45).fill(1);
    genome[0] = 0;
    const config = { ...DEFAULT_RUN_CONFIG, size: 49, steps: 512 };
    const expected = simulate(genome, config);
    const actual = sampleTrajectory(genome, config, config.randomSeed);
    actual.layerTimes.forEach((time, index) =>
      assert.deepEqual(
        expandPreviewLayer(actual.simulation.layers[index], config.size),
        expected.layers[time],
      ),
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
      assert.deepEqual(
        plane,
        Uint32Array.of((((127 ** 2 - 1) / 2) << 4) | (1 + (time % 4))),
      );
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
    expect(frame.simulation.layers.every((plane) => plane.length === 1)).toBe(
      true,
    );
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

  it("reports an explicit range limit instead of silently skipping timesteps", () => {
    const genome = Array<number>(45).fill(1);
    genome[0] = 0;
    expect(() =>
      sampleTrajectory(
        genome,
        { ...DEFAULT_RUN_CONFIG, size: 425, steps: 512 },
        1729,
      ),
    ).toThrow(/shorter preview range/);
  });
});

it("renders an explicit interior range exactly, including a single slice, with full-horizon metrics", () => {
  const config = { ...DEFAULT_RUN_CONFIG, size: 17, steps: 259 };
  const genome = PRESETS[1].genome;
  const full = simulate(genome, config);
  for (const range of [
    { start: 127, end: 151 },
    { start: 192, end: 192 },
  ]) {
    const frame = sampleTrajectory(genome, config, config.randomSeed, range);
    expect(frame.layerTimes).toEqual(
      Array.from(
        { length: range.end - range.start + 1 },
        (_, i) => range.start + i,
      ),
    );
    frame.simulation.layers.forEach((layer, i) =>
      expect(expandPreviewLayer(layer, config.size)).toEqual(
        full.layers[range.start + i],
      ),
    );
    expect(frame.simulation.population).toEqual(full.population);
    expect(frame.simulation.lifetime).toBe(full.lifetime);
    expect(frame.totalSteps).toBe(config.steps);
    expect(frame.stride).toBe(1);
  }
});
it.each([
  { start: -1, end: 1 },
  { start: 5, end: 4 },
  { start: 0, end: 2048 },
  { start: 0.5, end: 7 },
])("rejects an invalid range %j", (range) => {
  expect(() =>
    sampleTrajectory(PRESETS[0].genome, DEFAULT_RUN_CONFIG, 1729, range),
  ).toThrow(/Preview range/);
});

it("retains all 2,048 dense default-scale planes beyond the instance budget", () => {
  const genome = Array(45).fill(1);
  genome[0] = 0;
  const config = { ...DEFAULT_RUN_CONFIG, seed: "point" as const };
  const frame = sampleTrajectory(genome, config, 1729);
  expect(frame.layerTimes).toEqual(
    Array.from({ length: config.steps }, (_, t) => t),
  );
  expect(frame.simulation.population).toEqual(
    Array.from(
      { length: config.steps },
      (_, t) => Math.min(config.size, 2 * t + 1) ** 2,
    ),
  );
  expect(
    frame.simulation.population.reduce((sum, n) => sum + n, 0),
  ).toBeGreaterThan(2_000_000);
  expect(frame.simulation.layers.at(-1)).toEqual(
    new Uint8Array(config.size ** 2).fill(1),
  );
  checkBounds(frame);
}, 15_000);
