import { parentPort, threadId } from "node:worker_threads";
import type { Genome } from "../src/simulation";
import { sampleTrajectory } from "../src/research/sample";
import type {
  PreviewFrame,
  PreviewRange,
  RunConfig,
} from "../src/research/types";
if (!parentPort || threadId === 0)
  throw new Error("Preview requires an actual Node worker.");
const port = parentPort;
port.on(
  "message",
  ({
    genome,
    config,
    seed,
    range,
  }: {
    genome: Genome;
    config: RunConfig;
    seed: number;
    range?: PreviewRange;
  }) => {
    try {
      const { simulation, layerTimes, totalSteps, stride, boundaryContacts } =
        sampleTrajectory(genome, config, seed, range);
      const frame: PreviewFrame = {
        genome,
        seed,
        encoding: "adaptive-v1",
        simulation: {
          ...simulation,
          layers: simulation.layers.map((layer) => {
            if (layer instanceof Uint8Array)
              return "d" + Buffer.from(layer).toString("base64");
            const bytes = Buffer.allocUnsafe(layer.length * 4);
            layer.forEach((entry, i) => bytes.writeUInt32LE(entry, i * 4));
            return "s" + bytes.toString("base64");
          }),
        },
        layerTimes,
        totalSteps,
        stride,
        boundaryContacts,
      };
      port.postMessage({ frame });
    } catch (error) {
      port.postMessage({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
);
