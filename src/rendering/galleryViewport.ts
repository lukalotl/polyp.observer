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
