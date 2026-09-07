import { describe, expect, it, vi } from "vitest";
import { DEFAULT_RUN_CONFIG } from "./config";
import { evaluateGenome } from "./evaluate";
import {
  advanceGeneration,
  generationSnapshot,
  initializePopulation,
  validateEngineState,
} from "./engine";
import { genomeId, type Genome } from "../simulation";
import type {
  BatchEvaluator,
  EngineState,
  Evaluation,
  RunConfig,
} from "./types";

const config = (updates: Partial<RunConfig> = {}): RunConfig => ({
  ...structuredClone(DEFAULT_RUN_CONFIG),
  initialization: "mutants",
  size: 9,
  steps: 8,
  populationSize: 16,
  eliteCount: 2,
  immigrantRate: 0,
  cacheSize: 64,
  ...updates,
});
const synthetic = (
  genome: Genome,
  cfg: RunConfig,
  neutral = false,
): Evaluation => {
  const fitness = neutral ? 0.5 : genome.reduce((a, b) => a + b, 0) / 176;
  return {
    fitness,
    validationFitness: cfg.validationSeeds.length ? 1 - fitness : null,
    disqualified: false,
    validationDisqualified: false,
    trainingScores: cfg.trainingSeeds.map(() => fitness),
    validationScores: cfg.validationSeeds.map(() => 1 - fitness),
    metrics: {
      diversity: 0.5,
      activity: 0.5,
      density: 0.5,
      variation: 0.5,
      persistence: 1,
      occupancy: 0.2,
      lifetime: cfg.steps,
      extinctFraction: 0,
    },
  };
};
const cheap: BatchEvaluator = async (genomes, cfg) =>
  genomes.map((genome) => synthetic(genome, cfg));
const neutral: BatchEvaluator = async (genomes, cfg) =>
  genomes.map((genome) => synthetic(genome, cfg, true));
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value));
async function generations(
  state: EngineState,
  count: number,
  evaluate: BatchEvaluator = cheap,
): Promise<EngineState> {
  for (let i = 0; i < count; i++)
    state = await advanceGeneration(state, evaluate);
  return state;
}
function trace(state: EngineState): void {
  for (const individual of state.population) {
    expect(individual.genome).toHaveLength(45);
    expect(individual.genome[0]).toBe(0);
    expect(individual.crossoverMask).toHaveLength(45);
    expect(individual.crossoverMask[0]).toBe(0);
    for (let locus = 1; locus < 45; locus++)
      if (individual.parents.length) {
        const before =
          individual.parents[individual.crossoverMask[locus]].genome[locus];
        expect(individual.genome[locus] !== before).toBe(
          individual.mutatedLoci.includes(locus),
        );
      }
  }
}

describe("retained generational population and honest provenance", () => {
  it("defaults to independent random contenders, reproducible and unaffected by the founder", async () => {
    const cfg = structuredClone(DEFAULT_RUN_CONFIG);
    const first = await initializePopulation(cfg, cheap);
    expect(first.config.initialization).toBe("random");
    expect(first.population).toHaveLength(cfg.populationSize);
    for (const contender of first.population) {
      expect(contender.origin).toBe("random");
      expect(contender.parents).toEqual([]);
      expect(contender.genome[0]).toBe(0);
      expect(contender.genome).not.toEqual(cfg.seedGenome);
    }
    const alternate = { ...cfg, seedGenome: Array(45).fill(0) };
    const repeated = await initializePopulation(alternate, cheap);
    expect(repeated).toEqual({ ...first, config: alternate });
    const differentSeed = await initializePopulation(
      { ...cfg, randomSeed: cfg.randomSeed + 1 },
      cheap,
    );
    expect(differentSeed.population.map((item) => item.genome)).not.toEqual(
      first.population.map((item) => item.genome),
    );
  });
  it("retains exact elites and breeds the whole prior population, not a reset around the champion", async () => {
    const first = await initializePopulation(
      config({ initialization: "random" }),
      neutral,
    );
    const before = json(first),
      second = await advanceGeneration(first, neutral);
    expect(first).toEqual(before);
    expect(second.generation).toBe(1);
    expect(second.population).toHaveLength(first.config.populationSize);
    expect(second.population.slice(0, 2)).toEqual(first.population.slice(0, 2));
    const oldIds = new Set(first.population.map((item) => item.id));
    for (const child of second.population.slice(2)) {
      expect(oldIds.has(child.id)).toBe(false);
      expect(child.birthGeneration).toBe(1);
      for (const parent of child.parents) {
        const original = first.population.find(
          (item) => item.id === parent.id,
        )!;
        expect(parent).toEqual({
          id: original.id,
          genome: original.genome,
          fitness: original.fitness,
          birthGeneration: original.birthGeneration,
        });
      }
    }
    expect(
      new Set(
        second.population.flatMap((item) =>
          item.parents.map((parent) => parent.id),
        ),
      ).size,
    ).toBeGreaterThan(4);
    second.population[0].genome[1] = 4;
    second.population[2].parents[0].genome[2] = 4;
    expect(first).toEqual(before);
  });
  it("starts mutants around a real founder or an entirely random population", async () => {
    const mutants = await initializePopulation(
      config({ mutationRate: 1 }),
      cheap,
    );
    expect(mutants.population[0].origin).toBe("founder");
    expect(mutants.population[0].genome).toEqual(mutants.config.seedGenome);
    for (const child of mutants.population.slice(1)) {
      expect(child.origin).toBe("mutant");
      expect(child.parents[0].id).toBe("i1");
      expect(child.mutatedLoci).toEqual(
        Array.from({ length: 44 }, (_, i) => i + 1),
      );
    }
    trace(mutants);
    const random = await initializePopulation(
      config({ initialization: "random" }),
      cheap,
    );
    expect(
      random.population.every(
        (item) => item.origin === "random" && item.parents.length === 0,
      ),
    ).toBe(true);
    expect(generationSnapshot(random).metrics.uniqueGenomes).toBe(16);
    expect(validateEngineState(mutants)).toEqual(mutants);
    expect(validateEngineState(random)).toEqual(random);
  });
  it.each(["uniform", "onePoint", "none"] as const)(
    "records actual %s parent masks and every changing mutation",
    async (crossover) => {
      let state = await initializePopulation(
        config({
          initialization: "random",
          eliteCount: 0,
          crossover,
          crossoverRate: 1,
          mutationRate: 0.4,
        }),
        cheap,
      );
      state = await advanceGeneration(state, cheap);
      trace(state);
      for (const child of state.population) {
        expect(child.origin).toBe(
          crossover === "none" ? "mutant" : "crossover",
        );
        expect(child.parents).toHaveLength(crossover === "none" ? 1 : 2);
        if (crossover === "onePoint") {
          expect(child.crossoverMask.slice(1)).toContain(0);
          expect(child.crossoverMask).toContain(1);
          expect(child.crossoverMask.join("")).toMatch(/^0+1+$/);
        } else if (crossover === "uniform") {
          expect(child.crossoverMask.slice(1)).toContain(0);
          expect(child.crossoverMask).toContain(1);
        } else expect(child.crossoverMask).toEqual(Array(45).fill(0));
      }
      expect(validateEngineState(state)).toEqual(state);
    },
  );
  it("honors zero crossover/mutation and preserves zero-quiescence at mutation rate one", async () => {
    const initial = await initializePopulation(
      config({
        initialization: "random",
        eliteCount: 0,
        crossoverRate: 0,
        mutationRate: 0,
      }),
      cheap,
    );
    const clones = await advanceGeneration(initial, cheap);
    expect(
      clones.population.every(
        (item) =>
          item.origin === "clone" &&
          item.parents.length === 1 &&
          item.mutatedLoci.length === 0,
      ),
    ).toBe(true);
    trace(clones);
    let full = await initializePopulation(
      config({ eliteCount: 0, mutationRate: 1, crossoverRate: 0 }),
      cheap,
    );
    full = await advanceGeneration(full, cheap);
    expect(
      full.population.every(
        (item) => item.mutatedLoci.length === 44 && item.genome[0] === 0,
      ),
    ).toBe(true);
    trace(full);
  });
  it("fills the exact floor(population × rate) immigrant slots with fresh unparented genomes", async () => {
    const first = await initializePopulation(
      config({ populationSize: 20, immigrantRate: 0.25 }),
      cheap,
    );
    const next = await advanceGeneration(first, cheap);
    expect(
      next.population.filter((item) => item.origin === "immigrant"),
    ).toHaveLength(5);
    for (const immigrant of next.population.slice(-5)) {
      expect(immigrant.parents).toEqual([]);
      expect(immigrant.mutatedLoci).toEqual([]);
      expect(immigrant.birthGeneration).toBe(1);
    }
    expect(next.population.slice(0, 2)).toEqual(
      first.population
        .slice()
        .sort((a, b) => b.fitness - a.fitness)
        .slice(0, 2),
    );
  });
  it("allows zero-elite regression while keeping an independent all-time champion", async () => {
    const seedGenome = [0, ...Array(44).fill(4)];
    const cfg = config({
      seedGenome,
      eliteCount: 0,
      mutationRate: 1,
      crossover: "none",
    });
    const first = await initializePopulation(cfg, cheap),
      next = await advanceGeneration(first, cheap);
    expect(first.champion.fitness).toBe(1);
    expect(generationSnapshot(next).metrics.best).toBeLessThan(1);
    expect(next.champion).toEqual(first.champion);
    expect(next.population.some((item) => item.id === first.champion.id)).toBe(
      false,
    );
    const guarded = await generations(
      await initializePopulation({ ...cfg, eliteCount: 1 }, cheap),
      3,
    );
    expect(generationSnapshot(guarded).metrics.best).toBe(1);
  });
  it("does not turn unlimited training into an unlimited CA horizon, and honors explicit generation limits", async () => {
    const state = await generations(
      await initializePopulation(config({ maxGenerations: 0 }), cheap),
      12,
    );
    expect(state.generation).toBe(12);
    expect(state.config.steps).toBe(8);
    const final = await generations(
      await initializePopulation(config({ maxGenerations: 2 }), cheap),
      2,
    );
    await expect(advanceGeneration(final, cheap)).rejects.toThrow(/limit/);
  });
});

describe("selection, neutral diversity, validation and scientific metrics", () => {
  it("tournament size increases selection pressure and rank gives fitter individuals higher expected weight", async () => {
    const cfg = config({
      populationSize: 512,
      eliteCount: 0,
      initialization: "random",
      mutationRate: 0,
      crossover: "none",
      cacheSize: 0,
    });
    const low = await initializePopulation(
      { ...cfg, tournamentSize: 2 },
      cheap,
    );
    const high = await initializePopulation(
      { ...cfg, tournamentSize: 32 },
      cheap,
    );
    const ranked = await initializePopulation(
      { ...cfg, selection: "rank" },
      cheap,
    );
    const lowNext = await advanceGeneration(low, cheap),
      highNext = await advanceGeneration(high, cheap),
      rankNext = await advanceGeneration(ranked, cheap);
    expect(generationSnapshot(highNext).metrics.mean).toBeGreaterThan(
      generationSnapshot(lowNext).metrics.mean + 0.035,
    );
    expect(generationSnapshot(rankNext).metrics.mean).toBeGreaterThan(
      generationSnapshot(ranked).metrics.mean + 0.01,
    );
  });
  it.each(["tournament", "rank"] as const)(
    "preserves a neutral genetic population under %s, without claiming fitness improvement",
    async (selection) => {
      const state = await generations(
        await initializePopulation(
          config({
            populationSize: 64,
            initialization: "random",
            selection,
            mutationRate: 0.03,
          }),
          neutral,
        ),
        8,
        neutral,
      );
      const metrics = generationSnapshot(state).metrics;
      expect(metrics.best).toBe(0.5);
      expect(metrics.mean).toBe(0.5);
      expect(metrics.bestEver).toBe(0.5);
      expect(metrics.uniqueGenomes).toBeGreaterThan(30);
      expect(metrics.diversity).toBeGreaterThan(0.5);
      expect(state.champion.id).toBe("i1");
    },
  );
  it("never uses held-out performance for selection, elites, tie breaks, or champion", async () => {
    const cfg = config({ initialization: "random" });
    const trainOnly = await generations(
      await initializePopulation(cfg, cheap),
      5,
    );
    const heldOut = await generations(
      await initializePopulation({ ...cfg, validationSeeds: [991] }, cheap),
      5,
    );
    expect(
      heldOut.population.map((item) => [
        item.id,
        item.genome,
        item.parents,
        item.fitness,
      ]),
    ).toEqual(
      trainOnly.population.map((item) => [
        item.id,
        item.genome,
        item.parents,
        item.fitness,
      ]),
    );
    expect(heldOut.champion.id).toBe(trainOnly.champion.id);
    expect(heldOut.rngState).toBe(trainOnly.rngState);
    expect(heldOut.champion.validationFitness).toBe(
      1 - heldOut.champion.fitness,
    );
    expect(generationSnapshot(heldOut).metrics.validationBest).toBe(
      1 - generationSnapshot(heldOut).metrics.worst,
    );
    expect(heldOut.evaluations).toBe(trainOnly.evaluations * 2);
  });
  it("computes best/mean/worst/even-and-odd median and normalized entropy over only 44 unlocked loci", async () => {
    const cfg = config({ populationSize: 10, initialization: "random" });
    const state = await initializePopulation(cfg, cheap);
    // Snapshot is a pure observational reduction; this synthetic balanced fixture
    // isolates entropy and order statistics from genetic/evaluation mechanics.
    state.population.forEach((item, i) => {
      item.genome = [0, ...Array(44).fill(i % 5)];
      item.fitness = i / 10;
      item.validationFitness = 1 - i / 10;
    });
    state.champion = { ...state.population[9], fitness: 1 };
    const snapshot = generationSnapshot(state),
      m = snapshot.metrics;
    expect(m).toMatchObject({
      generation: 0,
      best: 0.9,
      mean: 0.45,
      worst: 0,
      median: 0.45,
      bestEver: 1,
      validationBest: 1,
      uniqueGenomes: 5,
      evaluations: state.evaluations,
      cacheHits: state.cacheHits,
    });
    expect(m.diversity).toBeCloseTo(1, 12);
    state.population.pop();
    expect(generationSnapshot(state).metrics.median).toBe(0.4);
    state.population.forEach((item) => {
      item.genome = Array(45).fill(0);
    });
    expect(generationSnapshot(state).metrics.diversity).toBe(0);
    snapshot.population[0].genome[1] = 3;
    snapshot.champion.genome[1] = 3;
    expect(state.population[0].genome[1]).toBe(0);
  });
  it("finds a reproducible strict improvement through the real CA pipeline", async () => {
    const cfg = config({
      objective: "complexity",
      boundaryPolicy: { spatial: false, horizon: false },
      size: 17,
      steps: 20,
      populationSize: 24,
      mutationRate: 0.08,
      randomSeed: 123,
    });
    const first = await initializePopulation(cfg),
      end = await generations(first, 8, async (genomes, cfg) =>
        genomes.map((g) => evaluateGenome(g, cfg)),
      );
    expect(end.champion.fitness).toBeGreaterThan(first.champion.fitness);
    expect(end.champion.fitness).toBe(
      evaluateGenome(end.champion.genome, cfg).fitness,
    );
    expect(
      await generations(
        await initializePopulation(cfg),
        8,
        async (genomes, cfg) => genomes.map((g) => evaluateGenome(g, cfg)),
      ),
    ).toEqual(end);
  });
});

describe("deterministic batch LRU, exact accounting and transactional replay", () => {
  it.each([0, 1, 16])(
    "deduplicates generation batches with cache capacity %i and counts actual train+heldout fixtures",
    async (cacheSize) => {
      const cfg = config({
        populationSize: 8,
        mutationRate: 0,
        crossoverRate: 0,
        trainingSeeds: [1, 2],
        validationSeeds: [3],
        cacheSize,
      });
      const evaluator = vi.fn(cheap),
        first = await initializePopulation(cfg, evaluator);
      expect(evaluator).toHaveBeenCalledTimes(1);
      expect(evaluator.mock.calls[0][0]).toHaveLength(1);
      expect(first.evaluations).toBe(3);
      expect(first.cacheHits).toBe(7);
      expect(first.cache).toHaveLength(cacheSize ? 1 : 0);
      const next = await advanceGeneration(first, evaluator);
      expect(next.evaluations).toBe(cacheSize ? 3 : 6);
      expect(next.cacheHits).toBe(cacheSize ? 13 : 12);
      expect(evaluator).toHaveBeenCalledTimes(cacheSize ? 1 : 2);
      expect(validateEngineState(next)).toEqual(next);
    },
  );
  it("keeps the full genome key and deterministic least-to-most-recent bounded cache in checkpoints", async () => {
    let state = await initializePopulation(
      config({ initialization: "random", cacheSize: 3 }),
      cheap,
    );
    expect(state.cache.map((entry) => entry.key)).toEqual(
      state.population.slice(-3).map((item) => item.genome.join("")),
    );
    for (let i = 0; i < 5; i++) {
      state = await advanceGeneration(state, cheap);
      expect(state.cache).toHaveLength(3);
      expect(state.cache.every((entry) => /^0[0-4]{44}$/.test(entry.key))).toBe(
        true,
      );
      expect(new Set(state.cache.map((entry) => entry.key)).size).toBe(3);
      expect(validateEngineState(json(state))).toEqual(state);
    }
  });
  it("never confuses two distinct genomes with the same short display fingerprint", async () => {
    const a = Array.from(
      "042344212244401340432320224112121032312034340",
      Number,
    );
    const b = Array.from(
      "020301013411423314341044000441411441304241442",
      Number,
    );
    expect(genomeId(a)).toBe(genomeId(b));
    expect(a).not.toEqual(b);
    const cfg = config({
      populationSize: 8,
      eliteCount: 0,
      initialization: "random",
      mutationRate: 0,
      crossover: "none",
    });
    const state = await initializePopulation(cfg, cheap);
    // Controlled valid generation-zero checkpoint: all founders A, cached B.
    state.population = state.population.map((item) => ({
      ...item,
      genome: a.slice(),
      ...synthetic(a, cfg),
    }));
    state.champion = json(state.population[0]);
    state.cache = [{ key: b.join(""), evaluation: synthetic(b, cfg) }];
    const evaluator = vi.fn(cheap),
      next = await advanceGeneration(state, evaluator);
    expect(evaluator).toHaveBeenCalledTimes(1);
    expect(evaluator.mock.calls[0][0]).toEqual([a]);
    expect(next.cache.map((entry) => entry.key)).toEqual([
      b.join(""),
      a.join(""),
    ]);
    expect(
      next.population.every(
        (item) => item.fitness === synthetic(a, cfg).fitness,
      ),
    ).toBe(true);
  });
  it("replays exact JSON state including RNG, IDs, traces, cache order and counters", async () => {
    const initial = await initializePopulation(
      config({
        initialization: "random",
        validationSeeds: [22],
        trainingSeeds: [1, 2],
        cacheSize: 7,
        immigrantRate: 0.25,
      }),
      cheap,
    );
    const checkpoint = await generations(initial, 3),
      before = json(checkpoint);
    const uninterrupted = await generations(checkpoint, 5);
    const restored = await generations(
      validateEngineState(json(checkpoint)),
      5,
    );
    expect(restored).toEqual(uninterrupted);
    expect(checkpoint).toEqual(before);
    expect(JSON.stringify(restored)).toBe(JSON.stringify(uninterrupted));
  });
  it("is independent of evaluator completion order when the executor restores input ordering", async () => {
    const completed: number[] = [];
    const reordered: BatchEvaluator = async (genomes, cfg) =>
      Promise.all(
        genomes.map(
          (genome, i) =>
            new Promise<Evaluation>((resolve) => {
              setTimeout(
                () => {
                  completed.push(i);
                  resolve(synthetic(genome, cfg));
                },
                (genomes.length - i) * 2,
              );
            }),
        ),
      );
    const cfg = config({ initialization: "random", cacheSize: 3 });
    const direct = await generations(await initializePopulation(cfg, cheap), 2);
    const concurrent = await generations(
      await initializePopulation(cfg, reordered),
      2,
      reordered,
    );
    expect(completed[0]).not.toBe(0);
    expect(concurrent).toEqual(direct);
  });
  it("rolls back input and PRNG exactly after cooperative abort, including a mutating evaluator", async () => {
    const first = await initializePopulation(
      config({ initialization: "random", mutationRate: 1, cacheSize: 0 }),
      cheap,
    );
    const before = json(first);
    const abort: BatchEvaluator = async (genomes, cfg) => {
      genomes[0][1] = 4;
      cfg.seedGenome[1] = 4;
      cfg.trainingSeeds.push(9);
      await Promise.resolve();
      throw new DOMException("Aborted", "AbortError");
    };
    await expect(advanceGeneration(first, abort)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(first).toEqual(before);
    expect(await advanceGeneration(first, cheap)).toEqual(
      await advanceGeneration(json(before), cheap),
    );
  });
  it("rejects malformed evaluator results without committing half a generation", async () => {
    const first = await initializePopulation(
        config({ initialization: "random", cacheSize: 0 }),
        cheap,
      ),
      before = json(first);
    await expect(advanceGeneration(first, async () => [])).rejects.toThrow(
      /batch length/,
    );
    await expect(
      advanceGeneration(first, async (genomes, cfg) =>
        genomes.map((g) => ({ ...synthetic(g, cfg), fitness: NaN })),
      ),
    ).rejects.toThrow(RangeError);
    expect(first).toEqual(before);
  });
});

describe("hostile or corrupted checkpoint rejection", () => {
  it("rejects incompatible models, oversized allocation requests, broken IDs, ancestry, traces, scores and accounting", async () => {
    const initial = await initializePopulation(
      config({ initialization: "random", cacheSize: 8 }),
      cheap,
    );
    const valid = await advanceGeneration(initial, cheap);
    const invalid: ((s: EngineState) => void)[] = [
      (s) => {
        (s as unknown as { version: number }).version = 2;
      },
      (s) => {
        (s as unknown as { modelVersion: string }).modelVersion = "ca9";
      },
      (s) => {
        s.config.size = 999999;
      },
      (s) => {
        s.generation = -1;
      },
      (s) => {
        s.rngState = 2 ** 32;
      },
      (s) => {
        s.nextId++;
      },
      (s) => {
        s.population.pop();
      },
      (s) => {
        s.population[1].id = s.population[0].id;
      },
      (s) => {
        s.population[0].genome[0] = 1;
      },
      (s) => {
        s.population[0].fitness = Infinity;
      },
      (s) => {
        s.population[0].fitness = 0.999;
      },
      (s) => {
        s.population[0].metrics.persistence = 0;
      },
      (s) => {
        s.population[2].parents[0].id = s.population[2].id;
      },
      (s) => {
        s.population[2].parents[0].birthGeneration = 1;
      },
      (s) => {
        const same = s.population.find((item) => item.id === s.champion.id)!;
        same.genome[1] = (same.genome[1] + 1) % 5;
      },
      (s) => {
        const key = s.population[0].genome.join("");
        s.cache = [
          {
            key,
            evaluation: {
              ...synthetic(s.population[0].genome, s.config),
              fitness: 0,
              trainingScores: [0],
            },
          },
        ];
      },
      (s) => {
        s.population[2].crossoverMask = [0];
      },
      (s) => {
        s.population[2].mutatedLoci = [0];
      },
      (s) => {
        s.population[2].mutatedLoci = [1, 1];
      },
      (s) => {
        s.population[2].genome[1] = (s.population[2].genome[1] + 1) % 5;
        s.population[2].mutatedLoci = s.population[2].mutatedLoci.filter(
          (locus) => locus !== 1,
        );
      },
      (s) => {
        s.population[2].origin = "founder";
      },
      (s) => {
        s.population[2].trainingScores = [];
      },
      (s) => {
        s.population[2].validationFitness = 0.5;
      },
      (s) => {
        s.champion.fitness = 0;
        s.champion.trainingScores = [0];
      },
      (s) => {
        s.cache.push(s.cache[0]);
      },
      (s) => {
        s.cache[1] = s.cache[0];
      },
      (s) => {
        s.cache[0].key = "deadbeef";
      },
      (s) => {
        s.evaluations++;
      },
      (s) => {
        s.cacheHits = -1;
      },
      (s) => {
        (s as unknown as Record<string, unknown>).unknown = true;
      },
    ];
    for (const corrupt of invalid) {
      const state = json(valid);
      corrupt(state);
      expect(() => validateEngineState(state)).toThrow(RangeError);
    }
    for (const value of [null, {}, [], 1])
      expect(() => validateEngineState(value)).toThrow(RangeError);
    const detached = validateEngineState(valid);
    detached.config.seedGenome[1] = 4;
    detached.population[0].genome[1] = 4;
    expect(valid).toEqual(await advanceGeneration(initial, cheap));
  });
});
