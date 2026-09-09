/** Search-health regression tests: evaluation deltas, summary mirrors, stall pauses
 * and tolerance for checkpoints written before the breeding-diversity metrics.
 * Real TCP, real worker lifecycles and real durable files, like the other suites.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startResearchServer } from "./index.js";
import { DEFAULT_RUN_CONFIG } from "../src/research/config";
import type {
  HistoryPoint,
  RunConfig,
  RunDetail,
  RunCheckpoint,
  RunList,
  RunSummary,
} from "../src/research/types";

type Server = Awaited<ReturnType<typeof startResearchServer>>;
const DEADLINE = 15_000;
const METRIC_KEYS = [
  "distinctElites",
  "bestCopies",
  "generationsSinceImprovement",
] as const;
const HISTORY_KEYS = [
  ...METRIC_KEYS,
  "generationEvaluations",
  "generationRepeats",
] as const;
const config = (patch: Partial<RunConfig> = {}): RunConfig => ({
  ...structuredClone(DEFAULT_RUN_CONFIG),
  initialization: "mutants",
  randomRuleBias: "uniform",
  name: "Search health fixture",
  size: 9,
  steps: 8,
  seed: "islands",
  trainingSeeds: [11, 29],
  validationSeeds: [101],
  populationSize: 8,
  eliteCount: 2,
  tournamentSize: 2,
  randomSeed: 49281,
  evaluationWorkers: 1,
  cacheSize: 32,
  checkpointSeconds: 2,
  snapshotEvery: 1,
  retainedSnapshots: 3,
  ...patch,
});
/**
 * Clone-based fixtures need per-locus mutation: the heavy-tailed policy always
 * changes at least one locus. An absent policy already means independent.
 */
function independentMutation(cfg: RunConfig): RunConfig {
  if (cfg.mutationPolicy === undefined) return cfg;
  const { mutationBeta: _beta, ...rest } = cfg;
  return { ...rest, mutationPolicy: "independent" };
}
/** Clones of one founder never improve, so generationsSinceImprovement equals generation. */
const stagnant = (patch: Partial<RunConfig> = {}): RunConfig =>
  independentMutation(
    config({
      seedGenome: Array(45).fill(0),
      mutationRate: 0,
      immigrantRate: 0,
      crossover: "none",
      maxGenerations: 0,
      ...patch,
    }),
  );
async function response(server: Server, path: string, input?: unknown) {
  return fetch(`http://127.0.0.1:${server.port}/api/${path}`, {
    signal: AbortSignal.timeout(DEADLINE),
    ...(input === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        }),
  });
}
async function api<T = RunDetail>(
  server: Server,
  path: string,
  input?: unknown,
): Promise<T> {
  const result = await response(server, path, input);
  const value = await result.json();
  assert.ok(
    result.ok,
    `${path}: HTTP ${result.status}: ${JSON.stringify(value)}`,
  );
  return value as T;
}
const action = (server: Server, id: string, action: string) =>
  api(server, `runs/${id}/actions`, { action });
const checkpoint = (server: Server, id: string) =>
  api<RunCheckpoint>(server, `runs/${id}/checkpoint`);
async function until(
  server: Server,
  id: string,
  check: (detail: RunDetail) => boolean,
  label = "run transition",
): Promise<RunDetail> {
  const end = Date.now() + DEADLINE;
  let last: RunDetail | undefined;
  do {
    last = await api<RunDetail>(server, `runs/${id}`);
    assert.notEqual(
      last.summary.status,
      "failed",
      `${label}: ${last.summary.error}`,
    );
    if (check(last)) return last;
    await delay(20);
  } while (Date.now() < end);
  assert.fail(`${label} timed out: ${JSON.stringify(last?.summary)}`);
}
async function step(server: Server, id: string): Promise<RunDetail> {
  const before = await api(server, `runs/${id}`);
  await action(server, id, "step");
  return until(
    server,
    id,
    (run) =>
      run.summary.status === "paused" &&
      run.summary.generation === before.summary.generation + 1,
    "one complete generation",
  );
}
async function fixture(
  run: (
    f: { server: Server; dir: string; restart: () => Promise<Server> },
  ) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), "polyp-search-health-"));
  const options = { port: 0, host: "127.0.0.1", dataDir: dir };
  let server = await startResearchServer(options);
  try {
    await run({
      get server() {
        return server;
      },
      dir,
      restart: async () => {
        await server.close();
        server = await startResearchServer(options);
        return server;
      },
    });
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
}
const strip = (value: object, keys: readonly string[]) => {
  for (const key of keys) delete (value as Record<string, unknown>)[key];
  return value;
};
/** Legacy shape: history, archives and summary as an older server wrote them. */
function asLegacyHistory(history: HistoryPoint[]): HistoryPoint[] {
  return history.map(
    (point) => strip(structuredClone(point), HISTORY_KEYS) as HistoryPoint,
  );
}
const fixtureCount = (cfg: RunConfig) =>
  cfg.trainingSeeds.length + cfg.validationSeeds.length;

test(
  "history points carry per-generation evaluation deltas whose sums reproduce the engine counters",
  { timeout: 30_000 },
  async () => {
    await fixture(async (f) => {
      // Sparse per-locus mutation leaves a fair share of children unchanged, so
      // the run mixes fresh evaluations with cache repeats every generation.
      const cfg = independentMutation(
        config({
          boundaryPolicy: { spatial: false, horizon: false },
          maxGenerations: 6,
          mutationRate: 0.03,
          immigrantRate: 0,
          crossover: "none",
        }),
      );
      const run = await api(f.server, "runs", { config: cfg, start: true });
      const done = await until(
        f.server,
        run.summary.id,
        (detail) => detail.summary.status === "completed",
        "six complete generations",
      );
      const cp = await checkpoint(f.server, run.summary.id);
      assert.ok(cp.state);
      assert.equal(done.history.length, 7);
      assert.equal(done.history[0].generation, 0);
      const fixtures = fixtureCount(cfg);
      let evaluations = 0,
        repeats = 0;
      for (const [index, point] of done.history.entries()) {
        const previous = index ? done.history[index - 1] : null;
        assert.ok(Number.isSafeInteger(point.generationEvaluations));
        assert.ok(Number.isSafeInteger(point.generationRepeats));
        assert.ok(point.generationEvaluations! >= 0);
        assert.ok(point.generationRepeats! >= 0);
        assert.equal(
          point.generationEvaluations,
          (point.evaluations - (previous?.evaluations ?? 0)) / fixtures,
          `generation ${point.generation} unique evaluations`,
        );
        assert.equal(
          point.generationRepeats,
          point.cacheHits - (previous?.cacheHits ?? 0),
          `generation ${point.generation} repeats`,
        );
        // Every bred candidate is either scored or a repeat of a known genome.
        assert.equal(
          point.generationEvaluations! + point.generationRepeats!,
          index ? cfg.populationSize - cfg.eliteCount : cfg.populationSize,
          `generation ${point.generation} candidate count`,
        );
        evaluations += point.generationEvaluations!;
        repeats += point.generationRepeats!;
      }
      assert.equal(
        evaluations * fixtures,
        cp.state.evaluations,
        "complete history sums to the engine evaluation counter",
      );
      assert.equal(repeats, cp.state.cacheHits);
      assert.ok(repeats > 0, "fixture exercises the fitness cache");
      const csv = await response(f.server, `runs/${run.summary.id}/metrics.csv`);
      const rows = (await csv.text()).trim().split("\n");
      const header = rows[0].split(",");
      for (const key of HISTORY_KEYS) assert.ok(header.includes(key), key);
      const first = Object.fromEntries(
        header.map((key, i) => [key, rows[1].split(",")[i]]),
      );
      assert.equal(
        first.generationEvaluations,
        String(done.history[0].generationEvaluations),
      );
      assert.equal(
        first.generationRepeats,
        String(done.history[0].generationRepeats),
      );
      const imported = await api(f.server, "runs/import", { checkpoint: cp });
      assert.deepEqual(
        (await api(f.server, `runs/${imported.summary.id}`)).history,
        done.history,
        "deltas validate and survive export/import unchanged",
      );
      await f.restart();
      assert.deepEqual(
        (await api(f.server, `runs/${run.summary.id}`)).history,
        done.history,
        "deltas persist on disk",
      );
    });
  },
);

test(
  "checkpoints and on-disk archives written before search-health metrics still load; present values are checked",
  { timeout: 30_000 },
  async () => {
    await fixture(async (f) => {
      const cfg = config();
      const run = await api(f.server, "runs", { config: cfg });
      for (let generation = 0; generation <= 2; generation++)
        await step(f.server, run.summary.id);
      const cp = await checkpoint(f.server, run.summary.id);
      assert.ok(cp.state);
      for (const key of HISTORY_KEYS)
        assert.ok(Object.hasOwn(cp.history.at(-1)!, key), key);
      const legacy: RunCheckpoint = {
        ...structuredClone(cp),
        history: asLegacyHistory(cp.history),
      };
      const imported = await api(f.server, "runs/import", {
        checkpoint: legacy,
      });
      const detail = await api(f.server, `runs/${imported.summary.id}`);
      assert.deepEqual(
        detail.history,
        legacy.history,
        "older history is retained as written, not fabricated",
      );
      assert.deepEqual(
        (await checkpoint(f.server, imported.summary.id)).state,
        cp.state,
      );
      // Snapshot metrics and summary mirrors are recomputed from the population.
      for (const key of METRIC_KEYS)
        assert.equal(detail.snapshot!.metrics[key], cp.history.at(-1)![key]);
      assert.equal(detail.summary.generationsSinceImprovement, 2);
      assert.equal(
        detail.summary.distinctElites,
        detail.snapshot!.metrics.distinctElites,
      );
      const continued = await step(f.server, imported.summary.id);
      const latest = continued.history.at(-1)!;
      assert.equal(latest.generation, 3);
      for (const key of HISTORY_KEYS) assert.ok(Object.hasOwn(latest, key), key);
      assert.equal(
        latest.generationEvaluations! + latest.generationRepeats!,
        cfg.populationSize - cfg.eliteCount,
      );
      assert.ok(
        !Object.hasOwn(continued.history.at(-2)!, "generationRepeats"),
        "older points stay unmodified after new generations",
      );
      // Present values are still validated exactly.
      const invalid: [string, (last: Record<string, unknown>) => void][] = [
        ["negative delta", (last) => (last.generationEvaluations = -1)],
        ["fractional repeats", (last) => (last.generationRepeats = 1.5)],
        ["string elites", (last) => (last.distinctElites = "2")],
        [
          "wrong distinct elites",
          (last) => (last.distinctElites = (last.distinctElites as number) + 1),
        ],
        [
          "wrong stall counter",
          (last) => (last.generationsSinceImprovement = 7),
        ],
      ];
      for (const [label, mutate] of invalid) {
        const broken = structuredClone(cp);
        mutate(broken.history.at(-1) as unknown as Record<string, unknown>);
        const result = await response(f.server, "runs/import", {
          checkpoint: broken,
        });
        assert.equal(result.status, 400, `${label}: ${await result.text()}`);
      }
      // A durable envelope from an older server: history, archives and summary
      // all lack the new keys.
      await f.server.close();
      const file = join(f.dir, `${run.summary.id}.json`);
      const stored = JSON.parse(await readFile(file, "utf8"));
      stored.checkpoint.history = asLegacyHistory(stored.checkpoint.history);
      for (const archive of stored.archives)
        strip(archive.snapshot.metrics, METRIC_KEYS);
      strip(stored.summary, ["generationsSinceImprovement", "distinctElites"]);
      assert.ok(stored.archives.length >= 2);
      await writeFile(file, JSON.stringify(stored));
      await f.restart();
      const health = await api<{ recoveryErrors: string[] }>(f.server, "health");
      assert.deepEqual(
        health.recoveryErrors,
        [],
        "legacy primary loads directly, not through backup recovery",
      );
      const loaded = await api(f.server, `runs/${run.summary.id}`);
      assert.deepEqual(loaded.history, stored.checkpoint.history);
      assert.equal(loaded.summary.generationsSinceImprovement, 2);
      assert.equal(
        loaded.summary.distinctElites,
        loaded.snapshot!.metrics.distinctElites,
      );
      const archived = await api<{ metrics: Record<string, unknown> }>(
        f.server,
        `runs/${run.summary.id}/generations/0`,
      );
      for (const key of METRIC_KEYS)
        assert.ok(
          Number.isSafeInteger(archived.metrics[key]),
          `archive backfills ${key}`,
        );
      await action(f.server, run.summary.id, "checkpoint");
      const rewritten = JSON.parse(await readFile(file, "utf8"));
      assert.equal(rewritten.storageVersion, 1);
      assert.equal(rewritten.summary.generationsSinceImprovement, 2);
      assert.ok(Number.isSafeInteger(rewritten.summary.distinctElites));
    });
  },
);

test(
  "summaries mirror the latest search-health metrics only once a population exists",
  { timeout: 20_000 },
  async () => {
    await fixture(async (f) => {
      const created = await api(f.server, "runs", { config: config() });
      const absent = (summary: RunSummary) =>
        !Object.hasOwn(summary, "generationsSinceImprovement") &&
        !Object.hasOwn(summary, "distinctElites");
      assert.ok(absent(created.summary), "no state, no mirrors");
      const listed = (await api<RunList>(f.server, "runs")).runs.find(
        (run) => run.id === created.summary.id,
      )!;
      assert.ok(absent(listed));
      const initialized = await step(f.server, created.summary.id);
      assert.equal(initialized.summary.generationsSinceImprovement, 0);
      assert.equal(
        initialized.summary.distinctElites,
        initialized.snapshot!.metrics.distinctElites,
      );
      assert.ok(initialized.summary.distinctElites! >= 1);
      const advanced = await step(f.server, created.summary.id);
      assert.equal(
        advanced.summary.generationsSinceImprovement,
        advanced.snapshot!.metrics.generationsSinceImprovement,
      );
      assert.equal(
        advanced.summary.generationsSinceImprovement,
        1 - advanced.snapshot!.champion.birthGeneration,
      );
      const fork = await api(f.server, `runs/${created.summary.id}/fork`, {});
      assert.equal(
        fork.summary.generationsSinceImprovement,
        advanced.summary.generationsSinceImprovement,
      );
      assert.equal(fork.summary.distinctElites, advanced.summary.distinctElites);
      const uninitialized = await api(f.server, "runs/import", {
        checkpoint: await checkpoint(
          f.server,
          (await api(f.server, "runs", { config: config() })).summary.id,
        ),
      });
      assert.ok(absent(uninitialized.summary));
      await f.restart();
      const list = await api<RunList>(f.server, "runs");
      assert.ok(absent(list.runs.find((run) => run.id === uninitialized.summary.id)!));
      const restored = list.runs.find((run) => run.id === created.summary.id)!;
      assert.equal(
        restored.generationsSinceImprovement,
        advanced.summary.generationsSinceImprovement,
      );
      assert.equal(restored.distinctElites, advanced.summary.distinctElites);
    });
  },
);

test(
  "a continuous run pauses at whole multiples of stallGenerations, resumes on start, and never stalls in step mode",
  { timeout: 40_000 },
  async () => {
    await fixture(async (f) => {
      const run = await api(f.server, "runs", {
        config: stagnant({ stallGenerations: 3 }),
        start: true,
      });
      const stalled = await until(
        f.server,
        run.summary.id,
        (detail) => detail.summary.status === "paused",
        "first stall pause",
      );
      assert.equal(stalled.summary.generation, 3, "exactly at the multiple");
      assert.equal(
        stalled.summary.stopReason,
        "Stalled: 3 generations without improvement.",
      );
      assert.equal(stalled.summary.generationsSinceImprovement, 3);
      assert.equal(stalled.summary.workerCount, 0);
      assert.equal(stalled.history.at(-1)!.generation, 3);
      const health = await api<{ workers: number; activeRuns: number }>(
        f.server,
        "health",
      );
      assert.deepEqual([health.workers, health.activeRuns], [0, 0]);
      const file = join(f.dir, `${run.summary.id}.json`);
      const persisted = JSON.parse(await readFile(file, "utf8"));
      assert.equal(persisted.summary.status, "paused");
      assert.equal(persisted.intent, null, "a stall is not resumable intent");
      assert.match(persisted.summary.stopReason, /^Stalled: 3 /);
      assert.equal(
        persisted.checkpoint.state.generation,
        3,
        "the generation that triggered the pause is committed and durable",
      );
      const resumed = await action(f.server, run.summary.id, "start");
      assert.equal(resumed.summary.stopReason, null);
      assert.ok(["queued", "starting", "running"].includes(resumed.summary.status));
      const again = await until(
        f.server,
        run.summary.id,
        (detail) =>
          detail.summary.status === "paused" && detail.summary.generation > 3,
        "second stall pause",
      );
      assert.equal(
        again.summary.generation,
        6,
        "resume does not re-pause until the next multiple",
      );
      assert.equal(
        again.summary.stopReason,
        "Stalled: 6 generations without improvement.",
      );
      assert.deepEqual(
        again.history.map((point) => point.generation),
        [0, 1, 2, 3, 4, 5, 6],
      );
      // A generation limit that coincides with a stall completes the run.
      const limited = await api(f.server, "runs", {
        config: stagnant({
          name: "Search health limit wins",
          stallGenerations: 2,
          maxGenerations: 4,
        }),
        start: true,
      });
      const firstStop = await until(
        f.server,
        limited.summary.id,
        (detail) => detail.summary.status === "paused",
      );
      assert.equal(firstStop.summary.generation, 2);
      await action(f.server, limited.summary.id, "start");
      const completed = await until(
        f.server,
        limited.summary.id,
        (detail) =>
          detail.summary.status === "completed" ||
          (detail.summary.status === "paused" && detail.summary.generation > 2),
      );
      assert.equal(completed.summary.status, "completed");
      assert.equal(completed.summary.generation, 4);
      assert.equal(completed.summary.stopReason, "Generation limit reached.");
      // Step mode pauses for its own reason even when every generation stalls.
      const stepped = await api(f.server, "runs", {
        config: stagnant({ name: "Search health steps", stallGenerations: 1 }),
      });
      for (let generation = 0; generation <= 2; generation++) {
        const detail = await step(f.server, stepped.summary.id);
        assert.equal(detail.summary.generation, generation);
        assert.equal(detail.summary.stopReason, "Single generation complete.");
      }
      // Zero (or omitted) means never: a stagnant run keeps going.
      const unlimited = await api(f.server, "runs", {
        config: stagnant({ name: "Search health no stall", stallGenerations: 0 }),
        start: true,
      });
      const running = await until(
        f.server,
        unlimited.summary.id,
        (detail) => detail.summary.generation >= 8,
        "stagnant research without a stall policy",
      );
      assert.equal(running.summary.status, "running");
      assert.equal(running.summary.generationsSinceImprovement, running.summary.generation);
      await action(f.server, unlimited.summary.id, "pause");
    });
  },
);
