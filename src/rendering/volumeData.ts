/** The spacetime lattice is packed once, in time order, so scrubbing only changes a draw count. */
export const LAYER_HEIGHT = 0.72;
export const VOXEL_WIDTH = 0.92;

export interface VolumeSimulation {
  layers: Uint8Array[];
  size: number;
}

export interface PackedVolume {
  positions: Float32Array;
  matrices: Float32Array;
  states: Uint8Array;
  layers: Uint16Array;
  layerEnds: Uint32Array;
  count: number;
}

export function packVolume(simulation: VolumeSimulation): PackedVolume {
  const { size, layers } = simulation;
  if (!Number.isInteger(size) || size < 1)
    throw new Error("The lattice size must be a positive integer.");
  let count = 0;
  const layerEnds = new Uint32Array(layers.length);
  layers.forEach((layer, t) => {
    for (let cell = 0; cell < Math.min(layer.length, size * size); cell++) {
      if (layer[cell] >= 1 && layer[cell] <= 4) count++;
    }
    layerEnds[t] = count;
  });
  const positions = new Float32Array(count * 3);
  const matrices = new Float32Array(count * 16);
  const states = new Uint8Array(count);
  const instanceLayers = new Uint16Array(count);
  const center = (size - 1) / 2;
  let index = 0;
  layers.forEach((layer, t) => {
    for (let cell = 0; cell < Math.min(layer.length, size * size); cell++) {
      const state = layer[cell];
      if (state < 1 || state > 4) continue;
      const x = (cell % size) - center;
      const y = t * LAYER_HEIGHT;
      const z = Math.floor(cell / size) - center;
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
