import type {
  EngineState,
  RunConfig,
  RunCheckpoint,
} from "../src/research/types";
import { HISTORY_LIMIT, IMPROVEMENT_LIMIT } from "./validation";

export const MAX_RESEARCH_MEMORY_BYTES = 512 * 1024 * 1024;
export const MAX_RUN_MEMORY_BYTES = 64 * 1024 * 1024;

interface RetainedRun extends Pick<
  RunCheckpoint,
  "config" | "history" | "improvements"
> {
  state: EngineState | null;
  archives: readonly unknown[];
}

function estimate(
  config: RunConfig,
  history: number,
  improvements: number,
  cache: number,
  populations: number,
): number {
  // Conservative object/lineage allowance, plus bounded config and metadata.
  const extraGenes = Math.max(0, 9 * config.stateCount - 45);
  const individualBytes = 2048 + extraGenes * 24;
  return (
    16 * 1024 +
    history * 512 +
    improvements * individualBytes +
    cache * (768 + extraGenes) +
    config.populationSize * individualBytes * populations
  );
}

/** A job reserves its complete configured growth before allocating workers. */
export function maximumRunMemory(config: RunConfig): number {
  return estimate(
    config,
    HISTORY_LIMIT,
    IMPROVEMENT_LIMIT,
    config.cacheSize,
    config.retainedSnapshots + 3,
  );
}

/** Stopped/queued runs cannot grow: charge only the collections they retain. */
export function retainedRunMemory(run: RetainedRun): number {
  return estimate(
    run.config,
    run.history.length,
    run.improvements.length,
    run.state?.cache.length ?? 0,
    // Keep the same conservative allowance for current population/snapshot copies.
    run.archives.length + (run.state ? 3 : 0),
  );
}
