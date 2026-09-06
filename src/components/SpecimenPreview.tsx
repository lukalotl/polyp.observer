import { useMemo } from "react";
import { simulate, type Preset } from "../simulation";

export function SpecimenPreview({ preset }: { preset: Preset }) {
  const cells = useMemo(() => {
    const sim = simulate(preset.genome, {
      size: 25,
      steps: 24,
      seed: preset.seed,
      randomSeed: 1729,
    });
    const output: { x: number; y: number; state: number }[] = [];
    sim.layers.forEach((layer, t) => {
      if (t % 2) return;
      layer.forEach((state, index) => {
        if (!state || index % 2) return;
        const x = (index % 25) - 12,
          z = Math.floor(index / 25) - 12;
        output.push({
          x: 60 + (x - z) * 1.6,
          y: 55 + (x + z) * 0.55 - t * 1.4,
          state,
        });
      });
    });
    return output;
  }, [preset]);
  const colors = ["transparent", "#6a8365", "#8b9d70", "#b6c591", "#d7dcc0"];
  return (
    <svg viewBox="0 0 120 78" aria-hidden="true" className="specimen-preview">
      <path
        d="M12 54 60 72 108 54 60 36Z"
        fill="none"
        stroke="currentColor"
        opacity=".15"
      />
      {cells.map((cell, i) => (
        <rect
          key={i}
          x={cell.x}
          y={cell.y}
          width="2"
          height="2"
          fill={colors[cell.state]}
        />
      ))}
    </svg>
  );
}
