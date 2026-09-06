import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { fitVolumeCamera } from "./cameraFit";
import { LAYER_HEIGHT, VOXEL_WIDTH } from "./volumeData";

function fittedCamera(options: Parameters<typeof fitVolumeCamera>[0]) {
  const fit = fitVolumeCamera(options);
  const camera = new THREE.OrthographicCamera(
    -options.width / 2,
    options.width / 2,
    options.height / 2,
    -options.height / 2,
    0.1,
    1000,
  );
  camera.position.copy(fit.position);
  camera.quaternion.copy(fit.quaternion);
  camera.zoom = fit.zoom;
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  return camera;
}

function projectBox(
  camera: THREE.Camera,
  half: number,
  bottom: number,
  top: number,
) {
  const projected = new THREE.Box3();
  for (const x of [-half, half])
    for (const y of [bottom, top])
      for (const z of [-half, half])
        projected.expandByPoint(new THREE.Vector3(x, y, z).project(camera));
  return projected;
}

describe("full-viewport camera framing", () => {
  it.each([
    { width: 1440, height: 820 },
    { width: 390, height: 750 },
    { width: 844, height: 390 },
  ])(
    "keeps the full lattice and floor in frame at $width × $height",
    (viewport) => {
      for (const [latticeSize, layers] of [
        [25, 24],
        [41, 48],
        [65, 96],
        [1, 0],
        [1, 96],
      ]) {
        const camera = fittedCamera({ latticeSize, layers, ...viewport });
        const timeHeight = Math.max(1, layers - 1) * LAYER_HEIGHT;
        const floor = projectBox(camera, latticeSize / 2 + 2.65, -0.98, -0.58);
        const volume = projectBox(
          camera,
          (latticeSize - 1 + VOXEL_WIDTH) / 2,
          -(LAYER_HEIGHT * VOXEL_WIDTH) / 2,
          timeHeight + (LAYER_HEIGHT * VOXEL_WIDTH) / 2,
        );
        for (const bounds of [floor, volume]) {
          expect(bounds.min.x).toBeGreaterThanOrEqual(-0.920001);
          expect(bounds.max.x).toBeLessThanOrEqual(0.920001);
          expect(bounds.min.y).toBeGreaterThanOrEqual(-0.920001);
          expect(bounds.max.y).toBeLessThanOrEqual(0.920001);
          expect(bounds.min.z).toBeGreaterThan(-1);
          expect(bounds.max.z).toBeLessThan(1);
        }
      }
    },
  );

  it("defaults to annotation-free framing, with no offset for time labels", () => {
    const options = { latticeSize: 41, layers: 48, width: 1440, height: 820 };
    const defaultFit = fitVolumeCamera(options);
    expect(defaultFit).toEqual(
      fitVolumeCamera({ ...options, annotations: false }),
    );
    const camera = fittedCamera(options);
    const envelope = projectBox(
      camera,
      options.latticeSize / 2 + 2.65,
      -0.98,
      (options.layers - 1) * LAYER_HEIGHT + 0.5,
    );
    expect(envelope.getCenter(new THREE.Vector3()).x).toBeCloseTo(0);
    expect(envelope.getCenter(new THREE.Vector3()).y).toBeCloseTo(0);
    // The limiting axis uses the canvas rather than reserving a UI header/footer.
    const extent = envelope.getSize(new THREE.Vector3());
    expect(Math.max(extent.x, extent.y)).toBeCloseTo(1.84);
  });

  it("reclaims technical-axis space, particularly on narrow screens", () => {
    for (const viewport of [
      { width: 1440, height: 820 },
      { width: 390, height: 750 },
    ]) {
      const options = { latticeSize: 41, layers: 48, ...viewport };
      const clean = fitVolumeCamera(options);
      const annotated = fitVolumeCamera({ ...options, annotations: true });
      expect(clean.zoom).toBeGreaterThan(annotated.zoom);
      expect(clean.quaternion).toEqual(annotated.quaternion);
      if (viewport.width === 390)
        expect(clean.zoom / annotated.zoom).toBeGreaterThan(1.15);
    }
  });

  it("preserves the deliberate axonometric direction across field sizes and time depths", () => {
    const direction = new THREE.Vector3(1.5, 0.7, 1.8).normalize();
    for (const latticeSize of [25, 41, 65]) {
      for (const layers of [0, 1, 24, 96]) {
        const fit = fitVolumeCamera({
          latticeSize,
          layers,
          width: 390,
          height: 750,
        });
        const actual = fit.position.clone().sub(fit.target).normalize();
        expect(actual.distanceTo(direction)).toBeLessThan(1e-12);
        expect(fit.zoom).toBeGreaterThan(0);
        expect(Number.isFinite(fit.zoom)).toBe(true);
      }
    }
  });

  it("scales zoom linearly with viewport size without changing the composition", () => {
    const options = { latticeSize: 41, layers: 48, width: 720, height: 410 };
    for (const annotations of [false, true]) {
      const small = fitVolumeCamera({ ...options, annotations });
      const large = fitVolumeCamera({
        ...options,
        width: options.width * 2,
        height: options.height * 2,
        annotations,
      });
      expect(large.zoom).toBeCloseTo(small.zoom * 2);
      expect(large.position).toEqual(small.position);
      expect(large.target).toEqual(small.target);
      expect(large.quaternion).toEqual(small.quaternion);
    }
  });
});
