import { decodePreview } from "../src/research/preview";
import { expandPreviewLayer } from "../src/research/previewLayers";
/** Native integration contract: real worker_threads, TCP/WS and isolated durable files.
 * Run via npm run test:server (the test bundle imports the compiled server entry).
 * No browser, mocked evaluator, production data directory or fixed app port is used.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  readdir,
  stat,
} from "node:fs/promises";
import { tmpdir, availableParallelism } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as tcpServer } from "node:net";
import { request } from "node:http";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { startResearchServer } from "./index.js";
import { DEFAULT_RUN_CONFIG } from "../src/research/config";
import {
  initializePopulation,
  advanceGeneration,
} from "../src/research/engine";
import { evaluateGenome } from "../src/research/evaluate";
import { simulate, fitness, type Genome } from "../src/simulation";
import type {
  EngineState,
  RunConfig,
  RunDetail,
  RunCheckpoint,
  RunList,
  PreviewFrame,
  ResearchEvent,
} from "../src/research/types";

type Server = Awaited<ReturnType<typeof startResearchServer>>;
type Endpoint = { port: number };
const DEADLINE = 15_000;
const limits = { maxEvaluationWorkers: 2, maxRuns: 2, cpuBudget: 3 };
const tiny = (patch: Partial<RunConfig> = {}): RunConfig => ({
  ...structuredClone(DEFAULT_RUN_CONFIG),
  name: "Fixture native research",
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
const url = (server: Endpoint, path: string) =>
  `http://127.0.0.1:${server.port}/api/${path}`;
async function response(
  server: Endpoint,
  path: string,
  input?: unknown,
  headers: Record<string, string> = {},
) {
  return fetch(url(server, path), {
    signal: AbortSignal.timeout(DEADLINE),
    ...(input === undefined
      ? { headers }
      : {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify(input),
        }),
  });
}
async function api<T = RunDetail>(
  server: Endpoint,
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
const create = (server: Endpoint, config = tiny(), start = false) =>
  api(server, "runs", { config, start });
const action = (server: Endpoint, id: string, action: string) =>
  api(server, `runs/${id}/actions`, { action });
const checkpoint = (server: Endpoint, id: string) =>
  api<RunCheckpoint>(server, `runs/${id}/checkpoint`);
async function until(
  server: Endpoint,
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
    await delay(30);
  } while (Date.now() < end);
  assert.fail(`${label} timed out: ${JSON.stringify(last?.summary)}`);
}
async function step(server: Endpoint, id: string): Promise<RunDetail> {
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
  t: TestContext,
  options: Partial<Parameters<typeof startResearchServer>[0]> = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "polyp-research-native-"));
  let server: Server | undefined;
  t.after(async () => {
    try {
      await server?.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  const open = async () =>
    (server = await startResearchServer({
      port: 0,
      host: "127.0.0.1",
      dataDir: dir,
      apiUpstream: "",
      ...limits,
      ...options,
    }));
  await open();
  return {
    dir,
    get server() {
      return server!;
    },
    restart: async () => {
      await server!.close();
      server = undefined;
      return open();
    },
    stop: async () => {
      await server?.close();
      server = undefined;
    },
    open,
  };
}
function geneticState(state: EngineState): EngineState {
  // Worker topology and display name are the only deliberately different config fields.
  const copy = structuredClone(state);
  copy.config.evaluationWorkers = 1;
  copy.config.name = "Fixture normalized";
  return copy;
}
async function reference(config: RunConfig, generation: number) {
  let state = await initializePopulation(config);
  while (state.generation < generation) state = await advanceGeneration(state);
  return state;
}
async function socket(
  t: TestContext,
  server: Endpoint,
  origin = `http://127.0.0.1:${server.port}`,
) {
  const peer = new WebSocket(`ws://127.0.0.1:${server.port}/api/research/ws`, {
    origin,
  });
  const messages: ResearchEvent[] = [];
  peer.on("message", (data) => messages.push(JSON.parse(data.toString())));
  t.after(() => {
    peer.terminate();
  });
  await new Promise<void>((resolve, reject) => {
    peer.once("open", resolve);
    peer.once("error", reject);
  });
  return {
    peer,
    messages,
    wait: async (check: (event: ResearchEvent) => boolean) => {
      const end = Date.now() + DEADLINE;
      do {
        const event = messages.find(check);
        if (event) return event;
        await delay(20);
      } while (Date.now() < end);
      assert.fail(
        `WebSocket publication timed out; received ${messages.map((message) => message.type).join(",")}`,
      );
    },
  };
}

test("production and preview frontend origins can control and observe the VM without allowing lookalike sites", async (t) => {
  const origins = ["https://polyp.observer", "https://polyp-preview.vercel.app"];
  const f = await fixture(t, { publicOrigins: origins });
  for (const origin of origins) {
    const result = await response(f.server, "runs", { config: tiny() }, { Origin: origin });
    assert.equal(result.status, 201);
    const observer = await socket(t, f.server, origin);
    await observer.wait((event) => event.type === "hello");
    observer.peer.close();
  }
  for (const origin of ["https://polyp.observer.attacker.invalid", "http://polyp.observer", "https://other-preview.vercel.app"]) {
    assert.equal((await response(f.server, "runs", { config: tiny() }, { Origin: origin })).status, 403);
    const status = await new Promise<number>((resolve, reject) => {
      const peer = new WebSocket(`ws://127.0.0.1:${f.server.port}/api/research/ws`, { origin });
      peer.once("unexpected-response", (_request, result) => {
        result.resume();
        resolve(result.statusCode!);
        peer.terminate();
      });
      peer.once("open", () => {
        peer.terminate();
        reject(new Error("Untrusted frontend opened a subscription"));
      });
      peer.on("error", () => {});
    });
    assert.equal(status, 403);
  }
  assert.equal((await api<RunList>(f.server, "runs")).runs.length, 2);
});

// This oracle retains the complete CA space-time volume, unlike worker evaluation.
function oracleMetrics(genome: Genome, config: RunConfig, seed: number) {
  const result = simulate(genome, {
    size: config.size,
    steps: config.steps,
    seed: config.seed,
    randomSeed: seed,
  });
  const clamp = (n: number) => Math.max(0, Math.min(1, n));
  const mean = result.occupancy * config.size * config.size;
  const variance =
    result.population.reduce((sum, count) => sum + (count - mean) ** 2, 0) /
    config.steps;
  return {
    score: fitness(result, config.objective),
    metrics: {
      diversity: result.diversity,
      activity: clamp(result.activity / Math.max(result.occupancy, 0.01)),
      density:
        clamp(result.occupancy / 0.1) *
        clamp(1 - Math.max(0, result.occupancy - 0.25) / 0.55),
      variation: clamp(Math.sqrt(variance) / Math.max(1, mean)),
      persistence: result.lifetime / config.steps,
      occupancy: result.occupancy,
      lifetime: result.lifetime,
      extinctFraction: result.extinct ? 1 : 0,
    },
  };
}

test(
  "actual evaluator workers 1 and 2 retain identical population, RNG, ancestry, cache and next checkpoint",
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    const config = tiny({
      maxGenerations: 6,
      mutationRate: 0.03,
      immigrantRate: 0.25,
      crossoverRate: 1,
    });
    const first = await create(f.server, config, true);
    const second = await create(
      f.server,
      { ...config, evaluationWorkers: 2 },
      true,
    );
    assert.notEqual(first.summary.id, second.summary.id);
    const one = await until(
      f.server,
      first.summary.id,
      (run) => run.summary.status === "completed",
    );
    const two = await until(
      f.server,
      second.summary.id,
      (run) => run.summary.status === "completed",
    );
    assert.equal(one.summary.generation, 6);
    assert.equal(two.summary.generation, 6);
    const cp1 = await checkpoint(f.server, first.summary.id),
      cp2 = await checkpoint(f.server, second.summary.id);
    assert.ok(cp1.state);
    assert.ok(cp2.state);
    assert.deepEqual(geneticState(cp1.state), geneticState(cp2.state));
    assert.deepEqual(
      cp1.state,
      await reference(config, 6),
      "native thread results equal the inline deterministic engine",
    );
    assert.equal(cp1.state.population.length, config.populationSize);
    assert.ok(cp1.state.cache.length > 0);
    assert.ok(cp1.state.cacheHits > 0);
    assert.ok(
      cp1.state.population.some((individual) => individual.parents.length > 0),
    );
    for (const individual of cp1.state.population) {
      assert.deepEqual(evaluateGenome(individual.genome, config), {
        fitness: individual.fitness,
        validationFitness: individual.validationFitness,
        trainingScores: individual.trainingScores,
        validationScores: individual.validationScores,
        metrics: individual.metrics,
      });
      const training = config.trainingSeeds.map((seed) =>
        oracleMetrics(individual.genome, config, seed),
      );
      assert.equal(individual.trainingScores.length, training.length);
      individual.trainingScores.forEach((score, index) =>
        assert.ok(
          Math.abs(score - training[index].score) < 1e-12,
          "worker fitness equals full-volume CA oracle",
        ),
      );
      for (const key of Object.keys(
        individual.metrics,
      ) as (keyof typeof individual.metrics)[])
        assert.ok(
          Math.abs(
            individual.metrics[key] -
              training.reduce((sum, result) => sum + result.metrics[key], 0) /
                training.length,
          ) < 1e-12,
          key,
        );
      assert.equal(
        individual.validationScores.length,
        config.validationSeeds.length,
      );
      individual.validationScores.forEach((score, index) =>
        assert.ok(
          Math.abs(
            score -
              oracleMetrics(
                individual.genome,
                config,
                config.validationSeeds[index],
              ).score,
          ) < 1e-12,
        ),
      );
    }
    assert.equal(one.summary.workerCount, 0);
    assert.equal(
      (await api<RunList>(f.server, "runs")).capacity.allocatedWorkers,
      0,
    );
  },
);

test(
  "zero observers and closed TCP WebSocket never stop unbounded research; explicit pause releases every worker",
  { timeout: 25_000 },
  async (t) => {
    const f = await fixture(t);
    const run = await create(f.server, tiny({ maxGenerations: 0 }), true);
    const independent = await until(
      f.server,
      run.summary.id,
      (detail) => detail.summary.generation >= 10,
      "headless research",
    );
    assert.equal(independent.summary.status, "running");
    const observer = await socket(t, f.server);
    observer.peer.send(
      JSON.stringify({ type: "subscribe", runId: run.summary.id }),
    );
    await observer.wait(
      (event) => event.type === "run" && event.runId === run.summary.id,
    );
    // WebSocket is observer-only, even if somebody sends a plausible control message.
    observer.peer.send(
      JSON.stringify({ type: "pause", runId: run.summary.id }),
    );
    await observer.wait((event) => event.type === "error");
    const closing = new Promise<void>((resolve) =>
      observer.peer.once("close", () => resolve()),
    );
    observer.peer.close();
    await closing;
    const before = await api(f.server, `runs/${run.summary.id}`);
    await until(
      f.server,
      run.summary.id,
      (detail) => detail.summary.generation > before.summary.generation + 5,
      "progress after last socket closes",
    );
    const paused = await action(f.server, run.summary.id, "pause");
    assert.equal(paused.summary.status, "paused");
    assert.equal(paused.summary.workerCount, 0);
    const cp = await checkpoint(f.server, run.summary.id);
    const path = join(f.dir, `${run.summary.id}.json`),
      bytes = await readFile(path, "utf8");
    await delay(120);
    assert.deepEqual(
      await checkpoint(f.server, run.summary.id),
      cp,
      "no in-flight generation can publish after pause returns",
    );
    assert.equal(
      await readFile(path, "utf8"),
      bytes,
      "no late worker can rewrite the paused checkpoint",
    );
    const health = await api<{
      workers: number;
      evaluationWorkers: number;
      activeRuns: number;
    }>(f.server, "health");
    assert.deepEqual(
      [health.workers, health.evaluationWorkers, health.activeRuns],
      [0, 0, 0],
    );
  },
);

test(
  "pausing an in-flight generation rolls back partial work and resumes exactly from the last complete RNG state",
  { timeout: 45_000 },
  async (t) => {
    const f = await fixture(t);
    const config = tiny({
      size: 65,
      steps: 256,
      seedGenome: Array.from({ length: 45 }, (_, gene) => (gene ? 1 : 0)),
      mutationRate: 0.15,
      cacheSize: 0,
    });
    const run = await create(f.server, config);
    assert.equal(run.summary.generation, -1);
    assert.equal(run.snapshot, null);
    await action(f.server, run.summary.id, "start");
    await until(
      f.server,
      run.summary.id,
      (detail) => detail.summary.status === "running",
      "coordinator ready before full evaluation",
    );
    const cancelled = await action(f.server, run.summary.id, "pause");
    assert.equal(
      cancelled.summary.generation,
      -1,
      "partial initialization is not a retained population",
    );
    assert.equal((await checkpoint(f.server, run.summary.id)).state, null);
    const initialized = await step(f.server, run.summary.id);
    assert.equal(initialized.summary.generation, 0);
    const complete = await checkpoint(f.server, run.summary.id);
    assert.ok(complete.state);
    await action(f.server, run.summary.id, "start");
    await until(
      f.server,
      run.summary.id,
      (detail) => detail.summary.status === "running",
    );
    const cancelledNext = await action(f.server, run.summary.id, "pause");
    assert.equal(
      cancelledNext.summary.generation,
      0,
      "partially scored offspring never replace the complete generation",
    );
    assert.deepEqual(
      (await checkpoint(f.server, run.summary.id)).state,
      complete.state,
    );
    await f.restart();
    assert.equal(
      (await api(f.server, `runs/${run.summary.id}`)).summary.status,
      "paused",
    );
    await step(f.server, run.summary.id);
    const resumed = await checkpoint(f.server, run.summary.id);
    assert.deepEqual(
      resumed.state,
      await advanceGeneration(complete.state),
      "checkpoint restart replays offspring, evaluations, cache and RNG exactly",
    );
  },
);

test(
  "FIFO admission cannot bypass a larger queued job, and global CPU reservations include coordinators",
  { timeout: 25_000 },
  async (t) => {
    const f = await fixture(t, {
      maxRuns: 3,
      maxEvaluationWorkers: 2,
      cpuBudget: 3,
    });
    const first = await create(
      f.server,
      tiny({ name: "Fixture FIFO first" }),
      true,
    );
    const second = await create(
      f.server,
      tiny({ name: "Fixture FIFO second", evaluationWorkers: 2 }),
      true,
    );
    const third = await create(
      f.server,
      tiny({ name: "Fixture FIFO third" }),
      true,
    );
    assert.equal(second.summary.status, "queued");
    assert.equal(second.summary.queuePosition, 1);
    assert.equal(third.summary.status, "queued");
    assert.equal(third.summary.queuePosition, 2);
    await until(
      f.server,
      first.summary.id,
      (detail) => detail.summary.generation >= 1,
    );
    const health = await api<{
      workers: number;
      evaluationWorkers: number;
      cpuBudget: number;
      activeRuns: number;
      queuedRuns: number;
    }>(f.server, "health");
    assert.deepEqual(
      [
        health.workers,
        health.evaluationWorkers,
        health.activeRuns,
        health.queuedRuns,
      ],
      [2, 1, 1, 2],
    );
    assert.ok(health.workers <= health.cpuBudget);
    const active = (await api<RunList>(f.server, "runs")).runs.find(
      (run) => run.id === first.summary.id,
    )!;
    assert.equal(
      active.workerCount,
      2,
      "summary includes one coordinator plus one evaluator",
    );
    await action(f.server, first.summary.id, "pause");
    const admitted = await until(
      f.server,
      second.summary.id,
      (detail) => detail.summary.generation >= 1,
    );
    assert.equal(admitted.summary.workerCount, 3);
    const list = await api<RunList>(f.server, "runs");
    assert.equal(
      list.capacity.allocatedWorkers,
      2,
      "capacity counts evaluators only",
    );
    assert.equal(
      list.runs.find((run) => run.id === third.summary.id)!.status,
      "queued",
    );
    assert.equal(
      list.runs.find((run) => run.id === third.summary.id)!.queuePosition,
      1,
    );
    await action(f.server, second.summary.id, "pause");
    await until(
      f.server,
      third.summary.id,
      (detail) => detail.summary.generation >= 1,
    );
  },
);

test(
  "config changes require new identity; fork and raw export/import preserve the full state without changing source",
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    const original = tiny();
    const run = await create(f.server, original);
    await step(f.server, run.summary.id);
    await step(f.server, run.summary.id);
    const source = await checkpoint(f.server, run.summary.id);
    assert.ok(source.state);
    original.seedGenome[1] = (original.seedGenome[1] + 1) % 5;
    original.randomSeed++;
    assert.deepEqual(
      (await api(f.server, `runs/${run.summary.id}`)).config,
      source.config,
    );
    const changed = await create(f.server, original);
    assert.notEqual(changed.summary.id, run.summary.id);
    const forbidden = await fetch(url(f.server, `runs/${run.summary.id}`), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: original }),
    });
    assert.equal(forbidden.status, 405);
    const fork = await api(f.server, `runs/${run.summary.id}/fork`, {
      name: "Fixture full-state fork",
    });
    const exported = await response(
      f.server,
      `runs/${run.summary.id}/checkpoint`,
    );
    assert.match(
      exported.headers.get("Content-Disposition") ?? "",
      /attachment/,
    );
    const raw = await exported.text();
    const imported = await api(f.server, "runs/import", {
      checkpoint: JSON.parse(raw),
    });
    assert.equal(
      new Set([run.summary.id, fork.summary.id, imported.summary.id]).size,
      3,
    );
    for (const copy of [fork, imported]) {
      assert.equal(copy.summary.parentRunId, run.summary.id);
      assert.equal(copy.summary.status, "paused");
      const cp = await checkpoint(f.server, copy.summary.id);
      assert.ok(cp.state);
      assert.deepEqual(geneticState(cp.state), geneticState(source.state));
      assert.deepEqual(cp.history, source.history);
      assert.deepEqual(cp.improvements, source.improvements);
      assert.equal(cp.elapsedMs, source.elapsedMs);
      await step(f.server, copy.summary.id);
      assert.deepEqual(
        geneticState((await checkpoint(f.server, copy.summary.id)).state!),
        geneticState(await advanceGeneration(source.state)),
      );
    }
    assert.deepEqual(
      await checkpoint(f.server, run.summary.id),
      source,
      "fork breeding cannot mutate the source population/config/cache",
    );
    await f.restart();
    assert.deepEqual(
      await checkpoint(f.server, run.summary.id),
      source,
      "raw population and RNG survive disk serialization",
    );
  },
);

test(
  "finite limits stop at the named generation; every-generation archives and CSV survive restart",
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    // The 4096-point boundary is exercised in determinism.test.ts; here every complete generation is archived.
    const config = tiny({
      maxGenerations: 8,
      trainingSeeds: [11],
      validationSeeds: [],
      seedGenome: Array(45).fill(0),
      mutationRate: 0,
      immigrantRate: 0,
      crossover: "none",
      initialization: "mutants",
      retainedSnapshots: 2,
      cacheSize: 8,
    });
    const run = await create(f.server, config, true);
    const done = await until(
      f.server,
      run.summary.id,
      (detail) => detail.summary.status === "completed",
      "finite complete generations",
    );
    assert.equal(done.summary.generation, config.maxGenerations);
    assert.equal(done.summary.workerCount, 0);
    assert.match(done.summary.stopReason ?? "", /limit/i);
    assert.equal(done.history.length, 9);
    assert.equal(done.history[0].generation, 0);
    assert.equal(done.history.at(-1)!.generation, 8);
    assert.ok(done.improvements.length <= 256);
    assert.deepEqual(
      done.snapshots.map((snapshot) => snapshot.generation),
      [7, 8],
    );
    const archived = await api<{ generation: number; population: unknown[] }>(
      f.server,
      `runs/${run.summary.id}/generations/7`,
    );
    assert.equal(archived.generation, 7);
    assert.equal(archived.population.length, 8);
    assert.equal(
      (await response(f.server, `runs/${run.summary.id}/generations/0`)).status,
      404,
    );
    const csv = await response(f.server, `runs/${run.summary.id}/metrics.csv`);
    assert.match(csv.headers.get("Content-Type") ?? "", /^text\/csv/);
    assert.equal(csv.headers.get("X-History-Limit"), "4096");
    assert.equal(csv.headers.get("X-History-First-Generation"), "0");
    assert.equal(csv.headers.get("X-History-Last-Generation"), "8");
    const rows = (await csv.text()).trim().split("\n");
    assert.equal(rows.length, 10);
    assert.match(rows[0], /generation,best,mean/);
    assert.equal(
      (await action(f.server, run.summary.id, "start")).summary.generation,
      8,
    );
    assert.equal(
      (
        await response(f.server, `runs/${run.summary.id}/actions`, {
          action: "step",
        })
      ).status,
      409,
    );
    const cp = await checkpoint(f.server, run.summary.id);
    assert.ok(
      Buffer.byteLength(JSON.stringify(cp)) < 4 * 1024 * 1024,
      "retained checkpoint remains bounded, independent of total generations",
    );
    await f.restart();
    const loaded = await api(f.server, `runs/${run.summary.id}`);
    assert.deepEqual(loaded.history, done.history);
    assert.deepEqual(loaded.snapshots, done.snapshots);
    assert.equal(loaded.summary.status, "completed");
  },
);

test(
  "explicit checkpoint is durable; corrupt primary recovers backup and corrupt pairs are safely quarantined",
  { timeout: 25_000 },
  async (t) => {
    const f = await fixture(t);
    const run = await create(f.server);
    await step(f.server, run.summary.id);
    await action(f.server, run.summary.id, "checkpoint");
    const cp = await checkpoint(f.server, run.summary.id);
    const file = join(f.dir, `${run.summary.id}.json`);
    const stored = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(stored.checkpoint, cp);
    assert.ok((await stat(`${file}.bak`)).isFile());
    assert.ok(
      !(await readdir(f.dir)).some((name) => name.endsWith(".tmp")),
      "atomic writes leave no temporary checkpoint",
    );
    await f.stop();
    await writeFile(file, "{interrupted atomic checkpoint");
    await f.open();
    assert.deepEqual(
      (await checkpoint(f.server, run.summary.id)).state,
      cp.state,
    );
    const health = await api<{ recoveryErrors: string[]; workers: number }>(
      f.server,
      "health",
    );
    assert.ok(
      health.recoveryErrors.some((error) =>
        /recovered valid backup/.test(error),
      ),
    );
    assert.equal(health.workers, 0);
    await action(f.server, run.summary.id, "checkpoint");
    const recovered = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(recovered.checkpoint.state, cp.state);
    await f.stop();
    await writeFile(file, "{");
    await writeFile(`${file}.bak`, "null");
    await f.open();
    assert.equal((await api<RunList>(f.server, "runs")).runs.length, 0);
    assert.ok(
      (
        await api<{ recoveryErrors: string[] }>(f.server, "health")
      ).recoveryErrors.some((error) => /skipped invalid/.test(error)),
    );
    assert.equal(
      (await response(f.server, `runs/${run.summary.id}`)).status,
      404,
    );
  },
);

test(
  "preview uses an independent worker and true full-grid CA timesteps/metrics while training and health continue",
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    const previewConfig = tiny({ size: 49, steps: 259, seed: "islands" });
    const previewRun = await create(f.server, previewConfig);
    const training = await create(
      f.server,
      tiny({ evaluationWorkers: 2 }),
      true,
    );
    const before = await until(
      f.server,
      training.summary.id,
      (detail) => detail.summary.generation >= 1,
    );
    const genome = previewConfig.seedGenome,
      seed = 919;
    const started = performance.now();
    const pending = api<PreviewFrame>(
      f.server,
      `runs/${previewRun.summary.id}/preview`,
      { genome, seed },
    );
    const health = await api<{
      execution: string;
      workers: number;
      activeRuns: number;
      evaluationWorkers: number;
    }>(f.server, "health");
    assert.equal(health.execution, "node:worker_threads");
    assert.equal(health.activeRuns, 1);
    assert.equal(health.evaluationWorkers, 2);
    assert.ok(
      performance.now() - started < 5000,
      "health is responsive, not blocked behind CA computation",
    );
    const frame = await pending;
    const actual = simulate(genome, {
      size: previewConfig.size,
      steps: previewConfig.steps,
      seed: previewConfig.seed,
      randomSeed: seed,
    });
    assert.equal(frame.totalSteps, previewConfig.steps);
    assert.equal(frame.simulation.size, previewConfig.size);
    assert.equal(frame.layerTimes[0], 0);
    assert.equal(frame.layerTimes.at(-1), previewConfig.steps - 1);
    assert.equal(frame.stride, 1);
    assert.equal(frame.layerTimes.length, previewConfig.steps);
    assert.equal(frame.simulation.layers.length, frame.layerTimes.length);
    const decoded = decodePreview(frame);
    for (const [index, time] of frame.layerTimes.entries()) {
      assert.ok(index === 0 || time > frame.layerTimes[index - 1]);
      assert.deepEqual(
        Buffer.from(
          expandPreviewLayer(decoded.layers[index], previewConfig.size),
        ),
        Buffer.from(actual.layers[time]),
        `full spatial layer t=${time}`,
      );
    }
    const { layers: _layers, ...metrics } = actual;
    const { layers: _encoded, ...previewMetrics } = frame.simulation;
    assert.deepEqual(
      previewMetrics,
      metrics,
      "population, activity, diversity, occupancy, lifetime and extinction cover unsampled full horizon",
    );
    const after = await until(
      f.server,
      training.summary.id,
      (detail) => detail.summary.generation > before.summary.generation,
    );
    assert.equal(after.summary.workerCount, 3);
    assert.equal(
      (await api<{ workers: number }>(f.server, "health")).workers,
      4,
      "preview is independent of the training coordinator/evaluators",
    );
    assert.deepEqual(
      await api<PreviewFrame>(
        f.server,
        `runs/${previewRun.summary.id}/preview`,
        { genome, seed },
      ),
      frame,
      "cached preview has identical real timesteps",
    );
    assert.equal(
      (await api(f.server, `runs/${previewRun.summary.id}`)).summary.generation,
      -1,
      "preview is not a training job",
    );
  },
);

test(
  "one data directory has one canonical owner; API_UPSTREAM proxies trusted HTTP/WS without a second trainer",
  { timeout: 25_000 },
  async (t) => {
    const f = await fixture(t);
    await assert.rejects(
      startResearchServer({
        port: 0,
        host: "127.0.0.1",
        dataDir: f.dir,
        apiUpstream: "",
        ...limits,
      }),
      /already locked/i,
    );
    const proxy = await startResearchServer({
      port: 0,
      host: "127.0.0.1",
      dataDir: f.dir,
      apiUpstream: `http://127.0.0.1:${f.server.port}`,
      ...limits,
    });
    t.after(() => proxy.close());
    assert.equal(proxy.manager, null);
    const posted = await response(
      proxy,
      "runs",
      { config: tiny(), start: true },
      { Origin: `http://127.0.0.1:${proxy.port}` },
    );
    assert.equal(posted.status, 201);
    const run = (await posted.json()) as RunDetail;
    await until(
      f.server,
      run.summary.id,
      (detail) => detail.summary.generation >= 2,
    );
    const observer = await socket(t, proxy);
    await observer.wait((event) => event.type === "hello");
    observer.peer.send(
      JSON.stringify({ type: "subscribe", runId: run.summary.id }),
    );
    await observer.wait(
      (event) => event.type === "run" && event.runId === run.summary.id,
    );
    const health = await api<{
      storedRuns: number;
      workers: number;
      activeRuns: number;
    }>(proxy, "health");
    assert.deepEqual(
      [health.storedRuns, health.workers, health.activeRuns],
      [1, 2, 1],
    );
    const denied = await response(
      proxy,
      "runs",
      { config: tiny() },
      {
        Origin: "https://attacker.invalid",
        "X-Forwarded-Host": "attacker.invalid",
        "X-Forwarded-Proto": "https",
      },
    );
    assert.equal(denied.status, 403);
    await action(proxy, run.summary.id, "pause");
    assert.deepEqual(
      await api<RunList>(proxy, "runs"),
      await api<RunList>(f.server, "runs"),
    );
    await proxy.close();
    await step(f.server, run.summary.id);
    assert.equal(
      (await api<RunList>(f.server, "runs")).runs.length,
      1,
      "closing an observing proxy does not close canonical storage or duplicate research",
    );
  },
);

test(
  "invalid config, JSON, origin and bounded HTTP/WebSocket payloads cannot allocate research",
  { timeout: 25_000 },
  async (t) => {
    const f = await fixture(t);
    for (const config of [
      tiny({ size: 10 }),
      tiny({ maxGenerations: -1 }),
      tiny({ evaluationWorkers: 3 }),
      tiny({ mutationRate: 2 }),
      { ...tiny(), untrusted: 1 },
    ])
      assert.equal(
        (await response(f.server, "runs", { config, start: true })).status,
        400,
      );
    for (const input of [
      { config: tiny(), start: "true" },
      { config: tiny(), action: "start" },
      {},
      [],
    ])
      assert.equal((await response(f.server, "runs", input)).status, 400);
    assert.equal(
      (
        await fetch(url(f.server, "runs"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(url(f.server, "runs"), {
          method: "POST",
          body: JSON.stringify({ config: tiny() }),
        })
      ).status,
      415,
    );
    for (const headers of [
      {
        Origin: "https://attacker.invalid",
        "X-Forwarded-Host": "attacker.invalid",
      },
      { "Sec-Fetch-Site": "cross-site" },
    ] as Record<string, string>[])
      assert.equal(
        (await response(f.server, "runs", { config: tiny() }, headers)).status,
        403,
      );
    const rejectedUpgrade = await new Promise<number>((resolve, reject) => {
      const peer = new WebSocket(
        `ws://127.0.0.1:${f.server.port}/api/research/ws`,
        { origin: "https://attacker.invalid" },
      );
      peer.once("unexpected-response", (_request, result) => {
        result.resume();
        resolve(result.statusCode!);
        peer.terminate();
      });
      peer.once("open", () => {
        peer.terminate();
        reject(new Error("Untrusted websocket opened"));
      });
      peer.on("error", () => {});
    });
    assert.equal(rejectedUpgrade, 403);
    const observer = await socket(t, f.server);
    observer.peer.send("{malformed");
    await observer.wait((event) => event.type === "error");
    const closed = new Promise<number>((resolve) =>
      observer.peer.once("close", (code) => resolve(code)),
    );
    observer.peer.send("x".repeat(4097));
    assert.equal(
      await closed,
      1009,
      "WS command payload has a hard 4 KiB bound",
    );
    const oversized = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port: f.server.port,
          path: "/api/runs",
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
        (result) => {
          result.resume();
          resolve(result.statusCode!);
        },
      );
      req.on("error", reject);
      req.setTimeout(DEADLINE, () =>
        req.destroy(new Error("body bound timed out")),
      );
      for (let i = 0; i < 17; i++) req.write(" ".repeat(1024 * 1024));
      req.end();
    });
    assert.equal(
      oversized,
      413,
      "chunked transfer cannot evade the 16 MiB limit",
    );
    assert.deepEqual((await api<RunList>(f.server, "runs")).runs, []);
    assert.equal(
      (await api<{ workers: number }>(f.server, "health")).workers,
      0,
    );
  },
);

async function freePort(): Promise<number> {
  const server = tcpServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}
async function cli(dir: string): Promise<
  Endpoint & {
    child: ChildProcessWithoutNullStreams;
    stop: (signal?: NodeJS.Signals) => Promise<void>;
    output: () => string;
  }
> {
  const port = await freePort();
  assert.ok(![3000, 4173, 8787, 5173].includes(port));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    POLYP_RUNS_DIR: dir,
    PORT: "1",
    HOST: "127.0.0.1",
    POLYP_MAX_EVALUATION_WORKERS: "2",
    POLYP_MAX_ACTIVE_RUNS: "2",
    POLYP_CPU_BUDGET: "3",
  };
  delete env.API_UPSTREAM;
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("./index.js", import.meta.url)),
      "--port",
      String(port),
      "--host",
      "127.0.0.1",
    ],
    { env, stdio: "pipe" },
  );
  let output = "";
  child.stdout.on("data", (data) => {
    output += data.toString();
  });
  child.stderr.on("data", (data) => {
    output += data.toString();
  });
  const stop = async (signal: NodeJS.Signals = "SIGTERM") => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill(signal);
    });
  };
  try {
    const end = Date.now() + DEADLINE;
    while (!output.includes(`on port ${port};`)) {
      if (child.exitCode !== null || child.signalCode !== null)
        assert.fail(`CLI startup failed: ${output}`);
      if (Date.now() > end) assert.fail(`CLI did not honor --port: ${output}`);
      await delay(30);
    }
    return { port, child, stop, output: () => output };
  } catch (error) {
    await stop("SIGKILL");
    throw error;
  }
}

test(
  "CLI explicit --port works; abrupt process restart auto-resumes durable run intent but never paused/opt-out jobs",
  { timeout: 45_000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "polyp-research-process-"));
    let processServer: Awaited<ReturnType<typeof cli>> | undefined;
    t.after(async () => {
      try {
        await processServer?.stop();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
    processServer = await cli(dir);
    assert.equal(
      (await api<{ execution: string }>(processServer, "health")).execution,
      "node:worker_threads",
    );
    const paused = await create(
      processServer,
      tiny({ name: "Fixture explicitly paused", resumeOnRestart: true }),
    );
    await step(processServer, paused.summary.id);
    await action(processServer, paused.summary.id, "pause");
    const pausedState = await checkpoint(processServer, paused.summary.id);
    const optOut = await create(
      processServer,
      tiny({ name: "Fixture restart opt-out", resumeOnRestart: false }),
      true,
    );
    await until(
      processServer,
      optOut.summary.id,
      (detail) => detail.summary.generation >= 2,
    );
    await action(processServer, optOut.summary.id, "checkpoint");
    const active = await create(
      processServer,
      tiny({ name: "Fixture durable running", resumeOnRestart: true }),
      true,
    );
    assert.equal(active.summary.status, "queued");
    // Leave restart intent truly active for both policies, not just paused envelopes.
    await action(processServer, optOut.summary.id, "pause");
    await until(
      processServer,
      active.summary.id,
      (detail) => detail.summary.generation >= 3,
    );
    await action(processServer, active.summary.id, "checkpoint");
    const durableFile = join(dir, `${active.summary.id}.json`);
    const durable = JSON.parse(await readFile(durableFile, "utf8")) as {
      checkpoint: RunCheckpoint;
    };
    await action(processServer, optOut.summary.id, "start"); // queued, opt-out must not auto-start
    await processServer.stop("SIGKILL");
    processServer = undefined;
    processServer = await cli(dir); // also proves kernel-exclusive lock is crash released
    const resumed = await until(
      processServer,
      active.summary.id,
      (detail) =>
        detail.summary.generation > durable.checkpoint.state!.generation,
      "durable auto-resume without browser",
    );
    assert.equal(resumed.summary.status, "running");
    assert.equal(
      (await api(processServer, `runs/${paused.summary.id}`)).summary.status,
      "paused",
    );
    assert.deepEqual(
      (await checkpoint(processServer, paused.summary.id)).state,
      pausedState.state,
    );
    assert.equal(
      (await api(processServer, `runs/${optOut.summary.id}`)).summary.status,
      "paused",
    );
    await action(processServer, active.summary.id, "pause");
    const after = await checkpoint(processServer, active.summary.id);
    assert.ok(after.state);
    let expected = durable.checkpoint.state!;
    while (expected.generation < after.state.generation)
      expected = await advanceGeneration(expected);
    assert.deepEqual(
      after.state,
      expected,
      "crash replay comes only from durable state, retaining RNG/population/cache exactly",
    );
  },
);

test(
  "periodic disk checkpoints advance without observers or an explicit checkpoint command",
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t);
    const run = await create(f.server, tiny({ checkpointSeconds: 2 }), true);
    const path = join(f.dir, `${run.summary.id}.json`);
    const initial = JSON.parse(await readFile(path, "utf8"));
    const deadline = Date.now() + DEADLINE;
    let periodic = initial;
    while (
      !periodic.checkpoint.state ||
      periodic.summary.checkpointAt === initial.summary.checkpointAt
    ) {
      assert.ok(
        Date.now() < deadline,
        "periodic durable checkpoint did not advance within 15 seconds",
      );
      await delay(100);
      periodic = JSON.parse(await readFile(path, "utf8"));
    }
    assert.ok(periodic.checkpoint.state.generation >= 0);
    assert.equal(periodic.intent, "run");
    assert.equal(periodic.summary.status, "running");
    const expected = await reference(
      run.config,
      periodic.checkpoint.state.generation,
    );
    assert.deepEqual(
      periodic.checkpoint.state,
      expected,
      "periodic write contains a complete, internally consistent population",
    );
    await action(f.server, run.summary.id, "pause");
    const paused = JSON.parse(await readFile(path, "utf8"));
    assert.equal(paused.intent, null);
    assert.equal(paused.summary.status, "paused");
    assert.deepEqual(
      paused.checkpoint.state,
      (await checkpoint(f.server, run.summary.id)).state,
    );
  },
);

test(
  "three active jobs and six evaluators respect hard caps and coordinator CPU reservations",
  { timeout: 25_000 },
  async (t) => {
    if (availableParallelism() < 8) {
      t.skip(
        "six evaluators, coordinator and reserved preview capacity require eight native CPU slots",
      );
      return;
    }
    const cpuBudget = 7;
    const f = await fixture(t, {
      cpuBudget,
      maxEvaluationWorkers: 6,
      maxRuns: 3,
    });
    const jobs: RunDetail[] = [];
    for (let i = 0; i < 4; i++)
      jobs.push(
        await create(
          f.server,
          tiny({ name: `Fixture simultaneous ${i}` }),
          true,
        ),
      );
    for (const run of jobs.slice(0, 3))
      await until(
        f.server,
        run.summary.id,
        (detail) => detail.summary.generation >= 1,
      );
    let health = await api<{
      activeRuns: number;
      workers: number;
      evaluationWorkers: number;
      cpuBudget: number;
      queuedRuns: number;
    }>(f.server, "health");
    assert.deepEqual(
      [
        health.activeRuns,
        health.workers,
        health.evaluationWorkers,
        health.queuedRuns,
      ],
      [3, 6, 3, 1],
    );
    assert.equal(
      (await api(f.server, `runs/${jobs[3].summary.id}`)).summary.status,
      "queued",
    );
    for (const run of jobs) await action(f.server, run.summary.id, "pause");
    const six = await create(
      f.server,
      tiny({ name: "Fixture six real evaluators", evaluationWorkers: 6 }),
      true,
    );
    await until(
      f.server,
      six.summary.id,
      (detail) => detail.summary.generation >= 1,
    );
    const extra = await create(
      f.server,
      tiny({ name: "Fixture blocked by total budget" }),
      true,
    );
    assert.equal(extra.summary.status, "queued");
    health = await api(f.server, "health");
    assert.deepEqual(
      [health.activeRuns, health.workers, health.evaluationWorkers],
      [1, 7, 6],
    );
    assert.ok(health.workers <= health.cpuBudget);
    assert.equal(
      (await api<RunList>(f.server, "runs")).capacity.allocatedWorkers,
      6,
    );
    await action(f.server, six.summary.id, "pause");
    await until(
      f.server,
      extra.summary.id,
      (detail) => detail.summary.generation >= 1,
    );
  },
);

test(
  "publication is bounded near 2 Hz and a non-reading real WebSocket cannot backpressure genetics",
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t);
    const run = await create(f.server, tiny(), true);
    const observer = await socket(t, f.server);
    observer.peer.send(
      JSON.stringify({ type: "subscribe", runId: run.summary.id }),
    );
    await observer.wait((event) => event.type === "run");
    const before = await api(f.server, `runs/${run.summary.id}`);
    observer.messages.length = 0;
    const started = performance.now();
    await delay(1650);
    const elapsed = performance.now() - started;
    const published = observer.messages.filter((event) => event.type === "run");
    assert.ok(
      published.length >= 2,
      "observing clients receive live retained state",
    );
    assert.ok(
      published.length <= Math.ceil(elapsed / 500) + 1,
      "worker speed cannot turn into unbounded per-generation socket publications",
    );
    const active = await api(f.server, `runs/${run.summary.id}`);
    assert.ok(
      active.summary.generation - before.summary.generation > published.length,
      "research cadence is not tied to publication cadence",
    );
    observer.peer.pause(); // Public WS transport API: real TCP receive-side backpressure.
    const checkpointBefore = active.summary.generation;
    await delay(1000);
    const healthy = await api<{ status: string; activeRuns: number }>(
      f.server,
      "health",
    );
    assert.equal(healthy.status, "ok");
    assert.equal(healthy.activeRuns, 1);
    await until(
      f.server,
      run.summary.id,
      (detail) => detail.summary.generation > checkpointBefore + 5,
      "progress while observer does not read",
    );
    observer.peer.terminate();
  },
);

test(
  "malformed genetic checkpoints and oversized retained histories are rejected without changing the source",
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t);
    const run = await create(f.server);
    await step(f.server, run.summary.id);
    const cp = await checkpoint(f.server, run.summary.id);
    assert.ok(cp.state);
    const invalid: [string, (value: RunCheckpoint) => void][] = [
      [
        "RNG must be uint32",
        (value) => {
          value.state!.rngState = -1;
        },
      ],
      [
        "candidate IDs must preserve history",
        (value) => {
          value.state!.nextId++;
        },
      ],
      [
        "population length is immutable",
        (value) => {
          value.state!.population.pop();
        },
      ],
      [
        "population identities must be unique",
        (value) => {
          value.state!.population[1] = structuredClone(
            value.state!.population[0],
          );
        },
      ],
      [
        "quiescent allele stays locked",
        (value) => {
          value.state!.population[0].genome[0] = 1;
        },
      ],
      [
        "cache accounting is exact",
        (value) => {
          value.state!.cacheHits++;
        },
      ],
      [
        "configuration matches state",
        (value) => {
          value.config.randomSeed++;
        },
      ],
      [
        "only known model versions replay",
        (value) => {
          (value as unknown as { modelVersion: string }).modelVersion =
            "future-unsupported-model";
        },
      ],
      [
        "current metrics match population",
        (value) => {
          value.history.at(-1)!.bestEver = 0.999999;
        },
      ],
      [
        "history cannot exceed 4096 points",
        (value) => {
          value.history = Array.from({ length: 4097 }, () =>
            structuredClone(value.history[0]),
          );
        },
      ],
      [
        "improvement trace cannot exceed 256 points",
        (value) => {
          value.improvements = Array.from({ length: 257 }, () =>
            structuredClone(value.improvements[0]),
          );
        },
      ],
      [
        "cache keys are exact full genomes",
        (value) => {
          value.state!.cache[0].key = "00000";
        },
      ],
    ];
    for (const [label, mutate] of invalid) {
      const broken = structuredClone(cp);
      mutate(broken);
      const result = await response(f.server, "runs/import", {
        checkpoint: broken,
        start: true,
      });
      assert.equal(result.status, 400, `${label}: ${await result.text()}`);
    }
    assert.deepEqual(await checkpoint(f.server, run.summary.id), cp);
    assert.equal((await api<RunList>(f.server, "runs")).runs.length, 1);
    assert.equal(
      (await api<{ workers: number }>(f.server, "health")).workers,
      0,
    );
  },
);

test(
  "64 stored runs is a real HTTP admission bound, including archives; rejected admission creates no file or worker",
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t);
    let first = "";
    for (let index = 0; index < 64; index++) {
      const run = await create(
        f.server,
        tiny({ name: `Fixture stored ${index}` }),
      );
      if (!index) first = run.summary.id;
      assert.equal(run.summary.status, "paused");
      // Below HTTP token budget; this is testing storage admission, not request rate.
      await delay(20);
    }
    await action(f.server, first, "archive");
    const before = (await readdir(f.dir)).sort();
    const rejected = await response(f.server, "runs", {
      config: tiny({ name: "Fixture over capacity" }),
      start: true,
    });
    assert.equal(rejected.status, 409);
    assert.match(await rejected.text(), /64 stored runs/);
    assert.deepEqual(
      (await readdir(f.dir)).sort(),
      before,
      "failed admission cannot leave a partial run on disk",
    );
    const list = await api<RunList>(f.server, "runs");
    assert.equal(list.runs.length, 64);
    assert.equal(list.runs.find((run) => run.id === first)!.status, "archived");
    assert.equal(
      (await api<{ workers: number }>(f.server, "health")).workers,
      0,
    );
  },
);
