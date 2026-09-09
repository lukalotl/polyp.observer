import type { Genome } from "../simulation";
import {
  exactKeys,
  finite,
  integer,
  record,
  validateGenome,
  validateRunConfig,
  migrateLegacyRunConfig,
} from "./config";
import { evaluateBatch } from "./evaluate";
import {
  MODEL_VERSION,
  LEGACY_MODEL_VERSION,
  PREVIOUS_MODEL_VERSION,
  type BatchEvaluator,
  type CachedEvaluation,
  type EngineState,
  type Evaluation,
  type FitnessMetrics,
  type GenerationSnapshot,
  type Individual,
  type ParentRef,
  type RunConfig,
} from "./types";

import { genomeKey as keyOf } from "./genome";
const metricKeys: (keyof FitnessMetrics)[] = [
  "diversity",
  "activity",
  "density",
  "variation",
  "persistence",
  "occupancy",
  "lifetime",
  "extinctFraction",
];
const evaluationKeys = [
  "fitness",
  "validationFitness",
  "disqualified",
  "validationDisqualified",
  "trainingScores",
  "validationScores",
  "metrics",
];
const individualKeys = [
  ...evaluationKeys,
  "id",
  "genome",
  "birthGeneration",
  "origin",
  "parents",
  "crossoverMask",
  "mutatedLoci",
];
const stateKeys = [
  "version",
  "modelVersion",
  "config",
  "generation",
  "rngState",
  "nextId",
  "population",
  "champion",
  "evaluations",
  "cacheHits",
  "cache",
];
const copy = <T>(value: T): T => structuredClone(value);

class Random {
  constructor(public state: number) {}
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(this.state ^ (this.state >>> 15), this.state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  }
  index(length: number): number {
    return Math.floor(this.next() * length);
  }
}
function randomGenome(random: Random, config: RunConfig): Genome {
  return Array.from({ length: 9 * config.stateCount }, (_, locus) => {
    if (locus === 0) return 0;
    // Preserve the original draw and mapping for existing saved searches.
    if (config.randomRuleBias !== "sparse")
      return random.index(config.stateCount);
    // Empty cells on an advancing outer edge see at most three live neighbors.
    // B1 is especially prone to maximum-speed radial growth. Keep these births
    // possible, but rare; distribute the remaining probability across live states.
    const emptyChance = locus === 1 ? 0.98 : locus <= 3 ? 0.95 : 0.8;
    const draw = random.next();
    return draw < emptyChance
      ? 0
      : 1 +
          Math.floor(
            ((draw - emptyChance) / (1 - emptyChance)) *
              (config.stateCount - 1),
          );
  });
}
function mutate(genome: Genome, rate: number, random: Random): number[] {
  const stateCount = genome.length / 9;
  const loci: number[] = [];
  for (let i = 1; i < genome.length; i++)
    if (random.next() < rate) {
      genome[i] = (genome[i] + 1 + random.index(stateCount - 1)) % stateCount;
      loci.push(i);
    }
  return loci;
}
function parentRef(individual: Individual): ParentRef {
  return {
    id: individual.id,
    genome: individual.genome.slice(),
    fitness: individual.fitness,
    birthGeneration: individual.birthGeneration,
  };
}
function aggregate(scores: number[], config: RunConfig): number {
  return config.aggregation === "minimum"
    ? Math.min(...scores)
    : scores.reduce((a, b) => a + b, 0) / scores.length;
}
export function validateEvaluation(
  value: unknown,
  config: RunConfig,
  strict = true,
): Evaluation {
  const v = record(value, "Evaluation");
  if (strict)
    exactKeys(
      v,
      [
        ...evaluationKeys,
        ...(Object.hasOwn(v, "fixturePasses") ? ["fixturePasses"] : []),
      ],
      "Evaluation",
    );
  const scores = (value: unknown, length: number, label: string) => {
    if (!Array.isArray(value) || value.length !== length)
      throw new RangeError(`${label} fixture count mismatch.`);
    return Array.from(value, (score) => finite(score, 0, 1, label));
  };
  const trainingScores = scores(
    v.trainingScores,
    config.trainingSeeds.length,
    "Training scores",
  );
  const validationScores = scores(
    v.validationScores,
    config.validationSeeds.length,
    "Validation scores",
  );
  const fitness = finite(v.fitness, 0, 1, "Fitness");
  const validationFitness =
    v.validationFitness === null
      ? null
      : finite(v.validationFitness, 0, 1, "Validation fitness");
  if (
    typeof v.disqualified !== "boolean" ||
    typeof v.validationDisqualified !== "boolean"
  )
    throw new RangeError("Disqualification flags must be boolean.");
  const { disqualified, validationDisqualified } = v;
  if (
    (!config.boundaryPolicy.spatial &&
      !config.boundaryPolicy.horizon &&
      (config.incentives ||
        (config.objective !== "finiteSparse" &&
          config.objective !== "finiteDense")) &&
      (disqualified || validationDisqualified)) ||
    (disqualified && !trainingScores.includes(0)) ||
    (validationDisqualified && !validationScores.includes(0))
  )
    throw new RangeError(
      "Disqualification contradicts boundary policy or fixture scores.",
    );
  if (
    Math.abs(
      fitness -
        (disqualified && config.fixtureFailures !== "aggregate"
          ? 0
          : aggregate(trainingScores, config)),
    ) > 1e-12 ||
    (validationScores.length === 0
      ? validationFitness !== null
      : validationFitness === null ||
        Math.abs(
          validationFitness -
            (validationDisqualified && config.fixtureFailures !== "aggregate"
              ? 0
              : aggregate(validationScores, config)),
        ) > 1e-12)
  )
    throw new RangeError(
      "Fitness must match the configured fixture aggregation.",
    );
  let fixturePasses: Evaluation["fixturePasses"];
  if (Object.hasOwn(v, "fixturePasses")) {
    const passes = record(v.fixturePasses, "Fixture passes");
    exactKeys(passes, ["training", "validation"], "Fixture passes");
    const validatePasses = (
      value: unknown,
      scores: number[],
      failed: boolean,
    ) => {
      if (
        !Array.isArray(value) ||
        value.length !== scores.length ||
        value.some(
          (pass, index) =>
            typeof pass !== "boolean" || (!pass && scores[index] !== 0),
        ) ||
        value.some((pass) => !pass) !== failed
      )
        throw new RangeError(
          "Fixture passes must agree with scores and disqualification.",
        );
      return [...value] as boolean[];
    };
    fixturePasses = {
      training: validatePasses(passes.training, trainingScores, disqualified),
      validation: validatePasses(
        passes.validation,
        validationScores,
        validationDisqualified,
      ),
    };
  }
  const m = record(v.metrics, "Metrics");
  exactKeys(m, metricKeys, "Metrics");
  const metrics = Object.fromEntries(
    metricKeys.map((key) => [
      key,
      finite(m[key], 0, key === "lifetime" ? config.steps : 1, key),
    ]),
  ) as unknown as FitnessMetrics;
  if (Math.abs(metrics.persistence - metrics.lifetime / config.steps) > 1e-12)
    throw new RangeError("Persistence must match mean lifetime / horizon.");
  return {
    ...(fixturePasses ? { fixturePasses } : {}),
    fitness,
    validationFitness,
    disqualified,
    validationDisqualified,
    trainingScores,
    validationScores,
    metrics,
  };
}

/** Transaction-local LRU. Batch duplicates hit even with persistent cache disabled.
 * Insertion/touch order follows candidates, never asynchronous completion order.
 */
async function evaluateCandidates(
  genomes: Genome[],
  state: Pick<EngineState, "config" | "cache" | "evaluations" | "cacheHits">,
  evaluate: BatchEvaluator,
): Promise<Evaluation[]> {
  const config = state.config;
  const retained = new Map(
    state.cache.map((entry) => [entry.key, entry.evaluation]),
  );
  const resolved = new Map<string, Evaluation>();
  const missing: Genome[] = [],
    missingKeys: string[] = [];
  for (const genome of genomes) {
    const key = keyOf(genome);
    if (resolved.has(key) || missingKeys.includes(key)) {
      state.cacheHits++;
      continue;
    }
    const hit = retained.get(key);
    if (hit) {
      state.cacheHits++;
      resolved.set(key, hit);
    } else {
      missingKeys.push(key);
      missing.push(genome.slice());
    }
  }
  if (missing.length) {
    // The evaluator receives no references into the transaction's genomes/config.
    const results = await evaluate(missing, copy(config));
    if (!Array.isArray(results) || results.length !== missing.length)
      throw new RangeError("Evaluator returned wrong batch length.");
    for (let i = 0; i < results.length; i++)
      resolved.set(missingKeys[i], validateEvaluation(results[i], config));
    state.evaluations +=
      missing.length *
      (config.trainingSeeds.length + config.validationSeeds.length);
    if (!Number.isSafeInteger(state.evaluations))
      throw new RangeError("Evaluation counter exhausted.");
  }
  const output = genomes.map((genome) => {
    const key = keyOf(genome),
      result = resolved.get(key)!;
    if (config.cacheSize) {
      retained.delete(key);
      retained.set(key, result);
      if (retained.size > config.cacheSize)
        retained.delete(retained.keys().next().value!);
    }
    return copy(result);
  });
  state.cache = config.cacheSize
    ? Array.from(retained, ([key, evaluation]) => ({
        key,
        evaluation: copy(evaluation),
      }))
    : [];
  return output;
}

/** Generation zero is a real population, not a transient neighborhood of a winner. */
export async function initializePopulation(
  config: RunConfig,
  evaluate: BatchEvaluator = evaluateBatch,
): Promise<EngineState> {
  const checked = validateRunConfig(config),
    random = new Random(checked.randomSeed >>> 0);
  const metadata: Omit<Individual, keyof Evaluation>[] = [];
  for (let i = 0; i < checked.populationSize; i++) {
    const genome =
      checked.initialization === "random"
        ? randomGenome(random, checked)
        : checked.seedGenome.slice();
    const mutatedLoci =
      checked.initialization === "mutants" && i > 0
        ? mutate(genome, checked.mutationRate, random)
        : [];
    metadata.push({
      id: `i${i + 1}`,
      genome,
      birthGeneration: 0,
      origin:
        checked.initialization === "random"
          ? "random"
          : i === 0
            ? "founder"
            : mutatedLoci.length
              ? "mutant"
              : "clone",
      parents: [],
      crossoverMask: Array(genome.length).fill(0),
      mutatedLoci,
    });
  }
  const transaction = {
    config: checked,
    cache: [] as CachedEvaluation[],
    evaluations: 0,
    cacheHits: 0,
  };
  const results = await evaluateCandidates(
    metadata.map((item) => item.genome),
    transaction,
    evaluate,
  );
  const population = metadata.map(
    (item, index): Individual => ({
      ...item,
      ...results[index],
    }),
  );
  if (checked.initialization === "mutants")
    for (const item of population.slice(1))
      item.parents = [parentRef(population[0])];
  const champion = population.reduce((best, item) =>
    item.fitness > best.fitness ? item : best,
  );
  return {
    ...transaction,
    version: 1,
    modelVersion: MODEL_VERSION,
    generation: 0,
    rngState: random.state,
    nextId: checked.populationSize + 1,
    population,
    champion: copy(champion),
  };
}

function selector(
  population: Individual[],
  config: RunConfig,
  random: Random,
): () => Individual {
  if (config.selection === "tournament")
    return () => {
      let best = population[random.index(population.length)];
      for (let i = 1; i < config.tournamentSize; i++) {
        const contender = population[random.index(population.length)];
        if (contender.fitness > best.fitness) best = contender;
      }
      return best;
    };
  const ranked = population.slice().sort((a, b) => a.fitness - b.fitness);
  // Linear-rank pressure (1..N), averaging ranks for ties avoids ID/order bias
  // on neutral plateaus and uses no held-out scores.
  const weights = ranked.map((_, i) => i + 1);
  for (let start = 0; start < ranked.length; ) {
    let end = start + 1;
    while (end < ranked.length && ranked[end].fitness === ranked[start].fitness)
      end++;
    const average = (start + 1 + end) / 2;
    weights.fill(average, start, end);
    start = end;
  }
  const total = (ranked.length * (ranked.length + 1)) / 2;
  return () => {
    let draw = random.next() * total;
    for (let i = 0; i < ranked.length; i++) {
      draw -= weights[i];
      if (draw < 0) return ranked[i];
    }
    return ranked[ranked.length - 1];
  };
}

/** Copy-on-advance: failed/aborted evaluation cannot change population, RNG or cache. */
export async function advanceGeneration(
  input: EngineState,
  evaluate: BatchEvaluator = evaluateBatch,
): Promise<EngineState> {
  const state = validateEngineState(input),
    config = state.config;
  if (
    state.generation >= 1_000_000_000 ||
    (config.maxGenerations > 0 && state.generation >= config.maxGenerations)
  )
    throw new RangeError("Run has reached its generation limit.");
  const random = new Random(state.rngState),
    generation = state.generation + 1;
  const select = selector(state.population, config, random);
  const elites = state.population
    .slice()
    .sort((a, b) => b.fitness - a.fitness)
    .slice(0, config.eliteCount);
  const immigrants = Math.floor(config.populationSize * config.immigrantRate);
  const metadata: Omit<Individual, keyof Evaluation>[] = [];
  const children = config.populationSize - elites.length - immigrants;
  for (let i = 0; i < children + immigrants; i++) {
    const isImmigrant = i >= children;
    const first = isImmigrant ? null : select();
    const parents = first ? [parentRef(first)] : [];
    const genome = first ? first.genome.slice() : randomGenome(random, config);
    const crossoverMask = Array(genome.length).fill(0);
    let crossed = false;
    if (
      first &&
      config.crossover !== "none" &&
      random.next() < config.crossoverRate
    ) {
      const second = select();
      parents.push(parentRef(second));
      crossed = true;
      const cut =
        config.crossover === "onePoint"
          ? 1 + random.index(genome.length - 2)
          : 0;
      for (let locus = 1; locus < genome.length; locus++) {
        const fromSecond =
          config.crossover === "onePoint" ? locus > cut : random.next() < 0.5;
        if (fromSecond) {
          genome[locus] = second.genome[locus];
          crossoverMask[locus] = 1;
        }
      }
    }
    const mutatedLoci = first
      ? mutate(genome, config.mutationRate, random)
      : [];
    metadata.push({
      id: `i${state.nextId++}`,
      genome,
      birthGeneration: generation,
      origin: isImmigrant
        ? "immigrant"
        : crossed
          ? "crossover"
          : mutatedLoci.length
            ? "mutant"
            : "clone",
      parents,
      crossoverMask,
      mutatedLoci,
    });
  }
  const results = await evaluateCandidates(
    metadata.map((item) => item.genome),
    state,
    evaluate,
  );
  state.population = [
    ...elites,
    ...metadata.map(
      (item, index): Individual => ({
        ...item,
        ...results[index],
      }),
    ),
  ];
  const best = state.population.reduce((best, item) =>
    item.fitness > best.fitness ? item : best,
  );
  if (best.fitness > state.champion.fitness) state.champion = copy(best);
  state.generation = generation;
  state.rngState = random.state;
  return state;
}

/** Detached snapshot: callers may serialize/render freely without aliasing live state. */
export function generationSnapshot(state: EngineState): GenerationSnapshot {
  const { stateCount } = state.config;
  const geneCount = 9 * stateCount;
  const fitnesses = state.population
    .map((item) => item.fitness)
    .sort((a, b) => a - b);
  const count = fitnesses.length,
    middle = Math.floor(count / 2);
  let diversity = 0;
  for (let locus = 1; locus < geneCount; locus++) {
    const counts = Array<number>(stateCount).fill(0);
    for (const item of state.population) counts[item.genome[locus]]++;
    for (const frequency of counts)
      if (frequency) {
        const p = frequency / count;
        diversity -= (p * Math.log(p)) / Math.log(stateCount) / (geneCount - 1);
      }
  }
  const validation = state.population.flatMap((item) =>
    item.validationFitness === null ? [] : [item.validationFitness],
  );
  // Breeding diversity: whole-population uniqueness overstates the variety
  // among the individuals most likely to be retained and selected.
  const ranked = state.population.slice().sort((a, b) => b.fitness - a.fitness);
  const bestKey = keyOf(ranked[0].genome);
  return {
    generation: state.generation,
    population: copy(state.population),
    champion: copy(state.champion),
    metrics: {
      generation: state.generation,
      best: fitnesses[count - 1],
      mean: fitnesses.reduce((a, b) => a + b, 0) / count,
      worst: fitnesses[0],
      median:
        count % 2
          ? fitnesses[middle]
          : (fitnesses[middle - 1] + fitnesses[middle]) / 2,
      bestEver: state.champion.fitness,
      validationBest: validation.length ? Math.max(...validation) : null,
      diversity: Math.max(0, Math.min(1, diversity)),
      uniqueGenomes: new Set(state.population.map((item) => keyOf(item.genome)))
        .size,
      evaluations: state.evaluations,
      cacheHits: state.cacheHits,
      distinctElites: new Set(
        ranked
          .slice(0, state.config.eliteCount)
          .map((item) => keyOf(item.genome)),
      ).size,
      bestCopies: ranked.filter((item) => keyOf(item.genome) === bestKey)
        .length,
      generationsSinceImprovement:
        state.generation - state.champion.birthGeneration,
    },
  };
}

/** Explicit v1/v2 migration preserves scores and never replays historical selection. */
function migrateLegacyEvaluation(value: unknown, individual = false) {
  const v = record(value, "Legacy evaluation");
  exactKeys(
    v,
    [
      ...(individual ? individualKeys : evaluationKeys),
      ...(Object.hasOwn(v, "fixturePasses") ? ["fixturePasses"] : []),
    ].filter(
      (key) => key !== "disqualified" && key !== "validationDisqualified",
    ),
    "Legacy evaluation",
  );
  return { ...v, disqualified: false, validationDisqualified: false };
}
export function migrateLegacyIndividual(value: unknown) {
  return migrateLegacyEvaluation(value, true);
}

/** Checkpoint trust boundary: bounded lengths checked before allocating; no coercion.
 * This validates structural/scientific invariants, not authenticity of externally
 * supplied fitness values (that would require replaying every historical fixture).
 */
export function validateEngineState(value: unknown): EngineState {
  const v = record(value, "Engine state");
  exactKeys(v, stateKeys, "Engine state");
  if (
    v.version === 1 &&
    (v.modelVersion === LEGACY_MODEL_VERSION ||
      v.modelVersion === PREVIOUS_MODEL_VERSION)
  ) {
    const config = migrateLegacyRunConfig(v.config, v.modelVersion);
    if (
      !Array.isArray(v.population) ||
      v.population.length !== config.populationSize ||
      !Array.isArray(v.cache) ||
      v.cache.length > config.cacheSize
    )
      throw new RangeError("Legacy population/cache size mismatch.");
    return validateEngineState({
      ...v,
      modelVersion: MODEL_VERSION,
      config,
      population: v.population.map(migrateLegacyIndividual),
      champion: migrateLegacyIndividual(v.champion),
      cache: v.cache.map((entry) => {
        const item = record(entry, "Legacy cache entry");
        exactKeys(item, ["key", "evaluation"], "Legacy cache entry");
        return {
          key: item.key,
          evaluation: migrateLegacyEvaluation(item.evaluation),
        };
      }),
    });
  }
  if (v.version !== 1 || v.modelVersion !== MODEL_VERSION)
    throw new RangeError("Unsupported engine/model version.");
  const config = validateRunConfig(v.config);
  const geneCount = 9 * config.stateCount;
  const generation = integer(v.generation, 0, 1_000_000_000, "Generation");
  if (config.maxGenerations > 0 && generation > config.maxGenerations)
    throw new RangeError("Generation exceeds configured limit.");
  const rngState = integer(v.rngState, 0, 0xffff_ffff, "RNG state");
  const nextId = integer(v.nextId, 1, Number.MAX_SAFE_INTEGER, "Next ID");
  if (
    nextId !==
    1 +
      config.populationSize +
      generation * (config.populationSize - config.eliteCount)
  )
    throw new RangeError("Next ID does not match retained-population history.");
  const id = (value: unknown): string => {
    if (
      typeof value !== "string" ||
      !/^i[1-9][0-9]{0,14}$/.test(value) ||
      !Number.isSafeInteger(Number(value.slice(1))) ||
      Number(value.slice(1)) >= nextId
    )
      throw new RangeError("Invalid individual ID.");
    return value;
  };
  const parent = (value: unknown): ParentRef => {
    const p = record(value, "Parent");
    exactKeys(p, ["id", "genome", "fitness", "birthGeneration"], "Parent");
    return {
      id: id(p.id),
      genome: validateGenome(p.genome, config.stateCount),
      fitness: finite(p.fitness, 0, 1, "Parent fitness"),
      birthGeneration: integer(
        p.birthGeneration,
        0,
        generation,
        "Parent birth generation",
      ),
    };
  };
  const individual = (value: unknown): Individual => {
    const item = record(value, "Individual");
    exactKeys(
      item,
      [
        ...individualKeys,
        ...(Object.hasOwn(item, "fixturePasses") ? ["fixturePasses"] : []),
      ],
      "Individual",
    );
    const individualId = id(item.id),
      genome = validateGenome(item.genome, config.stateCount);
    const birthGeneration = integer(
      item.birthGeneration,
      0,
      generation,
      "Birth generation",
    );
    if (!Array.isArray(item.parents) || item.parents.length > 2)
      throw new RangeError("At most two parents are permitted.");
    const parents = Array.from(item.parents, parent);
    if (
      parents.some(
        (p) =>
          Number(p.id.slice(1)) >= Number(individualId.slice(1)) ||
          p.birthGeneration > (birthGeneration === 0 ? 0 : birthGeneration - 1),
      )
    )
      throw new RangeError("Parents must precede their offspring.");
    if (
      !Array.isArray(item.crossoverMask) ||
      item.crossoverMask.length !== geneCount
    )
      throw new RangeError(`Crossover mask must have ${geneCount} entries.`);
    const crossoverMask = Array.from(item.crossoverMask, (entry) =>
      integer(entry, 0, Math.max(0, parents.length - 1), "Crossover mask"),
    );
    if (crossoverMask[0] !== 0)
      throw new RangeError("Crossover cannot alter quiescent locus.");
    if (
      !Array.isArray(item.mutatedLoci) ||
      item.mutatedLoci.length > geneCount - 1
    )
      throw new RangeError("Invalid mutation trace.");
    const mutatedLoci = Array.from(item.mutatedLoci, (locus) =>
      integer(locus, 1, geneCount - 1, "Mutated locus"),
    );
    if (
      mutatedLoci.some(
        (locus, index) => index > 0 && locus <= mutatedLoci[index - 1],
      )
    )
      throw new RangeError("Mutation trace must be unique and ordered.");
    const origin = item.origin;
    if (
      ![
        "founder",
        "random",
        "mutant",
        "crossover",
        "clone",
        "immigrant",
      ].includes(origin as string)
    )
      throw new RangeError("Unknown individual origin.");
    if (
      (origin === "crossover" && parents.length !== 2) ||
      ((origin === "mutant" || origin === "clone") && parents.length !== 1) ||
      ((origin === "founder" ||
        origin === "random" ||
        origin === "immigrant") &&
        (parents.length !== 0 || mutatedLoci.length !== 0)) ||
      (origin === "mutant" && mutatedLoci.length === 0) ||
      (origin === "clone" && mutatedLoci.length !== 0) ||
      ((origin === "founder" || origin === "random") &&
        birthGeneration !== 0) ||
      (origin === "immigrant" && birthGeneration === 0)
    )
      throw new RangeError("Origin contradicts ancestry/mutation trace.");
    if (parents.length)
      for (let locus = 0; locus < genome.length; locus++) {
        const source = parents[crossoverMask[locus]].genome[locus];
        if ((genome[locus] !== source) !== mutatedLoci.includes(locus))
          throw new RangeError("Genome contradicts crossover/mutation trace.");
      }
    return {
      ...validateEvaluation(item, config, false),
      id: individualId,
      genome,
      birthGeneration,
      origin: origin as Individual["origin"],
      parents,
      crossoverMask,
      mutatedLoci,
    };
  };
  if (
    !Array.isArray(v.population) ||
    v.population.length !== config.populationSize
  )
    throw new RangeError("Population size mismatch.");
  const population = Array.from(v.population, individual);
  if (new Set(population.map((item) => item.id)).size !== population.length)
    throw new RangeError("Duplicate population IDs.");
  const champion = individual(v.champion);
  if (population.some((item) => item.fitness > champion.fitness))
    throw new RangeError("All-time champion is worse than population best.");
  const currentChampion = population.find((item) => item.id === champion.id);
  if (
    currentChampion &&
    JSON.stringify(currentChampion) !== JSON.stringify(champion)
  )
    throw new RangeError("Champion conflicts with population identity.");
  if (!Array.isArray(v.cache) || v.cache.length > config.cacheSize)
    throw new RangeError("Cache exceeds configured bound.");
  const cache = Array.from(v.cache, (value) => {
    const item = record(value, "Cache entry");
    exactKeys(item, ["key", "evaluation"], "Cache entry");
    if (
      typeof item.key !== "string" ||
      item.key.length !== geneCount ||
      item.key[0] !== "0" ||
      [...item.key].some(
        (char) =>
          !/^[0-9a-f]$/.test(char) || parseInt(char, 16) >= config.stateCount,
      )
    )
      throw new RangeError("Cache key must be a complete quiescent genome.");
    return {
      key: item.key,
      evaluation: validateEvaluation(item.evaluation, config),
    };
  });
  if (new Set(cache.map((entry) => entry.key)).size !== cache.length)
    throw new RangeError("Duplicate LRU cache keys.");
  // Known identities and genotype evaluations must agree everywhere they recur;
  // checkpoints are not allowed to smuggle conflicting ancestry or cache data.
  const identities = new Map<string, string>(),
    knownEvaluations = new Map<string, Evaluation>();
  const rememberIdentity = (reference: ParentRef) => {
    const signature = JSON.stringify(reference);
    if (
      identities.has(reference.id) &&
      identities.get(reference.id) !== signature
    )
      throw new RangeError("Conflicting references to one individual ID.");
    identities.set(reference.id, signature);
  };
  const rememberEvaluation = (key: string, result: Evaluation) => {
    const prior = knownEvaluations.get(key);
    if (
      prior &&
      (prior.fitness !== result.fitness ||
        prior.validationFitness !== result.validationFitness ||
        prior.trainingScores.some(
          (score, i) => score !== result.trainingScores[i],
        ) ||
        prior.validationScores.some(
          (score, i) => score !== result.validationScores[i],
        ) ||
        metricKeys.some((key) => prior.metrics[key] !== result.metrics[key]))
    )
      throw new RangeError("Conflicting evaluations for one genotype.");
    knownEvaluations.set(key, result);
  };
  for (const item of [...population, champion]) {
    rememberIdentity(parentRef(item));
    item.parents.forEach(rememberIdentity);
    rememberEvaluation(keyOf(item.genome), item);
  }
  for (const entry of cache) rememberEvaluation(entry.key, entry.evaluation);
  const evaluations = integer(
    v.evaluations,
    0,
    Number.MAX_SAFE_INTEGER,
    "Evaluation count",
  );
  const cacheHits = integer(
    v.cacheHits,
    0,
    Number.MAX_SAFE_INTEGER,
    "Cache hits",
  );
  const fixtures = config.trainingSeeds.length + config.validationSeeds.length;
  if (
    evaluations % fixtures !== 0 ||
    evaluations / fixtures + cacheHits !== nextId - 1
  )
    throw new RangeError(
      "Evaluation/cache counters do not match candidate history.",
    );
  return {
    version: 1,
    modelVersion: MODEL_VERSION,
    config,
    generation,
    rngState,
    nextId,
    population,
    champion,
    evaluations,
    cacheHits,
    cache,
  };
}
