import type { EvolutionCommand, EvolutionRequest } from "../src/protocol";

export const MAX_COMMAND_BYTES = 16 * 1024;
export const MAX_WORKERS = 4;
export const EPOCH_INTERVAL_MS = 150;
export const MAX_OUTBOUND_BYTES = 512 * 1024;
export const COMPUTE_TIMEOUT_MS = 10_000;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}
export function commandId(value: unknown): number | undefined {
  return record(value) && safeInteger(value.id) && value.id >= 0
    ? value.id
    : undefined;
}

/** Validate before allocating or posting to a thread; unknown keys are rejected. */
export function validateCommand(value: unknown): EvolutionCommand {
  if (!record(value) || commandId(value) === undefined)
    throw new Error("A command needs a nonnegative safe-integer id.");
  if (value.type === "pause") {
    if (!exactKeys(value, ["type", "id"]))
      throw new Error("Unsupported pause fields.");
    return { type: "pause", id: value.id as number };
  }
  if (!["evaluate", "start", "step"].includes(value.type as string))
    throw new Error("Unknown command type.");
  if (
    !exactKeys(value, [
      "type",
      "id",
      "genome",
      "config",
      "objective",
      "mutationRate",
      "randomSeed",
      "epoch",
    ])
  )
    throw new Error("Missing or unsupported command fields.");
  if (
    !Array.isArray(value.genome) ||
    value.genome.length !== 45 ||
    value.genome[0] !== 0 ||
    value.genome.some(
      (gene: unknown) => !safeInteger(gene) || gene < 0 || gene > 4,
    )
  )
    throw new Error(
      "A genome needs 45 integer states from 0 through 4; gene 0 must be 0.",
    );
  const config = value.config;
  if (
    !record(config) ||
    !exactKeys(config, ["size", "steps", "seed", "randomSeed"]) ||
    ![25, 33, 41, 49].includes(config.size as number) ||
    ![24, 32, 48, 64].includes(config.steps as number) ||
    !["point", "cross", "islands"].includes(config.seed as string) ||
    !safeInteger(config.randomSeed)
  )
    throw new Error(
      "Unsupported simulation settings: size 25/33/41/49, steps 24/32/48/64, a known seed form and safe-integer random seed are required.",
    );
  if (
    !["complexity", "longevity", "growth"].includes(value.objective as string)
  )
    throw new Error("Unknown fitness objective.");
  if (
    typeof value.mutationRate !== "number" ||
    !Number.isFinite(value.mutationRate) ||
    value.mutationRate < 0 ||
    value.mutationRate > 1
  )
    throw new Error("Mutation rate must be between 0 and 1.");
  if (!safeInteger(value.randomSeed))
    throw new Error("Evolution random seed must be a safe integer.");
  if (
    !safeInteger(value.epoch) ||
    value.epoch < 0 ||
    value.epoch >= Number.MAX_SAFE_INTEGER
  )
    throw new Error(
      "Epoch must be a nonnegative safe integer below the maximum.",
    );
  return value as unknown as EvolutionRequest;
}
