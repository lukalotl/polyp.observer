import type { VolumeBounds } from "./volumeData";

/** Spatial walls are the real lattice extents; only the time extent follows the specimen. */
export function simulationBounds(
  size: number,
  occupied: VolumeBounds | null,
): VolumeBounds {
  return {
    min: [-size / 2, occupied?.min[1] ?? -0.5, -size / 2],
    max: [size / 2, occupied?.max[1] ?? 0.5, size / 2],
  };
}

/** The ceiling marks the final tested timestep, in the same coordinates as the voxels. */
export function cutoffHeight(
  cutoff: number,
  firstTime: number,
  timeScale: number,
) {
  return (cutoff - firstTime) * timeScale;
}
