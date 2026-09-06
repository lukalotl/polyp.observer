import type { PreviewFrame } from "./types";
import { MAX_PREVIEW_LAYER_BYTES } from "./sample";
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
  if (
    frame.encoding !== undefined &&
    frame.encoding !== "sparse-u32le" &&
    frame.encoding !== "adaptive-v1"
  )
    throw new Error("Unsupported preview encoding.");
  if (
    frame.encoding &&
    (frame.stride !== 1 ||
      frame.layerTimes.some(
        (time, index) => index > 0 && time !== frame.layerTimes[index - 1] + 1,
      ))
  )
    throw new Error("Preview must include every consecutive timestep.");
  let bytes = 0;
  return {
    size: frame.simulation.size,
    layerTimes: frame.layerTimes,
    layers: frame.simulation.layers.map((encoded) => {
      const adaptive = frame.encoding === "adaptive-v1";
      const codec = adaptive ? encoded[0] : frame.encoding ? "s" : "d";
      if (codec !== "s" && codec !== "d")
        throw new Error("Invalid preview plane encoding.");
      const raw = atob(adaptive ? encoded.slice(1) : encoded);
      bytes += raw.length;
      if (bytes > MAX_PREVIEW_LAYER_BYTES)
        throw new Error("Preview exceeds the render data limit.");
      if (codec === "s") {
        if (raw.length % 4)
          throw new Error("Invalid sparse preview layer size.");
        const layer = new Uint32Array(raw.length / 4);
        let previousCell = -1;
        for (let i = 0; i < layer.length; i++) {
          const offset = i * 4;
          const entry =
            (raw.charCodeAt(offset) |
              (raw.charCodeAt(offset + 1) << 8) |
              (raw.charCodeAt(offset + 2) << 16) |
              (raw.charCodeAt(offset + 3) << 24)) >>>
            0;
          const cell = entry >>> 4,
            state = entry & 15;
          if (
            !state ||
            state >= frame.genome.length / 9 ||
            cell <= previousCell ||
            cell >= frame.simulation.size ** 2
          )
            throw new Error("Invalid sparse preview cell.");
          layer[i] = entry;
          previousCell = cell;
        }
        return layer;
      }
      if (raw.length !== frame.simulation.size ** 2)
        throw new Error("Invalid preview layer size.");
      const layer = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) {
        layer[i] = raw.charCodeAt(i);
        if (layer[i] >= frame.genome.length / 9)
          throw new Error("Invalid preview cell state.");
      }
      return layer;
    }),
  };
}
