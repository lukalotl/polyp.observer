import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startResearchServer } from "./index.js";
import { DEFAULT_RUN_CONFIG } from "../src/research/config";
import type {
  RunConfig,
  RunDetail,
  RunCheckpoint,
} from "../src/research/types";
import {
  MAX_RESEARCH_MEMORY_BYTES,
  maximumRunMemory,
  retainedRunMemory,
} from "./memory";

type Server = Awaited<ReturnType<typeof startResearchServer>>;
const config = (patch: Partial<RunConfig> = {}): RunConfig => ({
  ...DEFAULT_RUN_CONFIG,
  name: "Memory regression",
  size: 9,
  steps: 8,
  evaluationWorkers: 1,
  snapshotEvery: 1,
  ...patch,
});
async function api<T = RunDetail>(
  server: Server,
  path: string,
  input?: unknown,
): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/${path}`, {
    method: input === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: input === undefined ? undefined : JSON.stringify(input),
  });
  const value = await response.json();
  assert.ok(response.ok, `${response.status}: ${JSON.stringify(value)}`);
  return value as T;
}
async function wait(
  server: Server,
  id: string,
  check: (d: RunDetail) => boolean,
) {
  for (let i = 0; i < 1000; i++) {
    const detail = await api(server, `runs/${id}`);
    assert.notEqual(
      detail.summary.status,
      "failed",
      detail.summary.error ?? "worker failed",
    );
    if (check(detail)) return detail;
    await delay(10);
  }
  throw new Error("Memory admission did not reach the expected state.");
}
interface Health {
  storedRuns: number;
  activeRuns: number;
  workers: number;
  recoveryErrors: string[];
  memory: { reservedBytes: number; limitBytes: number };
}

test("unused retention is not resident memory; all populated collections remain charged", () => {
  const cfg = config();
  const empty = {
    config: cfg,
    state: null,
    history: [],
    improvements: [],
    archives: [],
  };
  assert.equal(retainedRunMemory(empty), 16 * 1024);
  assert.equal(
    retainedRunMemory({
      ...empty,
      config: config({ retainedSnapshots: 128, cacheSize: 8192 }),
    }),
    retainedRunMemory(empty),
  );
  assert.ok(maximumRunMemory(cfg) > retainedRunMemory(empty) * 100);
  // Collection counts at their retention ceilings must exhaust the exact job
  // reservation; no stopped-data allowance may silently exceed its active bound.
  const full = {
    ...empty,
    state: { cache: Array(cfg.cacheSize) } as RunCheckpoint["state"],
    history: Array(4096),
    improvements: Array(256),
    archives: Array(cfg.retainedSnapshots),
  };
  assert.equal(retainedRunMemory(full), maximumRunMemory(cfg));
  for (const stateCount of [2, 10, 16]) {
    const changed = { ...full, config: { ...cfg, stateCount } };
    assert.equal(retainedRunMemory(changed), maximumRunMemory(changed.config));
  }
});

test(
  "a registry beyond 512 MiB of hypothetical growth supports create, import, fork and lossless restart",
  { timeout: 30_000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "polyp-memory-registry-"));
    let server: Server | undefined;
    try {
      server = await startResearchServer({
        host: "127.0.0.1",
        port: 0,
        dataDir: dir,
      });
      const cfg = config({
        populationSize: 256,
        retainedSnapshots: 100,
        maxGenerations: 2,
      });
      const source = await api(server, "runs", { config: cfg, start: true });
      await wait(
        server,
        source.summary.id,
        (d) => d.summary.status === "completed",
      );
      const checkpoint = await api<RunCheckpoint>(
        server,
        `runs/${source.summary.id}/checkpoint`,
      );
      const generation = await api(
        server,
        `runs/${source.summary.id}/generations/0`,
      );
      const ids = [source.summary.id];
      for (let i = 0; i < 10; i++) {
        const run = await api(server, "runs", { config: cfg });
        ids.push(run.summary.id);
      }
      const imported = await api(server, "runs/import", { checkpoint });
      const fork = await api(server, `runs/${source.summary.id}/fork`, {});
      ids.push(imported.summary.id, fork.summary.id);
      await api(server, `runs/${source.summary.id}/actions`, {
        action: "archive",
      });
      assert.ok(ids.length * maximumRunMemory(cfg) > MAX_RESEARCH_MEMORY_BYTES);
      const before = await api<Health>(server, "health");
      assert.equal(before.storedRuns, ids.length);
      assert.ok(before.memory.reservedBytes < 32 * 1024 * 1024);
      assert.equal(before.memory.limitBytes, MAX_RESEARCH_MEMORY_BYTES);
      await server.close();
      server = await startResearchServer({
        host: "127.0.0.1",
        port: 0,
        dataDir: dir,
      });
      const recovered = await api<Health>(server, "health");
      assert.deepEqual(recovered.recoveryErrors, []);
      assert.equal(recovered.storedRuns, ids.length);
      assert.equal(recovered.memory.reservedBytes, before.memory.reservedBytes);
      for (const id of ids)
        assert.equal((await api(server, `runs/${id}`)).summary.id, id);
      assert.equal(
        (await api(server, `runs/${source.summary.id}`)).summary.status,
        "archived",
      );
      assert.deepEqual(
        await api(server, `runs/${source.summary.id}/checkpoint`),
        checkpoint,
      );
      assert.deepEqual(
        await api(server, `runs/${source.summary.id}/generations/0`),
        generation,
      );
      assert.deepEqual(
        (
          await api<RunCheckpoint>(
            server,
            `runs/${imported.summary.id}/checkpoint`,
          )
        ).state,
        checkpoint.state,
      );
      // The independent count limit still bounds disk-backed registry growth.
      for (let i = ids.length; i < 64; i++)
        await api(server, "runs", { config: cfg });
      const denied = await fetch(`http://127.0.0.1:${server.port}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: cfg }),
      });
      assert.equal(denied.status, 409);
      assert.match(await denied.text(), /64 stored runs/);
    } finally {
      await server?.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "memory admission is FIFO, survives restart, and releases growth only after workers stop",
  { timeout: 30_000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "polyp-memory-admission-"));
    const cfg = config({ cacheSize: 32, snapshotEvery: 100 });
    const limit = maximumRunMemory(cfg) + 1024 * 1024;
    const options = {
      host: "127.0.0.1",
      port: 0,
      dataDir: dir,
      maxEvaluationWorkers: 3,
      cpuBudget: 6,
      maxMemoryBytes: limit,
    };
    let server: Server | undefined;
    try {
      server = await startResearchServer(options);
      const first = await api(server, "runs", { config: cfg, start: true });
      await wait(server, first.summary.id, (d) => d.summary.generation >= 0);
      const second = await api(server, "runs", { config: cfg, start: true });
      const third = await api(server, "runs", {
        config: config({
          populationSize: 8,
          retainedSnapshots: 2,
          cacheSize: 0,
        }),
        start: true,
      });
      assert.equal(second.summary.status, "queued");
      assert.equal(third.summary.status, "queued");
      assert.equal(third.summary.queuePosition, 2);
      const health = await api<Health>(server, "health");
      assert.equal(
        health.activeRuns,
        1,
        "memory, not available CPUs, blocks the queue",
      );
      assert.ok(health.memory.reservedBytes <= limit);
      assert.ok(health.memory.reservedBytes >= maximumRunMemory(cfg));
      await api(server, `runs/${first.summary.id}/actions`, {
        action: "archive",
      });
      await wait(server, second.summary.id, (d) => d.summary.generation >= 0);
      assert.equal(
        (await api(server, `runs/${third.summary.id}`)).summary.status,
        "queued",
      );
      await api(server, `runs/${second.summary.id}/actions`, {
        action: "pause",
      });
      await wait(server, third.summary.id, (d) => d.summary.generation >= 0);
      await api(server, `runs/${third.summary.id}/actions`, {
        action: "pause",
      });
      const stopped = await api<Health>(server, "health");
      assert.equal(stopped.workers, 0);
      assert.ok(stopped.memory.reservedBytes < maximumRunMemory(cfg));
      // A step also obtains a full reservation and releases it on completion.
      const prior = (await api(server, `runs/${second.summary.id}`)).summary
        .generation;
      await api(server, `runs/${second.summary.id}/actions`, {
        action: "step",
      });
      await wait(
        server,
        second.summary.id,
        (d) =>
          d.summary.status === "paused" && d.summary.generation === prior + 1,
      );
      assert.ok(
        (await api<Health>(server, "health")).memory.reservedBytes <
          maximumRunMemory(cfg),
      );
      await api(server, `runs/${second.summary.id}/actions`, {
        action: "start",
      });
      await api(server, `runs/${third.summary.id}/actions`, {
        action: "start",
      });
      await server.close();
      server = await startResearchServer(options);
      const restarted = await api<Health>(server, "health");
      assert.equal(
        restarted.storedRuns,
        3,
        "queued intent must not make recovery skip runs",
      );
      assert.deepEqual(restarted.recoveryErrors, []);
      assert.equal(restarted.activeRuns, 1);
      assert.ok(restarted.memory.reservedBytes <= limit);
      assert.equal(
        (await api(server, `runs/${first.summary.id}`)).summary.status,
        "archived",
      );
      const resumed = await Promise.all(
        [second, third].map((run) => api(server!, `runs/${run.summary.id}`)),
      );
      assert.equal(
        resumed.filter((run) => run.summary.status === "queued").length,
        1,
      );
      assert.equal(
        resumed.find((run) => run.summary.status === "queued")!.summary
          .queuePosition,
        1,
      );
    } finally {
      await server?.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("retained data and imports still enforce the hard memory limit without allocating workers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "polyp-memory-hard-limit-"));
  const server = await startResearchServer({
    host: "127.0.0.1",
    port: 0,
    dataDir: dir,
    maxMemoryBytes: 32 * 1024,
  });
  try {
    const first = await api(server, "runs", { config: config() });
    const cp = await api<RunCheckpoint>(
      server,
      `runs/${first.summary.id}/checkpoint`,
    );
    await api(server, "runs/import", { checkpoint: cp });
    for (const [path, body] of [
      ["runs", { config: config() }],
      ["runs/import", { checkpoint: cp }],
      [`runs/${first.summary.id}/fork`, {}],
    ] as const) {
      const denied = await fetch(
        `http://127.0.0.1:${server.port}/api/${path}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      assert.equal(denied.status, 409);
      assert.match(await denied.text(), /Retained run data/);
    }
    const health = await api<Health>(server, "health");
    assert.equal(health.workers, 0);
    assert.equal(health.storedRuns, 2);
    assert.equal(health.memory.reservedBytes, health.memory.limitBytes);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
