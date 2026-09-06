import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUN_CONFIG,
  validateGenome,
  validateRunConfig,
} from "./config";
import { evaluateGenome } from "./evaluate";
import { sampleTrajectory } from "./sample";
import {
  advanceGeneration,
  generationSnapshot,
  initializePopulation,
  validateEngineState,
} from "./engine";
import { founderPresets, genomeKey, resizeGenome } from "./genome";
import { LEGACY_MODEL_VERSION, MODEL_VERSION, type RunConfig } from "./types";
import { PRESETS } from "../simulation";

const configFor = (
  stateCount: number,
  patch: Partial<RunConfig> = {},
): RunConfig => ({
  ...DEFAULT_RUN_CONFIG,
  stateCount,
  seedGenome: resizeGenome(DEFAULT_RUN_CONFIG.seedGenome, stateCount),
  size: 9,
  steps: 32,
  populationSize: 8,
  eliteCount: 2,
  tournamentSize: 2,
  evaluationWorkers: 1,
  cacheSize: 64,
  ...patch,
});

describe("configurable state alphabets", () => {
  it.each(Array.from({ length: 15 }, (_, i) => i + 2))(
    "accepts %i states with exactly nine transitions per state",
    (count) => {
      const config = configFor(count);
      expect(validateRunConfig(config)).toEqual(config);
      expect(validateGenome(config.seedGenome, count)).toHaveLength(count * 9);
      expect(() =>
        validateRunConfig({
          ...config,
          seedGenome: config.seedGenome.slice(1),
        }),
      ).toThrow(/genes/);
      const invalid = config.seedGenome.slice();
      invalid[1] = count;
      expect(() => validateGenome(invalid, count)).toThrow(/Gene 1/);
      invalid[0] = 1;
      invalid[1] = 0;
      expect(() => validateGenome(invalid, count)).toThrow(/quiescent/);
    },
  );
  it.each([1, 17, 2.5, NaN, Infinity, undefined])(
    "rejects invalid or unspecified state counts: %s",
    (stateCount) => {
      expect(() =>
        validateRunConfig({ ...DEFAULT_RUN_CONFIG, stateCount }),
      ).toThrow(/State count/);
    },
  );
  it("resizes founders predictably and preserves the five-state presets", () => {
    expect(founderPresets(5)).toEqual(PRESETS);
    const genome = Array.from({ length: 45 }, (_, i) => i % 5);
    expect(resizeGenome(genome, 2)).toEqual(
      genome.slice(0, 18).map((output) => (output < 2 ? output : 1)),
    );
    expect(resizeGenome(genome, 16).slice(0, 45)).toEqual(genome);
    expect(resizeGenome(genome, 16).slice(135)).toEqual(genome.slice(9, 18));
  });
  it("provides binary Life and HighLife with their exact birth/survival sets", () => {
    for (const preset of founderPresets(2)) {
      const births = preset.genome
        .slice(0, 9)
        .flatMap((output, n) => (output ? [n] : []));
      const survival = preset.genome
        .slice(9)
        .flatMap((output, n) => (output ? [n] : []));
      expect(births).toEqual(preset.id === "life" ? [3] : [3, 6]);
      expect(survival).toEqual([2, 3]);
    }
  });
  it("keeps decimal concatenation collisions distinct, including states above nine", () => {
    const a = Array(144).fill(0),
      b = a.slice();
    a[1] = 1;
    a[2] = 11;
    b[1] = 11;
    b[2] = 1;
    expect(a.join("")).toBe(b.join(""));
    expect(genomeKey(a)).not.toBe(genomeKey(b));
    expect(genomeKey(a)).toHaveLength(144);
    expect(genomeKey(PRESETS[0].genome)).toBe(PRESETS[0].genome.join(""));
  });
});

// Independent full-plane reference: no halo, bounding box, shared seed builder,
// early-out or streaming implementation. Point/cross fixtures are deterministic.
function reference(genome: number[], cfg: RunConfig) {
  const layers: Uint8Array[] = [new Uint8Array(cfg.size ** 2)];
  const center = Math.floor(cfg.size / 2);
  const place = (x: number, y: number) => {
    layers[0][y * cfg.size + x] = 1;
  };
  place(center, center);
  if (cfg.seed === "cross")
    for (let d = 1; d <= 2; d++) {
      place(center + d, center);
      place(center - d, center);
      place(center, center + d);
      place(center, center - d);
    }
  for (let time = 1; time < cfg.steps; time++) {
    const prev = layers[time - 1],
      next = new Uint8Array(prev.length);
    for (let y = 0; y < cfg.size; y++)
      for (let x = 0; x < cfg.size; x++) {
        let neighbors = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            if (
              (!dx && !dy) ||
              x + dx < 0 ||
              x + dx >= cfg.size ||
              y + dy < 0 ||
              y + dy >= cfg.size
            )
              continue;
            neighbors += Number(prev[(y + dy) * cfg.size + x + dx] !== 0);
          }
        next[y * cfg.size + x] = genome[prev[y * cfg.size + x] * 9 + neighbors];
      }
    layers.push(next);
  }
  return layers;
}
describe("state-independent scientific stepping and scoring", () => {
  it.each([2, 3, 10, 16])(
    "matches an independent full-plane oracle for %i states, including zero boundaries",
    (count) => {
      for (const seed of ["point", "cross"] as const)
        for (let variant = 1; variant <= 3; variant++) {
          const cfg = configFor(count, { seed, objective: "complexity" });
          const genome = Array.from({ length: count * 9 }, (_, locus) =>
            locus ? (locus * variant + Math.floor(locus / 7)) % count : 0,
          );
          const expected = reference(genome, cfg),
            actual = sampleTrajectory(genome, cfg, 123);
          const population = expected.map((layer) =>
            layer.reduce((sum, s) => sum + Number(s !== 0), 0),
          );
          expect(actual.simulation.layers).toEqual(expected);
          expect(actual.simulation.population).toEqual(population);
          expect(actual.simulation.lifetime).toBe(
            population.filter(Boolean).length,
          );
          let changed = 0;
          for (let t = 1; t < expected.length; t++)
            for (let i = 0; i < expected[t].length; i++)
              changed += Number(expected[t][i] !== expected[t - 1][i]);
          expect(actual.simulation.activity).toBe(
            changed / (cfg.size ** 2 * (cfg.steps - 1)),
          );
          const frequencies = Array(count).fill(0);
          for (const layer of expected)
            for (const value of layer) if (value) frequencies[value]++;
          const occupied = population.reduce((a, b) => a + b, 0);
          const entropy =
            count === 2
              ? 0
              : frequencies.reduce(
                  (h, n) =>
                    n
                      ? h -
                        ((n / occupied) * Math.log(n / occupied)) /
                          Math.log(count - 1)
                      : h,
                  0,
                );
          expect(actual.simulation.diversity).toBeCloseTo(entropy, 14);
          expect(Number.isFinite(evaluateGenome(genome, cfg).fitness)).toBe(
            true,
          );
        }
    },
  );
  it.each([2, 16])(
    "scores a known finite lifetime and preserves every state in the %i-state preview",
    (count) => {
      const genome = Array(count * 9).fill(0);
      for (let state = 1; state < count - 1; state++)
        genome[state * 9] = state + 1;
      const cfg = configFor(count, { seed: "point" });
      const frame = sampleTrajectory(genome, cfg, 1729);
      expect(frame.simulation.population).toEqual(
        Array.from({ length: 32 }, (_, time) => Number(time < count - 1)),
      );
      expect(
        frame.simulation.layers.slice(0, count - 1).map((layer) => layer[40]),
      ).toEqual(Array.from({ length: count - 1 }, (_, i) => i + 1));
      const evaluated = evaluateGenome(genome, cfg);
      expect(evaluated.fitness).toBe((count - 1) / 31);
      expect(evaluated.metrics.diversity).toBeCloseTo(count === 2 ? 0 : 1, 14);
      genome[(count - 1) * 9] = 1; // An immortal point cycle must score zero finite longevity.
      expect(evaluateGenome(genome, cfg).fitness).toBe(0);
    },
  );
  it.each([2, 3, 16])(
    "islands seed only legal occupied states for %i states, reproducibly",
    (count) => {
      const cfg = configFor(count, { seed: "islands" });
      const a = sampleTrajectory(cfg.seedGenome, cfg, -91),
        b = sampleTrajectory(cfg.seedGenome, cfg, -91);
      expect(a).toEqual(b);
      for (const layer of a.simulation.layers)
        expect(layer.every((state) => state < count)).toBe(true);
      expect(a.simulation.layers[0].some((state) => state > 0)).toBe(true);
    },
  );
});

describe("state-count genetics and migration", () => {
  it.each([2, 16])(
    "retains valid mutation/crossover ancestry and resumes %i-state populations deterministically",
    async (count) => {
      for (const crossover of ["uniform", "onePoint", "none"] as const) {
        const cfg = configFor(count, {
          initialization: "random",
          crossover,
          crossoverRate: 1,
          mutationRate: 1,
          immigrantRate: 0.25,
        });
        const first = await initializePopulation(cfg),
          next = await advanceGeneration(first);
        expect(validateEngineState(next)).toEqual(next);
        expect(
          await advanceGeneration(JSON.parse(JSON.stringify(next))),
        ).toEqual(await advanceGeneration(next));
        for (const item of next.population) {
          expect(item.genome).toHaveLength(count * 9);
          expect(
            item.genome.every((state) => state >= 0 && state < count),
          ).toBe(true);
          expect(item.genome[0]).toBe(0);
          if (item.birthGeneration === 1 && item.parents.length) {
            expect(item.mutatedLoci).toHaveLength(count * 9 - 1);
            for (let locus = 1; locus < item.genome.length; locus++)
              expect(item.genome[locus]).not.toBe(
                item.parents[item.crossoverMask[locus]].genome[locus],
              );
          }
        }
        expect(
          next.population.some((item) => item.origin === "immigrant"),
        ).toBe(true);
        if (count === 16)
          expect(next.cache.some((entry) => /[a-f]/.test(entry.key))).toBe(
            true,
          );
        const metrics = generationSnapshot(next).metrics;
        expect(metrics.uniqueGenomes).toBe(
          new Set(next.population.map((item) => genomeKey(item.genome))).size,
        );
        expect(metrics.diversity).toBeGreaterThan(0);
        expect(metrics.diversity).toBeLessThanOrEqual(1);
      }
    },
  );
  it("migrates only explicitly versioned five-state data without changing RNG, cache, metrics or continuation", async () => {
    const original = await advanceGeneration(
      await initializePopulation(configFor(5)),
    );
    const legacy: any = structuredClone(original);
    legacy.modelVersion = LEGACY_MODEL_VERSION;
    delete legacy.config.stateCount;
    const migrated = validateEngineState(legacy);
    expect(migrated).toEqual(original);
    expect(await advanceGeneration(migrated)).toEqual(
      await advanceGeneration(original),
    );
    expect(legacy.config.stateCount).toBeUndefined();
    expect(() =>
      validateEngineState({ ...legacy, modelVersion: MODEL_VERSION }),
    ).toThrow();
    expect(() =>
      validateEngineState({
        ...legacy,
        config: { ...legacy.config, stateCount: 2 },
      }),
    ).toThrow(/Legacy configuration/);
  });
});
