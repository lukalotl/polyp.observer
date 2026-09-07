import { describe, expect, it } from "vitest";
import { cutoffHeight, simulationBounds } from "./simulationBounds";

describe("scientific boundaries in the renderer", () => {
  it("keeps the real X/Z walls around a tiny specimen while fitting Y to its volume", () => {
    expect(
      simulationBounds(129, { min: [-1, -0.5, -2], max: [1, 3.5, 2] }),
    ).toEqual({
      min: [-64.5, -0.5, -64.5],
      max: [64.5, 3.5, 64.5],
    });
  });
  it("has a stable real spatial frame even when the fixture is empty", () => {
    expect(simulationBounds(9, null)).toEqual({
      min: [-4.5, -0.5, -4.5],
      max: [4.5, 0.5, 4.5],
    });
  });
  it("places the true cutoff in full, cropped and compressed time coordinates", () => {
    expect(cutoffHeight(511, 0, 1)).toBe(511);
    expect(cutoffHeight(511, 500, 1)).toBe(11);
    expect(cutoffHeight(511, 500, 0.72)).toBeCloseTo(7.92);
  });
});
