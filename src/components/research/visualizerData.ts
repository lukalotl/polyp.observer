import type { Individual, HistoryPoint } from "../../research/types";

export const geneCase = (locus: number) => ({
  state: Math.floor(locus / 9),
  neighbors: locus % 9,
});
export function geneLabel(locus: number, output: number) {
  const { state, neighbors } = geneCase(locus);
  return `Current state ${state}; ${neighbors} active neighbors → output ${output}${locus === 0 ? " (quiescent, fixed)" : ""}`;
}
export function traceGene(individual: Individual, locus: number) {
  const source = individual.crossoverMask[locus];
  const parent = individual.parents[source];
  return {
    source: parent ? source : null,
    parent: parent ?? null,
    before: parent?.genome[locus] ?? null,
    after: individual.genome[locus],
    mutated: individual.mutatedLoci.includes(locus),
  };
}
/** Fractions, not color bins: each locus column sums to 1 for a nonempty population. */
export function alleleFrequencies(
  population: readonly Individual[],
  stateCount = population[0]?.genome.length
    ? population[0].genome.length / 9
    : 5,
): number[][] {
  const geneCount = 9 * stateCount;
  const counts = Array.from({ length: stateCount }, () =>
    Array<number>(geneCount).fill(0),
  );
  if (population.length === 0) return counts;
  for (const individual of population)
    individual.genome.forEach((value, locus) => {
      if (counts[value] && locus < geneCount) counts[value][locus]++;
    });
  return counts.map((row) => row.map((count) => count / population.length));
}
export function rankPopulation(population: readonly Individual[]) {
  return population
    .map((individual, index) => ({ individual, index }))
    .sort(
      (a, b) =>
        b.individual.fitness - a.individual.fitness || a.index - b.index,
    )
    .map(({ individual }) => individual);
}
/** Training-minus-held-out gaps above this are emphasized as a generalization warning. */
export const GAP_EMPHASIS = 0.1;
/** Signed training-minus-held-out fitness; null when held-out fixtures were not evaluated. */
export function fitnessGap(
  individual: Pick<Individual, "fitness" | "validationFitness">,
): number | null {
  const { fitness, validationFitness } = individual;
  if (
    validationFitness === null ||
    validationFitness === undefined ||
    !Number.isFinite(validationFitness) ||
    !Number.isFinite(fitness)
  )
    return null;
  return fitness - validationFitness;
}
/**
 * Share of this generation's candidates whose genome had already been evaluated.
 * Null when the counts were not recorded (older history) or no candidate exists.
 */
export function repeatShare(
  point: Pick<HistoryPoint, "generationEvaluations" | "generationRepeats">,
): number | null {
  const evaluations = point.generationEvaluations,
    repeats = point.generationRepeats;
  if (
    evaluations === undefined ||
    repeats === undefined ||
    !Number.isFinite(evaluations) ||
    !Number.isFinite(repeats)
  )
    return null;
  const total = evaluations + repeats;
  return total > 0 ? repeats / total : null;
}
/** Run-level denominators the chart can normalize counts by; both are optional. */
export interface HistoryScale {
  eliteCount?: number;
  populationSize?: number;
}
const positive = (value: number | undefined): value is number =>
  value !== undefined && Number.isFinite(value) && value > 0;
/**
 * Denominator for distinct elites: the configured elite count, else the
 * population size, else the largest count recorded so a line still fits 0–1.
 */
export function distinctEliteScale(
  history: readonly HistoryPoint[],
  scale: HistoryScale = {},
): number {
  if (positive(scale.eliteCount)) return scale.eliteCount;
  if (positive(scale.populationSize)) return scale.populationSize;
  let largest = 1;
  for (const point of history)
    if (Number.isFinite(point.distinctElites))
      largest = Math.max(largest, point.distinctElites);
  return largest;
}
export type HistoryMetric =
  | "bestEver"
  | "best"
  | "mean"
  | "worst"
  | "validationBest"
  | "diversity"
  | "repeatShare"
  | "distinctElites";
/** Series drawn against the right-hand 0–1 axis rather than the fitness axis. */
export const UNIT_METRICS: ReadonlySet<HistoryMetric> = new Set<HistoryMetric>([
  "diversity",
  "repeatShare",
  "distinctElites",
]);
/**
 * Plotted value for a metric: stored fitness metrics as recorded, repeat share
 * derived from the optional counts, distinct elites divided by `eliteScale`.
 * Null (never NaN) when the point lacks the data.
 */
export function historyValue(
  point: HistoryPoint,
  metric: HistoryMetric,
  eliteScale = 1,
): number | null {
  if (metric === "repeatShare") return repeatShare(point);
  if (metric === "distinctElites")
    return Number.isFinite(point.distinctElites) && eliteScale > 0
      ? point.distinctElites / eliteScale
      : null;
  const value = point[metric];
  return value === null || !Number.isFinite(value) ? null : value;
}
/** Missing values break a line. Never interpolate through unevaluated held-out generations. */
export function historySegments(
  history: readonly HistoryPoint[],
  metric: HistoryMetric,
  eliteScale = 1,
): HistoryPoint[][] {
  const segments: HistoryPoint[][] = [];
  let segment: HistoryPoint[] = [];
  for (const point of history) {
    if (historyValue(point, metric, eliteScale) === null) {
      if (segment.length) segments.push(segment);
      segment = [];
    } else segment.push(point);
  }
  if (segment.length) segments.push(segment);
  return segments;
}
/** Readout text for a hovered point: shares as percentages, distinct elites as a count over its scale. */
export function historyReadout(
  point: HistoryPoint,
  metric: HistoryMetric,
  scale: HistoryScale = {},
): string {
  if (metric === "repeatShare") return formatPercent(repeatShare(point));
  if (metric === "distinctElites") {
    if (!Number.isFinite(point.distinctElites)) return "—";
    const denominator = positive(scale.eliteCount)
      ? scale.eliteCount
      : positive(scale.populationSize)
        ? scale.populationSize
        : null;
    return denominator === null
      ? String(point.distinctElites)
      : `${point.distinctElites} / ${denominator}`;
  }
  return formatFitness(point[metric]);
}
export function nearestGeneration(
  generations: readonly number[],
  target: number,
): number | null {
  if (!generations.length) return null;
  return generations.reduce((nearest, value) =>
    Math.abs(value - target) < Math.abs(nearest - target) ? value : nearest,
  );
}
export const formatFitness = (value: number | null | undefined) =>
  value == null || !Number.isFinite(value) ? "—" : value.toFixed(4);
/** Signed with an explicit plus and a true minus sign; a dash for no value. */
export const formatSigned = (value: number | null | undefined) =>
  value == null || !Number.isFinite(value)
    ? "—"
    : value < 0
      ? `−${(-value).toFixed(4)}`
      : `+${value.toFixed(4)}`;
export const formatPercent = (value: number | null | undefined) =>
  value == null || !Number.isFinite(value)
    ? "—"
    : `${(value * 100).toFixed(1)}%`;
export const formatCount = (value: number | null | undefined) =>
  value == null || !Number.isFinite(value) ? "—" : String(value);
