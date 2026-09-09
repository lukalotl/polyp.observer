import { describe, expect, it } from "vitest";
import { DEFAULT_RUN_CONFIG } from "./config";
import { streamTrajectory } from "./trajectory";
import { evaluateGenome } from "./evaluate";
import { presetIncentive } from "./incentives";
import { sampleTrajectory } from "./sample";
import { expandPreviewLayer } from "./previewLayers";
import { simulate, mutate, PRESETS, type SeedMode } from "../simulation";
import type { RunConfig } from "./types";

const config = (overrides: Partial<RunConfig> = {}): RunConfig => ({
  ...structuredClone(DEFAULT_RUN_CONFIG),
  size: 9,
  steps: 8,
  seed: "point",
  boundaryPolicy: { spatial: false, horizon: false },
  ...overrides,
});

describe("spatial reuse with and without death", () => {
  it("distinguishes first occupation, death, persistent occupation and changes between live states", () => {
    const dead = Array(45).fill(0);
    const survivor = dead.slice();
    survivor[9] = 1;
    const cycling = dead.slice();
    cycling[9] = 2;
    cycling[18] = 1;
    for (const genome of [survivor, cycling])
      expect(streamTrajectory(genome, config(), 1729)).toMatchObject({
        exposedCells: 1,
        reusedCells: 0,
        reuseEvents: 0,
        reuseAlive: 7,
        cellDeaths: 0,
      });
    expect(streamTrajectory(dead, config(), 1729)).toMatchObject({
      exposedCells: 1,
      reusedCells: 0,
      reuseEvents: 0,
      reuseAlive: 0,
      cellDeaths: 1,
    });
    // An empty soup never dies; padding after extinction never repeats a death.
    expect(
      streamTrajectory(dead, config({ seed: "soup", soupSize: 1 }), 7),
    ).toMatchObject({
      exposedCells: 0,
      reusedCells: 0,
      reuseEvents: 0,
      reuseAlive: 0,
      cellDeaths: 0,
    });
    expect(
      streamTrajectory(dead, config({ seed: "cross", steps: 128 }), 1),
    ).toMatchObject({
      exposedCells: 9,
      reusedCells: 0,
      reuseEvents: 0,
      reuseAlive: 0,
      cellDeaths: 9,
    });
  });
  it.each([2, 5, 16])(
    "penalizes continuous occupation equally across live types with %i states",
    (stateCount) => {
      for (const nextState of [1, stateCount - 1]) {
        const genome = Array(stateCount * 9).fill(0);
        genome[9] = nextState;
        if (nextState !== 1) genome[nextState * 9] = 1;
        const cfg = config({ stateCount, seedGenome: genome });
        expect(streamTrajectory(genome, cfg, 1729)).toMatchObject({
          exposedCells: 1,
          reuseEvents: 0,
          reuseAlive: 7,
          cellDeaths: 0,
        });
        expect(
          evaluateGenome(genome, {
            ...cfg,
            incentives: [presetIncentive("avoidReuseAlive")],
          }).fitness,
        ).toBe(1 / 8);
        expect(
          evaluateGenome(genome, {
            ...cfg,
            incentives: [presetIncentive("avoidRepeatedReuse")],
          }).fitness,
        ).toBe(1);
      }
    },
  );
  it("scores zero reuse as one and counts occupation only through the cutoff", () => {
    const genome = Array(45).fill(0);
    genome[9] = 2;
    genome[18] = 3;
    genome[27] = 4;
    genome[36] = 1;
    for (const steps of [8, 9, 128]) {
      const cfg = config({ steps });
      expect(streamTrajectory(genome, cfg, 1729).reuseAlive).toBe(steps - 1);
      expect(
        evaluateGenome(genome, {
          ...cfg,
          incentives: [presetIncentive("avoidReuseAlive")],
        }).fitness,
      ).toBe(1 / steps);
    }
    for (const reuseAlive of [0, 1, 2]) {
      const transient = Array(45).fill(0);
      for (let state = 1; state <= reuseAlive; state++)
        transient[state * 9] = state + 1;
      expect(streamTrajectory(transient, config(), 1729)).toMatchObject({
        reuseAlive,
        reuseEvents: 0,
        cellDeaths: 1,
      });
      expect(
        evaluateGenome(transient, {
          ...config(),
          incentives: [presetIncentive("avoidReuseAlive")],
        }).fitness,
      ).toBe(1 / (1 + reuseAlive));
    }
    for (const cfg of [
      config(),
      config({ seed: "soup", soupSize: 1, trainingSeeds: [7] }),
    ])
      expect(
        evaluateGenome(Array(45).fill(0), {
          ...cfg,
          incentives: [presetIncentive("avoidReuseAlive")],
        }).fitness,
      ).toBe(1);
  });
  it("counts a known Life blinker once per reused position and again on each later return", () => {
    const life = Array(18).fill(0);
    life[3] = 1;
    life[11] = 1;
    life[12] = 1;
    const cfg = config({
      stateCount: 2,
      seed: "soup",
      soupSize: 3,
      seedGenome: life,
      trainingSeeds: [424],
    });
    const preview = sampleTrajectory(life, cfg, 424);
    const first = expandPreviewLayer(preview.simulation.layers[0], cfg.size);
    expect(
      Array.from(first).flatMap((state, cell) => (state ? [cell] : [])),
    ).toEqual([39, 40, 41]);
    expect(preview.simulation.population).toEqual(Array(8).fill(3));
    // Two end cells die each transition. The center never dies. At t=1 two
    // new positions are born; the next six turns each reclaim two old ones.
    // All reuse also counts the center on all seven transitions: 12 + 7 = 19.
    expect(streamTrajectory(life, cfg, 424)).toMatchObject({
      exposedCells: 5,
      reusedCells: 4,
      reuseEvents: 12,
      reuseAlive: 19,
      cellDeaths: 14,
    });
    const longer = streamTrajectory(life, { ...cfg, steps: 12 }, 424);
    expect(longer).toMatchObject({
      exposedCells: 5,
      reusedCells: 4,
      reuseEvents: 20,
      reuseAlive: 31,
      cellDeaths: 22,
    });
    expect(
      evaluateGenome(life, {
        ...cfg,
        incentives: [presetIncentive("avoidReuse")],
      }).fitness,
    ).toBeCloseTo(0.2, 14);
    expect(
      evaluateGenome(life, {
        ...cfg,
        incentives: [presetIncentive("avoidRepeatedReuse")],
      }).fitness,
    ).toBe(1 / 13);
    expect(
      evaluateGenome(life, {
        ...cfg,
        incentives: [presetIncentive("avoidReuseAlive")],
      }).fitness,
    ).toBe(1 / 20);
    expect(
      evaluateGenome(life, {
        ...cfg,
        incentives: [presetIncentive("avoidDeaths")],
      }).fitness,
    ).toBe(1 / 15);
    expect(
      evaluateGenome(life, {
        ...cfg,
        incentives: [
          {
            name: "Fresh light",
            expression: "(exposedCells / area) / (1 + reuseEvents)",
            weight: 1,
          },
        ],
      }).fitness,
    ).toBe(5 / 81 / 13);
  });
  it("matches a per-position lifetime scan of independent full-history simulations", () => {
    for (const seed of ["point", "cross", "islands", "soup"] as SeedMode[])
      for (let index = 0; index < 12; index++) {
        const cfg = config({
          seed,
          soupSize: 6,
          size: index % 2 ? 17 : 9,
          steps: index % 3 ? 24 : 64,
          trainingSeeds: [index - 4],
        });
        const genome =
          index < 3
            ? PRESETS[index].genome
            : mutate(PRESETS[index % 3].genome, (index % 5) / 4, index * 997);
        const full = simulate(genome, { ...cfg, randomSeed: index - 4 });
        let reusedCells = 0,
          reuseEvents = 0,
          reuseAlive = 0,
          cellDeaths = 0;
        for (let cell = 0; cell < cfg.size ** 2; cell++) {
          let deaths = 0,
            returns = 0,
            everAlive = Boolean(full.layers[0][cell]);
          for (let time = 1; time < cfg.steps; time++) {
            if (full.layers[time][cell]) {
              if (everAlive) reuseAlive++;
              everAlive = true;
            }
            if (full.layers[time - 1][cell] && !full.layers[time][cell])
              deaths++;
            if (
              !full.layers[time - 1][cell] &&
              full.layers[time][cell] &&
              deaths > 0
            )
              returns++;
          }
          cellDeaths += deaths;
          reuseEvents += returns;
          reusedCells += Number(returns > 0);
        }
        expect(streamTrajectory(genome, cfg, index - 4)).toMatchObject({
          reusedCells,
          reuseEvents,
          reuseAlive,
          cellDeaths,
        });
        const fitness = evaluateGenome(genome, {
          ...cfg,
          incentives: [
            {
              name: "Reuse pressure",
              expression:
                "1 / (1 + reusedCells + reuseEvents + reuseAlive + cellDeaths)",
              weight: 1,
            },
          ],
        }).fitness;
        expect(fitness).toBe(
          1 / (1 + reusedCells + reuseEvents + reuseAlive + cellDeaths),
        );
      }
  });
});
