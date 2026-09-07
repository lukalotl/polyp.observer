import type { Genome, Simulation } from "../simulation";
import type { RunConfig, BoundaryContacts } from "./types";

export type Trajectory = Omit<Simulation, "layers" | "population"> & {
  population: Float64Array;
  boundaryContacts: BoundaryContacts;
  /** One exposed cell per X/Z column ever occupied, even after extinction. */
  exposedCells: number;
  /** Distinct positions repopulated after at least one live-to-empty transition. */
  reusedCells: number;
  /** All returns to a previously occupied position after an empty timestep. */
  reuseEvents: number;
  /** All observed live-to-empty transitions; no inferred death after the cutoff. */
  cellDeaths: number;
};

/** Mulberry32, identical to the frozen simulation's island-fixture RNG. */
function fixtureRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** Validated inputs only. The layer callback borrows the reused halo buffer. */
export function streamTrajectory(
  genome: Genome,
  config: Pick<
    RunConfig,
    "size" | "steps" | "seed" | "stateCount" | "soupSize"
  >,
  seed: number,
  onLayer?: (
    time: number,
    halo: Uint8Array,
    occupied: number,
    bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
  ) => void,
): Trajectory {
  const { size, steps, stateCount } = config;
  const area = size * size,
    stride = size + 2;
  // The topmost live cell in each time-column owns its exposure. Counting the
  // union gives the same total without retaining history or performing raycasts.
  const exposed = new Uint32Array(Math.ceil(area / 32));
  const reused = new Uint32Array(exposed.length);
  let exposedCells = 0,
    reusedCells = 0,
    reuseEvents = 0,
    cellDeaths = 0;
  const claimExposure = (cell: number, birth = false) => {
    const word = cell >>> 5,
      bit = 1 << (cell & 31);
    if (!(exposed[word] & bit)) {
      exposed[word] |= bit;
      exposedCells++;
    } else if (birth) {
      reuseEvents++;
      if (!(reused[word] & bit)) {
        reused[word] |= bit;
        reusedCells++;
      }
    }
  };
  let current = new Uint8Array(stride * stride),
    next = new Uint8Array(stride * stride);
  let minX = size,
    minZ = size,
    maxX = -1,
    maxZ = -1;
  const place = (x: number, z: number, state = 1) => {
    if (x < 0 || z < 0 || x >= size || z >= size) return;
    current[(z + 1) * stride + x + 1] = state;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  };
  const center = Math.floor(size / 2);
  if (config.seed !== "soup") place(center, center);
  if (config.seed === "cross") {
    for (let d = 1; d <= 2; d++) {
      place(center + d, center);
      place(center - d, center);
      place(center, center + d);
      place(center, center - d);
    }
  } else if (config.seed === "soup") {
    const random = fixtureRandom(seed);
    const n = config.soupSize!;
    const start = Math.floor((size - n) / 2);
    for (let z = start; z < start + n; z++)
      for (let x = start; x < start + n; x++) {
        const state = Math.floor(random() * stateCount);
        if (state) place(x, z, state);
      }
  } else if (config.seed === "islands") {
    const random = fixtureRandom(seed),
      radius = Math.max(1, Math.floor(size * 0.16));
    for (let island = 0; island < 7; island++) {
      const x = center + Math.floor(random() * (2 * radius + 1)) - radius;
      const z = center + Math.floor(random() * (2 * radius + 1)) - radius;
      place(x, z, 1 + Math.floor(random() * (stateCount - 1)));
      if (random() < 0.65) place(x + 1, z, 1);
      if (random() < 0.65) place(x, z + 1, Math.min(2, stateCount - 1));
    }
  }
  const population = new Float64Array(steps),
    counts = Array<number>(stateCount).fill(0);
  const boundaryContacts: BoundaryContacts = {
    left: null,
    right: null,
    front: null,
    back: null,
    horizon: false,
  };
  let live = 0,
    occupied = 0,
    changed = 0,
    lifetime = 0;
  for (let z = minZ; z <= maxZ; z++)
    for (let x = minX; x <= maxX; x++) {
      const state = current[(z + 1) * stride + x + 1];
      if (state) {
        live++;
        counts[state]++;
        claimExposure(z * size + x);
      }
    }
  for (let t = 0; t < steps; t++) {
    population[t] = live;
    occupied += live;
    if (live > 0) lifetime++;
    if (live > 0) {
      if (minX === 0) boundaryContacts.left ??= t;
      if (maxX === size - 1) boundaryContacts.right ??= t;
      if (minZ === 0) boundaryContacts.front ??= t;
      if (maxZ === size - 1) boundaryContacts.back ??= t;
      if (t === steps - 1) boundaryContacts.horizon = true;
    }
    // Locked gene 0 makes all remaining layers identically zero. Their counts
    // already occupy the zero-filled array, preserving denominators and variance.
    onLayer?.(t, current, live, { minX, maxX, minZ, maxZ });
    if (t === steps - 1 || live === 0) {
      // A preview still includes each empty plane through the final time.
      if (live === 0 && onLayer)
        for (let rest = t + 1; rest < steps; rest++)
          onLayer(rest, current, 0, { minX, maxX, minZ, maxZ });
      break;
    }
    const fromX = Math.max(0, minX - 1),
      toX = Math.min(size - 1, maxX + 1);
    const fromZ = Math.max(0, minZ - 1),
      toZ = Math.min(size - 1, maxZ + 1);
    minX = size;
    minZ = size;
    maxX = -1;
    maxZ = -1;
    // Reused output can contain cells from two steps ago outside today's box.
    // Clear them: otherwise contraction followed by expansion resurrects ghosts.
    next.fill(0);
    live = 0;
    for (let z = fromZ; z <= toZ; z++) {
      let index = (z + 1) * stride + fromX + 1;
      for (let x = fromX; x <= toX; x++, index++) {
        const neighbors =
          (current[index - stride - 1] !== 0 ? 1 : 0) +
          (current[index - stride] !== 0 ? 1 : 0) +
          (current[index - stride + 1] !== 0 ? 1 : 0) +
          (current[index - 1] !== 0 ? 1 : 0) +
          (current[index + 1] !== 0 ? 1 : 0) +
          (current[index + stride - 1] !== 0 ? 1 : 0) +
          (current[index + stride] !== 0 ? 1 : 0) +
          (current[index + stride + 1] !== 0 ? 1 : 0);
        const state = genome[current[index] * 9 + neighbors];
        next[index] = state;
        if (state !== current[index]) changed++;
        if (current[index] && !state) cellDeaths++;
        if (state) {
          live++;
          counts[state]++;
          if (!current[index]) claimExposure(z * size + x, true);
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minZ = Math.min(minZ, z);
          maxZ = Math.max(maxZ, z);
        }
      }
    }
    [current, next] = [next, current];
  }
  let diversity = 0;
  if (occupied > 0 && stateCount > 2)
    for (let state = 1; state < stateCount; state++) {
      const proportion = counts[state] / occupied;
      if (proportion > 0)
        diversity -=
          (proportion * Math.log(proportion)) / Math.log(stateCount - 1);
    }
  return {
    size,
    population,
    activity: changed / (area * (steps - 1)),
    diversity: Math.max(0, Math.min(1, diversity)),
    occupancy: occupied / (area * steps),
    lifetime,
    extinct: population[steps - 1] === 0,
    boundaryContacts,
    exposedCells,
    reusedCells,
    reuseEvents,
    cellDeaths,
  };
}
