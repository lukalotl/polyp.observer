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
export type HistoryMetric =
  | "bestEver"
  | "best"
  | "mean"
  | "worst"
  | "validationBest"
  | "diversity";
/** Missing values break a line. Never interpolate through unevaluated held-out generations. */
export function historySegments(
  history: readonly HistoryPoint[],
  metric: HistoryMetric,
): HistoryPoint[][] {
  const segments: HistoryPoint[][] = [];
  let segment: HistoryPoint[] = [];
  for (const point of history) {
    const value = point[metric];
    if (value === null || !Number.isFinite(value)) {
      if (segment.length) segments.push(segment);
      segment = [];
    } else segment.push(point);
  }
  if (segment.length) segments.push(segment);
  return segments;
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
