import { describe, expect, it } from "vitest";
import { DEFAULT_RUN_CONFIG } from "./config";
import { boundaryDescription, SPATIAL_WALLS } from "./boundaries";
import { evaluateGenome } from "./evaluate";
import { initializePopulation, validateEngineState } from "./engine";
import { sampleTrajectory } from "./sample";
import { streamTrajectory } from "./trajectory";
import type { RunConfig } from "./types";

const config = (patch: Partial<RunConfig> = {}): RunConfig => ({
  ...structuredClone(DEFAULT_RUN_CONFIG),
  fixtureFailures: "all",
  stateCount: 2,
  seedGenome: Array(18).fill(0),
  size: 9,
  steps: 16,
  seed: "point",
  objective: "complexity",
  populationSize: 8,
  eliteCount: 2,
  ...patch,
});
const spreading = Array.from({ length: 18 }, (_, i) => (i ? 1 : 0));
// Seed 1 reaches only the right wall; seed 2 becomes extinct without contact.
const split = [0, 0, 0, 1, 0, 0, 1, 1, 1, 0, 0, 1, 0, 1, 1, 0, 0, 0];
// Seed 1 contacts three walls before becoming extinct at t=14.
const finite = [0, 0, 1, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0];

describe("boundary qualification of complete trajectories", () => {
  it("records the first contact with all four walls, including corners", () => {
    const cfg = config();
    const frame = sampleTrajectory(spreading, cfg, 1);
    expect(frame.boundaryContacts).toEqual({
      left: 4,
      right: 4,
      front: 4,
      back: 4,
      horizon: true,
    });
    expect(evaluateGenome(spreading, cfg)).toMatchObject({
      fitness: 0,
      disqualified: true,
    });
    const cropped = sampleTrajectory(spreading, cfg, 1, { start: 0, end: 2 });
    expect(cropped.boundaryContacts).toEqual(frame.boundaryContacts);
    expect(boundaryDescription(frame.boundaryContacts, 15)).toBe(
      "left at t=4 · right at t=4 · front at t=4 · back at t=4 · time cutoff at t=15",
    );
  });
  it("remembers spatial contact even after extinction and preserves observed metrics", () => {
    const cfg = config({
      seed: "islands",
      trainingSeeds: [1],
      objective: "longevity",
    });
    const trajectory = streamTrajectory(finite, cfg, 1);
    expect(trajectory.boundaryContacts).toEqual({
      left: 3,
      right: 12,
      front: 8,
      back: null,
      horizon: false,
    });
    const rejected = evaluateGenome(finite, cfg);
    const allowed = evaluateGenome(finite, {
      ...cfg,
      boundaryPolicy: { spatial: false, horizon: true },
    });
    expect(rejected).toMatchObject({ fitness: 0, disqualified: true });
    expect(allowed).toMatchObject({ fitness: 14 / 15, disqualified: false });
    expect(rejected.metrics).toEqual(allowed.metrics);
    expect(rejected.metrics.extinctFraction).toBe(1);
  });
  it("qualifies the same expanding rule when there is sufficient spatial room", () => {
    const cfg = config({
      steps: 8,
      boundaryPolicy: { spatial: true, horizon: false },
    });
    expect(evaluateGenome(spreading, cfg).disqualified).toBe(true);
    const roomy = { ...cfg, size: 33 };
    expect(evaluateGenome(spreading, roomy).disqualified).toBe(false);
    expect(evaluateGenome(spreading, roomy).fitness).toBeGreaterThan(0);
    const contacts = streamTrajectory(spreading, roomy, 1).boundaryContacts;
    for (const wall of SPATIAL_WALLS) expect(contacts[wall]).toBeNull();
  });
  it.each(["growth", "complexity", "longevity"] as const)(
    "makes the horizon policy explicit for %s",
    (objective) => {
      const survivor = Array(18).fill(0);
      survivor[9] = 1;
      const cfg = config({ objective });
      const rejected = evaluateGenome(survivor, cfg);
      const allowed = evaluateGenome(survivor, {
        ...cfg,
        boundaryPolicy: { spatial: true, horizon: false },
      });
      expect(rejected).toMatchObject({ fitness: 0, disqualified: true });
      expect(allowed.disqualified).toBe(false);
      if (objective === "longevity") expect(allowed.fitness).toBe(0);
      else expect(allowed.fitness).toBeGreaterThan(0);
      // The intentional initial plane is not a rejecting time boundary.
      expect(evaluateGenome(Array(18).fill(0), cfg).disqualified).toBe(false);
    },
  );
  it.each(["mean", "minimum"] as const)(
    "rejects the whole training candidate independently of %s aggregation and held-out selection",
    (aggregation) => {
      const cfg = config({
        seed: "islands",
        trainingSeeds: [1, 2],
        aggregation,
        boundaryPolicy: { spatial: true, horizon: false },
      });
      const both = evaluateGenome(split, cfg);
      expect(streamTrajectory(split, cfg, 1).boundaryContacts).toEqual({
        left: null,
        right: 9,
        front: null,
        back: null,
        horizon: true,
      });
      expect(both).toMatchObject({
        fitness: 0,
        disqualified: true,
        validationDisqualified: false,
        validationFitness: null,
      });
      expect(both.trainingScores[0]).toBe(0);
      expect(both.trainingScores[1]).toBeGreaterThan(0);
      const heldOut = evaluateGenome(split, {
        ...cfg,
        trainingSeeds: [2],
        validationSeeds: [1],
      });
      expect(heldOut).toMatchObject({
        disqualified: false,
        validationDisqualified: true,
        validationFitness: 0,
      });
      expect(heldOut.fitness).toBe(both.trainingScores[1]);
      const validation = evaluateGenome(split, {
        ...cfg,
        trainingSeeds: [3],
        validationSeeds: [1, 2],
      });
      expect(validation.validationFitness).toBe(0);
      expect(validation.validationScores[1]).toBeGreaterThan(0);
      expect(validation.validationDisqualified).toBe(true);
    },
  );
  it("averages failures as zero while worst-fixture and legacy runs retain their strict behavior", async () => {
    const cfg = config({
      fixtureFailures: "aggregate",
      seed: "islands",
      seedGenome: split,
      trainingSeeds: [1, 2],
      validationSeeds: [3, 4],
      mutationRate: 0,
      boundaryPolicy: { spatial: true, horizon: false },
    });
    const mean = evaluateGenome(split, cfg);
    expect(mean.fixturePasses?.training).toEqual([false, true]);
    expect(mean.fitness).toBe(mean.trainingScores[1] / 2);
    expect(mean.fitness).toBeGreaterThan(0);
    expect(mean.validationFitness).toBe(
      mean.validationScores.reduce((a, b) => a + b, 0) / 2,
    );
    expect(
      evaluateGenome(split, { ...cfg, aggregation: "minimum" }).fitness,
    ).toBe(0);
    const { fixtureFailures: _, ...legacy } = cfg;
    expect(evaluateGenome(split, legacy)).toMatchObject({
      fitness: 0,
      disqualified: true,
    });
    expect(evaluateGenome(split, legacy).fixturePasses).toBeUndefined();
    const state = await initializePopulation(cfg);
    expect(validateEngineState(JSON.parse(JSON.stringify(state)))).toEqual(
      state,
    );
    const invalid = structuredClone(state);
    invalid.cache[0].evaluation.fixturePasses!.training[0] = true;
    expect(() => validateEngineState(invalid)).toThrow(/Fixture passes/);
  });
  it("round-trips disqualification through populations and cached evaluation without accepting contradictory flags", async () => {
    const cfg = config({
      seed: "islands",
      seedGenome: split,
      trainingSeeds: [1, 2],
      mutationRate: 0,
      boundaryPolicy: { spatial: true, horizon: false },
    });
    const state = await initializePopulation(cfg);
    expect(state.champion.disqualified).toBe(true);
    expect(validateEngineState(state)).toEqual(state);
    expect(state.cache[0].evaluation.disqualified).toBe(true);
    const invalid = structuredClone(state);
    invalid.cache[0].evaluation.validationDisqualified = true;
    expect(() => validateEngineState(invalid)).toThrow(/Disqualification/);
  });
});
