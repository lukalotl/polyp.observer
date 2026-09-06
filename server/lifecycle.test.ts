/** Native regression tests: actual TCP, filesystem transactions and worker lifecycles. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { request } from "node:http";
import { WebSocket } from "ws";
import { startResearchServer } from "./index.js";
import { DEFAULT_RUN_CONFIG } from "../src/research/config";
import type {
  RunConfig,
  RunDetail,
  RunCheckpoint,
} from "../src/research/types";

type Server = Awaited<ReturnType<typeof startResearchServer>>;
const config = (patch: Partial<RunConfig> = {}): RunConfig => ({
  ...DEFAULT_RUN_CONFIG,
  name: "Native lifecycle",
  size: 9,
  steps: 8,
  populationSize: 8,
  eliteCount: 2,
  tournamentSize: 2,
  evaluationWorkers: 1,
  cacheSize: 32,
  checkpointSeconds: 2,
  snapshotEvery: 1,
  retainedSnapshots: 3,
  ...patch,
});
async function api(
  server: Server,
  path: string,
  input?: unknown,
  origin?: string,
) {
  const response = await fetch(
    `http://127.0.0.1:${server.port}/api/${path}`,
    input === undefined
      ? {}
      : {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(origin ? { Origin: origin } : {}),
          },
          body: JSON.stringify(input),
        },
  );
  const value = (await response.json()) as any;
  assert.ok(response.ok, `${response.status} ${JSON.stringify(value)}`);
  return value;
}
async function wait(
  server: Server,
  id: string,
  check: (detail: RunDetail) => boolean,
  timeout = 10_000,
): Promise<RunDetail> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const detail = (await api(server, `runs/${id}`)) as RunDetail;
    if (check(detail)) return detail;
    assert.notEqual(
      detail.summary.status,
      "failed",
      detail.summary.error ?? "worker failed",
    );
    await delay(10);
  }
  throw new Error("Timed out waiting for research state.");
}
async function fixture(
  run: (server: Server, dir: string) => Promise<void>,
  options = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "polyp-lifecycle-"));
  const server = await startResearchServer({
    port: 0,
    host: "127.0.0.1",
    dataDir: dir,
    ...options,
  });
  try {
    await run(server, dir);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("browser disconnect is observer-only; FIFO admission counts coordinator threads and pause has no late writes", async () => {
  await fixture(
    async (server, dir) => {
      const first = (await api(server, "runs", {
        config: config(),
        start: true,
      })) as RunDetail;
      const second = (await api(server, "runs", {
        config: config(),
        start: true,
      })) as RunDetail;
      assert.equal(second.summary.status, "queued");
      assert.equal(second.summary.queuePosition, 1);
      const live = await wait(
        server,
        first.summary.id,
        (d) => d.summary.generation >= 3,
      );
      const socket = new WebSocket(
        `ws://127.0.0.1:${server.port}/api/research/ws`,
      );
      await new Promise<void>((done, reject) => {
        socket.once("open", done);
        socket.once("error", reject);
      });
      socket.send(
        JSON.stringify({ type: "subscribe", runId: first.summary.id }),
      );
      socket.terminate();
      await wait(
        server,
        first.summary.id,
        (d) => d.summary.generation > live.summary.generation + 2,
      );
      const paused = (await api(server, `runs/${first.summary.id}/actions`, {
        action: "pause",
      })) as RunDetail;
      assert.equal(paused.summary.status, "paused");
      assert.equal(paused.summary.workerCount, 0);
      const path = join(dir, first.summary.id + ".json");
      const stamp = (await stat(path)).mtimeMs;
      await wait(server, second.summary.id, (d) => d.summary.generation >= 2);
      await delay(80);
      assert.equal(
        (await api(server, `runs/${first.summary.id}`)).summary.generation,
        paused.summary.generation,
      );
      assert.equal(
        (await stat(path)).mtimeMs,
        stamp,
        "cancelled run has no late checkpoint writes",
      );
      const health = await api(server, "health");
      assert.equal(health.activeRuns, 1);
      assert.equal(health.workers, 2);
    },
    { maxEvaluationWorkers: 2, cpuBudget: 3 },
  );
});

test("single-step intent cannot turn into indefinite research after checkpoint recovery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "polyp-step-intent-"));
  let server: Server | undefined;
  try {
    server = await startResearchServer({
      port: 0,
      host: "127.0.0.1",
      dataDir: dir,
    });
    const run = (await api(server, "runs", { config: config() })) as RunDetail;
    await api(server, `runs/${run.summary.id}/actions`, { action: "step" });
    await wait(
      server,
      run.summary.id,
      (d) => d.summary.status === "paused" && d.summary.generation === 0,
    );
    await server.close();
    server = undefined;
    const path = join(dir, run.summary.id + ".json");
    const stored = JSON.parse(await readFile(path, "utf8"));
    // Exact interrupted-step envelope, independently exercising restart intent.
    stored.intent = "step";
    stored.summary.status = "running";
    await writeFile(path, JSON.stringify(stored));
    server = await startResearchServer({
      port: 0,
      host: "127.0.0.1",
      dataDir: dir,
    });
    await delay(100);
    const resumed = await api(server, `runs/${run.summary.id}`);
    assert.equal(resumed.summary.status, "paused");
    assert.equal(resumed.summary.generation, 0);
    assert.equal((await api(server, "health")).workers, 0);
  } finally {
    await server?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("archive is a stop, immutable source; imports preserve provenance and full genetic state", async () => {
  await fixture(async (server) => {
    const run = (await api(server, "runs", {
      config: config({ maxGenerations: 4 }),
      start: true,
    })) as RunDetail;
    await wait(server, run.summary.id, (d) => d.summary.status === "completed");
    const cp = (await api(
      server,
      `runs/${run.summary.id}/checkpoint`,
    )) as RunCheckpoint;
    const imported = (await api(server, "runs/import", {
      checkpoint: cp,
      name: "Imported",
    })) as RunDetail;
    const fork = (await api(server, `runs/${run.summary.id}/fork`, {
      name: "Forked",
    })) as RunDetail;
    assert.notEqual(imported.summary.id, run.summary.id);
    assert.notEqual(fork.summary.id, imported.summary.id);
    assert.equal(imported.summary.parentRunId, run.summary.id);
    assert.equal(fork.summary.parentRunId, run.summary.id);
    const copied = (await api(
      server,
      `runs/${imported.summary.id}/checkpoint`,
    )) as RunCheckpoint;
    const expected = structuredClone(cp.state!);
    expected.config.name = "Imported";
    assert.deepEqual(copied.state, expected);
    await api(server, `runs/${run.summary.id}/actions`, { action: "archive" });
    const response = await fetch(
      `http://127.0.0.1:${server.port}/api/runs/${run.summary.id}/actions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "pause" }),
      },
    );
    assert.equal(response.status, 409);
    assert.equal(
      (await api(server, `runs/${run.summary.id}`)).summary.status,
      "archived",
    );
  });
});

test("canonical lock is exclusive while HTTP and WebSocket proxy owns no jobs or data lock", async () => {
  await fixture(async (server, dir) => {
    await assert.rejects(
      startResearchServer({ port: 0, host: "127.0.0.1", dataDir: dir }),
      /already locked/,
    );
    const proxy = await startResearchServer({
      port: 0,
      host: "127.0.0.1",
      dataDir: dir,
      apiUpstream: `http://127.0.0.1:${server.port}`,
    });
    try {
      assert.equal(proxy.manager, null);
      const run = (await api(
        proxy,
        "runs",
        { config: config() },
        `http://127.0.0.1:${proxy.port}`,
      )) as RunDetail;
      assert.deepEqual(await api(proxy, "runs"), await api(server, "runs"));
      assert.equal(
        (await api(server, `runs/${run.summary.id}`)).summary.id,
        run.summary.id,
      );
      const socket = new WebSocket(
        `ws://127.0.0.1:${proxy.port}/api/research/ws`,
        { origin: `http://127.0.0.1:${proxy.port}` },
      );
      const hello = await new Promise<any>((done, reject) => {
        socket.once("message", (data) => done(JSON.parse(data.toString())));
        socket.once("error", reject);
      });
      assert.equal(hello.type, "hello");
      socket.terminate();
      const denied = await fetch(`http://127.0.0.1:${proxy.port}/api/runs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://evil.example",
          "X-Forwarded-Host": "evil.example",
        },
        body: JSON.stringify({ config: config() }),
      });
      assert.equal(denied.status, 403);
    } finally {
      await proxy.close();
    }
  });
});

test("large chunked JSON gets an explicit 413, not an unbounded body or lost worker", async () => {
  await fixture(async (server) => {
    const status = await new Promise<number>((done, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port: server.port,
          path: "/api/runs",
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
        (res) => {
          res.resume();
          done(res.statusCode!);
        },
      );
      req.on("error", reject);
      for (let i = 0; i < 17; i++) req.write(" ".repeat(1024 * 1024));
      req.end();
    });
    assert.equal(status, 413);
    assert.equal((await api(server, "health")).workers, 0);
  });
});

test("untrusted historical trace and oversized reservation are rejected without allocating workers", async () => {
  await fixture(async (server) => {
    const run = (await api(server, "runs", {
      config: config({ maxGenerations: 1 }),
      start: true,
    })) as RunDetail;
    await wait(server, run.summary.id, (d) => d.summary.status === "completed");
    const cp = (await api(
      server,
      `runs/${run.summary.id}/checkpoint`,
    )) as RunCheckpoint;
    const broken = structuredClone(cp);
    broken.improvements[0].individual.crossoverMask = [];
    const post = (path: string, input: unknown) =>
      fetch(`http://127.0.0.1:${server.port}/api/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
    assert.equal(
      (await post("runs/import", { checkpoint: broken })).status,
      400,
    );
    assert.equal(
      (
        await post("runs", {
          config: config({ populationSize: 512, retainedSnapshots: 128 }),
        })
      ).status,
      400,
    );
    assert.equal((await api(server, "health")).workers, 0);
  });
});

test(
  "negotiated DEFLATE shrinks real TCP full-detail traffic through canonical and proxy while decoded payload limits hold",
  { timeout: 15_000 },
  async (t) => {
    await fixture(async (server, dir) => {
      const run = (await api(server, "runs", {
        config: config({
          maxGenerations: 256,
          snapshotEvery: 100,
          mutationRate: 0.03,
        }),
        start: true,
      })) as RunDetail;
      const complete = await wait(
        server,
        run.summary.id,
        (d) => d.summary.status === "completed",
        12_000,
      );
      assert.equal(complete.history.length, 257);
      const proxy = await startResearchServer({
        port: 0,
        host: "127.0.0.1",
        dataDir: dir,
        apiUpstream: `http://127.0.0.1:${server.port}`,
      });
      try {
        for (const endpoint of [server, proxy]) {
          const peer = new WebSocket(
            `ws://127.0.0.1:${endpoint.port}/api/research/ws`,
            {
              origin: `http://127.0.0.1:${endpoint.port}`,
              perMessageDeflate: true,
            },
          );
          try {
            const measured = await new Promise<{
              decoded: number;
              wire: number;
              extensions: string;
              detail: RunDetail;
            }>((done, reject) => {
              let connection: import("node:net").Socket | undefined;
              let extensions = "";
              const timer = setTimeout(
                () => reject(new Error("Compressed publication timed out.")),
                4000,
              );
              peer.once("upgrade", (response) => {
                connection = response.socket;
                extensions = String(
                  response.headers["sec-websocket-extensions"] ?? "",
                );
              });
              peer.once("error", (error) => {
                clearTimeout(timer);
                reject(error);
              });
              peer.once("open", () =>
                peer.send(
                  JSON.stringify({ type: "subscribe", runId: run.summary.id }),
                ),
              );
              peer.on("message", (data) => {
                const event = JSON.parse(data.toString());
                if (event.type !== "run" || event.runId !== run.summary.id)
                  return;
                clearTimeout(timer);
                // Public Node TCP Socket counter includes the HTTP upgrade, hello,
                // runs metadata and framing too: a conservative actual-wire bound.
                done({
                  decoded: Buffer.byteLength(data.toString()),
                  wire: connection!.bytesRead,
                  extensions,
                  detail: event.detail,
                });
              });
            });
            assert.match(measured.extensions, /permessage-deflate/);
            assert.match(measured.extensions, /server_no_context_takeover/);
            assert.match(measured.extensions, /client_no_context_takeover/);
            assert.deepEqual(measured.detail.snapshot, complete.snapshot);
            assert.deepEqual(measured.detail.history, complete.history);
            assert.ok(
              measured.decoded > 50_000,
              "fixture publishes a representative full population/history detail",
            );
            assert.ok(
              measured.wire < measured.decoded * 0.65,
              `actual TCP ${measured.wire} bytes must be smaller than decoded JSON ${measured.decoded} bytes`,
            );
            t.diagnostic(
              `${endpoint === server ? "canonical" : "proxy"}: ${measured.wire} TCP bytes / ${measured.decoded} decoded detail bytes (includes handshake and metadata)`,
            );
            // A highly compressible frame is small on the network but exceeds the
            // 4 KiB decoded observer-message limit. Compression cannot bypass it.
            const rejected = new Promise<number>((done, reject) => {
              const timer = setTimeout(
                () =>
                  reject(
                    new Error("Compressed oversized frame was not closed."),
                  ),
                3000,
              );
              peer.once("close", (code) => {
                clearTimeout(timer);
                done(code);
              });
            });
            peer.send(
              JSON.stringify({ type: "subscribe", runId: "x".repeat(8192) }),
              { compress: true },
            );
            assert.equal(await rejected, 1009);
            assert.equal((await api(server, "health")).workers, 0);
          } finally {
            peer.terminate();
          }
        }
        // Compression is negotiated, never a requirement of the wire protocol.
        const plain = new WebSocket(
          `ws://127.0.0.1:${proxy.port}/api/research/ws`,
          { perMessageDeflate: false },
        );
        try {
          const hello = await new Promise<{ type: string }>((done, reject) => {
            plain.once("message", (data) => done(JSON.parse(data.toString())));
            plain.once("error", reject);
          });
          assert.equal(hello.type, "hello");
          assert.equal(plain.extensions, "");
        } finally {
          plain.terminate();
        }
      } finally {
        await proxy.close();
      }
    });
  },
);
