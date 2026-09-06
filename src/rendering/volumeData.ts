import { MAX_STATE_COUNT } from "../research/genome";

/** The spacetime lattice is packed once, in time order, so scrubbing only changes a draw count. */
export const LAYER_HEIGHT = 0.72;
export const VOXEL_WIDTH = 0.92;

export interface VolumeSimulation {
  layers: Uint8Array[];
  size: number;
  /** Actual CA timestep per sampled layer; geometry and callbacks still use array indices. */
  layerTimes?: number[];
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
  positions: Float32Array;
  matrices: Float32Array;
  states: Uint8Array;
  layers: Uint16Array;
  layerEnds: Uint32Array;
  count: number;
  /** Occupied voxel extents, including voxel thickness; null for an empty specimen. */
  bounds: VolumeBounds | null;
}

export function packVolume(simulation: VolumeSimulation): PackedVolume {
  const { size, layers } = simulation;
  if (!Number.isInteger(size) || size < 1)
    throw new Error("The lattice size must be a positive integer.");
  let count = 0;
  const layerEnds = new Uint32Array(layers.length);
  layers.forEach((layer, t) => {
    for (let cell = 0; cell < Math.min(layer.length, size * size); cell++) {
      if (layer[cell] >= 1 && layer[cell] < MAX_STATE_COUNT) count++;
    }
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
    for (let cell = 0; cell < Math.min(layer.length, size * size); cell++) {
      const state = layer[cell];
      if (state < 1 || state >= MAX_STATE_COUNT) continue;
      const x = (cell % size) - center;
      const y = t * LAYER_HEIGHT;
      const z = Math.floor(cell / size) - center;
      min[0] = Math.min(min[0], x - VOXEL_WIDTH / 2);
      min[1] = Math.min(min[1], y - (LAYER_HEIGHT * VOXEL_WIDTH) / 2);
      min[2] = Math.min(min[2], z - VOXEL_WIDTH / 2);
      max[0] = Math.max(max[0], x + VOXEL_WIDTH / 2);
      max[1] = Math.max(max[1], y + (LAYER_HEIGHT * VOXEL_WIDTH) / 2);
      max[2] = Math.max(max[2], z + VOXEL_WIDTH / 2);
      positions.set([x, y, z], index * 3);
      const offset = index * 16;
      matrices[offset] = VOXEL_WIDTH;
      matrices[offset + 5] = LAYER_HEIGHT * VOXEL_WIDTH;
      matrices[offset + 10] = VOXEL_WIDTH;
      matrices[offset + 12] = x;
      matrices[offset + 13] = y;
      matrices[offset + 14] = z;
      matrices[offset + 15] = 1;
      states[index] = state;
      instanceLayers[index] = t;
      index++;
    }
  });
  return {
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
