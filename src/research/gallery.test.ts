import { beforeAll, describe, expect, it } from "vitest";
import { researchFixture } from "../test/researchFixtures";
import {
  galleryCandidates,
  galleryIndex,
  galleryNeighbors,
  galleryWindow,
  galleryLayout,
} from "./gallery";

let fixture: Awaited<ReturnType<typeof researchFixture>>;
beforeAll(async () => {
  fixture = await researchFixture();
});

describe("model gallery sources and cursor", () => {
  it("orders retained records chronologically, deduplicates IDs, and includes a checkpoint's missing champion", () => {
    const detail = structuredClone(fixture.detail);
    const population = detail.snapshot!.population;
    const old = population.find(
      (item) => item.id !== detail.snapshot!.champion.id,
    )!;
    detail.improvements = [
      { individual: old, generation: 2, elapsedMs: 200 },
      { individual: old, generation: 0, elapsedMs: 0 },
    ];
    const items = galleryCandidates(detail, detail.snapshot, "best", null);
    expect(items.map((item) => item.individual.id)).toEqual([
      old.id,
      detail.snapshot!.champion.id,
    ]);
    expect(items[0].generation).toBe(0);
    expect(detail.improvements).toHaveLength(2);
  });
  it("uses only the requested generation's population, without changing its original rank order", () => {
    const snapshot = fixture.snapshots[0];
    const before = snapshot.population.map((individual) => individual.id);
    const items = galleryCandidates(
      fixture.detail,
      snapshot,
      "generation",
      null,
    );
    expect(items).toHaveLength(snapshot.population.length);
    expect(items.every((item) => item.generation === 0)).toBe(true);
    expect(items.map((item) => item.individual.fitness)).toEqual(
      snapshot.population
        .map((individual) => individual.fitness)
        .sort((a, b) => a - b),
    );
    expect(snapshot.population.map((individual) => individual.id)).toEqual(
      before,
    );
  });
  it("defaults to the right edge, preserves manual inspection, and falls back when an individual leaves", () => {
    const items = galleryCandidates(
      fixture.detail,
      fixture.detail.snapshot,
      "generation",
      null,
    );
    expect(galleryIndex(items, null)).toBe(items.length - 1);
    expect(galleryIndex(items, items[1].individual.id)).toBe(1);
    expect(galleryIndex(items.slice(2), items[1].individual.id)).toBe(
      items.length - 3,
    );
    expect(galleryIndex([], null)).toBe(-1);
    const chosen = items[1];
    expect(
      galleryCandidates(
        fixture.detail,
        fixture.detail.snapshot,
        "selected",
        chosen,
      ),
    ).toEqual([chosen]);
  });
  it("fits five compact models in a laptop viewport and culls the rest of a large population", () => {
    expect(galleryLayout(512, 1200)).toEqual({ itemWidth: 240, inset: 0 });
    expect(galleryWindow(512, 1200, 507 * 240)).toEqual([
      507, 508, 509, 510, 511,
    ]);
    expect(galleryNeighbors(galleryWindow(512, 1200, 507 * 240), 511)).toEqual([
      510, 509, 508, 507,
    ]);
    expect(galleryWindow(512, 1200, 0)).toEqual([0, 1, 2, 3, 4]);
    expect(galleryWindow(512, 1200, 238 * 240)).toEqual([
      238, 239, 240, 241, 242,
    ]);
  });
  it("tracks partial items while panning, including when selection is offscreen", () => {
    expect(galleryWindow(512, 1200, 120)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(galleryWindow(512, 1200, 1200)).toEqual([5, 6, 7, 8, 9]);
    expect(galleryWindow(512, 1208, Math.round((3 * 1208) / 5))).toEqual([
      3, 4, 5, 6, 7,
    ]);
  });
  it("adapts to small screens and keeps short lists grouped instead of spreading them apart", () => {
    expect(galleryLayout(2, 1200)).toEqual({ itemWidth: 240, inset: 360 });
    expect(galleryWindow(2, 1200, 0)).toEqual([0, 1]);
    expect(galleryWindow(512, 390, 0)).toEqual([0, 1]);
    expect(galleryLayout(1, 1200)).toEqual({ itemWidth: 1200, inset: 0 });
    expect(galleryWindow(0, 1200, 0)).toEqual([]);
    expect(galleryWindow(512, 0, 0)).toEqual([]);
  });
});
