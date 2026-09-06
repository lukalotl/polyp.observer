import { parentPort, threadId } from "node:worker_threads";
import type { Genome } from "../src/simulation";
import { sampleTrajectory } from "../src/research/sample";
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
      const { simulation, layerTimes, totalSteps, stride } = sampleTrajectory(
        genome,
        config,
        seed,
      );
      const frame: PreviewFrame = {
        genome,
        seed,
        simulation: {
          ...simulation,
          layers: simulation.layers.map((layer) =>
            Buffer.from(layer).toString("base64"),
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
