/** Shared browser ↔ VM wire contract. No browser-side evolution execution. */
import type { Config, Genome, Objective, Simulation } from "./simulation";

export interface EvolutionRequest {
  type: "evaluate" | "start" | "step";
  /** Client revision. Every result echoes this so replaced work can be ignored. */
  id: number;
  genome: Genome;
  config: Config;
  objective: Objective;
  mutationRate: number;
  /** Evolution RNG seed, distinct from config.randomSeed (the seed fixture). */
  randomSeed: number;
  epoch: number;
}

export interface PauseRequest {
  type: "pause";
  id: number;
}

export type EvolutionCommand = EvolutionRequest | PauseRequest;

export interface Execution {
  kind: "node:worker_threads";
  threadId: number;
}

/** Layers are base64-encoded row-major Uint8Array data, one string per layer. */
export type WireSimulation = Omit<Simulation, "layers"> & { layers: string[] };

export interface SnapshotMessage {
  type: "snapshot";
  id: number;
  genome: Genome;
  config: Config;
  simulation: WireSimulation;
  epoch: number;
  fitness: number;
  /** Seed for the NEXT evolve call; evaluate leaves it unchanged. */
  randomSeed: number;
  running: boolean;
  execution: Execution;
}

export type EvolutionResponse =
  | { type: "ready"; execution: Execution }
  | SnapshotMessage
  | { type: "paused"; id: number }
  | { type: "error"; id?: number; error: string };
