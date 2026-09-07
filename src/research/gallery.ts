import type { GenerationSnapshot, Individual, RunDetail } from "./types";

export interface GalleryCandidate {
  individual: Individual;
  generation: number;
}

export type CandidateSource = "best" | "generation" | "selected";

/** Records read left to right in time; populations read from lowest to highest fitness. */
export function galleryCandidates(
  detail: RunDetail | null,
  snapshot: GenerationSnapshot | null,
  source: CandidateSource,
  selected: GalleryCandidate | null,
): GalleryCandidate[] {
  if (!detail) return [];
  if (source === "selected") return selected ? [selected] : [];
  if (source === "generation")
    return [...(snapshot?.population ?? [])]
      .sort((a, b) => a.fitness - b.fitness || b.id.localeCompare(a.id))
      .map((individual) => ({ individual, generation: snapshot!.generation }));
  const records = [...detail.improvements].sort(
    (a, b) => a.generation - b.generation,
  );
  const seen = new Set<string>();
  const candidates = records.filter(({ individual }) => {
    if (seen.has(individual.id)) return false;
    seen.add(individual.id);
    return true;
  });
  // Older checkpoints may retain no record history, but still have a champion.
  const champion = detail.snapshot?.champion;
  if (champion && !seen.has(champion.id))
    candidates.push({
      individual: champion,
      generation: detail.snapshot!.generation,
      elapsedMs: detail.summary.elapsedMs,
    });
  return candidates;
}

/** A null cursor follows the right edge; an explicit cursor survives observer updates. */
export function galleryIndex(
  items: GalleryCandidate[],
  cursor: string | null,
): number {
  const found =
    cursor === null
      ? -1
      : items.findIndex(({ individual }) => individual.id === cursor);
  return found < 0 ? items.length - 1 : found;
}

export function galleryNeighbors(length: number, index: number): number[] {
  return galleryWindow(length, index)
    .filter((value) => value !== index)
    .sort((a, b) => Math.abs(a - index) - Math.abs(b - index));
}

export function galleryWindow(length: number, index: number): number[] {
  const count = Math.min(3, length);
  const start = Math.max(0, Math.min(index - 1, length - count));
  return Array.from({ length: count }, (_, offset) => start + offset);
}
