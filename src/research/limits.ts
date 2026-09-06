/** Work is bounded separately from the two-buffer simulation's memory use. */
export const MAX_GRID_SIZE = 1025;
export const MAX_CA_STEPS = 65_536;
export const MAX_FIXTURE_SITES = 1_073_741_824;

export function maxHorizon(size: number): number {
  return Number.isFinite(size) && size > 0
    ? Math.min(MAX_CA_STEPS, Math.floor(MAX_FIXTURE_SITES / size ** 2))
    : MAX_CA_STEPS;
}

export const SIMULATION_SCALES = [
  { id: "quick", label: "Quick · 49 × 49 × 96", size: 49, steps: 96 },
  { id: "deep", label: "Deep · 129 × 129 × 2,048", size: 129, steps: 2048 },
  { id: "wide", label: "Wide · 257 × 257 × 4,096", size: 257, steps: 4096 },
  { id: "long", label: "Long · 127 × 127 × 65,536", size: 127, steps: 65_536 },
] as const;
