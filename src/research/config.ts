import { validateIncentives } from "./incentives";
import { PRESETS, type Genome } from "../simulation";
import { MIN_STATE_COUNT, MAX_STATE_COUNT } from "./genome";
import {
  LEGACY_MODEL_VERSION,
  PREVIOUS_MODEL_VERSION,
  type RunConfig,
} from "./types";
import { MAX_GRID_SIZE, MAX_CA_STEPS, maxHorizon } from "./limits";

/** Outer-totalistic Moore CA: configurable states, zero-quiescence and zero halo. */
export const DEFAULT_RUN_CONFIG: RunConfig = {
  name: "Experiment",
  stateCount: 5,
  size: 129,
  steps: 2048,
  seed: "cross",
  trainingSeeds: [1729],
  validationSeeds: [],
  objective: "longevity",
  boundaryPolicy: { spatial: true, horizon: true },
  aggregation: "mean",
  fixtureFailures: "aggregate",
  weights: { diversity: 0.34, activity: 0.3, density: 0.24, variation: 0.12 },
  seedGenome: PRESETS[0].genome.slice(),
  initialization: "random",
  populationSize: 64,
  eliteCount: 4,
  selection: "tournament",
  tournamentSize: 4,
  crossover: "uniform",
  crossoverRate: 0.7,
  mutationRate: 0.03,
  immigrantRate: 0.05,
  randomSeed: 1729,
  cacheSize: 2048,
  evaluationWorkers: 2,
  maxGenerations: 0,
  checkpointSeconds: 10,
  snapshotEvery: 100,
  retainedSnapshots: 48,
  resumeOnRestart: true,
};

export function record(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  )
    throw new RangeError(`${label} must be a plain object.`);
  return value as Record<string, unknown>;
}
export function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new RangeError(
      `${label} must contain exactly the documented fields.`,
    );
}
export function finite(
  value: unknown,
  min: number,
  max: number,
  label: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    throw new RangeError(
      `${label} must be finite and between ${min} and ${max}.`,
    );
  return value;
}
export function integer(
  value: unknown,
  min: number,
  max: number,
  label: string,
): number {
  const result = finite(value, min, max, label);
  if (!Number.isSafeInteger(result))
    throw new RangeError(`${label} must be a safe integer.`);
  return result;
}
function choice<T extends string>(
  value: unknown,
  choices: readonly T[],
  label: string,
): T {
  if (typeof value !== "string" || !choices.includes(value as T))
    throw new RangeError(`Unknown ${label}.`);
  return value as T;
}
export function validateGenome(value: unknown, stateCount = 5): Genome {
  integer(stateCount, MIN_STATE_COUNT, MAX_STATE_COUNT, "State count");
  const geneCount = 9 * stateCount;
  if (!Array.isArray(value) || value.length !== geneCount)
    throw new RangeError(
      `Genome must contain ${geneCount} genes for ${stateCount} states.`,
    );
  const genome: Genome = [];
  for (let i = 0; i < geneCount; i++)
    genome.push(integer(value[i], 0, stateCount - 1, `Gene ${i}`));
  if (genome[0] !== 0)
    throw new RangeError("Gene 0 must remain quiescent (0).");
  return genome;
}
function seeds(value: unknown, min: number, label: string): number[] {
  if (!Array.isArray(value) || value.length < min || value.length > 8)
    throw new RangeError(`${label} must contain ${min} through 8 seeds.`);
  const result = Array.from(value, (seed) =>
    integer(seed, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, label),
  );
  if (new Set(result.map((seed) => seed >>> 0)).size !== result.length)
    throw new RangeError(
      `${label} must be distinct (including uint32 RNG aliases).`,
    );
  return result;
}

/** Complete, strict, detached configuration. No coercion, silent defaults or model overrides. */
export function validateRunConfig(value: unknown): RunConfig {
  const v = record(value, "Configuration");
  exactKeys(
    v,
    [
      ...Object.keys(DEFAULT_RUN_CONFIG).filter(
        (key) => key !== "fixtureFailures",
      ),
      ...(Object.hasOwn(v, "fixtureFailures") ? ["fixtureFailures"] : []),
      ...(Object.hasOwn(v, "soupSize") ? ["soupSize"] : []),
      ...(Object.hasOwn(v, "incentives") ? ["incentives"] : []),
    ],
    "Configuration",
  );
  if (typeof v.name !== "string" || !v.name.trim() || v.name.length > 80)
    throw new RangeError(
      "Name must contain 1 through 80 characters and not be blank.",
    );
  const stateCount = integer(
    v.stateCount,
    MIN_STATE_COUNT,
    MAX_STATE_COUNT,
    "State count",
  );
  const size = integer(v.size, 9, MAX_GRID_SIZE, "Size");
  const steps = integer(v.steps, 8, MAX_CA_STEPS, "Steps");
  if (size % 2 !== 1) throw new RangeError("Size must be odd.");
  if (steps > maxHorizon(size))
    throw new RangeError(
      `At grid size ${size}, the work budget allows at most ${maxHorizon(size).toLocaleString("en-US")} CA timesteps. Reduce the grid or horizon.`,
    );
  const populationSize = integer(v.populationSize, 8, 512, "Population size");
  const eliteCount = integer(
    v.eliteCount,
    0,
    populationSize - 1,
    "Elite count",
  );
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
  if (Object.values(weights).reduce((a, b) => a + b, 0) <= 0)
    throw new RangeError("Weights must have positive sum.");
  if (typeof v.resumeOnRestart !== "boolean")
    throw new RangeError("resumeOnRestart must be boolean.");
  const boundary = record(v.boundaryPolicy, "Boundary policy");
  exactKeys(boundary, ["spatial", "horizon"], "Boundary policy");
  if (
    typeof boundary.spatial !== "boolean" ||
    typeof boundary.horizon !== "boolean"
  )
    throw new RangeError("Boundary policy settings must be boolean.");
  const trainingSeeds = seeds(v.trainingSeeds, 1, "Training seeds"),
    validationSeeds = seeds(v.validationSeeds, 0, "Validation seeds");
  if (
    validationSeeds.some((seed) =>
      trainingSeeds.some((train) => train >>> 0 === seed >>> 0),
    )
  )
    throw new RangeError(
      "Training and held-out seeds must not overlap (including uint32 RNG aliases).",
    );
  return {
    ...(Object.hasOwn(v, "incentives")
      ? { incentives: validateIncentives(v.incentives) }
      : {}),
    name: v.name,
    stateCount,
    size,
    steps,
    seed: choice(v.seed, ["point", "cross", "islands", "soup"], "seed"),
    ...(v.seed === "soup" || Object.hasOwn(v, "soupSize")
      ? {
          soupSize: integer(
            v.soupSize,
            1,
            v.seed === "soup" ? size : MAX_GRID_SIZE,
            "Soup size",
          ),
        }
      : {}),
    trainingSeeds,
    validationSeeds,
    objective: choice(
      v.objective,
      ["complexity", "longevity", "growth", "finiteSparse", "finiteDense"],
      "objective",
    ),
    aggregation: choice(v.aggregation, ["mean", "minimum"], "aggregation"),
    ...(Object.hasOwn(v, "fixtureFailures")
      ? {
          fixtureFailures: choice(
            v.fixtureFailures,
            ["aggregate", "all"] as const,
            "fixture failure handling",
          ),
        }
      : {}),
    boundaryPolicy: { spatial: boundary.spatial, horizon: boundary.horizon },
    weights,
    seedGenome: validateGenome(v.seedGenome, stateCount),
    initialization: choice(
      v.initialization,
      ["mutants", "random"],
      "initialization",
    ),
    populationSize,
    eliteCount,
    selection: choice(v.selection, ["tournament", "rank"], "selection"),
    tournamentSize: integer(
      v.tournamentSize,
      2,
      Math.min(32, populationSize),
      "Tournament size",
    ),
    crossover: choice(
      v.crossover,
      ["uniform", "onePoint", "none"],
      "crossover",
    ),
    crossoverRate: finite(v.crossoverRate, 0, 1, "Crossover rate"),
    mutationRate: finite(v.mutationRate, 0, 1, "Mutation rate"),
    immigrantRate,
    randomSeed: integer(
      v.randomSeed,
      Number.MIN_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
      "Random seed",
    ),
    cacheSize: integer(v.cacheSize, 0, 8192, "Cache size"),
    evaluationWorkers: integer(v.evaluationWorkers, 1, 6, "Evaluation workers"),
    maxGenerations: integer(
      v.maxGenerations,
      0,
      1_000_000_000,
      "Maximum generations",
    ),
    checkpointSeconds: finite(
      v.checkpointSeconds,
      2,
      300,
      "Checkpoint seconds",
    ),
    snapshotEvery: integer(v.snapshotEvery, 1, 10_000, "Snapshot interval"),
    retainedSnapshots: integer(
      v.retainedSnapshots,
      2,
      128,
      "Retained snapshots",
    ),
    resumeOnRestart: v.resumeOnRestart,
  };
}

/** Only the explicitly versioned five-state checkpoint format may omit stateCount. */
export function migrateLegacyRunConfig(
  value: unknown,
  version = LEGACY_MODEL_VERSION,
): RunConfig {
  if (version !== LEGACY_MODEL_VERSION && version !== PREVIOUS_MODEL_VERSION)
    throw new RangeError("Unsupported legacy model version.");
  const v = record(value, "Legacy configuration");
  exactKeys(
    v,
    Object.keys(DEFAULT_RUN_CONFIG).filter(
      (key) =>
        (key !== "fixtureFailures" || Object.hasOwn(v, key)) &&
        key !== "boundaryPolicy" &&
        (version !== LEGACY_MODEL_VERSION || key !== "stateCount"),
    ),
    "Legacy configuration",
  );
  return validateRunConfig({
    ...v,
    ...(version === LEGACY_MODEL_VERSION ? { stateCount: 5 } : {}),
    boundaryPolicy: { spatial: false, horizon: false },
  });
}
