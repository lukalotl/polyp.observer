import { PRESETS, type Genome } from "../simulation";
import type { RunConfig } from "./types";

/** Scientific model is fixed: five states, 45 genes, zero-quiescence, Moore/zero halo. */
export const DEFAULT_RUN_CONFIG: RunConfig = {
  name: "Experiment", size: 49, steps: 96, seed: "cross",
  trainingSeeds: [1729], validationSeeds: [], objective: "complexity", aggregation: "mean",
  weights: { diversity: 0.34, activity: 0.30, density: 0.24, variation: 0.12 },
  seedGenome: PRESETS[0].genome.slice(), initialization: "mutants",
  populationSize: 64, eliteCount: 4, selection: "tournament", tournamentSize: 4,
  crossover: "uniform", crossoverRate: 0.7, mutationRate: 0.03, immigrantRate: 0.05,
  randomSeed: 1729, cacheSize: 2048, evaluationWorkers: 2, maxGenerations: 0,
  checkpointSeconds: 10, snapshotEvery: 100, retainedSnapshots: 48, resumeOnRestart: true,
};

export function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null))
    throw new RangeError(`${label} must be a plain object.`);
  return value as Record<string, unknown>;
}
export function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !keys.includes(key)))
    throw new RangeError(`${label} must contain exactly the documented fields.`);
}
export function finite(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)
    throw new RangeError(`${label} must be finite and between ${min} and ${max}.`);
  return value;
}
export function integer(value: unknown, min: number, max: number, label: string): number {
  const result = finite(value, min, max, label);
  if (!Number.isSafeInteger(result)) throw new RangeError(`${label} must be a safe integer.`);
  return result;
}
function choice<T extends string>(value: unknown, choices: readonly T[], label: string): T {
  if (typeof value !== "string" || !choices.includes(value as T)) throw new RangeError(`Unknown ${label}.`);
  return value as T;
}
export function validateGenome(value: unknown): Genome {
  if (!Array.isArray(value) || value.length !== 45) throw new RangeError("Genome must contain 45 genes.");
  const genome: Genome = [];
  for (let i = 0; i < 45; i++) genome.push(integer(value[i], 0, 4, `Gene ${i}`));
  if (genome[0] !== 0) throw new RangeError("Gene 0 must remain quiescent (0).");
  return genome;
}
function seeds(value: unknown, min: number, label: string): number[] {
  if (!Array.isArray(value) || value.length < min || value.length > 8)
    throw new RangeError(`${label} must contain ${min} through 8 seeds.`);
  const result = Array.from(value, seed => integer(seed, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, label));
  if (new Set(result.map(seed => seed >>> 0)).size !== result.length)
    throw new RangeError(`${label} must be distinct (including uint32 RNG aliases).`);
  return result;
}

/** Complete, strict, detached configuration. No coercion, silent defaults or model overrides. */
export function validateRunConfig(value: unknown): RunConfig {
  const v = record(value, "Configuration");
  exactKeys(v, Object.keys(DEFAULT_RUN_CONFIG), "Configuration");
  if (typeof v.name !== "string" || !v.name.trim() || v.name.length > 80)
    throw new RangeError("Name must contain 1 through 80 characters and not be blank.");
  const size = integer(v.size, 9, 129, "Size");
  const steps = integer(v.steps, 8, 1024, "Steps");
  if (size % 2 !== 1) throw new RangeError("Size must be odd.");
  if (size * size * steps > 16_000_000) throw new RangeError("Fixture exceeds 16 million cell sites.");
  const populationSize = integer(v.populationSize, 8, 512, "Population size");
  const eliteCount = integer(v.eliteCount, 0, populationSize - 1, "Elite count");
  const immigrantRate = finite(v.immigrantRate, 0, 0.5, "Immigrant rate");
  if (Math.floor(populationSize * immigrantRate) > populationSize - eliteCount)
    throw new RangeError("Immigrants must fit the non-elite slots.");
  const w = record(v.weights, "Weights");
  exactKeys(w, ["diversity", "activity", "density", "variation"], "Weights");
  const weights = {
    diversity: finite(w.diversity, 0, 10, "Diversity weight"),
    activity: finite(w.activity, 0, 10, "Activity weight"),
    density: finite(w.density, 0, 10, "Density weight"),
    variation: finite(w.variation, 0, 10, "Variation weight"),
  };
  if (Object.values(weights).reduce((a, b) => a + b, 0) <= 0) throw new RangeError("Weights must have positive sum.");
  if (typeof v.resumeOnRestart !== "boolean") throw new RangeError("resumeOnRestart must be boolean.");
  const trainingSeeds = seeds(v.trainingSeeds, 1, "Training seeds"), validationSeeds = seeds(v.validationSeeds, 0, "Validation seeds");
  if (validationSeeds.some(seed => trainingSeeds.some(train => (train >>> 0) === (seed >>> 0))))
    throw new RangeError("Training and held-out seeds must not overlap (including uint32 RNG aliases).");
  return {
    name: v.name, size, steps, seed: choice(v.seed, ["point", "cross", "islands"], "seed"),
    trainingSeeds, validationSeeds,
    objective: choice(v.objective, ["complexity", "longevity", "growth"], "objective"),
    aggregation: choice(v.aggregation, ["mean", "minimum"], "aggregation"), weights,
    seedGenome: validateGenome(v.seedGenome), initialization: choice(v.initialization, ["mutants", "random"], "initialization"),
    populationSize, eliteCount, selection: choice(v.selection, ["tournament", "rank"], "selection"),
    tournamentSize: integer(v.tournamentSize, 2, Math.min(32, populationSize), "Tournament size"),
    crossover: choice(v.crossover, ["uniform", "onePoint", "none"], "crossover"),
    crossoverRate: finite(v.crossoverRate, 0, 1, "Crossover rate"), mutationRate: finite(v.mutationRate, 0, 1, "Mutation rate"),
    immigrantRate, randomSeed: integer(v.randomSeed, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, "Random seed"),
    cacheSize: integer(v.cacheSize, 0, 8192, "Cache size"), evaluationWorkers: integer(v.evaluationWorkers, 1, 6, "Evaluation workers"),
    maxGenerations: integer(v.maxGenerations, 0, 1_000_000_000, "Maximum generations"),
    checkpointSeconds: finite(v.checkpointSeconds, 2, 300, "Checkpoint seconds"),
    snapshotEvery: integer(v.snapshotEvery, 1, 10_000, "Snapshot interval"),
    retainedSnapshots: integer(v.retainedSnapshots, 2, 128, "Retained snapshots"), resumeOnRestart: v.resumeOnRestart,
  };
}
