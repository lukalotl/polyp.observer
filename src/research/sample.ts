import type { Genome } from "../simulation";
import { validateGenome, validateRunConfig } from "./config";
import { streamTrajectory } from "./trajectory";
import type { RunConfig } from "./types";

export const MAX_PREVIEW_LAYERS = 128;
export const MAX_PREVIEW_VOXELS = 180_000;
export const MAX_PREVIEW_LAYER_BYTES = 8 * 1024 * 1024;

/** One full trajectory, with bounded complete spatial planes retained as it runs. */
export function sampleTrajectory(
  genomeInput: Genome,
  input: RunConfig,
  seed: number,
) {
  const config = validateRunConfig(input),
    genome = validateGenome(genomeInput, config.stateCount);
  if (!Number.isSafeInteger(seed))
    throw new RangeError("Preview seed must be a safe integer.");
  const { size, steps } = config;
  const area = size ** 2,
    last = steps - 1;
  const maxLayers = Math.min(
    MAX_PREVIEW_LAYERS,
    Math.floor(MAX_PREVIEW_LAYER_BYTES / area),
  );
  let stride = Math.max(1, Math.ceil(last / (maxLayers - 1)));
  let samples: { time: number; layer: Uint8Array; occupied: number }[] = [];
  let voxels = 0;
  const trajectory = streamTrajectory(
    genome,
    config,
    seed,
    (time, halo, occupied) => {
      if (time % stride !== 0 && time !== last) return;
      const layer = new Uint8Array(area);
      for (let row = 0; row < size; row++)
        layer.set(
          halo.subarray(
            (row + 1) * (size + 2) + 1,
            (row + 1) * (size + 2) + 1 + size,
          ),
          row * size,
        );
      samples.push({ time, layer, occupied });
      voxels += occupied;
      while (samples.length > maxLayers || voxels > MAX_PREVIEW_VOXELS) {
        if (stride >= last)
          throw new RangeError(
            "Preview limit: complete first/last spatial layers exceed 180,000 occupied voxels.",
          );
        // Doubled strides are subsets of every prior sampling grid. No required
        // plane is lost, and the final, possibly shorter interval is explicit.
        stride = Math.min(last, stride * 2);
        samples = samples.filter(
          (sample) => sample.time % stride === 0 || sample.time === last,
        );
        voxels = samples.reduce((sum, sample) => sum + sample.occupied, 0);
      }
    },
  );
  return {
    simulation: {
      ...trajectory,
      population: Array.from(trajectory.population),
      layers: samples.map((sample) => sample.layer),
    },
    layerTimes: samples.map((sample) => sample.time),
    totalSteps: steps,
    stride,
  };
}
