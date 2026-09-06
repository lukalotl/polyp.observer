export const WINDOW_IDS = [
  "registry",
  "clock",
  "metrics",
  "inspector",
  "analysis",
  "ascii",
] as const;
export type WindowId = (typeof WINDOW_IDS)[number];
export interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface DesktopSize {
  width: number;
  height: number;
}
export type Frames = Record<WindowId, Frame>;
export const LAYOUT_KEY = "polyp.desktop.layout.v1";

export function constrainFrame(frame: Frame, size: DesktopSize): Frame {
  const width = Math.min(size.width - 12, Math.max(240, frame.width));
  const height = Math.min(size.height - 12, Math.max(110, frame.height));
  return {
    width,
    height,
    x: Math.max(6, Math.min(size.width - width - 6, frame.x)),
    y: Math.max(6, Math.min(size.height - height - 6, frame.y)),
  };
}

export function desktopSize(width: number, height: number): DesktopSize {
  return {
    width: Math.max(280, width),
    height: width < 760 ? 2130 : Math.max(540, height - 76),
  };
}

export function defaultFrames(size: DesktopSize): Frames {
  const w = size.width,
    h = size.height;
  const values: Record<WindowId, number[]> =
    w < 760
      ? {
          registry: [8, 12, w - 16, 430],
          clock: [8, 456, w - 16, 146],
          metrics: [8, 616, w - 16, 178],
          inspector: [8, 808, w - 16, 460],
          analysis: [8, 1282, w - 16, 430],
          ascii: [8, 1726, w - 16, 370],
        }
      : {
          registry: [w * 0.028, h * 0.045, w * 0.31, h * 0.55],
          clock: [w * 0.66, h * 0.085, w * 0.295, h * 0.18],
          metrics: [w * 0.278, h * 0.33, w * 0.465, h * 0.185],
          inspector: [w * 0.278, h * 0.528, w * 0.465, h * 0.435],
          analysis: [w * 0.028, h * 0.615, w * 0.265, h * 0.348],
          ascii: [w * 0.688, h * 0.585, w * 0.29, h * 0.39],
        };
  return Object.fromEntries(
    WINDOW_IDS.map((id) => {
      const [x, y, width, height] = values[id];
      return [id, constrainFrame({ x, y, width, height }, size)];
    }),
  ) as Frames;
}

export function restoreFrames(raw: string | null, size: DesktopSize): Frames {
  const defaults = defaultFrames(size);
  if (!raw) return defaults;
  try {
    const saved = JSON.parse(raw);
    if (
      saved.version !== 1 ||
      !Number.isFinite(saved.size?.width) ||
      !Number.isFinite(saved.size?.height) ||
      saved.size.width <= 0 ||
      saved.size.height <= 0
    )
      return defaults;
    // A phone layout and a desktop layout have different spatial hierarchies.
    if (saved.size.width < 760 !== size.width < 760) return defaults;
    for (const id of WINDOW_IDS) {
      const frame = saved.frames?.[id];
      if (
        !frame ||
        ![frame.x, frame.y, frame.width, frame.height].every(Number.isFinite)
      )
        continue;
      defaults[id] = constrainFrame(
        {
          x: (frame.x * size.width) / saved.size.width,
          y: (frame.y * size.height) / saved.size.height,
          width: (frame.width * size.width) / saved.size.width,
          height: (frame.height * size.height) / saved.size.height,
        },
        size,
      );
    }
  } catch {
    /* Invalid or unavailable preferences never prevent opening research. */
  }
  return defaults;
}
