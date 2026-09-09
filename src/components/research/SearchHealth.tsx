import type { HistoryPoint } from "../../research/types";
import {
  formatCount,
  formatPercent,
  repeatShare,
  type HistoryScale,
} from "./visualizerData";
import "./visualizers.css";

export interface SearchHealthProps extends HistoryScale {
  /** Latest recorded history point; null renders placeholders without NaN. */
  latest: HistoryPoint | null | undefined;
}
interface HealthItem {
  key: string;
  label: string;
  value: string;
  title: string;
  recorded: boolean;
}
const known = (value: number | undefined): value is number =>
  value !== undefined && Number.isFinite(value) && value > 0;
const ratio = (count: number | undefined, denominator: number | undefined) =>
  known(denominator) && count !== undefined && Number.isFinite(count)
    ? `${count} / ${denominator}`
    : formatCount(count);

/** Compact strip of breeding-diversity and redundancy signals for the latest generation. */
export default function SearchHealth({
  latest,
  eliteCount,
  populationSize,
}: SearchHealthProps) {
  const counted =
    latest !== null &&
    latest !== undefined &&
    latest.generationEvaluations !== undefined &&
    latest.generationRepeats !== undefined;
  const share = latest ? repeatShare(latest) : null;
  const stalled = latest?.generationsSinceImprovement;
  const items: HealthItem[] = [
    {
      key: "improvement",
      label: "Since improvement",
      value:
        stalled === undefined || !Number.isFinite(stalled)
          ? "—"
          : `${stalled} gen`,
      title:
        "GA generations since the all-time champion was born, i.e. since the training best last strictly improved.",
      recorded: true,
    },
    {
      key: "elites",
      label: known(eliteCount)
        ? `Distinct among top ${eliteCount}`
        : "Distinct among top ranks",
      value: ratio(latest?.distinctElites, eliteCount),
      title: `Head convergence: distinct genomes among the ${known(eliteCount) ? `${eliteCount} fittest individuals` : "top-ranked individuals (one per elite slot)"} by fitness rank. Under distinct elitism the retained elites are distinct by construction, so this counts how many copies of the leader crowd the top ranks: fewer distinct means more copies, even when the whole population looks diverse.`,
      recorded: true,
    },
    {
      key: "copies",
      label: "Best copies",
      value: ratio(latest?.bestCopies, populationSize),
      title: `Individuals carrying the genome of the current fittest member${known(populationSize) ? ", over the population size" : ""}. Many copies mean one genome dominates breeding.`,
      recorded: true,
    },
    {
      key: "unique",
      label: "Unique evaluations",
      value:
        latest && latest.generationEvaluations === undefined
          ? "not recorded"
          : formatCount(latest?.generationEvaluations),
      title:
        "Genomes actually evaluated in the latest generation (cache misses). Repeats of already-scored genomes cost nothing but add no information.",
      recorded: !latest || latest.generationEvaluations !== undefined,
    },
    {
      key: "repeats",
      label: "Repeat share",
      value:
        latest && !counted
          ? "not recorded"
          : share === null
            ? "—"
            : formatPercent(share),
      title:
        "Candidates that repeated an already-evaluated genome over all candidates of the latest generation: repeats / (repeats + unique evaluations). A high share means the search keeps re-proposing known genomes.",
      recorded: !latest || counted,
    },
  ];
  return (
    <section className="rv-search-health" aria-label="Search health">
      {items.map((item) => (
        <span
          key={item.key}
          className={`rv-health-item${item.recorded ? "" : " rv-health-unrecorded"}`}
          title={item.title}
        >
          {item.label} <b>{item.value}</b>
        </span>
      ))}
    </section>
  );
}
