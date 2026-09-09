import {
  compileExpression,
  type Measurements,
} from "../../../research/expressions";
import { scoreIncentives, type Incentive } from "../../../research/incentives";
import type { BoundaryPolicy, RunConfig } from "../../../research/types";

export interface ScoreExample {
  id: string;
  name: string;
  description: string;
  measurements: Measurements;
}
export interface ScoreExampleRow {
  example: ScoreExample;
  /** Clamped per-incentive values in incentive order; invalid arithmetic gives 0. */
  values: number[];
  /** Weighted score before hard constraints. */
  score: number;
  /** Which hard constraint (if any) would zero this world. */
  zeroedBy: "spatial" | "horizon" | null;
}

const clamp = (value: number) => Math.max(0, Math.min(1, value));

function seedPopulation(draft: Pick<RunConfig, "seed" | "soupSize">): number {
  switch (draft.seed) {
    case "point":
      return 1;
    case "cross":
      return 5;
    case "islands":
      return 16;
    default:
      return Math.max(1, Math.round(0.8 * (draft.soupSize ?? 9) ** 2));
  }
}

interface Shape {
  population: (t: number) => number;
  exposedFactor: number;
  reusedShare: number;
  eventsPerReused: number;
  diversity: number;
  activity: number;
  spatialContact: boolean;
}

/** Same derived quantities as the evaluator, applied to a synthetic trajectory. */
function measure(
  size: number,
  steps: number,
  stateCount: number,
  shape: Shape,
): Measurements {
  const area = size * size;
  const population = Array.from({ length: steps }, (_, t) =>
    Math.max(0, Math.round(shape.population(t))),
  );
  let lifetime = 0;
  while (lifetime < steps && population[lifetime] > 0) lifetime++;
  const total = population.reduce((sum, count) => sum + count, 0);
  const peak = population.reduce((max, count) => Math.max(max, count), 0);
  const final = population[steps - 1];
  const mean = total / steps;
  const variance =
    population.reduce((sum, count) => sum + (count - mean) ** 2, 0) / steps;
  const occupancy = total / (area * steps);
  const exposed = Math.max(
    peak,
    Math.min(area, total, Math.round(peak * shape.exposedFactor)),
  );
  const reused = Math.min(
    exposed,
    Math.max(0, Math.round(exposed * shape.reusedShare)),
  );
  const reuseEvents = Math.round(reused * shape.eventsPerReused);
  return {
    diversity: stateCount > 2 ? shape.diversity : 0,
    activity: shape.activity,
    density:
      clamp(occupancy / 0.1) * clamp(1 - Math.max(0, occupancy - 0.25) / 0.55),
    variation: clamp(Math.sqrt(variance) / Math.max(1, mean)),
    persistence: lifetime / steps,
    occupancy,
    exposedCells: exposed,
    reusedCells: reused,
    reuseEvents,
    reuseAlive: Math.max(0, total - exposed),
    cellDeaths: reuseEvents + Math.max(0, exposed - final),
    lifetime,
    extinct: final === 0 ? 1 : 0,
    initialPopulation: population[0],
    finalPopulation: final,
    peakPopulation: peak,
    totalCells: total,
    meanPopulation: mean,
    populationVariance: variance,
    spatialContact: shape.spatialContact ? 1 : 0,
    cutoffContact: final > 0 ? 1 : 0,
    size,
    area,
    steps,
    stateCount,
  };
}

/** Five plausible worlds built from the draft's size, horizon and state count. */
export function scoreExamples(
  draft: Pick<RunConfig, "size" | "steps" | "stateCount" | "seed" | "soupSize">,
): ScoreExample[] {
  const { size, steps, stateCount } = draft;
  if (
    !Number.isFinite(size) ||
    !Number.isFinite(steps) ||
    !Number.isFinite(stateCount) ||
    size < 1 ||
    steps < 2
  )
    return [];
  const area = size * size;
  const p0 = seedPopulation(draft);
  const hump = (length: number, peak: number) => (t: number) =>
    t >= length
      ? 0
      : t === 0
        ? p0
        : Math.max(1, peak * (1 - Math.abs((2 * t) / length - 1)));
  const containedLength = Math.max(2, Math.round(0.6 * steps));
  const contactLength = Math.max(3, Math.min(steps - 1, Math.round(0.8 * steps)));
  const sparseLength = Math.max(2, Math.min(steps - 1, Math.round(0.1 * steps)));
  const survivorCap = Math.max(p0 + 1, Math.round(0.02 * area));
  const rise = Math.max(1, Math.round(0.25 * steps));
  const build = (
    id: string,
    name: string,
    description: string,
    shape: Shape,
  ): ScoreExample => ({
    id,
    name,
    description,
    measurements: measure(size, steps, stateCount, shape),
  });
  return [
    build(
      "extinction",
      "Immediate extinction",
      "The seed dies at the first timestep; nothing is reused and nothing survives.",
      {
        population: (t) => (t === 0 ? p0 : 0),
        exposedFactor: 1,
        reusedShare: 0,
        eventsPerReused: 0,
        diversity: 0,
        activity: 0,
        spatialContact: false,
      },
    ),
    build(
      "survivor",
      "Cutoff survivor",
      `Grows to a stable blob of about ${survivorCap.toLocaleString("en-US")} cells and is still alive at the horizon.`,
      {
        population: (t) =>
          Math.min(survivorCap, p0 + ((survivorCap - p0) * Math.min(t, rise)) / rise),
        exposedFactor: 1.6,
        reusedShare: 0.1,
        eventsPerReused: 3,
        diversity: 0.55,
        activity: 0.25,
        spatialContact: false,
      },
    ),
    build(
      "contained",
      "Contained finite life",
      `Expands, retreats over some of its own trail and dies out at about 60% of the horizon (t≈${containedLength.toLocaleString("en-US")}).`,
      {
        population: hump(
          containedLength,
          Math.max(p0 + 1, Math.round(0.01 * area)),
        ),
        exposedFactor: 2.2,
        reusedShare: 0.15,
        eventsPerReused: 1.5,
        diversity: 0.6,
        activity: 0.4,
        spatialContact: false,
      },
    ),
    build(
      "contact",
      "Spatial edge contact",
      `A fast front reaches an X/Z edge, then collapses and dies at about 80% of the horizon (t≈${contactLength.toLocaleString("en-US")}).`,
      {
        population: hump(contactLength, Math.max(p0 + 1, Math.round(0.12 * area))),
        exposedFactor: 2.5,
        reusedShare: 0.2,
        eventsPerReused: 2,
        diversity: 0.5,
        activity: 0.6,
        spatialContact: true,
      },
    ),
    build(
      "sparse",
      "Sparse short life",
      `A few moving cells never revisit a position and die at about 10% of the horizon (t≈${sparseLength.toLocaleString("en-US")}).`,
      {
        population: (t) =>
          t >= sparseLength ? 0 : Math.max(1, p0 * (1 - t / sparseLength)),
        exposedFactor: Number.POSITIVE_INFINITY,
        reusedShare: 0,
        eventsPerReused: 0,
        diversity: 0.3,
        activity: 1,
        spatialContact: false,
      },
    ),
  ];
}

export function scoreExampleRows(
  examples: ScoreExample[],
  incentives: Incentive[],
  policy: BoundaryPolicy | undefined,
): ScoreExampleRow[] {
  const usable = incentives.filter(
    (item) => Number.isFinite(item.weight) && item.weight >= 0,
  );
  return examples.map((example) => {
    const values = incentives.map((item) => {
      try {
        return clamp(compileExpression(item.expression)(example.measurements));
      } catch {
        return 0;
      }
    });
    const total = usable.reduce((sum, item) => sum + item.weight, 0);
    return {
      example,
      values,
      score:
        total > 0 && usable.length === incentives.length
          ? scoreIncentives(incentives, example.measurements)
          : 0,
      zeroedBy:
        policy?.spatial && example.measurements.spatialContact
          ? "spatial"
          : policy?.horizon && example.measurements.cutoffContact
            ? "horizon"
            : null,
    };
  });
}
