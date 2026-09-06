import { PRESETS, type Genome, type SeedMode } from "../simulation";

export const MIN_STATE_COUNT = 2;
export const MAX_STATE_COUNT = 16;

/** One hex digit per locus, including states 10–15. Five-state keys stay identical. */
export const genomeKey = (genome: Genome): string =>
  genome.map((state) => state.toString(16)).join("");

/** Display fingerprint only; never used for evaluation/cache identity. */
export function genomeId(genome: Genome): string {
  let hash = 2166136261;
  for (const gene of genome) hash = Math.imul(hash ^ gene, 16777619) >>> 0;
  return hash.toString(16).padStart(8, "0").toUpperCase();
}

/** Keep existing rows; fold removed outputs to occupied state 1.
 * New rows inherit state 1's transitions. This changes the rule, not saved runs.
 */
export function resizeGenome(genome: Genome, stateCount: number): Genome {
  if (
    !Number.isInteger(stateCount) ||
    stateCount < MIN_STATE_COUNT ||
    stateCount > MAX_STATE_COUNT
  )
    throw new RangeError("State count must be between 2 and 16.");
  return Array.from({ length: 9 * stateCount }, (_, locus) => {
    const output = genome[locus < genome.length ? locus : 9 + (locus % 9)];
    return output < stateCount ? output : 1;
  });
}

export function founderPresets(stateCount: number): {
  id: string;
  name: string;
  genome: Genome;
  seed: SeedMode;
}[] {
  if (stateCount === 2) {
    return [
      { id: "life", name: "Life · B3/S23", births: [3] },
      { id: "highlife", name: "HighLife · B36/S23", births: [3, 6] },
    ].map(({ id, name, births }) => ({
      id,
      name,
      seed: "cross",
      genome: Array.from({ length: 18 }, (_, locus) =>
        Number(locus < 9 ? births.includes(locus) : [2, 3].includes(locus - 9)),
      ),
    }));
  }
  return PRESETS.map((preset) => ({
    ...preset,
    genome: resizeGenome(preset.genome, stateCount),
  }));
}
