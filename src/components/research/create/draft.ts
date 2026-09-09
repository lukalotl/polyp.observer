import type { RunConfig } from "../../../research/types";
import type { SectionId } from "./summary";

/** Shared by every section: one draft, one updater, one error lookup. */
export interface DraftApi {
  draft: RunConfig;
  update: <K extends keyof RunConfig>(key: K, value: RunConfig[K]) => void;
  patch: (change: (current: RunConfig) => RunConfig) => void;
  /** Validation message for the control with this accessible label, if any. */
  errorFor: (label: string) => string | undefined;
}

export interface LocatedError {
  field: string;
  section: SectionId | null;
}
/** Validation messages come from validateRunConfig; map them to the control that fixes them. */
const LOCATIONS: [RegExp, string, SectionId | null][] = [
  [/^Name must/, "Run name", null],
  [/^State count/, "State count", "worlds"],
  [/^Size must|^At grid size/, "Grid size", "worlds"],
  [/^Steps must/, "CA horizon", "worlds"],
  [/^Soup size/, "Soup size N", "worlds"],
  [/^Training seeds/, "Training seeds", "worlds"],
  [/^Validation seeds|^Held-out seeds|held-out seeds must not overlap/i, "Held-out seeds", "worlds"],
  [/^Population size/, "Population", "search"],
  [/^Elite count/, "Elites", "search"],
  [/^Unknown elitism/, "Elitism", "search"],
  [/^Tournament size/, "Tournament size", "search"],
  [/^Unknown selection|lexicase/i, "Selection", "search"],
  [/^Unknown crossover/, "Crossover", "search"],
  [/^Crossover rate/, "Crossover probability", "search"],
  [/^Mutation rate/, "Mutation probability", "search"],
  [/^Unknown mutation policy/, "Mutation policy", "search"],
  [/^Mutation beta|beta/i, "Mutation beta", "search"],
  [/^Immigrant|^Immigrants must fit/, "Immigrant fraction", "search"],
  [/^Random seed/, "Search RNG seed", "search"],
  [/^Genome must|^Gene \d|quiescent/, "Founder preset", "search"],
  [/^Unknown initialization|^Unknown random rule bias/, "Initialization", "search"],
  [/^Evaluation workers/, "CPU workers", "budget"],
  [/^Maximum generations/, "Generation limit", "budget"],
  [/^Stall/i, "Stall pause", "budget"],
  [/^Checkpoint seconds/, "Checkpoint interval (s)", "budget"],
  [/^Snapshot interval/, "Archive every N generations", "budget"],
  [/^Retained snapshots/, "Retained populations", "budget"],
  [/^Cache size/, "Evaluation cache entries", "budget"],
  [/incentive|weight|formula/i, "Scoring incentives", "goal"],
  [/^Boundary policy/, "Scoring incentives", "goal"],
  [/^Unknown aggregation/, "Aggregation", "goal"],
];

export function locateError(message: string): LocatedError | null {
  const match = LOCATIONS.find(([pattern]) => pattern.test(message));
  return match ? { field: match[1], section: match[2] } : null;
}
