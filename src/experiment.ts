import type { Config, Genome } from "./simulation";

export interface Experiment {
  version: 1;
  genome: Genome;
  config: Config;
  name: string;
}
export const STORAGE_KEY = "polyp.experiment.v1";
export function parseExperiment(raw: string): Experiment {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object")
    throw new Error("This is not a Polyp specimen.");
  const data = value as Experiment;
  if (
    data.version !== 1 ||
    !Array.isArray(data.genome) ||
    data.genome.length !== 45 ||
    data.genome[0] !== 0 ||
    data.genome.some((g) => !Number.isInteger(g) || g < 0 || g > 4)
  )
    throw new Error("A specimen needs a valid 45-gene, five-state rule.");
  const c = data.config;
  if (
    !c ||
    ![25, 33, 41, 49].includes(c.size) ||
    ![24, 32, 48, 64].includes(c.steps) ||
    !["point", "cross", "islands"].includes(c.seed) ||
    !Number.isSafeInteger(c.randomSeed) ||
    typeof data.name !== "string" ||
    data.name.length > 100
  )
    throw new Error("The specimen settings are not supported.");
  return {
    version: 1,
    genome: [...data.genome],
    config: { ...c },
    name: data.name,
  };
}
export function loadExperiment(): Experiment | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? parseExperiment(raw) : null;
  } catch {
    return null;
  }
}
