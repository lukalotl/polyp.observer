import { forEachOccupied, type PreviewLayer } from "../research/previewLayers";

/** The spacetime lattice is packed once, in time order, so scrubbing only changes a draw count. */
/** One CA timestep equals one spatial cell unit by default. */
export const LAYER_HEIGHT = 1;
const COMPACT_LAYER_HEIGHT = 0.72;
// Full lattice cells share faces; no decorative gaps in space or time.
export const VOXEL_WIDTH = 1;

export interface VolumeSimulation {
  layers: PreviewLayer[];
  size: number;
  /** Actual CA timestep per sampled layer. Picking callbacks use array indices. */
  layerTimes?: number[];
}

export interface TimeLayout {
  heights: number[];
  /** World units per CA timestep; applies equally to positions and voxel thickness. */
  scale: number;
}

/** A single slice sits at height zero but retains its actual timestamp label.
 * Compression is a uniform scale, so even a shorter final interval stays proportional.
 */
export function layoutTimeLayers(
  count: number,
  layerTimes?: readonly number[],
  compressTime = false,
): TimeLayout {
  if (
    layerTimes &&
    (layerTimes.length !== count ||
      layerTimes.some(
        (time, index) =>
          !Number.isSafeInteger(time) ||
          time < 0 ||
          (index > 0 && time <= layerTimes[index - 1]),
      ))
  )
    throw new RangeError(
      "Layer times must be complete, increasing nonnegative integers.",
    );
  const times =
    layerTimes ?? Array.from({ length: count }, (_, index) => index);
  const duration = count > 1 ? times[count - 1] - times[0] : 0;
  const scale =
    compressTime && duration > 0
      ? Math.min(1, (COMPACT_LAYER_HEIGHT * (count - 1)) / duration)
      : LAYER_HEIGHT;
  return {
    scale,
    heights: Array.from(times, (time) => (time - times[0]) * scale),
  };
}

/** Keep annotations legible when the time axis spans tens of thousands of cells. */
export function referenceScale(
  size: number,
  timeHeight: number,
  bounds?: VolumeBounds | null,
): number {
  const spans = bounds
    ? bounds.max.map((value, axis) => value - bounds.min[axis])
    : [size, timeHeight];
  return Math.max(1, Math.max(...spans) / 100);
}

export interface VolumeBounds {
  min: [number, number, number];
  max: [number, number, number];
}

/** A supplied but incomplete time map must not mislabel sample indices as timesteps. */
export function layerTimeLabel(
  index: number,
  layerTimes?: readonly number[],
): string {
  if (!layerTimes) return String(index);
  const time = layerTimes[index];
  return Number.isFinite(time) ? String(time) : "?";
}

export interface PackedVolume {
  timeLayout: TimeLayout;
  positions: Float32Array;
  matrices: Float32Array;
  states: Uint8Array;
  layers: Uint16Array;
  layerEnds: Uint32Array;
  count: number;
  /** Occupied voxel extents, including voxel thickness; null for an empty specimen. */
  bounds: VolumeBounds | null;
}

export function packVolume(
  simulation: VolumeSimulation,
  compressTime = false,
): PackedVolume {
  const { size, layers } = simulation;
  if (!Number.isInteger(size) || size < 1)
    throw new Error("The lattice size must be a positive integer.");
  const timeLayout = layoutTimeLayers(
    layers.length,
    simulation.layerTimes,
    compressTime,
  );
  const voxelHeight = timeLayout.scale;
  let count = 0;
  const layerEnds = new Uint32Array(layers.length);
  layers.forEach((layer, t) => {
    forEachOccupied(layer, size * size, () => count++);
    layerEnds[t] = count;
  });
  const positions = new Float32Array(count * 3);
  const matrices = new Float32Array(count * 16);
  const states = new Uint8Array(count);
  const instanceLayers = new Uint16Array(count);
  const center = (size - 1) / 2;
  let index = 0;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  layers.forEach((layer, t) => {
    forEachOccupied(layer, size * size, (cell, state) => {
      const x = (cell % size) - center;
      const y = timeLayout.heights[t];
      const z = Math.floor(cell / size) - center;
      min[0] = Math.min(min[0], x - VOXEL_WIDTH / 2);
      min[1] = Math.min(min[1], y - voxelHeight / 2);
      min[2] = Math.min(min[2], z - VOXEL_WIDTH / 2);
      max[0] = Math.max(max[0], x + VOXEL_WIDTH / 2);
      max[1] = Math.max(max[1], y + voxelHeight / 2);
      max[2] = Math.max(max[2], z + VOXEL_WIDTH / 2);
      positions.set([x, y, z], index * 3);
      const offset = index * 16;
      matrices[offset] = VOXEL_WIDTH;
      matrices[offset + 5] = voxelHeight;
      matrices[offset + 10] = VOXEL_WIDTH;
      matrices[offset + 12] = x;
      matrices[offset + 13] = y;
      matrices[offset + 14] = z;
      matrices[offset + 15] = 1;
      states[index] = state;
      instanceLayers[index] = t;
      index++;
    });
  });
  return {
    timeLayout,
    positions,
    matrices,
    states,
    layers: instanceLayers,
    layerEnds,
    count,
    bounds: count ? { min, max } : null,
  };
}

export function visibleCount(
  data: PackedVolume,
  visibleLayers: number,
): number {
  const end = Math.max(
    0,
    Math.min(data.layerEnds.length, Math.floor(visibleLayers)),
  );
  return end > 0 ? data.layerEnds[end - 1] : 0;
}
