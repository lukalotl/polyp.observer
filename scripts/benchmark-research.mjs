#!/usr/bin/env node
/** Reproducible local scalar benchmark; no server/worker pool/network in timed sections. */
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, cpus } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(join(tmpdir(), "polyp-research-bench-"));
try {
  const outfile = join(temporary, "subject.mjs");
  await build({
    stdin: {
      contents: `
    export { DEFAULT_RUN_CONFIG } from "./src/research/config.ts";
    export { MAX_GRID_SIZE, MAX_CA_STEPS, maxHorizon } from "./src/research/limits.ts";
    export { evaluateGenome } from "./src/research/evaluate.ts";
    export { initializePopulation, advanceGeneration, generationSnapshot } from "./src/research/engine.ts";
    export { simulate, fitness, mutate, PRESETS } from "./src/simulation/index.ts";
  `,
      resolveDir: root,
      loader: "ts",
    },
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  const {
    DEFAULT_RUN_CONFIG,
    MAX_GRID_SIZE,
    MAX_CA_STEPS,
    maxHorizon,
    evaluateGenome,
    simulate,
    fitness,
    mutate,
    PRESETS,
    initializePopulation,
    advanceGeneration,
    generationSnapshot,
  } = await import(pathToFileURL(outfile).href);
  const rounds = Number(process.env.BENCH_ROUNDS ?? 5);
  if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 20)
    throw new Error("BENCH_ROUNDS must be 1..20");
  const genomes = Array.from({ length: 64 }, (_, i) =>
    mutate(PRESETS[i % 3].genome, i % 4 === 0 ? 0.3 : 0.03, 1000 + i),
  );
  let sink = 0;
  const report = {
    node: process.version,
    cpu: cpus()[0]?.model,
    rounds,
    candidatesPerRound: genomes.length,
    methodology:
      "Single-thread, uncached whole genome evaluations (one fixture each). One warm-up sweep per method; alternate method order each timed round. Median wall-time throughput; speedup is workload/hardware-specific. Typed-array bounds are analytical live payload, not measured process RSS and exclude JS metadata/GC/worker overhead.",
    workloads: [],
  };
  for (const workload of [
    { label: "original-cross", size: 49, steps: 96, seed: "cross" },
    { label: "larger-islands", size: 97, steps: 192, seed: "islands" },
  ]) {
    const config = {
      ...structuredClone(DEFAULT_RUN_CONFIG),
      objective: "complexity",
      ...workload,
    };
    delete config.label;
    const methods = {
      legacyVolume: (genome) =>
        fitness(simulate(genome, config), config.objective),
      streamingSparseScalar: (genome) => evaluateGenome(genome, config).fitness,
    };
    for (const method of Object.values(methods))
      for (const genome of genomes) sink += method(genome);
    const times = { legacyVolume: [], streamingSparseScalar: [] };
    for (let round = 0; round < rounds; round++) {
      const names = Object.keys(methods);
      if (round % 2) names.reverse();
      for (const name of names) {
        global.gc?.();
        const start = performance.now();
        for (const genome of genomes) sink += methods[name](genome);
        times[name].push(performance.now() - start);
      }
    }
    const median = (values) =>
      values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const medianMs = Object.fromEntries(
      Object.entries(times).map(([name, values]) => [name, median(values)]),
    );
    const evaluationsPerSecond = Object.fromEntries(
      Object.entries(medianMs).map(([name, ms]) => [
        name,
        Number(((genomes.length * 1000) / ms).toFixed(2)),
      ]),
    );
    const halo = 2 * (config.size + 2) ** 2;
    report.workloads.push({
      ...workload,
      timesMs: times,
      evaluationsPerSecond,
      speedup: Number(
        (medianMs.legacyVolume / medianMs.streamingSparseScalar).toFixed(3),
      ),
      typedArrayLivePayloadBytes: {
        legacyVolume: halo + config.size ** 2 * config.steps,
        streamingSparseScalar: halo + 8 * config.steps,
      },
      legacyRetainedLayersBytes: config.size ** 2 * config.steps,
    });
  }
  // Keep the original benchmark comparable after increasing new-run defaults.
  const config = {
    ...structuredClone(DEFAULT_RUN_CONFIG),
    objective: "complexity",
    size: 49,
    steps: 96,
    populationSize: 64,
  };
  let state = await initializePopulation(config);
  const initialEvaluations = state.evaluations,
    start = performance.now();
  for (let i = 0; i < 10; i++) state = await advanceGeneration(state);
  const elapsedMs = performance.now() - start;
  report.retainedEngine = {
    generations: 10,
    elapsedMs,
    actualFixtureEvaluations: state.evaluations - initialEvaluations,
    fixtureEvaluationsPerSecond:
      ((state.evaluations - initialEvaluations) * 1000) / elapsedMs,
    finalMetrics: generationSnapshot(state).metrics,
    checkpointJSONBytes: Buffer.byteLength(JSON.stringify(state)),
  };
  report.maxAcceptedStreamingTypedArrayPayloadBytes = Math.max(
    ...Array.from({ length: (MAX_GRID_SIZE - 9) / 2 + 1 }, (_, i) => {
      const size = 9 + i * 2;
      return 2 * (size + 2) ** 2 + 8 * maxHorizon(size);
    }),
  );
  report.maxAcceptedStreamingConservativeBoundBytes =
    2 * (MAX_GRID_SIZE + 2) ** 2 + 8 * MAX_CA_STEPS;
  report.sink = sink;
  console.log(JSON.stringify(report, null, 2));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
