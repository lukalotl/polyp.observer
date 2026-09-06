import { MODEL_VERSION, type RunCheckpoint } from "../src/research/types";
import { validateRunConfig } from "../src/research/config";
import {
  validateEngineState,
  generationSnapshot,
} from "../src/research/engine";

export const MAX_BODY_BYTES = 16 * 1024 * 1024;
export const MAX_COMMAND_BYTES = 4096;
export const MAX_OUTBOUND_BYTES = 8 * 1024 * 1024;
export const HISTORY_LIMIT = 4096;
export const IMPROVEMENT_LIMIT = 256;
export const MAX_RUNS = 64;
export const MAX_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_STORAGE_BYTES = 1024 * 1024 * 1024;
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
export function fields(
  value: unknown,
  allowed: string[],
  required: string[] = [],
): asserts value is Record<string, unknown> {
  if (
    !record(value) ||
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  )
    throw new HttpError(400, "Missing or unsupported JSON fields.");
}
export function genome(value: unknown): asserts value is number[] {
  if (
    !Array.isArray(value) ||
    value.length !== 45 ||
    value[0] !== 0 ||
    value.some((n) => !Number.isInteger(n) || n < 0 || n > 4)
  )
    throw new HttpError(
      400,
      "Genome must have 45 integer states (0–4), with gene 0 locked to 0.",
    );
}
export function optionalBoolean(value: unknown): boolean {
  if (value !== undefined && typeof value !== "boolean")
    throw new HttpError(400, "start must be a boolean.");
  return value === true;
}
export function runName(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 80 ||
    /[\x00-\x1f]/.test(value)
  )
    throw new HttpError(400, "Name must be 1–80 printable characters.");
  return value.trim();
}
export function date(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length < 40 &&
    Number.isFinite(Date.parse(value))
  );
}
function boundedTree(value: unknown, depth = 0): void {
  if (depth > 20) throw new Error("Checkpoint nesting exceeds limit.");
  if (typeof value === "number" && !Number.isFinite(value))
    throw new Error("Checkpoint contains a non-finite number.");
  if (typeof value === "string" && value.length > 8192)
    throw new Error("Checkpoint string exceeds limit.");
  if (Array.isArray(value)) {
    if (value.length > 65536)
      throw new Error("Checkpoint array exceeds limit.");
    for (const child of value) boundedTree(child, depth + 1);
  } else if (record(value)) {
    if (Object.keys(value).length > 64)
      throw new Error("Checkpoint object exceeds limit.");
    for (const [key, child] of Object.entries(value)) {
      if (["__proto__", "constructor", "prototype"].includes(key))
        throw new Error("Unsupported checkpoint key.");
      boundedTree(child, depth + 1);
    }
  }
}
export function validateCheckpoint(value: unknown): RunCheckpoint {
  fields(
    value,
    [
      "format",
      "version",
      "modelVersion",
      "config",
      "state",
      "history",
      "improvements",
      "elapsedMs",
      "createdAt",
      "sourceRunId",
    ],
    [
      "format",
      "version",
      "modelVersion",
      "config",
      "state",
      "history",
      "improvements",
      "elapsedMs",
      "createdAt",
    ],
  );
  boundedTree(value);
  if (
    value.sourceRunId !== undefined &&
    (typeof value.sourceRunId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        value.sourceRunId,
      ))
  )
    throw new Error("Invalid checkpoint source run id.");
  if (
    value.format !== "polyp-research-checkpoint" ||
    value.version !== 1 ||
    value.modelVersion !== MODEL_VERSION
  )
    throw new Error("Unsupported checkpoint format or model version.");
  const config = validateRunConfig(value.config);
  runName(config.name);
  if (
    typeof value.elapsedMs !== "number" ||
    value.elapsedMs < 0 ||
    !date(value.createdAt)
  )
    throw new Error("Invalid checkpoint time metadata.");
  if (value.state !== null) {
    value.state = validateEngineState(value.state);
    if (
      JSON.stringify((value.state as RunCheckpoint["state"])!.config) !==
      JSON.stringify(config)
    )
      throw new Error("Checkpoint state/config disagree.");
  }
  if (
    !Array.isArray(value.history) ||
    value.history.length > HISTORY_LIMIT ||
    !Array.isArray(value.improvements) ||
    value.improvements.length > IMPROVEMENT_LIMIT
  )
    throw new Error("Checkpoint history exceeds retained limits.");
  const state = value.state as RunCheckpoint["state"];
  let previous = -1;
  for (const point of value.history) {
    if (
      !record(point) ||
      !Number.isSafeInteger(point.generation) ||
      (point.generation as number) <= previous ||
      (point.generation as number) > (state?.generation ?? -1)
    )
      throw new Error("Invalid generation history.");
    for (const key of [
      "best",
      "mean",
      "worst",
      "median",
      "bestEver",
      "diversity",
      "uniqueGenomes",
      "evaluations",
      "cacheHits",
      "elapsedMs",
      "generationMs",
      "evalsPerSecond",
    ])
      if (typeof point[key] !== "number" || point[key] < 0)
        throw new Error(`Invalid history ${key}.`);
    if (
      point.validationBest !== null &&
      typeof point.validationBest !== "number"
    )
      throw new Error("Invalid validation fitness.");
    previous = point.generation as number;
  }
  if (state) {
    const last = value.history.at(-1);
    if (!last || last.generation !== state.generation)
      throw new Error(
        "Checkpoint must include its current generation metrics.",
      );
    const actual = generationSnapshot(state).metrics;
    for (const [key, entry] of Object.entries(actual))
      if (last[key] !== entry)
        throw new Error(`Current history ${key} disagrees with engine state.`);
  } else if (value.history.length || value.improvements.length)
    throw new Error("Uninitialized checkpoint cannot contain history.");
  previous = -1;
  for (const point of value.improvements) {
    if (
      !record(point) ||
      !Number.isSafeInteger(point.generation) ||
      (point.generation as number) < previous ||
      (point.generation as number) > (state?.generation ?? -1) ||
      typeof point.elapsedMs !== "number" ||
      point.elapsedMs < 0 ||
      !record(point.individual)
    )
      throw new Error("Invalid champion history.");
    const individual = point.individual;
    fields(
      individual,
      [
        "id",
        "genome",
        "birthGeneration",
        "origin",
        "parents",
        "crossoverMask",
        "mutatedLoci",
        "fitness",
        "validationFitness",
        "trainingScores",
        "validationScores",
        "metrics",
      ],
      [
        "id",
        "genome",
        "birthGeneration",
        "origin",
        "parents",
        "crossoverMask",
        "mutatedLoci",
        "fitness",
        "validationFitness",
        "trainingScores",
        "validationScores",
        "metrics",
      ],
    );
    genome(individual.genome);
    if (
      !Number.isSafeInteger(individual.birthGeneration) ||
      (individual.birthGeneration as number) < 0 ||
      (individual.birthGeneration as number) > (point.generation as number) ||
      ![
        "founder",
        "random",
        "mutant",
        "crossover",
        "clone",
        "immigrant",
      ].includes(individual.origin as string)
    )
      throw new Error("Invalid historic ancestry.");
    if (
      !Array.isArray(individual.parents) ||
      individual.parents.length > 2 ||
      !Array.isArray(individual.crossoverMask) ||
      individual.crossoverMask.length !== 45 ||
      individual.crossoverMask.some(
        (value) => !Number.isInteger(value) || value < 0 || value > 1,
      ) ||
      !Array.isArray(individual.mutatedLoci) ||
      individual.mutatedLoci.length > 44 ||
      individual.mutatedLoci.some(
        (value) => !Number.isInteger(value) || value < 1 || value > 44,
      )
    )
      throw new Error("Invalid historic genetic trace.");
    for (const parent of individual.parents) {
      fields(
        parent,
        ["id", "genome", "fitness", "birthGeneration"],
        ["id", "genome", "fitness", "birthGeneration"],
      );
      genome(parent.genome);
      if (
        typeof parent.id !== "string" ||
        typeof parent.fitness !== "number" ||
        parent.fitness < 0 ||
        parent.fitness > 1 ||
        !Number.isSafeInteger(parent.birthGeneration)
      )
        throw new Error("Invalid historic parent.");
    }
    for (const [key, count] of [
      ["trainingScores", config.trainingSeeds.length],
      ["validationScores", config.validationSeeds.length],
    ] as const)
      if (
        !Array.isArray(individual[key]) ||
        individual[key].length !== count ||
        individual[key].some(
          (score) => typeof score !== "number" || score < 0 || score > 1,
        )
      )
        throw new Error("Invalid historic fixture scores.");
    if (!record(individual.metrics))
      throw new Error("Invalid historic metrics.");
    for (const key of [
      "diversity",
      "activity",
      "density",
      "variation",
      "persistence",
      "occupancy",
      "lifetime",
      "extinctFraction",
    ])
      if (
        typeof individual.metrics[key] !== "number" ||
        individual.metrics[key] < 0 ||
        individual.metrics[key] > (key === "lifetime" ? config.steps : 1)
      )
        throw new Error("Invalid historic fitness metric.");
    if (
      individual.validationFitness !== null &&
      (typeof individual.validationFitness !== "number" ||
        individual.validationFitness < 0 ||
        individual.validationFitness > 1)
    )
      throw new Error("Invalid historic validation fitness.");
    if (
      typeof point.individual.fitness !== "number" ||
      point.individual.fitness < 0 ||
      point.individual.fitness > 1 ||
      typeof point.individual.id !== "string"
    )
      throw new Error("Invalid historic champion.");
    previous = point.generation as number;
  }
  return value as unknown as RunCheckpoint;
}
