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

export function galleryNeighbors(visible: number[], index: number): number[] {
  return visible
    .filter((value) => value !== index)
    .sort((a, b) => Math.abs(a - index) - Math.abs(b - index));
}

/** Compact slots fit about five specimens on a laptop; short lists stay grouped. */
export function galleryLayout(length: number, width: number) {
  const columns =
    length === 1 ? 1 : Math.max(2, Math.min(6, Math.floor(width / 220)));
  const itemWidth = Math.max(1, width) / columns;
  return { itemWidth, inset: Math.max(0, (width - length * itemWidth) / 2) };
}

/** Use the actual scroll viewport, including partial items during a pan.
 * A half-pixel tolerance ignores subpixel rounding at the viewport's edges.
 */
export function galleryWindow(
  length: number,
  width: number,
  scrollLeft: number,
): number[] {
  if (width <= 0 || length === 0) return [];
  const { itemWidth, inset } = galleryLayout(length, width);
  const start = Math.max(0, Math.floor((scrollLeft - inset + 0.5) / itemWidth));
  const end = Math.min(
    length,
    Math.ceil((scrollLeft + width - inset - 0.5) / itemWidth),
  );
  return Array.from(
    { length: Math.max(0, end - start) },
    (_, offset) => start + offset,
  );
}
