import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadExperiment,
  parseExperiment,
  STORAGE_KEY,
  type Experiment,
} from "./experiment";
import { PRESETS, simulate } from "./simulation";

const specimen = (): Experiment => ({
  version: 1,
  genome: [...PRESETS[1].genome],
  config: { size: 25, steps: 24, seed: "islands", randomSeed: 2024 },
  name: "A reproducible island study",
});

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("the versioned, reproducible specimen format", () => {
  it("round-trips a specimen and reproduces every simulation layer", () => {
    const original = specimen();
    const restored = parseExperiment(JSON.stringify(original));
    expect(restored).toEqual(original);
    expect(simulate(restored.genome, restored.config)).toEqual(
      simulate(original.genome, original.config),
    );
  });

  it.each(PRESETS)("accepts the $name starting rule", (preset) => {
    const value = {
      ...specimen(),
      genome: preset.genome,
      name: preset.name,
      config: { ...specimen().config, seed: preset.seed },
    };
    expect(parseExperiment(JSON.stringify(value))).toEqual(value);
  });

  it.each([25, 33, 41, 49])("accepts supported world size %i", (size) => {
    const value = specimen();
    value.config.size = size;
    expect(parseExperiment(JSON.stringify(value)).config.size).toBe(size);
  });

  it.each([24, 32, 48, 64])("accepts supported time depth %i", (steps) => {
    const value = specimen();
    value.config.steps = steps;
    expect(parseExperiment(JSON.stringify(value)).config.steps).toBe(steps);
  });

  it.each(["point", "cross", "islands"] as const)(
    "accepts the %s seed",
    (seed) => {
      const value = specimen();
      value.config.seed = seed;
      expect(parseExperiment(JSON.stringify(value)).config.seed).toBe(seed);
    },
  );

  it.each([
    ["malformed JSON", '{"version":'],
    ["null", "null"],
    ["a string", '"polyp"'],
    ["an array", "[]"],
    ["an empty object", "{}"],
  ])("rejects %s without returning an unsafe specimen", (_label, raw) => {
    expect(() => parseExperiment(raw)).toThrow();
  });

  it.each([
    ["unsupported version", { version: 2 }],
    ["missing version", { version: undefined }],
    ["short rule", { genome: Array(44).fill(0) }],
    ["long rule", { genome: Array(46).fill(0) }],
    ["non-quiescent void", { genome: [1, ...Array(44).fill(0)] }],
    ["negative state", { genome: [0, -1, ...Array(43).fill(0)] }],
    ["sixth state", { genome: [0, 5, ...Array(43).fill(0)] }],
    ["fractional state", { genome: [0, 1.5, ...Array(43).fill(0)] }],
    ["numeric string state", { genome: [0, "1", ...Array(43).fill(0)] }],
    ["null state", { genome: [0, null, ...Array(43).fill(0)] }],
    ["object instead of rule", { genome: { length: 45, 0: 0 } }],
    ["missing name", { name: undefined }],
    ["non-string name", { name: 17 }],
    ["oversize name", { name: "n".repeat(101) }],
    ["missing config", { config: undefined }],
  ])("rejects a specimen with %s", (_label, invalid) => {
    expect(() =>
      parseExperiment(JSON.stringify({ ...specimen(), ...invalid })),
    ).toThrow();
  });

  it.each([
    ["unsupported world size", { size: 27 }],
    ["unbounded world size", { size: 1_000_000 }],
    ["string world size", { size: "25" }],
    ["fractional world size", { size: 25.1 }],
    ["unsupported depth", { steps: 25 }],
    ["negative depth", { steps: -24 }],
    ["unbounded depth", { steps: 1_000_000 }],
    ["string depth", { steps: "24" }],
    ["unknown seed mode", { seed: "random" }],
    ["missing random seed", { randomSeed: undefined }],
    ["fractional random seed", { randomSeed: 0.5 }],
    ["unsafe random seed", { randomSeed: Number.MAX_SAFE_INTEGER + 1 }],
    ["null random seed", { randomSeed: null }],
  ])("rejects %s before the engine can allocate memory", (_label, invalid) => {
    const value = specimen();
    expect(() =>
      parseExperiment(
        JSON.stringify({ ...value, config: { ...value.config, ...invalid } }),
      ),
    ).toThrow();
  });

  it("allows a maximum-length name and renders data rather than interpreting markup", () => {
    const value = specimen();
    value.name = "<img src=x onerror=alert(1)>".padEnd(100, "x");
    expect(parseExperiment(JSON.stringify(value)).name).toBe(value.name);
  });
});

describe("optional browser persistence", () => {
  it("returns null when no specimen has been saved", () => {
    expect(loadExperiment()).toBeNull();
  });

  it("loads only the current versioned storage key", () => {
    const value = specimen();
    localStorage.setItem(
      "polyp.experiment.v0",
      JSON.stringify({ ...value, name: "Old study" }),
    );
    expect(loadExperiment()).toBeNull();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    expect(loadExperiment()).toEqual(value);
  });

  it.each([
    "not JSON",
    "{}",
    "null",
    JSON.stringify({ ...specimen(), version: 99 }),
  ])("recovers safely from corrupted persisted data: %s", (raw) => {
    localStorage.setItem(STORAGE_KEY, raw);
    expect(loadExperiment()).toBeNull();
  });

  it("does not make blocked storage fatal", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("Blocked", "SecurityError");
    });
    expect(loadExperiment()).toBeNull();
  });
});
