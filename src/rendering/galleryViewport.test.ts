import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { foregroundFrustum, galleryViewport } from "./galleryViewport";

describe("shared carousel coordinates", () => {
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

it.each([0.5, 1, 8, 48])(
  "keeps the foreground centered in its slot at zoom %s without clipping it to that slot",
  (zoom) => {
    const canvas = { left: 200, top: 100, width: 1200, height: 500 };
    const item = galleryViewport(canvas, {
      left: 1000,
      top: 100,
      width: 240,
      height: 500,
    });
    const frustum = foregroundFrustum(canvas, item, zoom);
    const camera = new THREE.OrthographicCamera(
      frustum.left,
      frustum.right,
      frustum.top,
      frustum.bottom,
      0.1,
      100,
    );
    camera.position.z = 10;
    camera.zoom = zoom;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    const center = new THREE.Vector3().project(camera);
    expect(((center.x + 1) * canvas.width) / 2).toBeCloseTo(
      item.left + item.width / 2,
    );
    expect(((center.y + 1) * canvas.height) / 2).toBeCloseTo(
      item.bottom + item.height / 2,
    );
    expect(frustum.right - frustum.left).toBe(canvas.width);
  },
);
