import type { Genome } from "../simulation";
import { validateGenome, validateRunConfig } from "./config";
import type { Evaluation, FitnessMetrics, RunConfig } from "./types";

const clamp = (value: number) => Math.max(0, Math.min(1, value));
const metricKeys: (keyof FitnessMetrics)[] = ["diversity", "activity", "density", "variation", "persistence", "occupancy", "lifetime", "extinctFraction"];

/** Mulberry32, identical to the frozen simulation's island-fixture RNG. */
function fixtureRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** Two haloed lattice buffers, plus O(steps) counts; never retains a space-time volume. */
function fixture(genome: Genome, config: RunConfig, seed: number): { score: number; metrics: FitnessMetrics } {
  const { size, steps } = config;
  const area = size * size, stride = size + 2;
  let current = new Uint8Array(stride * stride), next = new Uint8Array(stride * stride);
  let minX = size, minZ = size, maxX = -1, maxZ = -1;
  const place = (x: number, z: number, state = 1) => {
    if (x < 0 || z < 0 || x >= size || z >= size) return;
    current[(z + 1) * stride + x + 1] = state;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  };
  const center = Math.floor(size / 2);
  place(center, center);
  if (config.seed === "cross") {
    for (let d = 1; d <= 2; d++) {
      place(center + d, center); place(center - d, center);
      place(center, center + d); place(center, center - d);
    }
  } else if (config.seed === "islands") {
    const random = fixtureRandom(seed), radius = Math.max(1, Math.floor(size * 0.16));
    for (let island = 0; island < 7; island++) {
      const x = center + Math.floor(random() * (2 * radius + 1)) - radius;
      const z = center + Math.floor(random() * (2 * radius + 1)) - radius;
      place(x, z, 1 + Math.floor(random() * 4));
      if (random() < 0.65) place(x + 1, z, 1);
      if (random() < 0.65) place(x, z + 1, 2);
    }
  }
  const population = new Float64Array(steps), counts = [0, 0, 0, 0, 0];
  let live = 0, occupied = 0, changed = 0, lifetime = 0;
  for (let z = minZ; z <= maxZ; z++) for (let x = minX; x <= maxX; x++) {
    const state = current[(z + 1) * stride + x + 1];
    if (state) { live++; counts[state]++; }
  }
  for (let t = 0; t < steps; t++) {
    population[t] = live; occupied += live;
    if (live > 0) lifetime++;
    // Locked gene 0 makes all remaining layers identically zero. Their counts
    // already occupy the zero-filled array, preserving denominators and variance.
    if (t === steps - 1 || live === 0) break;
    const fromX = Math.max(0, minX - 1), toX = Math.min(size - 1, maxX + 1);
    const fromZ = Math.max(0, minZ - 1), toZ = Math.min(size - 1, maxZ + 1);
    minX = size; minZ = size; maxX = -1; maxZ = -1;
    // Reused output can contain cells from two steps ago outside today's box.
    // Clear them: otherwise contraction followed by expansion resurrects ghosts.
    next.fill(0);
    live = 0;
    for (let z = fromZ; z <= toZ; z++) {
      let index = (z + 1) * stride + fromX + 1;
      for (let x = fromX; x <= toX; x++, index++) {
        const neighbors =
          (current[index - stride - 1] !== 0 ? 1 : 0) + (current[index - stride] !== 0 ? 1 : 0) +
          (current[index - stride + 1] !== 0 ? 1 : 0) + (current[index - 1] !== 0 ? 1 : 0) +
          (current[index + 1] !== 0 ? 1 : 0) + (current[index + stride - 1] !== 0 ? 1 : 0) +
          (current[index + stride] !== 0 ? 1 : 0) + (current[index + stride + 1] !== 0 ? 1 : 0);
        const state = genome[current[index] * 9 + neighbors];
        next[index] = state;
        if (state !== current[index]) changed++;
        if (state) {
          live++; counts[state]++;
          minX = Math.min(minX, x); maxX = Math.max(maxX, x);
          minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
        }
      }
    }
    [current, next] = [next, current];
  }
  const occupancy = occupied / (area * steps), persistence = lifetime / steps;
  let diversity = 0;
  if (occupied > 0) for (let state = 1; state < 5; state++) {
    const proportion = counts[state] / occupied;
    if (proportion > 0) diversity -= proportion * Math.log(proportion) / Math.log(4);
  }
  diversity = clamp(diversity);
  const activity = clamp((changed / (area * (steps - 1))) / Math.max(occupancy, 0.01));
  const mean = occupancy * area;
  // Same ordered sum as legacy, not E[x²]-E[x]² (which loses precision).
  const variance = population.reduce((sum, count) => sum + (count - mean) ** 2, 0) / steps;
  const variation = clamp(Math.sqrt(variance) / Math.max(1, mean));
  const density = clamp(occupancy / 0.1) * clamp(1 - Math.max(0, occupancy - 0.25) / 0.55);
  const final = population[steps - 1], extinct = final === 0;
  const metrics: FitnessMetrics = { diversity, activity, density, variation, persistence, occupancy, lifetime, extinctFraction: extinct ? 1 : 0 };
  let score: number;
  if (config.objective === "longevity") score = extinct ? clamp(lifetime / Math.max(1, steps - 1)) : 0;
  else if (config.objective === "growth") {
    const gain = clamp((final - population[0]) / Math.max(1, area - population[0]));
    score = clamp(0.65 * gain + 0.25 * occupancy + 0.1 * persistence);
  } else {
    const w = config.weights, total = w.diversity + w.activity + w.density + w.variation;
    // Normalize first, so even finite subnormal positive weights cannot lose
    // their entire weighted numerator to underflow. Default total is exactly 1.
    score = clamp(persistence * ((w.diversity / total) * diversity + (w.activity / total) * activity + (w.density / total) * density + (w.variation / total) * variation));
  }
  return { score, metrics };
}

function evaluateValid(genome: Genome, config: RunConfig): Evaluation {
  const training = config.trainingSeeds.map(seed => fixture(genome, config, seed));
  const trainingScores = training.map(result => result.score);
  const validationScores = config.validationSeeds.map(seed => fixture(genome, config, seed).score);
  const aggregate = (scores: number[]) => config.aggregation === "minimum" ? Math.min(...scores) : scores.reduce((a, b) => a + b, 0) / scores.length;
  const metrics = Object.fromEntries(metricKeys.map(key => [key, training.reduce((sum, result) => sum + result.metrics[key], 0) / training.length])) as unknown as FitnessMetrics;
  return { fitness: aggregate(trainingScores), validationFitness: validationScores.length ? aggregate(validationScores) : null, trainingScores, validationScores, metrics };
}

export function evaluateGenome(genome: Genome, config: RunConfig): Evaluation {
  return evaluateValid(validateGenome(genome), validateRunConfig(config));
}
/** Inline reference implementation. Parallel executors must return INPUT order, not completion order. */
export async function evaluateBatch(genomes: Genome[], config: RunConfig): Promise<Evaluation[]> {
  const checked = validateRunConfig(config);
  if (!Array.isArray(genomes) || genomes.length > 512) throw new RangeError("Evaluation batch exceeds 512 candidates.");
  return Array.from(genomes, genome => evaluateValid(validateGenome(genome), checked));
}
