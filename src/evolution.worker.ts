import { evolve } from "./simulation";
import type { Config, Genome, Objective } from "./simulation";

self.onmessage = (
  event: MessageEvent<{
    genome: Genome;
    config: Config;
    objective: Objective;
    mutationRate: number;
    randomSeed: number;
  }>,
) => {
  try {
    const { genome, config, objective, mutationRate, randomSeed } = event.data;
    self.postMessage({
      result: evolve(genome, config, objective, mutationRate, randomSeed),
    });
  } catch (error) {
    self.postMessage({
      error:
        error instanceof Error ? error.message : "Evolution could not finish.",
    });
  }
};
