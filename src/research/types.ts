import type { Genome, Objective, SeedMode, Simulation } from "../simulation";

export const LEGACY_MODEL_VERSION = "ca5-moore-research-v1";
export const MODEL_VERSION = "ca-moore-research-v2";

export interface FitnessWeights {
  diversity: number;
  activity: number;
  density: number;
  variation: number;
}
export interface RunConfig {
  name: string;
  stateCount: number;
  size: number;
  steps: number;
  seed: SeedMode;
  trainingSeeds: number[];
  validationSeeds: number[];
  objective: Objective;
  aggregation: "mean" | "minimum";
  weights: FitnessWeights;
  seedGenome: Genome;
  initialization: "mutants" | "random";
  populationSize: number;
  eliteCount: number;
  selection: "tournament" | "rank";
  tournamentSize: number;
  crossover: "uniform" | "onePoint" | "none";
  crossoverRate: number;
  mutationRate: number;
  immigrantRate: number;
  randomSeed: number;
  cacheSize: number;
  evaluationWorkers: number;
  /** Zero means no generation limit. */
  maxGenerations: number;
  checkpointSeconds: number;
  snapshotEvery: number;
  retainedSnapshots: number;
  resumeOnRestart: boolean;
}

export interface FitnessMetrics {
  diversity: number;
  activity: number;
  density: number;
  variation: number;
  persistence: number;
  occupancy: number;
  lifetime: number;
  extinctFraction: number;
}
export interface Evaluation {
  fitness: number;
  validationFitness: number | null;
  trainingScores: number[];
  validationScores: number[];
  metrics: FitnessMetrics;
}
export interface ParentRef {
  id: string;
  genome: Genome;
  fitness: number;
  birthGeneration: number;
}
export type IndividualOrigin =
  | "founder"
  | "random"
  | "mutant"
  | "crossover"
  | "clone"
  | "immigrant";
export interface Individual extends Evaluation {
  id: string;
  genome: Genome;
  birthGeneration: number;
  origin: IndividualOrigin;
  parents: ParentRef[];
  /** One entry per gene: 0 or 1 identifies the source parent before mutation. */
  crossoverMask: number[];
  mutatedLoci: number[];
}
export interface CachedEvaluation {
  key: string;
  evaluation: Evaluation;
}
/** Complete, serializable genetic state; RNG and population survive checkpoints. */
export interface EngineState {
  version: 1;
  modelVersion: typeof MODEL_VERSION;
  config: RunConfig;
  generation: number;
  rngState: number;
  nextId: number;
  population: Individual[];
  champion: Individual;
  /** Actual fixture evaluations, excluding cache hits. */
  evaluations: number;
  cacheHits: number;
  cache: CachedEvaluation[];
}
export interface GenerationMetrics {
  generation: number;
  best: number;
  mean: number;
  worst: number;
  median: number;
  bestEver: number;
  validationBest: number | null;
  /** Mean per-locus normalized allele entropy over unlocked genes. */
  diversity: number;
  uniqueGenomes: number;
  evaluations: number;
  cacheHits: number;
}
export interface GenerationSnapshot {
  generation: number;
  population: Individual[];
  champion: Individual;
  metrics: GenerationMetrics;
}
export interface HistoryPoint extends GenerationMetrics {
  elapsedMs: number;
  generationMs: number;
  evalsPerSecond: number;
}
export interface ChampionPoint {
  generation: number;
  individual: Individual;
  elapsedMs: number;
}
export type RunStatus =
  | "paused"
  | "queued"
  | "starting"
  | "running"
  | "pausing"
  | "completed"
  | "failed"
  | "archived";
export interface RunSummary {
  id: string;
  name: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  checkpointAt: string | null;
  generation: number;
  evaluations: number;
  cacheHits: number;
  bestFitness: number | null;
  meanFitness: number | null;
  validationFitness: number | null;
  diversity: number;
  uniqueGenomes: number;
  elapsedMs: number;
  evalsPerSecond: number;
  generationMs: number;
  workerCount: number;
  queuePosition: number | null;
  error: string | null;
  stopReason: string | null;
  parentRunId: string | null;
}
export interface SnapshotRef {
  generation: number;
  savedAt: string;
  bestFitness: number;
}
export interface RunDetail {
  summary: RunSummary;
  config: RunConfig;
  snapshot: GenerationSnapshot | null;
  history: HistoryPoint[];
  improvements: ChampionPoint[];
  snapshots: SnapshotRef[];
}
export interface Capacity {
  maxRuns: number;
  maxEvaluationWorkers: number;
  allocatedWorkers: number;
}
export interface RunList {
  runs: RunSummary[];
  capacity: Capacity;
  modelVersion: string;
}
export interface RunCheckpoint {
  format: "polyp-research-checkpoint";
  version: 1;
  modelVersion: typeof MODEL_VERSION;
  /** Origin identity is retained when moving an exported checkpoint between servers. */
  sourceRunId?: string;
  config: RunConfig;
  state: EngineState | null;
  history: HistoryPoint[];
  improvements: ChampionPoint[];
  elapsedMs: number;
  createdAt: string;
}
export type ResearchEvent =
  | { type: "hello"; modelVersion: string; capacity: Capacity }
  | ({ type: "runs" } & RunList)
  | { type: "run"; runId: string; detail: RunDetail }
  | { type: "error"; error: string };
export type RunAction = "start" | "pause" | "step" | "checkpoint" | "archive";
export interface PreviewFrame {
  genome: Genome;
  seed: number;
  simulation: Omit<Simulation, "layers"> & { layers: string[] };
  /** Omitted by older servers, whose planes are dense bytes. */
  encoding?: "sparse-u32le" | "adaptive-v1";
  /** Actual CA timestep for each returned layer (preview can be sampled). */
  layerTimes: number[];
  totalSteps: number;
  stride: number;
}
export interface PreviewRange {
  start: number;
  end: number;
}
export type BatchEvaluator = (
  genomes: Genome[],
  config: RunConfig,
) => Promise<Evaluation[]>;
