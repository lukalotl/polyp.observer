import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  installResearchNetwork,
  previewFor,
  researchFixture,
  type ControlledHttp,
} from "../test/researchFixtures";
import { useNeighborPreviews } from "./useNeighborPreviews";

let fixture: Awaited<ReturnType<typeof researchFixture>>;
let http: ControlledHttp;
beforeAll(async () => {
  fixture = await researchFixture();
});
beforeEach(() => {
  vi.useFakeTimers();
  http = installResearchNetwork();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("waits for the inspected model, serializes neighbors, and reuses previews within the same fixture", async () => {
  const genomes = fixture.state.population
    .slice(0, 2)
    .map((item) => item.genome);
  const props = {
    context: "run-a:1729",
    runId: "run-a",
    genomes,
    seed: 1729,
    ready: false,
  };
  const { result, rerender } = renderHook(useNeighborPreviews, {
    initialProps: props,
  });
  await act(() => vi.advanceTimersByTimeAsync(200));
  expect(http.requests).toHaveLength(0);
  rerender({ ...props, ready: true });
  await act(() => vi.advanceTimersByTimeAsync(200));
  expect(http.requests).toHaveLength(1);
  await http.reply(
    "/api/runs/run-a/preview",
    previewFor(fixture.detail, genomes[0], 1729),
    "POST",
  );
  if (genomes[0].join(",") !== genomes[1].join(",")) {
    expect(http.requests).toHaveLength(2);
    await http.reply(
      "/api/runs/run-a/preview",
      previewFor(fixture.detail, genomes[1], 1729),
      "POST",
    );
  }
  expect(result.current(genomes[0])?.simulation?.layers).toHaveLength(
    fixture.detail.config.steps,
  );
  expect(result.current(genomes[1])?.simulation).toBeDefined();
  const requests = http.requests.length;
  rerender({ ...props, ready: true, genomes: [...genomes].reverse() });
  await act(() => vi.advanceTimersByTimeAsync(200));
  expect(http.requests).toHaveLength(requests);
});

it("aborts superseded neighbor requests and never caches a stale fixture or failed model as the inspected preview", async () => {
  const genome = fixture.state.champion.genome;
  const props = {
    context: "run-a:1729",
    runId: "run-a",
    genomes: [genome],
    seed: 1729,
    ready: true,
  };
  const { result, rerender } = renderHook(useNeighborPreviews, {
    initialProps: props,
  });
  await act(() => vi.advanceTimersByTimeAsync(200));
  const stale = http.pending("/api/runs/run-a/preview", "POST");
  rerender({ ...props, context: "run-a:23", seed: 23 });
  expect(stale.options.signal?.aborted).toBe(true);
  await act(async () => stale.resolve(fixture.preview));
  expect(result.current(genome)).toBeUndefined();
  await act(() => vi.advanceTimersByTimeAsync(200));
  await http.reply(
    "/api/runs/run-a/preview",
    { error: "Preview unavailable" },
    "POST",
    422,
  );
  expect(result.current(genome)).toEqual(
    expect.objectContaining({ error: "Preview unavailable" }),
  );
  expect(result.current(genome)?.simulation).toBeUndefined();
});

it("retains all visible previews and releases old cached data when the viewport moves", async () => {
  const base = fixture.state.champion.genome;
  const states = base.length / 9;
  const genomes = Array.from({ length: 5 }, (_, index) => {
    const genome = [...base];
    genome[1] = index % states;
    genome[2] = Math.floor(index / states);
    return genome;
  });
  const props = {
    context: "run-a:1729",
    runId: "run-a",
    genomes: genomes.slice(0, 4),
    seed: 1729,
    ready: true,
  };
  const { result, rerender } = renderHook(useNeighborPreviews, {
    initialProps: props,
  });
  await act(() => vi.advanceTimersByTimeAsync(200));
  for (const genome of genomes.slice(0, 4)) {
    await http.reply(
      "/api/runs/run-a/preview",
      previewFor(fixture.detail, genome, 1729),
      "POST",
    );
  }
  expect(
    genomes.slice(0, 4).every((genome) => result.current(genome)?.simulation),
  ).toBe(true);
  expect(http.requests).toHaveLength(4);
  rerender({ ...props, genomes: [genomes[4]] });
  await act(() => vi.advanceTimersByTimeAsync(200));
  await http.reply(
    "/api/runs/run-a/preview",
    previewFor(fixture.detail, genomes[4], 1729),
    "POST",
  );
  expect(result.current(genomes[4])?.simulation).toBeDefined();
  expect(genomes.filter((genome) => result.current(genome))).toHaveLength(2);
});
