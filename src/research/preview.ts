import type { PreviewFrame } from "./types";
export function decodePreview(frame: PreviewFrame) {
  if (
    frame.layerTimes.length !== frame.simulation.layers.length ||
    frame.layerTimes.some(
      (time, index) =>
        !Number.isInteger(time) ||
        time < 0 ||
        time >= frame.totalSteps ||
        (index > 0 && time <= frame.layerTimes[index - 1]),
    )
  )
    throw new Error("Invalid preview time mapping.");
  return {
    size: frame.simulation.size,
    layerTimes: frame.layerTimes,
    layers: frame.simulation.layers.map((encoded) => {
      const raw = atob(encoded);
      if (raw.length !== frame.simulation.size ** 2)
        throw new Error("Invalid preview layer size.");
      const layer = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) layer[i] = raw.charCodeAt(i);
      return layer;
    }),
  };
}
