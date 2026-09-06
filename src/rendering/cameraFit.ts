import * as THREE from "three";
import { LAYER_HEIGHT, referenceScale, type VolumeBounds } from "./volumeData";

export type VolumeView = "iso" | "top" | "front";
export type VolumeFitMode = "specimen" | "world";

interface CameraFitOptions {
  latticeSize: number;
  layers: number;
  /** Last rendered layer height, including actual sampled timestep spacing. */
  timeHeight?: number;
  width: number;
  height: number;
  annotations?: boolean;
  fitMode?: VolumeFitMode;
  view?: VolumeView;
  occupiedBounds?: VolumeBounds | null;
}

/** Fit all occupied sampled layers (stable during playback), or the original world lattice. */
export function fitVolumeCamera({
  latticeSize,
  layers,
  timeHeight = Math.max(1, layers - 1) * LAYER_HEIGHT,
  width,
  height,
  annotations = false,
  fitMode = "world",
  view = "iso",
  occupiedBounds,
}: CameraFitOptions) {
  if (fitMode === "specimen" || view !== "iso") {
    return fitBoundsCamera({
      latticeSize,
      layers,
      timeHeight,
      width,
      height,
      annotations,
      fitMode,
      view,
      occupiedBounds,
    });
  }
  const annotationScale = referenceScale(latticeSize, timeHeight);
  const target = new THREE.Vector3(0, timeHeight * 0.45, 0);
  const reference = new THREE.OrthographicCamera();
  // Keep the low axonometric composition: time is vertical, both spatial axes legible.
  // Orthographic distance does not change scale; leave the whole form in front
  // of the near plane even for a tiny field with a tall history.
  const distance = Math.max(latticeSize, timeHeight, 4);
  reference.position.set(
    distance * 1.5,
    distance * 0.7 + target.y,
    distance * 1.8,
  );
  reference.lookAt(target);
  reference.updateMatrixWorld();

  // Without annotations, fit the complete lattice and quiet floor plinth, not
  // the reference stage's time axis or labels. Never crop to current occupancy:
  // a growing or evolving form should not cause the camera to jump around.
  const half = latticeSize / 2 + (annotations ? 1 : 2.65);
  const bottom = annotations ? -1.5 * annotationScale : -0.98;
  const top = timeHeight + (annotations ? 3.5 * annotationScale : 0.5);
  const bounds = new THREE.Box3();
  for (const x of [-half, half])
    for (const y of [bottom, top])
      for (const z of [-half, half]) {
        bounds.expandByPoint(
          new THREE.Vector3(x, y, z).applyMatrix4(reference.matrixWorldInverse),
        );
      }
  const span = bounds.getSize(new THREE.Vector3());
  const safeWidth = annotations
    ? (span.x * (latticeSize + 12 * annotationScale)) / (latticeSize + 2)
    : span.x;
  const zoom = Math.min(
    (width * (annotations ? 0.88 : 0.92)) / safeWidth,
    (height * 0.92) / span.y,
  );
  const center = bounds.getCenter(new THREE.Vector3());
  const shift = new THREE.Vector3(
    center.x,
    center.y + (annotations ? (height * 0.02) / zoom : 0),
    0,
  ).applyQuaternion(reference.quaternion);

  return {
    position: reference.position.clone().add(shift),
    quaternion: reference.quaternion.clone(),
    target: target.add(shift),
    zoom,
    far: Math.max(1000, distance * 8),
  };
}

function fitBoundsCamera({
  latticeSize,
  layers,
  timeHeight = Math.max(1, layers - 1) * LAYER_HEIGHT,
  width,
  height,
  annotations = false,
  fitMode,
  view,
  occupiedBounds,
}: CameraFitOptions) {
  const half = Math.max(1, latticeSize) / 2;
  const specimen = fitMode === "specimen" && occupiedBounds;
  const envelope = specimen
    ? new THREE.Box3(
        new THREE.Vector3(...specimen.min),
        new THREE.Vector3(...specimen.max),
      )
    : new THREE.Box3(
        new THREE.Vector3(-half - 2.65, -0.98, -half - 2.65),
        new THREE.Vector3(half + 2.65, timeHeight + 0.5, half + 2.65),
      );
  if (annotations) {
    // Match the stage's floor, frame and labels. The specimen stage is local to occupied extents.
    const scale = referenceScale(latticeSize, timeHeight, specimen || null);
    envelope.min.add(new THREE.Vector3(-7.2, -0.8, -0.8).multiplyScalar(scale));
    envelope.max.add(new THREE.Vector3(6.5, 4, 6).multiplyScalar(scale));
  }
  const target = envelope.getCenter(new THREE.Vector3());
  const span = envelope.getSize(new THREE.Vector3());
  const distance = Math.max(span.x, span.y, span.z, 4) * 3;
  const direction =
    view === "top"
      ? new THREE.Vector3(0, 1, 0)
      : view === "front"
        ? new THREE.Vector3(0, 0, 1)
        : new THREE.Vector3(1.5, 0.7, 1.8).normalize();
  const reference = new THREE.OrthographicCamera();
  if (view === "top") reference.up.set(0, 0, -1);
  reference.position.copy(target).addScaledVector(direction, distance);
  reference.lookAt(target);
  reference.updateMatrixWorld();
  const projected = new THREE.Box3();
  for (const x of [envelope.min.x, envelope.max.x])
    for (const y of [envelope.min.y, envelope.max.y])
      for (const z of [envelope.min.z, envelope.max.z])
        projected.expandByPoint(
          new THREE.Vector3(x, y, z).applyMatrix4(reference.matrixWorldInverse),
        );
  const projectedSpan = projected.getSize(new THREE.Vector3());
  const zoom = Math.min(
    (Math.max(1, width) * 0.92) / Math.max(0.1, projectedSpan.x),
    (Math.max(1, height) * 0.92) / Math.max(0.1, projectedSpan.y),
  );
  return {
    position: reference.position.clone(),
    quaternion: reference.quaternion.clone(),
    target,
    zoom,
    far: Math.max(1000, distance * 8),
  };
}
