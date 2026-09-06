import { describe, expect, it } from "vitest";
import { evolve, fitness, genomeId, mutate, PRESETS, simulate } from "./index";
import type { Config, Genome, Objective } from "./index";
import { tournamentSelect, uniformCrossover } from "./genetics";

const config: Config = { size: 17, steps: 20, seed: "cross", randomSeed: 42 };
const blank = (): Genome => Array(45).fill(0);

/** Deliberately slow, independent reference: explicit boundary checks, no halo. */
function referenceStep(
  current: Uint8Array,
  size: number,
  genome: Genome,
): Uint8Array {
  const result = new Uint8Array(size * size);
  for (let z = 0; z < size; z++) {
    for (let x = 0; x < size; x++) {
      let neighbors = 0;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dz === 0) continue;
          const nx = x + dx;
          const nz = z + dz;
          if (
            nx >= 0 &&
            nx < size &&
            nz >= 0 &&
            nz < size &&
            current[nz * size + nx] > 0
          )
            neighbors++;
        }
      }
      result[z * size + x] = genome[current[z * size + x] * 9 + neighbors];
    }
  }
  return result;
}

describe("outer-totalistic five-state simulation", () => {
  it("records exactly steps layers, with an exact one-cell point at t=0", () => {
    const result = simulate(PRESETS[0].genome, {
      ...config,
      size: 5,
      steps: 1,
      seed: "point",
    });
    expect(result.layers).toHaveLength(1);
    expect(result.layers[0]).toBeInstanceOf(Uint8Array);
    expect(Array.from(result.layers[0])).toEqual(
      Array.from({ length: 25 }, (_, index) => (index === 12 ? 1 : 0)),
    );
    expect(result.population).toEqual([1]);
    expect(result.activity).toBe(0);
    expect(result.lifetime).toBe(1);
    expect(result.extinct).toBe(false);
  });

  it("uses a nine-cell cruciform seed rather than a filled square", () => {
    const result = simulate(PRESETS[0].genome, {
      ...config,
      size: 5,
      steps: 1,
    });
    expect(Array.from(result.layers[0])).toEqual([
      0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 1, 1, 1, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0,
    ]);
  });

  it("counts occupied Moore neighbors, indexes currentState * 9 + count, and does not wrap", () => {
    const genome = blank();
    genome[1] = 1; // Empty cells with exactly one occupied neighbor are born.
    genome[9] = 1; // The isolated initial cell stays alive.
    genome[9 + 3] = 2;
    genome[9 + 5] = 3;
    genome[9 + 8] = 4;
    genome[18 + 3] = 4;
    genome[27 + 5] = 1;
    genome[36 + 8] = 2;
    const result = simulate(genome, {
      ...config,
      size: 3,
      steps: 4,
      seed: "point",
    });
    expect(Array.from(result.layers[1])).toEqual(Array(9).fill(1));
    // With wrapping all cells would see eight neighbors. Real corners see three.
    expect(Array.from(result.layers[2])).toEqual([2, 3, 2, 3, 4, 3, 2, 3, 2]);
    // Differently colored neighbors still each count as ONE, not their state value.
    expect(Array.from(result.layers[3])).toEqual([4, 1, 4, 1, 2, 1, 4, 1, 4]);
  });

  it.each([1, 2, 3, 8, 13])(
    "matches the independent reference on size %i including tiny boundaries",
    (size) => {
      for (let seed = 0; seed < 6; seed++) {
        const genome = mutate(PRESETS[0].genome, 1, seed);
        const result = simulate(genome, {
          ...config,
          size,
          steps: 12,
          seed: "islands",
          randomSeed: seed,
        });
        for (let t = 1; t < result.layers.length; t++) {
          expect(result.layers[t]).toEqual(
            referenceStep(result.layers[t - 1], size, genome),
          );
        }
      }
    },
  );

  it("tracks extinction exactly and pads the horizon with independent empty layers", () => {
    const result = simulate(blank(), {
      ...config,
      size: 3,
      steps: 5,
      seed: "point",
    });
    expect(result.population).toEqual([1, 0, 0, 0, 0]);
    expect(result.layers).toHaveLength(5);
    expect(result.layers[2]).not.toBe(result.layers[3]);
    expect(result.lifetime).toBe(1);
    expect(result.extinct).toBe(true);
    expect(result.occupancy).toBeCloseTo(1 / 45);
    expect(result.activity).toBeCloseTo(1 / 36);
    expect(result.diversity).toBe(0);
  });

  it("is deterministic and uses randomSeed for island placement, not Math.random", () => {
    const islandConfig: Config = { ...config, size: 41, seed: "islands" };
    expect(simulate(PRESETS[2].genome, islandConfig)).toEqual(
      simulate(PRESETS[2].genome, islandConfig),
    );
    expect(
      simulate(PRESETS[2].genome, { ...islandConfig, randomSeed: 43 })
        .layers[0],
    ).not.toEqual(simulate(PRESETS[2].genome, islandConfig).layers[0]);
    expect(simulate(PRESETS[0].genome, config)).toEqual(
      simulate(PRESETS[0].genome, { ...config, randomSeed: 777 }),
    );
  });

  it("does not mutate input genomes or alias recorded layers", () => {
    const genome = PRESETS[0].genome.slice();
    const before = genome.slice();
    const result = simulate(genome, config);
    expect(genome).toEqual(before);
    const second = result.layers[1].slice();
    result.layers[0].fill(4);
    expect(result.layers[1]).toEqual(second);
  });

  it("preserves the reflection symmetry of a centered cruciform seed", () => {
    const result = simulate(PRESETS[0].genome, config);
    for (const layer of result.layers) {
      for (let z = 0; z < config.size; z++) {
        for (let x = 0; x < config.size; x++) {
          expect(layer[z * config.size + x]).toBe(
            layer[z * config.size + config.size - 1 - x],
          );
        }
      }
    }
  });
});

describe("curated temporal sculptures", () => {
  const expected = [
    { id: "B9166C0D", voxels: 5427, max: 352, final: 340 },
    { id: "B10D003D", voxels: 17442, max: 664, final: 536 },
    { id: "863D1693", voxels: 8569, max: 453, final: 453 },
  ];

  it("offers three genuinely distinct genomes and seed forms", () => {
    expect(PRESETS).toHaveLength(3);
    expect(new Set(PRESETS.map((preset) => genomeId(preset.genome))).size).toBe(
      3,
    );
    expect(new Set(PRESETS.map((preset) => preset.seed)).size).toBe(3);
  });

  it.each(PRESETS.map((preset, index) => ({ ...preset, index })))(
    "$name remains sparse, growing, multistate, and alive at the default horizon",
    (preset) => {
      const result = simulate(preset.genome, {
        size: 41,
        steps: 48,
        seed: preset.seed,
        randomSeed: 42,
      });
      const target = expected[preset.index];
      expect(genomeId(preset.genome)).toBe(target.id);
      expect(result.population.reduce((sum, count) => sum + count, 0)).toBe(
        target.voxels,
      );
      expect(Math.max(...result.population)).toBe(target.max);
      expect(result.population.at(-1)).toBe(target.final);
      expect(result.lifetime).toBe(48);
      expect(result.extinct).toBe(false);
      expect(result.occupancy).toBeGreaterThan(0.04);
      expect(result.occupancy).toBeLessThan(0.25);
      expect(result.diversity).toBeGreaterThan(0.95);
      expect(result.activity).toBeGreaterThan(0.05);
      expect(result.population.at(-1)!).toBeGreaterThan(
        result.population[0] * 10,
      );
      for (const layer of result.layers.slice(16))
        expect(new Set(layer)).toEqual(new Set([0, 1, 2, 3, 4]));
    },
  );

  it("keeps the default crown clear of the field boundary through layer 47", () => {
    const result = simulate(PRESETS[0].genome, {
      size: 41,
      steps: 48,
      seed: PRESETS[0].seed,
      randomSeed: 42,
    });
    for (const layer of result.layers) {
      for (let x = 0; x < 41; x++) {
        expect(layer[x]).toBe(0);
        expect(layer[40 * 41 + x]).toBe(0);
        expect(layer[x * 41]).toBe(0);
        expect(layer[x * 41 + 40]).toBe(0);
      }
    }
  });
});

describe("genetic operators and actual population search", () => {
  it("mutates reproducibly without changing the parent or the quiescent locus", () => {
    const parent = PRESETS[0].genome.slice();
    expect(mutate(parent, 0, 123)).toEqual(parent);
    expect(mutate(parent, 0, 123)).not.toBe(parent);
    const child = mutate(parent, 1, 123);
    expect(child[0]).toBe(0);
    for (let index = 1; index < 45; index++) {
      expect(child[index]).not.toBe(parent[index]);
      expect(child[index]).toBeGreaterThanOrEqual(0);
      expect(child[index]).toBeLessThanOrEqual(4);
    }
    expect(mutate(parent, 0.2, 123)).toEqual(mutate(parent, 0.2, 123));
    expect(mutate(parent, 0.2, 123)).not.toEqual(mutate(parent, 0.2, 124));
    expect(parent).toEqual(PRESETS[0].genome);
  });

  it("uniformly recombines both parents, rather than relabeling one mutation as crossover", () => {
    const first = [0, 1, 1, 1, 1];
    const second = [0, 4, 4, 4, 4];
    const draws = [0.2, 0.8, 0.4, 0.7];
    let cursor = 0;
    expect(uniformCrossover(first, second, () => draws[cursor++])).toEqual([
      0, 4, 1, 4, 1,
    ]);
    expect(cursor).toBe(4);
    expect(first).toEqual([0, 1, 1, 1, 1]);
    expect(second).toEqual([0, 4, 4, 4, 4]);
  });

  it("selects the fittest among three random tournament entrants, not the whole population", () => {
    const population = [
      { fitness: 0.1 },
      { fitness: 0.7 },
      { fitness: 0.5 },
      { fitness: 1 },
    ];
    const draws = [0.01, 0.3, 0.6];
    let cursor = 0;
    expect(tournamentSelect(population, () => draws[cursor++])).toBe(
      population[1],
    );
    expect(cursor).toBe(3);
  });

  it.each<Objective>(["complexity", "longevity", "growth"])(
    "is reproducible and preserves elite fitness for %s",
    (objective) => {
      const genome = PRESETS[0].genome.slice();
      const baseline = fitness(simulate(genome, config), objective);
      const first = evolve(genome, config, objective, 0.08, 123);
      expect(first).toEqual(evolve(genome, config, objective, 0.08, 123));
      expect(first.fitness).toBeGreaterThanOrEqual(baseline);
      expect(first.fitness).toBe(fitness(first.simulation, objective));
      expect(first.simulation).toEqual(simulate(first.genome, config));
      expect(first.genome[0]).toBe(0);
      expect(first.improved).toBe(first.fitness > baseline + 1e-12);
      expect(genome).toEqual(PRESETS[0].genome);
    },
  );

  it("finds a concrete better candidate through the complete search pipeline", () => {
    const result = evolve(PRESETS[0].genome, config, "complexity", 0.08, 123);
    expect(result.improved).toBe(true);
    expect(genomeId(result.genome)).toBe("D256CDFF");
    expect(result.fitness).toBeCloseTo(0.9748248806029908, 12);
  });

  it("takes a reproducible neutral genotype walk without inventing fitness improvement", () => {
    const fixture: Config = { ...config, size: 9, steps: 8 };
    const baseline = simulate(PRESETS[0].genome, fixture);
    const baselineFitness = fitness(baseline, "complexity");
    const walk = () => {
      let parent = PRESETS[0].genome;
      const visited: Genome[] = [parent];
      for (let step = 0; step < 3; step++) {
        const result = evolve(parent, fixture, "complexity", 0.01, 42);
        // Locus 19 is unexpressed in this organism's observed trajectory. Its
        // neutral changes must be allowed to persist between separate searches.
        expect(result.genome).not.toEqual(parent);
        expect(result.genome[19]).not.toBe(parent[19]);
        expect(result.fitness).toBe(baselineFitness);
        expect(result.simulation).toEqual(baseline);
        expect(result.improved).toBe(false);
        visited.push(result.genome);
        parent = result.genome;
      }
      expect(new Set(visited.map(genomeId)).size).toBe(4);
      return visited;
    };
    expect(walk()).toEqual(walk());
  });

  it("makes no invented progress when mutation is disabled and all founders match", () => {
    const result = evolve(PRESETS[0].genome, config, "complexity", 0, 123);
    expect(result.genome).toEqual(PRESETS[0].genome);
    expect(result.genome).not.toBe(PRESETS[0].genome);
    expect(result.improved).toBe(false);
  });
});

describe("bounded, interpretable fitness and validation", () => {
  it.each<Objective>(["complexity", "longevity", "growth"])(
    "returns normalized %s fitness across diverse mutants",
    (objective) => {
      for (let seed = 0; seed < 12; seed++) {
        const result = simulate(mutate(PRESETS[0].genome, 0.3, seed), config);
        const score = fitness(result, objective);
        expect(Number.isFinite(score)).toBe(true);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      }
    },
  );

  it("rewards longer FINITE lives and rejects censored survivors for finite longevity", () => {
    const cycle = blank();
    cycle[9] = 2;
    cycle[18] = 3;
    cycle[27] = 4;
    const persistent = blank();
    persistent[9] = 1;
    const fixture: Config = { ...config, size: 1, steps: 8, seed: "point" };
    const short = simulate(blank(), fixture);
    const longer = simulate(cycle, fixture);
    const censored = simulate(persistent, fixture);
    expect(short.lifetime).toBe(1);
    expect(longer.lifetime).toBe(4);
    expect(fitness(short, "longevity")).toBeCloseTo(1 / 7);
    expect(fitness(longer, "longevity")).toBeCloseTo(4 / 7);
    expect(fitness(longer, "longevity")).toBeGreaterThan(
      fitness(short, "longevity"),
    );
    expect(censored.extinct).toBe(false);
    expect(fitness(censored, "longevity")).toBe(0);
    expect(
      fitness(simulate(cycle, { ...fixture, steps: 5 }), "longevity"),
    ).toBe(1);
  });

  it("rewards expansion and structure over immediate extinction for growth and complexity", () => {
    const dead = simulate(blank(), config);
    const alive = simulate(PRESETS[0].genome, config);
    expect(fitness(alive, "growth")).toBeGreaterThan(fitness(dead, "growth"));
    expect(fitness(alive, "complexity")).toBeGreaterThan(
      fitness(dead, "complexity"),
    );
  });

  it("rejects malformed or non-quiescent genomes", () => {
    for (const genome of [
      [],
      Array(44).fill(0),
      Array(45),
      Array(45).fill(5),
      Array(45).fill(0.5),
      Array(45).fill(NaN),
      Array(45).fill(1),
    ]) {
      expect(() => simulate(genome, config)).toThrow(RangeError);
      expect(() => genomeId(genome)).toThrow(RangeError);
    }
  });

  it("rejects impossible horizons, invalid random seeds, and unbounded allocations", () => {
    for (const update of [
      { size: 0 },
      { size: -1 },
      { size: 2.5 },
      { steps: 0 },
      { steps: NaN },
      { randomSeed: Infinity },
      { size: 1000, steps: 1000 },
    ]) {
      expect(() =>
        simulate(PRESETS[0].genome, { ...config, ...update }),
      ).toThrow(RangeError);
    }
  });

  it("rejects mutation probabilities outside [0, 1]", () => {
    for (const rate of [-1, 1.01, NaN, Infinity]) {
      expect(() => mutate(PRESETS[0].genome, rate, 42)).toThrow(RangeError);
      expect(() =>
        evolve(PRESETS[0].genome, config, "complexity", rate, 42),
      ).toThrow(RangeError);
    }
  });
});
