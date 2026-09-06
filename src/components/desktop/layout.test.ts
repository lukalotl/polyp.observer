import { describe, expect, it } from "vitest";
import {
  constrainFrame,
  defaultFrames,
  desktopSize,
  restoreFrames,
  WINDOW_IDS,
} from "./layout";

describe("persistent floating research windows", () => {
  const size = desktopSize(1440, 1000);
  it("keeps every initial title bar and resize corner inside the desktop", () => {
    const frames = defaultFrames(size);
    expect(Object.keys(frames)).toEqual([...WINDOW_IDS]);
    for (const frame of Object.values(frames)) {
      expect(frame.x).toBeGreaterThanOrEqual(6);
      expect(frame.y).toBeGreaterThanOrEqual(6);
      expect(frame.x + frame.width).toBeLessThanOrEqual(size.width - 6);
      expect(frame.y + frame.height).toBeLessThanOrEqual(size.height - 6);
    }
  });
  it("cannot lose a dragged window offscreen or resize it beyond the desktop", () => {
    expect(
      constrainFrame({ x: -5000, y: 9000, width: 300, height: 200 }, size),
    ).toEqual({ x: 6, y: size.height - 206, width: 300, height: 200 });
    expect(
      constrainFrame({ x: 90, y: 80, width: 5000, height: 9000 }, size),
    ).toEqual({ x: 6, y: 6, width: size.width - 12, height: size.height - 12 });
  });
  it("restores actual user positions and scales them when the viewport changes", () => {
    const frames = defaultFrames(size);
    frames.clock = { x: 200, y: 100, width: 360, height: 170 };
    const saved = JSON.stringify({ version: 1, size, frames });
    expect(restoreFrames(saved, size).clock).toEqual(frames.clock);
    const smaller = { width: 1080, height: 693 };
    expect(restoreFrames(saved, smaller).clock).toEqual({
      x: 150,
      y: 75,
      width: 270,
      height: 127.5,
    });
  });
  it("recovers corrupted preferences without discarding other valid windows", () => {
    const frames = defaultFrames(size);
    const saved = JSON.stringify({
      version: 1,
      size,
      frames: {
        ...frames,
        clock: { ...frames.clock, x: "broken" },
        registry: { ...frames.registry, x: 110 },
      },
    });
    expect(restoreFrames(saved, size).clock).toEqual(frames.clock);
    expect(restoreFrames(saved, size).registry.x).toBe(110);
    for (const value of [
      null,
      "{broken",
      "null",
      '{"version":1,"size":{"width":0,"height":300}}',
    ])
      expect(restoreFrames(value, size)).toEqual(frames);
  });
  it("starts with a usable stacked phone layout instead of shrinking desktop windows", () => {
    const phone = desktopSize(375, 812);
    const frames = restoreFrames(
      JSON.stringify({ version: 1, size, frames: defaultFrames(size) }),
      phone,
    );
    expect(phone.height).toBe(2130);
    let bottom = 0;
    for (const id of WINDOW_IDS) {
      const frame = frames[id];
      expect(frame.y).toBeGreaterThan(bottom);
      expect(frame.width).toBeLessThanOrEqual(363);
      bottom = frame.y + frame.height;
    }
  });
});
