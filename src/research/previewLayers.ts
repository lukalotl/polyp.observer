/** Sparse entries pack a spatial cell index and a nonzero four-bit state.
 * Every time plane is retained; only empty spatial cells are implicit.
 */
export type PreviewLayer = Uint8Array | Uint32Array;

export function forEachOccupied(
  layer: PreviewLayer,
  area: number,
  visit: (cell: number, state: number) => void,
): void {
  if (layer instanceof Uint32Array) {
    for (const entry of layer) visit(entry >>> 4, entry & 15);
  } else {
    for (let cell = 0; cell < Math.min(area, layer.length); cell++)
      if (layer[cell] > 0 && layer[cell] < 16) visit(cell, layer[cell]);
  }
}

/** Expand one slice for an independent full-plane oracle comparison. */
export function expandPreviewLayer(
  layer: PreviewLayer,
  size: number,
): Uint8Array {
  if (layer instanceof Uint8Array) return layer;
  const plane = new Uint8Array(size * size);
  forEachOccupied(layer, plane.length, (cell, state) => {
    plane[cell] = state;
  });
  return plane;
}
