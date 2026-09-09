import type { RunConfig } from "./types";

/**
 * Pure descriptions of the mutation operators' change-count distributions.
 * The engine's heavy-tailed sampler and the run creator's summary must agree,
 * so both derive from these tables. No RNG here.
 */
export function unlockedLoci(stateCount: number): number {
  return 9 * stateCount - 1;
}

/** Largest number of loci one heavy-tailed mutation may change (Doerr et al. 2017 use n/2). */
export function heavyTailedMaxChanges(stateCount: number): number {
  return Math.max(1, Math.floor(unlockedLoci(stateCount) / 2));
}

/**
 * Normalized P(k) for k = 1..kMax with P(k) ∝ k^-beta. Index 0 holds k = 1.
 * Deterministic: the engine builds its cumulative table from exactly this array.
 */
export function heavyTailedWeights(stateCount: number, beta: number): number[] {
  const kMax = heavyTailedMaxChanges(stateCount);
  const raw = Array.from({ length: kMax }, (_, i) => (i + 1) ** -beta);
  const total = raw.reduce((a, b) => a + b, 0);
  return raw.map((w) => w / total);
}

export interface MutationChangeDistribution {
  /** probabilities[k] is the chance a one-parent child receives exactly k changed loci. */
  probabilities: number[];
  mean: number;
  /** Mutable loci for the given state count. */
  unlocked: number;
}

/** Change-count distribution for the configured policy; index 0 is "no change" (a clone). */
export function mutationChangeDistribution(
  config: Pick<
    RunConfig,
    "stateCount" | "mutationPolicy" | "mutationRate" | "mutationBeta"
  >,
): MutationChangeDistribution {
  const unlocked = unlockedLoci(config.stateCount);
  if ((config.mutationPolicy ?? "independent") === "heavyTailed") {
    const weights = heavyTailedWeights(config.stateCount, config.mutationBeta ?? 1.5);
    const probabilities = [0, ...weights];
    const mean = weights.reduce((sum, p, i) => sum + p * (i + 1), 0);
    return { probabilities, mean, unlocked };
  }
  // Binomial(unlocked, rate), computed by recurrence to avoid huge factorials.
  const p = config.mutationRate;
  const probabilities = new Array<number>(unlocked + 1).fill(0);
  if (p <= 0) probabilities[0] = 1;
  else if (p >= 1) probabilities[unlocked] = 1;
  else {
    let term = (1 - p) ** unlocked;
    for (let k = 0; k <= unlocked; k++) {
      probabilities[k] = term;
      term *= ((unlocked - k) / (k + 1)) * (p / (1 - p));
    }
  }
  return { probabilities, mean: unlocked * p, unlocked };
}

/** Per-locus rate that yields the requested expected number of changes under "independent". */
export function rateForExpectedChanges(
  stateCount: number,
  expectedChanges: number,
): number {
  return Math.max(0, Math.min(1, expectedChanges / unlockedLoci(stateCount)));
}
