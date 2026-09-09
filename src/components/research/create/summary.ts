import { mutationChangeDistribution } from "../../../research/mutation";
import type { RunConfig } from "../../../research/types";
import { distinctWorlds } from "./seeds";

export type SectionId = "goal" | "worlds" | "search" | "budget";
export const SECTIONS: {
  id: SectionId;
  label: string;
  hint: string;
  description: string;
}[] = [
  {
    id: "goal",
    label: "Goal",
    hint: "What earns fitness",
    description:
      "Weighted incentives define what each world's trajectory earns. Hard constraints override them.",
  },
  {
    id: "worlds",
    label: "Starting worlds",
    hint: "Grid, horizon, patterns",
    description:
      "Every candidate rule is simulated on the same starting worlds. CA timesteps are not GA generations.",
  },
  {
    id: "search",
    label: "Search",
    hint: "Population and variation",
    description:
      "How the genetic search proposes, keeps and recombines rules between generations.",
  },
  {
    id: "budget",
    label: "Budget",
    hint: "Workers, limits, repeats",
    description:
      "How long the search runs, how much CPU it takes and what is retained.",
  },
];

export interface SummaryItem {
  key: string;
  section: SectionId;
  label: string;
  text: string;
}
/** Order of the one-sentence description; other items appear only in the detail list. */
const SENTENCE: string[] = [
  "rules",
  "worlds",
  "aggregation",
  "mutation",
  "elites",
  "selection",
  "immigrants",
  "stall",
  "generations",
  "repeats",
];

const plural = (count: number, noun: string, plural = `${noun}s`) =>
  `${count.toLocaleString("en-US")} ${count === 1 ? noun : plural}`;
export const roughly = (value: number) =>
  Number.isFinite(value) ? value.toFixed(value >= 10 ? 0 : 1) : "—";
const percent = (value: number) =>
  Number.isFinite(value) ? `${Math.round(100 * value)}%` : "—";

export interface WorldSummary {
  deterministic: boolean;
  training: number;
  validation: number;
  text: string;
}
/** Cross and point ignore fixture seeds, so they evaluate one world however many seeds are listed. */
export function effectiveWorlds(
  seed: RunConfig["seed"],
  training: number[],
  validation: number[],
): WorldSummary {
  if (seed === "point" || seed === "cross")
    return {
      deterministic: true,
      training: 1,
      validation: 0,
      text: "1 deterministic world, seeds ignored",
    };
  const trainingCount = distinctWorlds(training);
  const validationCount = distinctWorlds(validation);
  return {
    deterministic: false,
    training: trainingCount,
    validation: validationCount,
    text:
      plural(trainingCount, "training world") +
      (validationCount
        ? `, ${plural(validationCount, "held-out world")}`
        : ""),
  };
}

export function mutationSummary(draft: RunConfig): string {
  const distribution = mutationChangeDistribution(draft);
  const mean = roughly(distribution.mean);
  return (draft.mutationPolicy ?? "independent") === "heavyTailed"
    ? `heavy-tailed mutation, about ${mean} changes per child (${percent(distribution.probabilities[1] ?? 0)} single)`
    : `independent mutation, about ${mean} changes per child (${percent(distribution.probabilities[0] ?? 0)} unchanged clones)`;
}

export function elitesSummary(draft: RunConfig): string {
  if (!draft.eliteCount) return "no elites";
  return (draft.elitism ?? "slots") === "distinct"
    ? plural(draft.eliteCount, "distinct elite")
    : plural(draft.eliteCount, "elite slot");
}

export function selectionSummary(
  draft: RunConfig,
  trainingSeeds: number,
): string {
  return draft.selection === "tournament"
    ? `tournament of ${draft.tournamentSize}`
    : draft.selection === "rank"
      ? "rank weighted"
      : `lexicase over ${plural(trainingSeeds, "world")}`;
}

export function immigrantsPerGeneration(draft: RunConfig): number {
  const count = Math.floor(draft.populationSize * draft.immigrantRate);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

export function experimentSummary(
  draft: RunConfig,
  training: number[],
  validation: number[],
  repeats: number,
  maxWorkers: number,
): SummaryItem[] {
  const incentives = draft.incentives ?? [];
  const totalWeight = incentives.reduce(
    (sum, item) => sum + (item.weight > 0 ? item.weight : 0),
    0,
  );
  const worlds = effectiveWorlds(draft.seed, training, validation);
  const immigrants = immigrantsPerGeneration(draft);
  const stall = draft.stallGenerations ?? 0;
  const constraints = [
    draft.boundaryPolicy?.spatial && "edge contact",
    draft.boundaryPolicy?.horizon && "cutoff contact",
  ].filter(Boolean) as string[];
  const items: SummaryItem[] = [
    {
      key: "incentives",
      section: "goal",
      label: "Incentives",
      text: incentives.length
        ? incentives
            .map(
              (item) =>
                `${item.name}${
                  totalWeight > 0 && incentives.length > 1
                    ? ` ${percent(Math.max(0, item.weight) / totalWeight)}`
                    : ""
                }`,
            )
            .join(", ")
        : "none yet",
    },
    {
      key: "constraints",
      section: "goal",
      label: "Hard constraints",
      text: constraints.length
        ? `${constraints.join(" and ")} ${constraints.length === 1 ? "disqualifies" : "disqualify"} a world`
        : "none",
    },
    {
      key: "aggregation",
      section: "goal",
      label: "Aggregation",
      text: draft.aggregation === "minimum" ? "worst-world score" : "mean score",
    },
    {
      key: "grid",
      section: "worlds",
      label: "Grid and horizon",
      text: `${draft.size} × ${draft.size} cells, ${plural(draft.steps, "CA timestep")} per world, ${plural(draft.stateCount, "state")}`,
    },
    {
      key: "worlds",
      section: "worlds",
      label: "Effective worlds",
      text: `${
        draft.seed === "soup"
          ? `${draft.soupSize ?? "?"} × ${draft.soupSize ?? "?"} soup: `
          : worlds.deterministic
            ? ""
            : `${draft.seed}: `
      }${worlds.text}`,
    },
    {
      key: "rules",
      section: "search",
      label: "Population",
      text: `${plural(draft.populationSize, "rule")}${
        draft.initialization === "mutants"
          ? ", founder plus mutants"
          : ", independent random rules"
      }`,
    },
    {
      key: "mutation",
      section: "search",
      label: "Mutation",
      text: mutationSummary(draft),
    },
    {
      key: "elites",
      section: "search",
      label: "Elites",
      text: elitesSummary(draft),
    },
    {
      key: "selection",
      section: "search",
      label: "Selection",
      text: selectionSummary(draft, training.length),
    },
    {
      key: "crossover",
      section: "search",
      label: "Crossover",
      text:
        draft.crossover === "none" || !draft.crossoverRate
          ? "no crossover"
          : `${draft.crossover === "onePoint" ? "one-point" : "uniform"} crossover for ${percent(draft.crossoverRate)} of children`,
    },
    {
      key: "immigrants",
      section: "search",
      label: "Immigrants",
      text: immigrants
        ? `${plural(immigrants, "immigrant")} per generation`
        : "no immigrants",
    },
    {
      key: "seed",
      section: "search",
      label: "Search seed",
      text:
        repeats > 1
          ? `seed ${draft.randomSeed} for repeat 1, fresh seeds for the rest`
          : `search seed ${draft.randomSeed}`,
    },
    {
      key: "workers",
      section: "budget",
      label: "Workers",
      text: `${draft.evaluationWorkers} of ${maxWorkers || "?"} CPU workers`,
    },
    {
      key: "stall",
      section: "budget",
      label: "Stall pause",
      text: stall
        ? `pause after ${plural(stall, "stalled generation")}`
        : "no stall pause",
    },
    {
      key: "generations",
      section: "budget",
      label: "Generation limit",
      text: draft.maxGenerations
        ? plural(draft.maxGenerations, "GA generation")
        : "unlimited GA generations",
    },
  ];
  if (repeats > 1)
    items.push({
      key: "repeats",
      section: "budget",
      label: "Repeats",
      text: `${plural(repeats, "independent repeat")} with distinct seeds`,
    });
  return items;
}

export function summarySentence(items: SummaryItem[]): string {
  const byKey = new Map(items.map((item) => [item.key, item]));
  return SENTENCE.map((key) => byKey.get(key))
    .filter((item): item is SummaryItem => Boolean(item))
    .map((item) =>
      item.key === "rules" ? item.text.split(",")[0] : item.text,
    )
    .join(" · ");
}
