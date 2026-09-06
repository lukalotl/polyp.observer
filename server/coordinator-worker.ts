import { parentPort, workerData, threadId } from "node:worker_threads";
import { setImmediate as yieldTurn } from "node:timers/promises";
import {
  initializePopulation,
  advanceGeneration,
  generationSnapshot,
} from "../src/research/engine";
import type {
  BatchEvaluator,
  EngineState,
  Evaluation,
  RunConfig,
} from "../src/research/types";
if (!parentPort || threadId === 0)
  throw new Error("Genetics requires an actual Node worker.");
const port = parentPort;
const initial = workerData as { state: EngineState | null; config: RunConfig };
let state = initial.state;
let busy = false;
let pending:
  | { resolve: (results: Evaluation[]) => void; reject: (error: Error) => void }
  | undefined;
const evaluate: BatchEvaluator = (genomes) =>
  new Promise((resolve, reject) => {
    pending = { resolve, reject };
    port.postMessage({ type: "evaluate", genomes });
  });
port.on("message", (message) => {
  if (message.type === "evaluated") {
    const batch = pending;
    pending = undefined;
    if (message.error) batch?.reject(new Error(message.error));
    else batch?.resolve(message.results);
  } else if (message.type === "advance" && !busy) {
    busy = true;
    void (async () => {
      const started = performance.now();
      try {
        // Engine functions never mutate the complete state while breeding/scoring.
        const next = state
          ? await advanceGeneration(state, evaluate)
          : await initializePopulation(initial.config, evaluate);
        state = next;
        port.postMessage({
          type: "generation",
          state,
          snapshot: generationSnapshot(state),
          generationMs: performance.now() - started,
        });
      } catch (error) {
        port.postMessage({
          type: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        await yieldTurn();
        busy = false;
        port.postMessage({ type: "ready" });
      }
    })();
  }
});
port.postMessage({ type: "ready" });
