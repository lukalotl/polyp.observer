import { describe, expect, it } from "vitest";
import { decodePreview } from "./preview";
import { expandPreviewLayer } from "./previewLayers";
import { DEFAULT_RUN_CONFIG } from "./config";
import type { PreviewFrame } from "./types";

function frame(entries = [(40 << 4) | 1]): PreviewFrame {
  const bytes = Buffer.alloc(entries.length * 4);
  entries.forEach((entry, i) => bytes.writeUInt32LE(entry, i * 4));
  return {
    genome: DEFAULT_RUN_CONFIG.seedGenome,
    seed: 1729,
    encoding: "sparse-u32le",
    totalSteps: 2048,
    stride: 1,
    layerTimes: [1023, 1024],
    simulation: {
      size: 9,
      layers: [bytes.toString("base64"), ""],
      population: [],
      lifetime: 1,
      extinct: true,
      activity: 0,
      diversity: 0,
      occupancy: 0,
    },
  };
}
describe("complete sparse preview transport", () => {
  it("decodes every occupied cell and retains an empty consecutive plane", () => {
    const decoded = decodePreview(frame());
    expect(decoded.layerTimes).toEqual([1023, 1024]);
    expect(decoded.layers).toHaveLength(2);
    expect(expandPreviewLayer(decoded.layers[0], 9)[40]).toBe(1);
    expect(
      expandPreviewLayer(decoded.layers[1], 9).every((value) => value === 0),
    ).toBe(true);
  });
  it.each(
    [[16], [1, 1], [33, 17], [(81 << 4) | 1], [(40 << 4) | 5]].map(
      (entries) => ({ entries }),
    ),
  )("rejects malformed sparse cells $entries", ({ entries }) => {
    expect(() => decodePreview(frame(entries))).toThrow(
      /Invalid sparse preview cell/,
    );
  });
  it("rejects skipped times instead of treating them as complete data", () => {
    expect(() =>
      decodePreview({ ...frame(), layerTimes: [1023, 1025] }),
    ).toThrow(/consecutive timestep/);
    expect(() => decodePreview({ ...frame(), stride: 2 })).toThrow(
      /consecutive timestep/,
    );
    const invalid = frame();
    invalid.simulation.layers[0] = "AQ==";
    expect(() => decodePreview(invalid)).toThrow(/layer size/);
  });
});
