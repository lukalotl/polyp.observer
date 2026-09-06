import type { Genome } from "../simulation";
import { validateGenome, validateRunConfig } from "./config";
import { streamTrajectory } from "./trajectory";
import type { PreviewRange, RunConfig } from "./types";
import type { PreviewLayer } from "./previewLayers";

// Sparse volumes use instances; dense volumes use an exact GPU voxel traversal.
// Explicit windows bound texture memory without dropping any time planes.
export const MAX_PREVIEW_VOXELS = 2_000_000;
export const MAX_PREVIEW_LAYER_BYTES = 64 * 1024 * 1024;

export function validatePreviewRange(
  input: unknown,
  steps: number,
): PreviewRange {
  if (input === undefined) return { start: 0, end: steps - 1 };
  const range = input as PreviewRange;
  if (
    !range ||
    typeof range !== "object" ||
    Array.isArray(range) ||
    Object.keys(range).some((key) => key !== "start" && key !== "end") ||
    !Number.isSafeInteger(range.start) ||
    !Number.isSafeInteger(range.end) ||
    range.start < 0 ||
    range.end < range.start ||
    range.end >= steps
  )
    throw new RangeError(
      `Preview range must be integer timesteps with 0 ≤ start ≤ end < ${steps}.`,
    );
  return { start: range.start, end: range.end };
}

/** Full scientific trajectory and every consecutive plane in the chosen range. */
export function sampleTrajectory(
  genomeInput: Genome,
  input: RunConfig,
  seed: number,
  requestedRange?: PreviewRange,
) {
  const config = validateRunConfig(input),
    genome = validateGenome(genomeInput, config.stateCount),
    range = validatePreviewRange(requestedRange, config.steps);
  if (!Number.isSafeInteger(seed))
    throw new RangeError("Preview seed must be a safe integer.");
  const { size, steps } = config;
  const layers: PreviewLayer[] = [],
    layerTimes: number[] = [];
  const empty = new Uint32Array(0);
  let voxels = 0,
    bytes = 0;
  const trajectory = streamTrajectory(
    genome,
    config,
    seed,
    (time, halo, occupied, bounds) => {
      if (time < range.start || time > range.end) return;
      voxels += occupied;
      const dense = occupied * 4 >= size * size;
      bytes += dense ? size * size : occupied * 4;
      if (
        bytes > MAX_PREVIEW_LAYER_BYTES ||
        (voxels > MAX_PREVIEW_VOXELS &&
          size * size * (range.end - range.start + 1) > MAX_PREVIEW_LAYER_BYTES)
      )
        throw new RangeError(
          "This volume exceeds 64 MiB of render data. Choose a shorter preview range to render every timestep. Training is unaffected.",
        );
      const layer = dense
        ? new Uint8Array(size * size)
        : occupied
          ? new Uint32Array(occupied)
          : empty;
      let index = 0;
      if (occupied)
        for (let z = bounds.minZ; z <= bounds.maxZ; z++)
          for (let x = bounds.minX; x <= bounds.maxX; x++) {
            const state = halo[(z + 1) * (size + 2) + x + 1];
            if (state) {
              const cell = z * size + x;
              if (dense) layer[cell] = state;
              else layer[index++] = (cell << 4) | state;
            }
          }
      layers.push(layer);
      layerTimes.push(time);
    },
  );
  return {
    simulation: {
      ...trajectory,
      population: Array.from(trajectory.population),
      layers,
    },
    layerTimes,
    totalSteps: steps,
    stride: 1,
  };
}
