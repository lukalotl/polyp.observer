import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  packDenseVolume,
  pickDenseLayer,
  needsDenseRenderer,
} from "./denseVolumeData";
import { packVolume } from "./volumeData";

describe("exact dense voxel rendering", () => {
  it("uses the texture path before a near-two-million-cell specimen exhausts instance memory", () => {
    const layer = new Uint8Array(65 ** 2);
    layer.fill(1, 0, 970);
    expect(
      needsDenseRenderer({ size: 65, layers: Array(2048).fill(layer) }),
    ).toBe(true);
    expect(needsDenseRenderer({ size: 65, layers: [layer] })).toBe(false);
  });
  it("packs the same state at every XYZ coordinate and bounds as the ordinary renderer", () => {
    const layers = Array.from({ length: 7 }, (_, t) =>
      Uint8Array.from({ length: 25 }, (_, cell) => (cell + t) % 5),
    );
    const simulation = {
      size: 5,
      layers,
      layerTimes: layers.map((_, i) => i + 87),
    };
    for (const compressed of [false, true]) {
      const data = packDenseVolume(simulation, compressed, 8);
      expect(data.bounds).toEqual(packVolume(simulation, compressed).bounds);
      expect(data.timeLayout).toEqual(
        packVolume(simulation, compressed).timeLayout,
      );
      for (let t = 0; t < layers.length; t++)
        for (let cell = 0; cell < 25; cell++)
          expect(data.cells[t * 25 + cell]).toBe(layers[t][cell]);
      expect(data.width * data.height * data.depth).toBeGreaterThanOrEqual(175);
    }
  });
  it("picks the first occupied voxel through empty timesteps, clipping exactly at playback", () => {
    const layers = Array.from({ length: 8 }, (_, t) =>
      Uint8Array.from({ length: 9 }, (_, i) =>
        i === 4 && (t === 2 || t === 6) ? 1 : 0,
      ),
    );
    const data = packDenseVolume({ size: 3, layers });
    const down = new THREE.Ray(
      new THREE.Vector3(0, 20, 0),
      new THREE.Vector3(0, -1, 0),
    );
    expect(pickDenseLayer(data, down, 8)).toBe(6);
    expect(pickDenseLayer(data, down, 6)).toBe(2);
    expect(pickDenseLayer(data, down, 2)).toBeNull();
    expect(
      pickDenseLayer(
        data,
        new THREE.Ray(new THREE.Vector3(0, 2, 10), new THREE.Vector3(0, 0, -1)),
        8,
      ),
    ).toBe(2);
    expect(
      pickDenseLayer(
        data,
        new THREE.Ray(new THREE.Vector3(0, 3, 10), new THREE.Vector3(0, 0, -1)),
        8,
      ),
    ).toBeNull();
    const compressed = packDenseVolume({ size: 3, layers }, true);
    expect(pickDenseLayer(compressed, down, 8)).toBe(6);
  });
});
