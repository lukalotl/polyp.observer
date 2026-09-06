import { describe, expect, it } from "vitest";
import {
  LAYER_HEIGHT,
  packVolume,
  visibleCount,
  VOXEL_WIDTH,
  layerTimeLabel,
} from "./volumeData";
import {
  instanceColors,
  makePointMaterial,
  makeVoxelMaterial,
} from "./materials";

const fixture = {
  size: 3,
  layers: [
    Uint8Array.from([1, 0, 0, 0, 2, 0, 0, 0, 0]),
    Uint8Array.from([0, 0, 3, 0, 0, 0, 0, 0, 4]),
    new Uint8Array(9),
  ],
};

describe("the spacetime render contract", () => {
  it("maps row-major XY slices to centered world XZ, and time to world Y", () => {
    const packed = packVolume(fixture);
    expect(packed.count).toBe(4);
    expect(Array.from(packed.states)).toEqual([1, 2, 3, 4]);
    expect(Array.from(packed.layers)).toEqual([0, 0, 1, 1]);
    expect(Array.from(packed.positions.slice(0, 6))).toEqual([
      -1, 0, -1, 0, 0, 0,
    ]);
    expect(packed.positions[6]).toBe(1);
    expect(packed.positions[7]).toBeCloseTo(LAYER_HEIGHT);
    expect(packed.positions[8]).toBe(-1);
    expect(packed.matrices[0]).toBeCloseTo(VOXEL_WIDTH);
    expect(packed.matrices[5]).toBeCloseTo(LAYER_HEIGHT * VOXEL_WIDTH);
    expect(packed.matrices[12]).toBe(-1);
    expect(packed.matrices[15]).toBe(1);
  });

  it("scrubs both directions using cumulative counts, without repacking or mutating the seed", () => {
    const seed = fixture.layers[0].slice();
    const packed = packVolume(fixture);
    const originalMatrices = packed.matrices;
    expect(Array.from(packed.layerEnds)).toEqual([2, 4, 4]);
    expect(visibleCount(packed, 2)).toBe(4);
    expect(visibleCount(packed, 1)).toBe(2);
    expect(visibleCount(packed, 100)).toBe(4);
    expect(visibleCount(packed, -1)).toBe(0);
    expect(packed.matrices).toBe(originalMatrices);
    expect(fixture.layers[0]).toEqual(seed);
  });

  it("does not render empty or invalid states, and supports extinction/empty simulations", () => {
    const empty = packVolume({
      size: 1,
      layers: [Uint8Array.of(0), Uint8Array.of(16)],
    });
    expect(empty.count).toBe(0);
    expect(visibleCount(empty, 2)).toBe(0);
    expect(packVolume({ size: 3, layers: [] }).count).toBe(0);
    expect(() => packVolume({ size: 0, layers: [] })).toThrow(
      "positive integer",
    );
  });

  it("keeps all four states distinct in every palette and generates deterministic colors", () => {
    const packed = packVolume(fixture);
    for (const palette of ["mineral", "ember", "ink"] as const) {
      const colors = instanceColors(packed, palette, fixture.layers.length);
      expect(colors).toEqual(
        instanceColors(packed, palette, fixture.layers.length),
      );
      const stateColors = Array.from({ length: 4 }, (_, i) =>
        Array.from(colors.slice(i * 3, i * 3 + 3)).join(","),
      );
      expect(new Set(stateColors).size).toBe(4);
      expect(
        Array.from(colors).every(
          (value) => Number.isFinite(value) && value >= 0,
        ),
      ).toBe(true);
    }
    expect(instanceColors(packed, "mineral", 3)).not.toEqual(
      instanceColors(packed, "ember", 3),
    );
  });

  it("injects actual fragment shading, with a uniform toggle instead of a material rebuild", () => {
    const voxel = makeVoxelMaterial();
    const shader = {
      vertexShader: "",
      fragmentShader: "#include <dithering_fragment>",
      uniforms: {},
    } as Parameters<typeof voxel.material.onBeforeCompile>[0];
    voxel.material.onBeforeCompile(
      shader,
      {} as Parameters<typeof voxel.material.onBeforeCompile>[1],
    );
    expect(shader.fragmentShader).toContain("polypBayer4(gl_FragCoord.xy)");
    expect(shader.fragmentShader).toContain("floor(gl_FragColor.rgb * 24.0");
    expect(shader.uniforms.uPolypGrain).toBe(voxel.grain);
    voxel.grain.value = 0;
    expect(shader.uniforms.uPolypGrain.value).toBe(0);
    voxel.material.dispose();
    const points = makePointMaterial();
    expect(points.material.type).toBe("PointsMaterial");
    points.material.dispose();
  });
});

describe("sampled specimen geometry", () => {
  it("records occupied bounds with physical voxel thickness, including off-center cells", () => {
    const data = packVolume({
      size: 5,
      layers: [
        Uint8Array.from({ length: 25 }, (_, i) => (i === 3 ? 1 : 0)),
        new Uint8Array(25),
        Uint8Array.from({ length: 25 }, (_, i) => (i === 24 ? 2 : 0)),
      ],
    });
    expect(data.bounds?.min[0]).toBeCloseTo(1 - VOXEL_WIDTH / 2);
    expect(data.bounds?.max[0]).toBeCloseTo(2 + VOXEL_WIDTH / 2);
    expect(data.bounds?.min[1]).toBeCloseTo((-LAYER_HEIGHT * VOXEL_WIDTH) / 2);
    expect(data.bounds?.max[1]).toBeCloseTo(
      2 * LAYER_HEIGHT + (LAYER_HEIGHT * VOXEL_WIDTH) / 2,
    );
    expect(data.bounds?.min[2]).toBeCloseTo(-2 - VOXEL_WIDTH / 2);
    expect(data.bounds?.max[2]).toBeCloseTo(2 + VOXEL_WIDTH / 2);
    expect(
      packVolume({ size: 1, layers: [Uint8Array.of(0)] }).bounds,
    ).toBeNull();
  });
  it("keeps sampled array-index geometry and callbacks separate from actual timestep labels", () => {
    const data = packVolume({
      size: 1,
      layers: [Uint8Array.of(1), Uint8Array.of(2), Uint8Array.of(3)],
      layerTimes: [0, 8, 19],
    });
    expect(Array.from(data.layers)).toEqual([0, 1, 2]);
    expect(data.positions[7]).toBeCloseTo(2 * LAYER_HEIGHT);
    expect(layerTimeLabel(2, [0, 8, 19])).toBe("19");
    expect(layerTimeLabel(2)).toBe("2");
    expect(layerTimeLabel(2, [0, 8])).toBe("?");
  });
});

it("packs and colors all fifteen occupied states without dropping high states", () => {
  const packed = packVolume({
    size: 4,
    layers: [Uint8Array.from({ length: 16 }, (_, i) => i)],
  });
  expect(packed.count).toBe(15);
  expect([...packed.states]).toEqual(
    Array.from({ length: 15 }, (_, i) => i + 1),
  );
  for (const palette of ["mineral", "ember", "ink"] as const) {
    const colors = instanceColors(packed, palette, 1);
    expect(colors.every(Number.isFinite)).toBe(true);
    expect(
      new Set(
        Array.from({ length: 15 }, (_, i) =>
          colors.slice(i * 3, i * 3 + 3).join(","),
        ),
      ).size,
    ).toBe(15);
  }
});
