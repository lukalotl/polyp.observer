import { describe, expect, it } from "vitest";
import { galleryViewport } from "./galleryViewport";

describe("scissored carousel coordinates", () => {
  const canvas = { left: 600, top: 250, width: 600, height: 180 };
  it("centers views relative to a resized, offset canvas instead of the page origin", () => {
    expect(
      galleryViewport(canvas, {
        left: 1000,
        top: 250,
        width: 200,
        height: 138,
      }),
    ).toEqual({
      left: 400,
      bottom: 42,
      width: 200,
      height: 138,
      visible: true,
    });
  });
  it("keeps partially visible models during panning and culls only fully offscreen models", () => {
    expect(
      galleryViewport(canvas, { left: 550, top: 250, width: 200, height: 138 })
        .visible,
    ).toBe(true);
    expect(
      galleryViewport(canvas, { left: 400, top: 250, width: 200, height: 138 })
        .visible,
    ).toBe(false);
    expect(
      galleryViewport(canvas, { left: 1200, top: 250, width: 200, height: 138 })
        .visible,
    ).toBe(false);
  });
});
