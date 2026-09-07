import { decodePreview } from "../src/research/preview";
import { expandPreviewLayer } from "../src/research/previewLayers";
/** Service-level scientific oracles: real TCP and worker pools, not mocked messages. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { startResearchServer, workspaceOrigins } from "./index.js";
import { DEFAULT_RUN_CONFIG } from "../src/research/config";
import {
  initializePopulation,
  advanceGeneration,
  generationSnapshot,
} from "../src/research/engine";
import { simulate } from "../src/simulation";
import { evaluateGenome } from "../src/research/evaluate";
import { parseListenOptions } from "../scripts/listen-options.mjs";
import type {
  RunConfig,
  RunDetail,
  RunCheckpoint,
  EngineState,
  PreviewFrame,
} from "../src/research/types";
const base = (patch: Partial<RunConfig> = {}): RunConfig => ({
  ...DEFAULT_RUN_CONFIG,
  initialization: "mutants",
  randomRuleBias: "uniform",
  name: "Scientific fixture",
  size: 9,
  steps: 8,
  populationSize: 8,
  eliteCount: 2,
  tournamentSize: 2,
  evaluationWorkers: 1,
  cacheSize: 64,
  checkpointSeconds: 2,
  snapshotEvery: 1,
  retainedSnapshots: 3,
  ...patch,
});
async function api(port: number, path: string, input?: unknown): Promise<any> {
  const response = await fetch(
    `http://127.0.0.1:${port}/api/${path}`,
    input === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        },
  );
  const value = await response.json();
  assert.ok(response.ok, `${response.status} ${JSON.stringify(value)}`);
  return value;
}
async function until<T>(
  read: () => Promise<T | false | undefined>,
  timeout = 20_000,
): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (value !== undefined && value !== false) return value;
    await delay(10);
  }
  throw new Error("Timed out waiting for a native research result.");
}
async function state(
  port: number,
  id: string,
  status = "paused",
  generation?: number,
  timeout = 20_000,
): Promise<RunDetail> {
  return until(async () => {
    const d = (await api(port, `runs/${id}`)) as RunDetail;
    assert.notEqual(
      d.summary.status,
      "failed",
      d.summary.error ?? "Failed run",
    );
    return d.summary.status === status &&
      (generation === undefined || d.summary.generation === generation)
      ? d
      : false;
  }, timeout);
}
async function fixture(run: (port: number, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "polyp-science-"));
  const server = await startResearchServer({
    port: 0,
    host: "127.0.0.1",
    dataDir: dir,
  });
  try {
    await run(server.port, dir);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
}
function science(value: EngineState): EngineState {
  const copy = structuredClone(value);
  copy.config.name = "Normalized cosmetic name";
  copy.config.evaluationWorkers = 1;
  return copy;
}

test("one and two actual evaluation workers match a full-population engine oracle through five generations", async () => {
  await fixture(async (port) => {
    const config = base({
      maxGenerations: 5,
      trainingSeeds: [17, -9],
      validationSeeds: [31],
      seed: "islands",
      mutationRate: 0.2,
    });
    let oracle = await initializePopulation(config);
    const first = generationSnapshot(oracle);
    for (let i = 0; i < 5; i++) oracle = await advanceGeneration(oracle);
    const a = (await api(port, "runs", { config, start: true })) as RunDetail;
    const b = (await api(port, "runs", {
      config: { ...config, evaluationWorkers: 2 },
      start: true,
    })) as RunDetail;
    const [one, two] = await Promise.all([
      state(port, a.summary.id, "completed", 5),
      state(port, b.summary.id, "completed", 5),
    ]);
    assert.deepEqual(one.snapshot, generationSnapshot(oracle));
    assert.deepEqual(two.snapshot, one.snapshot);
    const checkpoint = (await api(
      port,
      `runs/${a.summary.id}/checkpoint`,
    )) as RunCheckpoint;
    assert.deepEqual(checkpoint.state, oracle);
    assert.equal(checkpoint.state!.population.length, config.populationSize);
    assert.equal(one.history.length, 6);
    assert.ok(one.snapshot!.population.some((i) => i.birthGeneration === 5));
    assert.notDeepEqual(first.population, one.snapshot!.population);
    assert.ok(
      one.snapshot!.population.some((i) => i.parents.length),
      "real lineage survives the VM boundary",
    );
  });
});

test("step initializes generation zero and imported/forked checkpoints resume the same RNG, IDs, cache and entire population", async () => {
  await fixture(async (port) => {
    const original = (await api(port, "runs", { config: base() })) as RunDetail;
    assert.equal(original.summary.generation, -1);
    assert.equal(original.snapshot, null);
    for (let generation = 0; generation <= 2; generation++) {
      await api(port, `runs/${original.summary.id}/actions`, {
        action: "step",
      });
      await state(port, original.summary.id, "paused", generation);
    }
    const checkpoint = (await api(
      port,
      `runs/${original.summary.id}/checkpoint`,
    )) as RunCheckpoint;
    const expected = await advanceGeneration(checkpoint.state!);
    const fork = (await api(port, `runs/${original.summary.id}/fork`, {
      name: "Fork",
    })) as RunDetail;
    const imported = (await api(port, "runs/import", {
      checkpoint,
      name: "Import",
    })) as RunDetail;
    for (const run of [original, fork, imported]) {
      await api(port, `runs/${run.summary.id}/actions`, { action: "step" });
      await state(port, run.summary.id, "paused", 3);
    }
    for (const run of [original, fork, imported]) {
      const cp = (await api(
        port,
        `runs/${run.summary.id}/checkpoint`,
      )) as RunCheckpoint;
      assert.deepEqual(science(cp.state!), science(expected));
    }
    const source = (await api(
      port,
      `runs/${original.summary.id}`,
    )) as RunDetail;
    await api(port, `runs/${fork.summary.id}/actions`, { action: "step" });
    await state(port, fork.summary.id, "paused", 4);
    assert.deepEqual(
      await api(port, `runs/${original.summary.id}`),
      source,
      "advancing fork cannot mutate source",
    );
  });
});

test(
  "retained histories are honest bounded windows and the latest complete generation is always inspectable",
  { timeout: 60_000 },
  async () => {
    await fixture(async (port) => {
      const run = (await api(port, "runs", {
        config: base({
          maxGenerations: 4101,
          mutationRate: 0,
          immigrantRate: 0,
          crossover: "none",
          snapshotEvery: 1000,
          retainedSnapshots: 2,
        }),
        start: true,
      })) as RunDetail;
      const result = await state(
        port,
        run.summary.id,
        "completed",
        4101,
        45_000,
      );
      assert.equal(result.history.length, 4096);
      assert.equal(result.history[0].generation, 6);
      assert.equal(result.history.at(-1)!.generation, 4101);
      assert.ok(result.improvements.length <= 256);
      assert.deepEqual(
        result.snapshots.map((x) => x.generation),
        [3000, 4000],
      );
      assert.equal(
        (await api(port, `runs/${run.summary.id}/generations/4101`)).generation,
        4101,
      );
      assert.equal(
        (await api(port, `runs/${run.summary.id}/generations/3000`)).generation,
        3000,
      );
      assert.equal(
        (
          await fetch(
            `http://127.0.0.1:${port}/api/runs/${run.summary.id}/generations/0`,
          )
        ).status,
        404,
      );
      const csv = await fetch(
        `http://127.0.0.1:${port}/api/runs/${run.summary.id}/metrics.csv`,
      );
      assert.equal(csv.headers.get("x-history-first-generation"), "6");
      assert.equal(csv.headers.get("x-history-last-generation"), "4101");
      assert.equal((await csv.text()).trim().split("\n").length, 4097);
    });
  },
);

test("large grids and deep horizons execute on real workers, preview fully, and resume exported checkpoints", async () => {
  await fixture(async (port) => {
    const genome = Array<number>(45).fill(0);
    genome[9] = 2;
    genome[18] = 3;
    genome[27] = 4;
    genome[36] = 1;
    const config = base({
      size: 257,
      steps: 8192,
      seed: "point",
      seedGenome: genome,
      mutationRate: 0,
      immigrantRate: 0,
      crossover: "none",
    });
    const run = (await api(port, "runs", { config })) as RunDetail;
    await api(port, `runs/${run.summary.id}/actions`, { action: "step" });
    const evaluated = await state(port, run.summary.id, "paused", 0);
    const expected = evaluateGenome(genome, config);
    assert.equal(evaluated.snapshot!.champion.fitness, expected.fitness);
    assert.equal(evaluated.snapshot!.champion.metrics.lifetime, 8192);
    const frame = (await api(port, `runs/${run.summary.id}/preview`, {
      genome,
      seed: 1729,
    })) as PreviewFrame;
    assert.equal(frame.totalSteps, 8192);
    assert.equal(frame.layerTimes.at(-1), 8191);
    assert.equal(frame.simulation.population.length, 8192);
    assert.equal(frame.layerTimes.length, 8192);
    const decoded = decodePreview(frame);
    for (const [index, time] of frame.layerTimes.entries()) {
      const layer = expandPreviewLayer(decoded.layers[index], config.size);
      assert.equal(layer.length, 257 ** 2);
      assert.equal(layer[(257 ** 2 - 1) / 2], 1 + (time % 4));
    }
    const saved = (await api(
      port,
      `runs/${run.summary.id}/checkpoint`,
    )) as RunCheckpoint;
    const imported = (await api(port, "runs/import", {
      checkpoint: saved,
    })) as RunDetail;
    await api(port, `runs/${imported.summary.id}/actions`, { action: "step" });
    const resumed = await state(port, imported.summary.id, "paused", 1);
    assert.equal(resumed.snapshot!.champion.metrics.lifetime, 8192);
    assert.equal(resumed.config.steps, 8192);
    assert.equal(resumed.config.size, 257);
    assert.equal(
      (await api(port, `runs/${run.summary.id}`)).summary.generation,
      0,
    );
  });
});

test("historic genome preview is exactly consecutive legacy data, full horizon statistics, complete planes and bounded voxels", async () => {
  await fixture(async (port) => {
    const genome = Array<number>(45).fill(1);
    genome[0] = 0;
    const config = base({ size: 49, steps: 256, seedGenome: genome });
    const run = (await api(port, "runs", { config })) as RunDetail;
    const request = api(port, `runs/${run.summary.id}/preview`, {
      genome,
      seed: -777,
    }) as Promise<PreviewFrame>;
    const started = performance.now();
    const health = await api(port, "health");
    assert.ok(performance.now() - started < 1000);
    assert.equal(health.execution, "node:worker_threads");
    const preview = await request;
    const simulation = simulate(genome, {
      size: config.size,
      steps: config.steps,
      seed: config.seed,
      randomSeed: -777,
    });
    assert.equal(preview.totalSteps, config.steps);
    assert.equal(preview.layerTimes[0], 0);
    assert.equal(preview.layerTimes.at(-1), config.steps - 1);
    assert.equal(preview.layerTimes.length, config.steps);
    assert.equal(preview.stride, 1);
    assert.deepEqual(preview.simulation.population, simulation.population);
    assert.equal(preview.simulation.activity, simulation.activity);
    assert.equal(preview.simulation.diversity, simulation.diversity);
    assert.equal(preview.simulation.occupancy, simulation.occupancy);
    let occupied = 0;
    const decoded = decodePreview(preview);
    for (const [i, t] of preview.layerTimes.entries()) {
      const actual = Buffer.from(
        expandPreviewLayer(decoded.layers[i], config.size),
      );
      assert.deepEqual(actual, Buffer.from(simulation.layers[t]));
      assert.equal(actual.length, config.size ** 2);
      occupied += simulation.population[t];
    }
    assert.equal(
      occupied,
      simulation.population.reduce((sum, value) => sum + value, 0),
    );
    assert.equal(preview.simulation.population.length, 256);
    assert.deepEqual(
      await api(port, `runs/${run.summary.id}/preview`, { genome, seed: -777 }),
      preview,
      "bounded cache is exact",
    );
    for (const range of [
      { start: 19, end: 37 },
      { start: 204, end: 204 },
    ]) {
      const window = (await api(port, `runs/${run.summary.id}/preview`, {
        genome,
        seed: -777,
        range,
      })) as PreviewFrame;
      assert.deepEqual(
        window.layerTimes,
        Array.from(
          { length: range.end - range.start + 1 },
          (_, i) => range.start + i,
        ),
      );
      const decodedWindow = decodePreview(window);
      for (const [index, layer] of decodedWindow.layers.entries())
        assert.deepEqual(
          expandPreviewLayer(layer, config.size),
          simulation.layers[range.start + index],
        );
      assert.deepEqual(
        window.simulation.population,
        preview.simulation.population,
      );
      assert.equal(window.simulation.lifetime, preview.simulation.lifetime);
      assert.equal(window.totalSteps, config.steps);
    }
    const invalid = await fetch(
      `http://127.0.0.1:${port}/api/runs/${run.summary.id}/preview`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          genome,
          seed: -777,
          range: { start: 37, end: 19 },
        }),
      },
    );
    assert.equal(invalid.status, 400);
    assert.equal(
      (await api(port, `runs/${run.summary.id}`)).summary.generation,
      -1,
      "preview never initializes/trains the run",
    );
  });
});

async function freePort(): Promise<number> {
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const address = socket.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((done) => socket.close(() => done()));
  return port;
}
async function launch(dir: string, port: number): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("./index.js", import.meta.url)),
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    {
      env: { ...process.env, API_UPSTREAM: "", POLYP_RUNS_DIR: dir, PORT: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let errors = "";
  child.stderr?.on("data", (data) => {
    errors += String(data);
  });
  child.stdout?.resume();
  await until(async () => {
    if (child.exitCode !== null)
      throw new Error(`Server exited ${child.exitCode}: ${errors}`);
    try {
      return (await fetch(`http://127.0.0.1:${port}/api/health`)).ok || false;
    } catch {
      return false;
    }
  });
  return child;
}
async function stop(
  child: ChildProcess | undefined,
  signal: NodeJS.Signals = "SIGTERM",
) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const ended = once(child, "exit");
  child.kill(signal);
  await ended;
}

test(
  "real process SIGKILL recovery resumes committed running state, but never paused state; CLI port overrides env",
  { timeout: 20_000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "polyp-restart-"));
    let child: ChildProcess | undefined;
    try {
      const port = await freePort();
      child = await launch(dir, port);
      const running = (await api(port, "runs", {
        config: base(),
        start: true,
      })) as RunDetail;
      const paused = (await api(port, "runs", { config: base() })) as RunDetail;
      await api(port, `runs/${paused.summary.id}/actions`, { action: "step" });
      await state(port, paused.summary.id, "paused", 0);
      await until(
        async () =>
          (await api(port, `runs/${running.summary.id}`)).summary.generation >=
            5 || false,
      );
      await api(port, `runs/${running.summary.id}/actions`, {
        action: "checkpoint",
      });
      const persisted = JSON.parse(
        await readFile(join(dir, running.summary.id + ".json"), "utf8"),
      );
      const generation = persisted.checkpoint.state.generation;
      assert.equal(persisted.intent, "run");
      assert.equal(persisted.summary.status, "running");
      await stop(child, "SIGKILL");
      child = undefined;
      await delay(80);
      child = await launch(dir, port);
      await until(
        async () =>
          (await api(port, `runs/${running.summary.id}`)).summary.generation >
            generation || false,
      );
      const samePaused = await api(port, `runs/${paused.summary.id}`);
      assert.equal(samePaused.summary.status, "paused");
      assert.equal(samePaused.summary.generation, 0);
      await stop(child);
      child = undefined;
      const stored = JSON.parse(
        await readFile(join(dir, running.summary.id + ".json"), "utf8"),
      );
      assert.equal(stored.intent, "run");
      assert.equal(stored.summary.status, "running");
      child = await launch(dir, port);
      await until(
        async () =>
          (await api(port, `runs/${running.summary.id}`)).summary.generation >
            stored.checkpoint.state.generation || false,
      );
    } finally {
      await stop(child);
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("corrupt primary uses valid backup; corruption of both copies isolates only that run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "polyp-corrupt-"));
  let server: Awaited<ReturnType<typeof startResearchServer>> | undefined;
  try {
    server = await startResearchServer({
      port: 0,
      host: "127.0.0.1",
      dataDir: dir,
    });
    const good = (await api(server.port, "runs", {
      config: base(),
    })) as RunDetail;
    const backup = (await api(server.port, "runs", {
      config: base(),
    })) as RunDetail;
    const broken = (await api(server.port, "runs", {
      config: base(),
    })) as RunDetail;
    await server.close();
    server = undefined;
    await writeFile(join(dir, backup.summary.id + ".json"), "{broken");
    await writeFile(join(dir, broken.summary.id + ".json"), "{broken");
    await writeFile(join(dir, broken.summary.id + ".json.bak"), "{broken");
    server = await startResearchServer({
      port: 0,
      host: "127.0.0.1",
      dataDir: dir,
    });
    const list = await api(server.port, "runs");
    assert.equal(list.runs.length, 2);
    assert.ok(
      list.runs.some((r: RunDetail["summary"]) => r.id === good.summary.id),
    );
    assert.ok(
      list.runs.some((r: RunDetail["summary"]) => r.id === backup.summary.id),
    );
    const health = await api(server.port, "health");
    assert.equal(health.recoveryErrors.length, 2);
    await api(server.port, `runs/${good.summary.id}/actions`, {
      action: "step",
    });
    await state(server.port, good.summary.id, "paused", 0);
  } finally {
    await server?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI parsing and forwarded origin aliases remain exact, not suffix wildcard matches", () => {
  assert.deepEqual(
    parseListenOptions(["--port=3000", "--host", "127.0.0.1", "--strictPort"], {
      port: 4173,
    }),
    { port: 3000, host: "127.0.0.1" },
  );
  assert.throws(
    () => parseListenOptions(["--port", "99999"], { port: 4173 }),
    /Port/,
  );
  const aliases = workspaceOrigins(8787, {
    WORKSPACE_SHORT_ID: "our-workspace",
    SOFT_MACHINE_PORT_FORWARDING_DOMAIN: "example.test",
  });
  assert.deepEqual(
    [...aliases],
    [
      "https://8787-our-workspace.example.test",
      "https://5173-our-workspace.example.test",
    ],
  );
  assert.ok(!aliases.has("https://other-our-workspace.example.test"));
});

test("binary and sixteen-state jobs evaluate, preview, export, import and continue on real workers", async () => {
  await fixture(async (port) => {
    for (const stateCount of [2, 16]) {
      const genome = Array(stateCount * 9).fill(0);
      for (let s = 1; s < stateCount - 1; s++) genome[s * 9] = s + 1;
      const cfg = base({
        stateCount,
        seedGenome: genome,
        seed: "point",
        steps: 32,
        mutationRate: 0.3,
        crossoverRate: 1,
      });
      const run = await api(port, "runs", { config: cfg });
      await api(port, `runs/${run.summary.id}/actions`, { action: "step" });
      const initialized = await state(port, run.summary.id, "paused", 0);
      const oracle = await initializePopulation(cfg);
      assert.deepEqual(initialized.snapshot, generationSnapshot(oracle));
      const preview = await api(port, `runs/${run.summary.id}/preview`, {
        genome,
        seed: 1729,
      });
      assert.equal(preview.simulation.lifetime, stateCount - 1);
      const decoded = decodePreview(preview);
      for (let time = 0; time < stateCount - 1; time++)
        assert.equal(
          expandPreviewLayer(decoded.layers[time], cfg.size)[40],
          time + 1,
        );
      const exported = await api(port, `runs/${run.summary.id}/checkpoint`);
      const imported = await api(port, "runs/import", { checkpoint: exported });
      assert.equal(imported.config.stateCount, stateCount);
      await api(port, `runs/${imported.summary.id}/actions`, {
        action: "step",
      });
      const continued = await state(port, imported.summary.id, "paused", 1);
      assert.deepEqual(
        continued.snapshot,
        generationSnapshot(await advanceGeneration(oracle)),
      );
      const invalidGenome = genome.slice();
      invalidGenome[1] = stateCount;
      const rejected = await fetch(
        `http://127.0.0.1:${port}/api/runs/${run.summary.id}/preview`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ genome: invalidGenome, seed: 1729 }),
        },
      );
      assert.equal(rejected.status, 400);
      assert.match(
        ((await rejected.json()) as { error: string }).error,
        /Gene 1/,
      );
    }
  });
});

for (const version of ["ca5-moore-research-v1", "ca-moore-research-v2"])
  test(`${version} checkpoint imports and on-disk archives preserve scientific continuation`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "polyp-state-migration-"));
    let server = await startResearchServer({
      port: 0,
      host: "127.0.0.1",
      dataDir: dir,
    });
    try {
      const cfg = base({ boundaryPolicy: { spatial: false, horizon: false } });
      const created = await api(server.port, "runs", { config: cfg });
      const id = created.summary.id;
      for (let generation = 0; generation <= 2; generation++) {
        await api(server.port, `runs/${id}/actions`, { action: "step" });
        await state(server.port, id, "paused", generation);
      }
      const before = await api(server.port, `runs/${id}/checkpoint`);
      const stripEvaluation = (item: any) => {
        delete item.disqualified;
        delete item.validationDisqualified;
      };
      const stripConfig = (config: any) => {
        delete config.boundaryPolicy;
        if (version === "ca5-moore-research-v1") delete config.stateCount;
      };
      const asLegacy = (checkpoint: any) => {
        checkpoint.modelVersion = version;
        stripConfig(checkpoint.config);
        checkpoint.improvements.forEach((point: any) =>
          stripEvaluation(point.individual),
        );
        if (checkpoint.state) {
          checkpoint.state.modelVersion = version;
          stripConfig(checkpoint.state.config);
          checkpoint.state.population.forEach(stripEvaluation);
          stripEvaluation(checkpoint.state.champion);
          checkpoint.state.cache.forEach((entry: any) =>
            stripEvaluation(entry.evaluation),
          );
        }
        return checkpoint;
      };
      const legacy = asLegacy(structuredClone(before));
      const imported = await api(server.port, "runs/import", {
        checkpoint: legacy,
      });
      assert.deepEqual(
        (await api(server.port, `runs/${imported.summary.id}/checkpoint`))
          .state,
        before.state,
      );
      await server.close();
      const file = join(dir, id + ".json"),
        stored = JSON.parse(await readFile(file, "utf8"));
      asLegacy(stored.checkpoint);
      assert.ok(stored.archives.length >= 2);
      for (const archive of stored.archives) {
        archive.snapshot.population.forEach(stripEvaluation);
        stripEvaluation(archive.snapshot.champion);
      }
      await writeFile(file, JSON.stringify(stored));
      server = await startResearchServer({
        port: 0,
        host: "127.0.0.1",
        dataDir: dir,
      });
      assert.deepEqual(
        (await api(server.port, `runs/${id}/checkpoint`)).state,
        before.state,
      );
      const historic = await api(server.port, `runs/${id}/generations/0`);
      assert.deepEqual(
        historic,
        generationSnapshot(await initializePopulation(cfg)),
      );
      await api(server.port, `runs/${id}/actions`, { action: "step" });
      const continued = await state(server.port, id, "paused", 3);
      assert.deepEqual(
        continued.snapshot,
        generationSnapshot(await advanceGeneration(before.state)),
      );
      assert.deepEqual((await api(server.port, "health")).recoveryErrors, []);
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
