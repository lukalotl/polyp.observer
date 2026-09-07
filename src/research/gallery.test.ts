import { beforeAll, describe, expect, it } from "vitest";
import { researchFixture } from "../test/researchFixtures";
import {
  galleryCandidates,
  galleryIndex,
  galleryNeighbors,
  galleryWindow,
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
  it("keeps three actual models visible at both ends of a large population", () => {
    expect(galleryWindow(512, 511)).toEqual([509, 510, 511]);
    expect(galleryNeighbors(512, 511)).toEqual([510, 509]);
    expect(galleryWindow(512, 0)).toEqual([0, 1, 2]);
    expect(galleryNeighbors(512, 240)).toEqual([239, 241]);
    expect(galleryWindow(2, 1)).toEqual([0, 1]);
    expect(galleryWindow(0, -1)).toEqual([]);
  });
});
