export interface ViewRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** DOM coordinates are absolute; WebGL coordinates are local and bottom-up. */
export function galleryViewport(canvas: ViewRect, item: ViewRect) {
  const left = item.left - canvas.left;
  const bottom = canvas.height - (item.top - canvas.top) - item.height;
  return {
    left,
    bottom,
    width: item.width,
    height: item.height,
    visible:
      left < canvas.width &&
      left + item.width > 0 &&
      bottom < canvas.height &&
      bottom + item.height > 0,
  };
}

/** Expand the foreground frustum to the full canvas without moving the model when zoom changes. */
export function foregroundFrustum(
  canvas: ViewRect,
  item: ReturnType<typeof galleryViewport>,
  zoom: number,
) {
  const x = (item.left + item.width / 2 - canvas.width / 2) / zoom;
  const y = (item.bottom + item.height / 2 - canvas.height / 2) / zoom;
  return {
    left: -canvas.width / 2 - x,
    right: canvas.width / 2 - x,
    top: canvas.height / 2 - y,
    bottom: -canvas.height / 2 - y,
  };
}
