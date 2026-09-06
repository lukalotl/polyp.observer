import { parentPort, threadId } from "node:worker_threads";
import { simulate, type Genome } from "../src/simulation";
import type { PreviewFrame, RunConfig } from "../src/research/types";
if (!parentPort || threadId === 0)
  throw new Error("Preview requires an actual Node worker.");
const port = parentPort;
port.on(
  "message",
  ({
    genome,
    config,
    seed,
  }: {
    genome: Genome;
    config: RunConfig;
    seed: number;
  }) => {
    try {
      // Full horizon is simulated exactly once. Only rendering layers are sampled.
      const simulation = simulate(genome, {
        size: config.size,
        steps: config.steps,
        seed: config.seed,
        randomSeed: seed,
      });
      const totalSteps = simulation.layers.length;
      let stride = Math.max(1, Math.ceil((totalSteps - 1) / 127));
      let layerTimes: number[];
      while (true) {
        layerTimes = [];
        for (let t = 0; t < totalSteps - 1; t += stride) layerTimes.push(t);
        layerTimes.push(totalSteps - 1);
        const occupied = layerTimes.reduce(
          (sum, t) => sum + simulation.population[t],
          0,
        );
        if (layerTimes.length <= 128 && occupied <= 180_000) break;
        if (stride >= totalSteps - 1)
          throw new Error(
            "Preview limit: complete first/last spatial layers exceed 180,000 occupied voxels.",
          );
        stride++;
      }
      const frame: PreviewFrame = {
        genome,
        seed,
        simulation: {
          ...simulation,
          layers: layerTimes.map((t) =>
            Buffer.from(simulation.layers[t]).toString("base64"),
          ),
        },
        layerTimes,
        totalSteps,
        stride,
      };
      port.postMessage({ frame });
    } catch (error) {
      port.postMessage({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
);
