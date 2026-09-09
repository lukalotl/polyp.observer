import { describe, expect, it, vi } from "vitest";
import { DEFAULT_RUN_CONFIG, validateRunConfig } from "./config";
import { evaluateGenome } from "./evaluate";
import {
  advanceGeneration,
  generationSnapshot,
  initializePopulation,
  validateEngineState,
} from "./engine";
import { heavyTailedWeights, mutationChangeDistribution } from "./mutation";
import { genomeId, type Genome } from "../simulation";
import type {
  BatchEvaluator,
  EngineState,
  Evaluation,
  RunConfig,
} from "./types";

/** Legacy-shaped config: the operator keys older saved runs omit are absent. */
const legacy = (cfg: RunConfig): RunConfig => {
  const copy = structuredClone(cfg);
  delete copy.elitism;
  delete copy.mutationPolicy;
  delete copy.mutationBeta;
  delete copy.stallGenerations;
  return copy;
};
const config = (updates: Partial<RunConfig> = {}): RunConfig => ({
  ...legacy(DEFAULT_RUN_CONFIG),
  initialization: "mutants",
  randomRuleBias: "uniform",
  size: 9,
  steps: 8,
  populationSize: 16,
  eliteCount: 2,
  tournamentSize: 4,
  mutationRate: 0.03,
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
/** Genome-derived per-fixture scores: training fixture f rewards the share of
 * unlocked loci holding state f + 1, scaled by f + 1 and clipped to one. So
 * all-ones is a fixture-0 specialist ([1, 0], mean 0.5) while a 22/22 split of
 * ones and twos scores [0.5, 1] and wins on the mean. Held-out scores are a
 * function of the training scores (inverted by default). */
const perFixture = (
  heldOut: (training: number[]) => number[] = (scores) =>
    scores.map((score) => 1 - score),
): BatchEvaluator => {
  const mean = (values: number[]) =>
    values.reduce((a, b) => a + b, 0) / values.length;
  return async (genomes, cfg) =>
    genomes.map((genome) => {
      const share = (state: number) =>
        genome.slice(1).filter((g) => g === state).length /
        (genome.length - 1);
      const trainingScores = cfg.trainingSeeds.map((_, f) =>
        Math.min(1, (f + 1) * share(f + 1)),
      );
      const held = heldOut(trainingScores);
      const validationScores = cfg.validationSeeds.map(
        (_, f) => held[f % held.length],
      );
      return {
        ...synthetic(genome, cfg),
        fitness: mean(trainingScores),
        validationFitness: validationScores.length
          ? mean(validationScores)
          : null,
        trainingScores,
        validationScores,
      };
    });
};
/** A valid generation-zero state whose parentless individuals carry the given
 * genomes and their evaluations, in population order. */
async function planted(
  cfg: RunConfig,
  genomes: Genome[],
  evaluate: BatchEvaluator,
): Promise<EngineState> {
  const state = await initializePopulation(cfg, evaluate);
  const results = await evaluate(
    genomes.map((genome) => genome.slice()),
    cfg,
  );
  state.population.forEach((item, i) =>
    Object.assign(item, { genome: genomes[i].slice() }, results[i]),
  );
  state.champion = json(
    state.population.reduce((best, item) =>
      item.fitness > best.fitness ? item : best,
    ),
  );
  state.cache = [];
  return validateEngineState(state);
}
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

describe("breeding-diversity operators: distinct elitism, heavy-tailed mutation, lexicase", () => {
  const A = [0, ...Array(44).fill(4)],
    B = [0, ...Array(44).fill(3)],
    C = [0, ...Array(44).fill(2)];
  const filler = Array.from({ length: 10 }, (_, j) => [
    0,
    ...Array(j + 1).fill(1),
    ...Array(43 - j).fill(0),
  ]);
  it("keeps the fittest individual per genome as an elite, byte-for-byte, and fills scarce distinct genomes with the next-best duplicates", async () => {
    const cfg = config({
      initialization: "random",
      eliteCount: 3,
      elitism: "distinct",
      crossover: "none",
      mutationRate: 0,
    });
    const prior = await planted(cfg, [A, A, A, B, A, C, ...filler], cheap);
    expect(generationSnapshot(prior).metrics).toMatchObject({
      distinctElites: 1,
      bestCopies: 4,
      uniqueGenomes: 13,
    });
    const next = await advanceGeneration(prior, cheap);
    expect(next.population.slice(0, 3)).toEqual([
      prior.population[0],
      prior.population[3],
      prior.population[5],
    ]);
    expect(next.population).toHaveLength(16);
    expect(next.nextId).toBe(1 + 16 + (16 - 3));
    expect(validateEngineState(json(next))).toEqual(next);
    const slots = await advanceGeneration(
      { ...prior, config: { ...prior.config, elitism: "slots" } },
      cheap,
    );
    expect(slots.population.slice(0, 3)).toEqual(prior.population.slice(0, 3));
    const scarce = await planted(cfg, [...Array(15).fill(A), B], cheap);
    const filled = await advanceGeneration(scarce, cheap);
    expect(filled.population.slice(0, 3)).toEqual([
      scarce.population[0],
      scarce.population[1],
      scarce.population[15],
    ]);
    expect(filled.population).toHaveLength(16);
    expect(filled.nextId).toBe(1 + 16 + (16 - 3));
    expect(validateEngineState(json(filled))).toEqual(filled);
    const uniform = await planted(cfg, Array(16).fill(A), cheap);
    expect(
      (await advanceGeneration(uniform, cheap)).population.slice(0, 3),
    ).toEqual(uniform.population.slice(0, 3));
  });
  it("replays legacy configurations exactly and matches explicit slots/independent, and distinct elitism whenever the fittest are already distinct", async () => {
    const base = config({
      initialization: "random",
      immigrantRate: 0.25,
      crossoverRate: 1,
      mutationRate: 0.3,
    });
    expect(base).not.toHaveProperty("elitism");
    expect(base).not.toHaveProperty("mutationPolicy");
    const absent = await generations(
      await initializePopulation(base, cheap),
      3,
    );
    expect(absent.config).not.toHaveProperty("elitism");
    expect(absent.config).not.toHaveProperty("mutationPolicy");
    const explicit = await generations(
      await initializePopulation(
        { ...base, elitism: "slots", mutationPolicy: "independent" },
        cheap,
      ),
      3,
    );
    expect({ ...explicit, config: base }).toEqual(absent);
    const distinct = await generations(
      await initializePopulation({ ...base, elitism: "distinct" }, cheap),
      3,
    );
    expect({ ...distinct, config: base }).toEqual(absent);
    expect(generationSnapshot(absent).metrics.distinctElites).toBe(2);
  });
  it("heavy-tailed mutation always changes at least one locus, so one-parent children are never clones", async () => {
    const cfg = config({
      mutationPolicy: "heavyTailed",
      mutationBeta: 1.5,
      mutationRate: 0,
      eliteCount: 0,
      crossover: "none",
    });
    const mutants = await initializePopulation(cfg, cheap);
    expect(mutants.population[0].origin).toBe("founder");
    for (const child of mutants.population.slice(1)) {
      expect(child.origin).toBe("mutant");
      expect(child.parents[0].id).toBe("i1");
      expect(child.mutatedLoci.length).toBeGreaterThanOrEqual(1);
      expect(child.mutatedLoci.length).toBeLessThanOrEqual(22);
      expect(child.mutatedLoci).toEqual(
        [...new Set(child.mutatedLoci)].sort((a, b) => a - b),
      );
    }
    trace(mutants);
    expect(validateEngineState(json(mutants))).toEqual(mutants);
    const next = await advanceGeneration(mutants, cheap);
    expect(
      next.population.every(
        (item) => item.origin === "mutant" && item.mutatedLoci.length >= 1,
      ),
    ).toBe(true);
    trace(next);
    expect(validateEngineState(json(next))).toEqual(next);
    const crossed = await advanceGeneration(
      await initializePopulation(
        { ...cfg, crossover: "uniform", crossoverRate: 1 },
        cheap,
      ),
      cheap,
    );
    expect(
      crossed.population.every(
        (item) =>
          item.origin === "crossover" &&
          item.parents.length === 2 &&
          item.mutatedLoci.length >= 1,
      ),
    ).toBe(true);
    trace(crossed);
  });
  it.each([
    { stateCount: 5, mutationBeta: 1.5 },
    { stateCount: 2, mutationBeta: 2.5 },
  ])(
    "draws heavy-tailed change counts distributed as heavyTailedWeights: %j",
    async ({ stateCount, mutationBeta }) => {
      const cfg = config({
        stateCount,
        seedGenome: Array(9 * stateCount).fill(0),
        initialization: "random",
        populationSize: 512,
        eliteCount: 0,
        crossover: "none",
        cacheSize: 0,
        mutationPolicy: "heavyTailed",
        mutationBeta,
      });
      let state = await initializePopulation(cfg, neutral);
      const counts = new Map<number, number>();
      let total = 0;
      for (let g = 0; g < 20; g++) {
        state = await advanceGeneration(state, neutral);
        for (const child of state.population) {
          const k = child.mutatedLoci.length;
          counts.set(k, (counts.get(k) ?? 0) + 1);
          total++;
        }
      }
      const weights = heavyTailedWeights(stateCount, mutationBeta);
      expect(counts.has(0)).toBe(false);
      expect(Math.max(...counts.keys())).toBeLessThanOrEqual(weights.length);
      weights.forEach((p, i) => {
        const observed = (counts.get(i + 1) ?? 0) / total;
        expect(Math.abs(observed - p)).toBeLessThanOrEqual(
          4 * Math.sqrt((p * (1 - p)) / total) + 1 / total,
        );
      });
      const expected = mutationChangeDistribution(cfg);
      const variance = expected.probabilities.reduce(
        (sum, p, k) => sum + p * (k - expected.mean) ** 2,
        0,
      );
      const mean =
        [...counts].reduce((sum, [k, n]) => sum + k * n, 0) / total;
      expect(Math.abs(mean - expected.mean)).toBeLessThanOrEqual(
        4 * Math.sqrt(variance / total),
      );
    },
  );
  it("lexicase selects on per-fixture training scores only, even when held-out scores would flip every choice", async () => {
    const specialist = [0, ...Array(44).fill(1)];
    const other = [0, ...Array(44).fill(3)];
    const genomes = [specialist, ...Array(15).fill(other)];
    const cfg = config({
      initialization: "random",
      selection: "lexicase",
      trainingSeeds: [1, 2],
      validationSeeds: [3, 4],
      eliteCount: 0,
      crossover: "none",
      mutationRate: 0,
    });
    const inverted = perFixture();
    const prior = await planted(cfg, genomes, inverted);
    expect(prior.population[0].trainingScores).toEqual([1, 0]);
    expect(prior.population[1].trainingScores).toEqual([0, 0]);
    expect(prior.population[0].validationFitness).toBeLessThan(
      prior.population[1].validationFitness!,
    );
    const next = await advanceGeneration(prior, inverted);
    expect(
      next.population.every(
        (child) =>
          child.parents.length === 1 &&
          child.parents[0].id === prior.population[0].id,
      ),
    ).toBe(true);
    const aligned = perFixture((scores) => scores);
    const agreeing = await advanceGeneration(
      await planted(cfg, genomes, aligned),
      aligned,
    );
    const heldOutFree = await advanceGeneration(
      await planted({ ...cfg, validationSeeds: [] }, genomes, inverted),
      inverted,
    );
    const genetics = (state: EngineState) => ({
      rngState: state.rngState,
      population: state.population.map((item) => [
        item.id,
        item.genome,
        item.parents.map((parent) => parent.id),
        item.trainingScores,
      ]),
    });
    expect(genetics(agreeing)).toEqual(genetics(next));
    expect(genetics(heldOutFree)).toEqual(genetics(next));
  });
  it("lexicase gives a fixture specialist the parentage that tournament and rank on the mean deny it", async () => {
    const specialist = [0, ...Array(44).fill(1)];
    const generalist = [0, ...Array(22).fill(1), ...Array(22).fill(2)];
    const genomes = [specialist, ...Array(15).fill(generalist)];
    const evaluate = perFixture();
    const base = config({
      initialization: "random",
      trainingSeeds: [1, 2],
      eliteCount: 0,
      crossover: "none",
      mutationRate: 0,
    });
    const specialistChildren = async (selection: RunConfig["selection"]) => {
      const prior = await planted({ ...base, selection }, genomes, evaluate);
      expect(prior.population[0].fitness).toBe(0.5);
      expect(prior.population[1].fitness).toBe(0.75);
      const next = await advanceGeneration(prior, evaluate);
      return next.population.filter(
        (child) => child.parents[0].id === prior.population[0].id,
      ).length;
    };
    // Whichever fixture is shuffled first decides: half of all lexicase
    // selections keep only the specialist; on the mean it always loses.
    const lexicase = await specialistChildren("lexicase");
    expect(lexicase).toBeGreaterThanOrEqual(4);
    expect(await specialistChildren("tournament")).toBe(0);
    expect(await specialistChildren("rank")).toBeLessThan(lexicase);
  });
  it("rejects lexicase with a single training fixture", async () => {
    await expect(
      initializePopulation(config({ selection: "lexicase" }), cheap),
    ).rejects.toThrow(/at least 2 training seeds/);
    expect(() =>
      validateRunConfig(config({ selection: "lexicase", trainingSeeds: [1, 2] })),
    ).not.toThrow();
  });
  it.each([
    { elitism: "distinct" },
    { mutationPolicy: "heavyTailed", mutationBeta: 1.5 },
    { selection: "lexicase", trainingSeeds: [1, 2, 3] },
    { stallGenerations: 5 },
    {
      elitism: "distinct",
      mutationPolicy: "heavyTailed",
      mutationBeta: 2,
      selection: "lexicase",
      trainingSeeds: [1, 2],
      validationSeeds: [9],
      stallGenerations: 3,
      eliteCount: 3,
    },
  ] as Partial<RunConfig>[])(
    "replays exact JSON checkpoints and keeps the nextId invariant under %j",
    async (options) => {
      const cfg = config({
        initialization: "random",
        immigrantRate: 0.25,
        cacheSize: 7,
        ...options,
      });
      const slots = cfg.populationSize - cfg.eliteCount;
      const checkpoint = await generations(
        await initializePopulation(cfg, cheap),
        3,
      );
      expect(checkpoint.nextId).toBe(1 + cfg.populationSize + 3 * slots);
      expect(validateEngineState(json(checkpoint))).toEqual(checkpoint);
      const uninterrupted = await generations(checkpoint, 3);
      const restored = await generations(
        validateEngineState(json(checkpoint)),
        3,
      );
      expect(JSON.stringify(restored)).toBe(JSON.stringify(uninterrupted));
      expect(restored.nextId).toBe(1 + cfg.populationSize + 6 * slots);
      expect(validateEngineState(json(restored))).toEqual(restored);
      const metrics = generationSnapshot(restored).metrics;
      expect(metrics.generationsSinceImprovement).toBe(
        restored.generation - restored.champion.birthGeneration,
      );
      expect(metrics.distinctElites).toBeLessThanOrEqual(cfg.eliteCount);
      expect(metrics.bestCopies).toBeGreaterThanOrEqual(1);
    },
  );
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
