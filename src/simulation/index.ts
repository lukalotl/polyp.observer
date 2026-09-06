/**
 * Five-state, outer-totalistic cellular automata. A deliberately small, visual
 * adaptation of minimal-rule evolution, not a reproduction of a paper model.
 * Every cell sees the occupied (not state-summed) count in its Moore neighborhood.
 */
import { tournamentSelect, uniformCrossover } from "./genetics";

export type SeedMode = "point" | "cross" | "islands";
export type Objective = "complexity" | "longevity" | "growth";
export type Genome = number[];

export interface Preset {
  id: string;
  name: string;
  subtitle: string;
  genome: Genome;
  seed: SeedMode;
}

export interface Config {
  size: number;
  /** Number of recorded layers, including the seed at t=0. */
  steps: number;
  seed: SeedMode;
  randomSeed: number;
}

export interface Simulation {
  /** Row-major layers: layers[t][z * size + x]. */
  layers: Uint8Array[];
  size: number;
  population: number[];
  /** Changed sites / all sites in adjacent recorded layers. */
  activity: number;
  /** Shannon entropy of occupied states / log(4), across all layers. */
  diversity: number;
  /** Mean occupied fraction across all recorded layers. */
  occupancy: number;
  /** Number of nonempty recorded layers (empty space is absorbing). */
  lifetime: number;
  /** True only if extinction was observed within the recorded horizon. */
  extinct: boolean;
}

export interface EvolutionResult {
  genome: Genome;
  simulation: Simulation;
  fitness: number;
  improved: boolean;
}

const STATE_COUNT = 5;
const GENE_COUNT = 45;
const clamp = (value: number) => Math.max(0, Math.min(1, value));

/** Mulberry32: reproducible local RNG; never reads or changes Math.random. */
function randomSource(seed: number): () => number {
  if (!Number.isFinite(seed))
    throw new RangeError("Random seed must be finite.");
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(value ^ (value >>> 15), value | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function validateGenome(genome: Genome): void {
  if (
    genome.length !== GENE_COUNT ||
    Array.from(genome).some(
      (gene) => !Number.isInteger(gene) || gene < 0 || gene >= STATE_COUNT,
    )
  ) {
    throw new RangeError(
      "A genome must contain exactly 45 integer states from 0 through 4.",
    );
  }
  if (genome[0] !== 0)
    throw new RangeError("Gene 0 must remain quiescent (0).");
}

function validateConfig(config: Config): void {
  if (
    !Number.isSafeInteger(config.size) ||
    config.size < 1 ||
    !Number.isSafeInteger(config.steps) ||
    config.steps < 1
  ) {
    throw new RangeError("Size and steps must be positive integers.");
  }
  if (config.size * config.size * config.steps > 16_000_000) {
    throw new RangeError(
      "A simulation may record at most 16 million cell sites.",
    );
  }
  if (!["point", "cross", "islands"].includes(config.seed))
    throw new RangeError("Unknown seed form.");
  if (!Number.isFinite(config.randomSeed))
    throw new RangeError("Random seed must be finite.");
}

function seedLayer(config: Config): Uint8Array {
  const { size, seed } = config;
  const layer = new Uint8Array(size * size);
  const center = Math.floor(size / 2);
  const place = (x: number, z: number, state = 1) => {
    if (x >= 0 && x < size && z >= 0 && z < size) layer[z * size + x] = state;
  };
  place(center, center);
  if (seed === "cross") {
    for (let distance = 1; distance <= 2; distance++) {
      place(center + distance, center);
      place(center - distance, center);
      place(center, center + distance);
      place(center, center - distance);
    }
  } else if (seed === "islands") {
    const random = randomSource(config.randomSeed);
    const radius = Math.max(1, Math.floor(size * 0.16));
    for (let island = 0; island < 7; island++) {
      const x = center + Math.floor(random() * (2 * radius + 1)) - radius;
      const z = center + Math.floor(random() * (2 * radius + 1)) - radius;
      place(x, z, 1 + Math.floor(random() * 4));
      // Small separated nuclei, not a uniform random soup.
      if (random() < 0.65) place(x + 1, z, 1);
      if (random() < 0.65) place(x, z + 1, 2);
    }
  }
  return layer;
}

export function simulate(genome: Genome, config: Config): Simulation {
  validateGenome(genome);
  validateConfig(config);
  const { size, steps } = config;
  const area = size * size;
  const stride = size + 2;
  // A permanently zero halo is both faster and less error-prone than wrapping.
  let current = new Uint8Array(stride * stride);
  let next = new Uint8Array(stride * stride);
  const initial = seedLayer(config);
  for (let z = 0; z < size; z++)
    current.set(
      initial.subarray(z * size, (z + 1) * size),
      (z + 1) * stride + 1,
    );
  const layers: Uint8Array[] = [initial];
  const population: number[] = [];
  const counts = [0, 0, 0, 0, 0];
  let occupied = 0;
  let changed = 0;
  let lifetime = 0;

  for (let t = 0; t < steps; t++) {
    const layer = layers[t];
    let live = 0;
    for (let cell = 0; cell < area; cell++) {
      const state = layer[cell];
      if (state !== 0) {
        live++;
        counts[state]++;
      }
    }
    population.push(live);
    occupied += live;
    if (live > 0) lifetime++;
    if (t === steps - 1) break;
    if (live === 0) {
      // Gene 0 is locked, so an empty layer cannot spontaneously restart.
      for (let rest = t + 1; rest < steps; rest++) {
        layers.push(new Uint8Array(area));
        population.push(0);
      }
      break;
    }
    const result = new Uint8Array(area);
    for (let z = 0; z < size; z++) {
      let padded = (z + 1) * stride + 1;
      let cell = z * size;
      for (let x = 0; x < size; x++, padded++, cell++) {
        const neighbors =
          (current[padded - stride - 1] !== 0 ? 1 : 0) +
          (current[padded - stride] !== 0 ? 1 : 0) +
          (current[padded - stride + 1] !== 0 ? 1 : 0) +
          (current[padded - 1] !== 0 ? 1 : 0) +
          (current[padded + 1] !== 0 ? 1 : 0) +
          (current[padded + stride - 1] !== 0 ? 1 : 0) +
          (current[padded + stride] !== 0 ? 1 : 0) +
          (current[padded + stride + 1] !== 0 ? 1 : 0);
        const state = genome[current[padded] * 9 + neighbors];
        next[padded] = state;
        result[cell] = state;
        if (state !== current[padded]) changed++;
      }
    }
    layers.push(result);
    [current, next] = [next, current];
  }
  let diversity = 0;
  if (occupied > 0) {
    for (let state = 1; state < STATE_COUNT; state++) {
      const proportion = counts[state] / occupied;
      if (proportion > 0)
        diversity -= (proportion * Math.log(proportion)) / Math.log(4);
    }
  }
  return {
    layers,
    size,
    population,
    activity: steps > 1 ? changed / (area * (steps - 1)) : 0,
    diversity: clamp(diversity),
    occupancy: occupied / (area * steps),
    lifetime,
    extinct: population[population.length - 1] === 0,
  };
}

/** Three transparent, bounded heuristic objectives; not biological fitness. */
export function fitness(simulation: Simulation, objective: Objective): number {
  const { population, layers, size, occupancy, diversity, activity, lifetime } =
    simulation;
  const survival = lifetime / layers.length;
  const motion = clamp(activity / Math.max(occupancy, 0.01));
  const final = population[population.length - 1];
  if (objective === "longevity") {
    // Finite-longevity search: surviving at the horizon is censored, not success.
    // The longest observable finite life ends on the final recorded layer.
    return simulation.extinct
      ? clamp(lifetime / Math.max(1, layers.length - 1))
      : 0;
  }
  if (objective === "growth") {
    const gain = clamp(
      (final - population[0]) / Math.max(1, size * size - population[0]),
    );
    return clamp(0.65 * gain + 0.25 * occupancy + 0.1 * survival);
  }
  if (objective !== "complexity")
    throw new RangeError("Unknown fitness objective.");
  const mean = occupancy * size * size;
  const variance =
    population.reduce((sum, count) => sum + (count - mean) ** 2, 0) /
    population.length;
  const breathing = clamp(Math.sqrt(variance) / Math.max(1, mean));
  // Reward visible sparse/mid-density structure; penalize empty and solid fields.
  const density =
    clamp(occupancy / 0.1) * clamp(1 - Math.max(0, occupancy - 0.25) / 0.55);
  return clamp(
    survival *
      (0.34 * diversity + 0.3 * motion + 0.24 * density + 0.12 * breathing),
  );
}

function validateRate(rate: number): void {
  if (!Number.isFinite(rate) || rate < 0 || rate > 1)
    throw new RangeError("Mutation rate must be between 0 and 1.");
}

function mutateWithRandom(
  genome: Genome,
  rate: number,
  random: () => number,
): Genome {
  const result = genome.slice();
  for (let gene = 1; gene < GENE_COUNT; gene++) {
    if (random() < rate) {
      // Each mutation changes the output; never silently reselect its old value.
      result[gene] =
        (result[gene] + 1 + Math.floor(random() * 4)) % STATE_COUNT;
    }
  }
  result[0] = 0;
  return result;
}

export function mutate(genome: Genome, rate: number, seed: number): Genome {
  validateGenome(genome);
  validateRate(rate);
  return mutateWithRandom(genome, rate, randomSource(seed));
}

/** Stable short display fingerprint, not a cryptographic or collision-free ID. */
export function genomeId(genome: Genome): string {
  validateGenome(genome);
  let hash = 2166136261;
  for (const gene of genome) hash = Math.imul(hash ^ gene, 16777619) >>> 0;
  return hash.toString(16).padStart(8, "0").toUpperCase();
}

/**
 * One UI iteration = three rounds of an eight-member population search.
 * Two elites survive each round; tournament selection, uniform crossover, and
 * point mutation create the remaining offspring. All candidates share one seed
 * fixture and full simulation horizon for a fair, deterministic comparison.
 */
export function evolve(
  genome: Genome,
  config: Config,
  objective: Objective,
  mutationRate: number,
  randomSeed: number,
): EvolutionResult {
  validateGenome(genome);
  validateConfig(config);
  validateRate(mutationRate);
  const random = randomSource(randomSeed);
  type Candidate = { genome: Genome; simulation: Simulation; fitness: number };
  const cache = new Map<string, Candidate>();
  const evaluate = (candidateGenome: Genome): Candidate => {
    const key = candidateGenome.join("");
    const cached = cache.get(key);
    if (cached) return cached;
    const simulation = simulate(candidateGenome, config);
    const candidate = {
      genome: candidateGenome,
      simulation,
      fitness: fitness(simulation, objective),
    };
    cache.set(key, candidate);
    return candidate;
  };
  const original = evaluate(genome.slice());
  let population = [original];
  for (let i = 1; i < 8; i++)
    population.push(evaluate(mutateWithRandom(genome, mutationRate, random)));
  for (let round = 0; round < 3; round++) {
    population.sort((a, b) => b.fitness - a.fitness);
    const offspring = population.slice(0, 2);
    while (offspring.length < 8) {
      const first = tournamentSelect(population, random).genome;
      const second = tournamentSelect(population, random).genome;
      const child = uniformCrossover(first, second, random);
      offspring.push(evaluate(mutateWithRandom(child, mutationRate, random)));
    }
    population = offspring;
  }
  population.sort((a, b) => b.fitness - a.fitness);
  const bestFitness = population[0].fitness;
  // Distinct exact ties may differ at neutral loci. Selecting among all evaluated
  // best genotypes permits a neutral walk between calls instead of freezing on
  // the incumbent through stable-sort order. The cache removes duplicate bias.
  const ties = [...cache.values()].filter(
    (candidate) => candidate.fitness === bestFitness,
  );
  const best = ties[Math.floor(random() * ties.length)];
  return {
    ...best,
    genome: best.genome.slice(),
    improved: best.fitness > original.fitness + 1e-12,
  };
}

export const PRESETS: Preset[] = [
  {
    id: "dendrite",
    name: "Dendrite",
    subtitle: "A branching crown",
    seed: "cross",
    genome: [
      0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 2, 2, 2, 2, 2, 0, 0, 0, 0, 3, 3, 3, 3, 3,
      0, 0, 0, 0, 4, 4, 4, 4, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ],
  },
  {
    id: "pagoda",
    name: "Pagoda",
    subtitle: "Terraces of lace",
    seed: "point",
    genome: [
      0, 1, 0, 0, 0, 0, 0, 0, 0, 2, 2, 2, 2, 2, 0, 0, 0, 0, 3, 3, 3, 3, 3, 0, 0,
      0, 0, 4, 4, 4, 4, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ],
  },
  {
    id: "archipelago",
    name: "Archipelago",
    subtitle: "An irregular canopy",
    seed: "islands",
    genome: [
      0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 2, 2, 2, 2, 2, 0, 0, 0, 0, 3, 3, 3, 3, 3, 0,
      0, 0, 0, 4, 4, 4, 4, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ],
  },
];
