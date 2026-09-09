import { compileExpression, type Measurements } from "./expressions";
import type { RunConfig } from "./types";

export interface Incentive {
  name: string;
  expression: string;
  weight: number;
}
export const INCENTIVE_PRESETS = [
  {
    id: "avoidReuse",
    name: "Avoid reused positions after death",
    expression: "1 - reusedCells / max(1, exposedCells)",
    description:
      "Reward keeping visited positions free of reuse after death. Each position is penalized once; empty trajectories also score 1, so combine with light exposure or growth.",
  },
  {
    id: "avoidRepeatedReuse",
    name: "Avoid reuse after death",
    expression: "1 / (1 + reuseEvents)",
    description:
      "Count every return to a previously occupied location after an empty timestep, regardless of cell type. Continuous survival and changes between live types do not count. 0 events scores 1, 1 scores 0.5, and 2 scores 0.333.",
  },
  {
    id: "avoidReuseAlive",
    name: "Avoid any cell reuse",
    expression: "1 / (1 + reuseAlive)",
    description:
      "Count every occupied timestep after a location's first occupation, regardless of cell type or death. Continuous survival, changes between live types and returns after death all count. 0 events scores 1, 1 scores 0.5, and 2 scores 0.333.",
  },
  {
    id: "avoidDeaths",
    name: "Avoid cell deaths",
    expression: "1 / (1 + cellDeaths)",
    description:
      "Reward fewer live-to-empty transitions. Every observed death counts; changes between live states do not.",
  },
  {
    id: "lightExposure",
    name: "Light exposure",
    expression: "exposedCells / area",
    description:
      "Reward the footprint exposed from above in time: each X/Z position ever occupied counts once, even if it later becomes empty.",
  },
  {
    id: "longevity",
    name: "Finite longevity",
    expression: "extinct * lifetime / max(1, steps - 1)",
    description:
      "Reward lifetime ending before the cutoff. Still alive scores zero for this incentive.",
  },
  {
    id: "finiteSparse",
    name: "Finite · fewer cells",
    expression: "extinct * (initialPopulation > 0) * (1 - occupancy)",
    description:
      "Reward a small total cell count, provided the fixture starts nonempty and becomes extinct. Immediate extinction is favored.",
  },
  {
    id: "finiteDense",
    name: "Finite · more cells",
    expression: "extinct * (initialPopulation > 0) * occupancy",
    description:
      "Reward a large total cell count, provided the fixture starts nonempty and becomes extinct.",
  },
  {
    id: "complexity",
    name: "Complexity heuristic",
    expression:
      "persistence * (0.34 * diversity + 0.30 * activity + 0.24 * density + 0.12 * variation)",
    description:
      "Balance state entropy, motion, intermediate density, and population variation; scale by persistence.",
  },
  {
    id: "growth",
    name: "Growth",
    expression:
      "0.65 * clamp((finalPopulation - initialPopulation) / max(1, area - initialPopulation)) + 0.25 * occupancy + 0.1 * persistence",
    description: "Reward population gain, occupied volume, and persistence.",
  },
  {
    id: "diversity",
    name: "State entropy",
    expression: "diversity",
    description:
      "Reward diverse occupied states. Always zero for binary rules.",
  },
  {
    id: "activity",
    name: "Motion",
    expression: "activity",
    description: "Reward cells changing state relative to occupancy.",
  },
  {
    id: "density",
    name: "Balanced density",
    expression: "density",
    description:
      "Reward intermediate occupancy, penalizing very sparse or crowded trajectories.",
  },
  {
    id: "variation",
    name: "Population variation",
    expression: "variation",
    description: "Reward fluctuations in the occupied population.",
  },
  {
    id: "persistence",
    name: "Persistence",
    expression: "persistence",
    description:
      "Reward more nonempty timesteps, including survivors at the cutoff.",
  },
  {
    id: "extinction",
    name: "Extinction rate",
    expression: "extinct",
    description:
      "Reward the fraction of fixtures that are empty at the cutoff when using mean aggregation.",
  },
  {
    id: "contained",
    name: "Spatial containment",
    expression: "1 - spatialContact",
    description:
      "Reward avoiding X/Z edges. Disable spatial disqualification to use this as a soft incentive.",
  },
] as const;

export function presetIncentive(id: string): Incentive {
  const preset = INCENTIVE_PRESETS.find((value) => value.id === id);
  if (!preset) throw new RangeError("Unknown incentive preset.");
  return { name: preset.name, expression: preset.expression, weight: 1 };
}

/** Only new drafts are upgraded. Stored legacy configurations remain unchanged. */
export function incentivesForConfig(config: RunConfig): Incentive[] {
  if (config.incentives)
    return config.incentives.map((value) => ({ ...value }));
  if (config.objective === "complexity")
    return Object.entries(config.weights).map(([key, weight]) => ({
      ...presetIncentive(key),
      expression: `persistence * ${key}`,
      weight,
    }));
  return [presetIncentive(config.objective)];
}

export function validateIncentives(value: unknown): Incentive[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16)
    throw new RangeError("Add 1–16 incentives.");
  const result = Array.from(value, (item) => {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(item)) ||
      Object.keys(item).length !== 3 ||
      !["name", "expression", "weight"].every((key) => Object.hasOwn(item, key))
    )
      throw new RangeError(
        "Each incentive must contain exactly name, expression, and weight.",
      );
    if (
      typeof item.name !== "string" ||
      !item.name.trim() ||
      item.name.length > 80
    )
      throw new RangeError("Incentive name must contain 1–80 characters.");
    if (
      typeof item.weight !== "number" ||
      !Number.isFinite(item.weight) ||
      item.weight < 0 ||
      item.weight > 10000
    )
      throw new RangeError(
        "Incentive weight must be finite and between 0 and 10000.",
      );
    compileExpression(item.expression);
    return {
      name: item.name,
      expression: item.expression as string,
      weight: item.weight as number,
    };
  });
  if (!result.some((item) => item.weight > 0))
    throw new RangeError("At least one incentive needs a positive weight.");
  return result;
}

/** Per-fixture weighted average; a numerical error zeros only that incentive. */
export function scoreIncentives(
  incentives: Incentive[],
  values: Measurements,
): number {
  const total = incentives.reduce((sum, item) => sum + item.weight, 0);
  let score = 0;
  for (const item of incentives) {
    if (item.weight === 0) continue;
    let value = 0;
    try {
      value = Math.max(
        0,
        Math.min(1, compileExpression(item.expression)(values)),
      );
    } catch {
      /* Invalid arithmetic for this fixture contributes zero. */
    }
    score += (item.weight / total) * value;
  }
  return Math.max(0, Math.min(1, score));
}
