import { parentPort, workerData, threadId } from "node:worker_threads";
import { evaluateGenome } from "../src/research/evaluate";
import type { Genome } from "../src/simulation";
import type { RunConfig } from "../src/research/types";
if (!parentPort || threadId === 0)
  throw new Error("Fitness requires an actual Node worker.");
const port = parentPort;
const config = workerData as RunConfig;
port.on("message", ({ index, genome }: { index: number; genome: Genome }) => {
  try {
    port.postMessage({ index, result: evaluateGenome(genome, config) });
  } catch (error) {
    port.postMessage({
      index,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
