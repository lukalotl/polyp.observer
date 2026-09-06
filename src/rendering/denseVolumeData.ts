import * as THREE from "three";
import { forEachOccupied } from "../research/previewLayers";
import { MAX_PREVIEW_LAYER_BYTES } from "../research/sample";
import {
  layoutTimeLayers,
  type VolumeBounds,
  type VolumeSimulation,
} from "./volumeData";

export function needsDenseRenderer(simulation: VolumeSimulation): boolean {
  // Switch well before instance matrices exhaust a browser's GPU memory.
  // Very sparse, very large worlds can still use the sparse instance path.
  if (simulation.size ** 2 * simulation.layers.length > MAX_PREVIEW_LAYER_BYTES)
    return false;
  let count = 0;
  for (const layer of simulation.layers) {
    if (layer instanceof Uint32Array) count += layer.length;
    else for (const state of layer) if (state) count++;
    if (count > 180_000) return true;
  }
  return false;
}

/** Exact byte lattice for GPU DDA; no interpolation, opacity integration or LOD. */
export function packDenseVolume(
  simulation: VolumeSimulation,
  compressTime = false,
  edge = 1024,
) {
  const { size, layers } = simulation;
  const length = size * size * layers.length;
  if (length > MAX_PREVIEW_LAYER_BYTES)
    throw new Error("Choose a shorter preview range for this volume.");
  const width = Math.min(edge, Math.max(1, length));
  const height = Math.min(edge, Math.ceil(length / width));
  const depth = Math.max(1, Math.ceil(length / (width * height)));
  if (depth > edge) throw new Error("This GPU needs a shorter preview range.");
  const cells = new Uint8Array(width * height * depth);
  const timeLayout = layoutTimeLayers(
    layers.length,
    simulation.layerTimes,
    compressTime,
  );
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const center = (size - 1) / 2;
  layers.forEach((layer, t) => {
    forEachOccupied(layer, size * size, (cell, state) => {
      cells[t * size * size + cell] = state;
      const x = (cell % size) - center,
        z = Math.floor(cell / size) - center,
        y = timeLayout.heights[t];
      min[0] = Math.min(min[0], x - 0.5);
      max[0] = Math.max(max[0], x + 0.5);
      min[1] = Math.min(min[1], y - timeLayout.scale / 2);
      max[1] = Math.max(max[1], y + timeLayout.scale / 2);
      min[2] = Math.min(min[2], z - 0.5);
      max[2] = Math.max(max[2], z + 0.5);
    });
  });
  return {
    cells,
    width,
    height,
    depth,
    size,
    layerCount: layers.length,
    timeLayout,
    bounds: Number.isFinite(min[0]) ? ({ min, max } as VolumeBounds) : null,
  };
}
export type DenseVolumeData = ReturnType<typeof packDenseVolume>;

/** Exact CPU counterpart for picking a rendered time plane. */
export function pickDenseLayer(
  data: DenseVolumeData,
  ray: THREE.Ray,
  visibleLayers: number,
): number | null {
  const { size, timeLayout, cells } = data;
  const count = Math.min(data.layerCount, visibleLayers),
    scale = timeLayout.scale;
  if (!count) return null;
  const origin = new THREE.Vector3(
    ray.origin.x + size / 2,
    ray.origin.y / scale + 0.5,
    ray.origin.z + size / 2,
  );
  const direction = new THREE.Vector3(
    ray.direction.x,
    ray.direction.y / scale,
    ray.direction.z,
  );
  const gridRay = new THREE.Ray(origin, direction);
  const entry = gridRay.intersectBox(
    new THREE.Box3(new THREE.Vector3(), new THREE.Vector3(size, count, size)),
    new THREE.Vector3(),
  );
  if (!entry) return null;
  // A ray originating inside the volume starts there rather than at its exit.
  const p =
    origin.x >= 0 &&
    origin.x < size &&
    origin.y >= 0 &&
    origin.y < count &&
    origin.z >= 0 &&
    origin.z < size
      ? origin.clone()
      : entry;
  p.addScaledVector(direction, 1e-7);
  const cell = [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)];
  const dirs = direction.toArray(),
    pos = p.toArray();
  const step = dirs.map(Math.sign),
    delta = dirs.map((d) => (d ? Math.abs(1 / d) : Infinity));
  const next = dirs.map((d, i) =>
    d ? (cell[i] + (d > 0 ? 1 : 0) - pos[i]) / d : Infinity,
  );
  for (let i = 0; i < size * 2 + count + 3; i++) {
    const [x, y, z] = cell;
    if (x < 0 || x >= size || y < 0 || y >= count || z < 0 || z >= size)
      return null;
    if (cells[y * size * size + z * size + x]) return y;
    const axis =
      next[0] <= next[1] && next[0] <= next[2] ? 0 : next[1] <= next[2] ? 1 : 2;
    cell[axis] += step[axis];
    next[axis] += delta[axis];
  }
  return null;
}
