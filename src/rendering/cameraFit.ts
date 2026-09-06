import * as THREE from "three";
import { LAYER_HEIGHT } from "./volumeData";

interface CameraFitOptions {
  latticeSize: number;
  layers: number;
  width: number;
  height: number;
  annotations?: boolean;
}

/** Stable lattice framing, independent of occupancy, playback and material. */
export function fitVolumeCamera({
  latticeSize,
  layers,
  width,
  height,
  annotations = false,
}: CameraFitOptions) {
  const timeHeight = Math.max(1, layers - 1) * LAYER_HEIGHT;
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
  const bottom = annotations ? -1.5 : -0.98;
  const top = timeHeight + (annotations ? 3.5 : 0.5);
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
    ? (span.x * (latticeSize + 12)) / (latticeSize + 2)
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
  };
}
